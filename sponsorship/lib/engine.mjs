import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { encodeFunctionData, formatEther, getAddress, keccak256, numberToHex, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { accountAbi, accountSalt, artifact, counterAbi, factoryAbi, feeOracle, json,
  oracleAbi, readJson, reader, same, saveJson, safeError } from './chain.mjs';
import { ApiError, checkIntent, encodeQuote, factoryCall, incrementCall, limits,
  operationHash, ownerAddress, packOperation, publicOperation, quoteHash,
  stubSignature, verifyOwner } from './user-operation.mjs';

const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const activeStates = ['submitted', 'included'];

export async function createEngine({ manifest, quotePrivateKey, executor, rpc, stateDir,
  client = reader(), requiredConfirmations = 18 }) {
  assert.equal(await client.getChainId(), manifest.chainId, 'Wrong chain');
  const signer = privateKeyToAccount(quotePrivateKey);
  const [entry, paymaster] = await Promise.all([artifact('EntryPoint'), artifact('CounterPaymaster')]);
  for (const contract of Object.values(manifest.contracts ?? {})) {
    assert.equal(keccak256(await client.getCode({ address: contract.address })), contract.runtimeCodeHash,
      'A configured contract has different code');
  }
  const sponsorRead = (functionName, args = []) => client.readContract({ address: manifest.paymaster, abi: paymaster.abi, functionName, args });
  assert(same(await sponsorRead('quoteSigner'), signer.address), 'Wrong quote signer');
  assert(same(await sponsorRead('counter'), manifest.counter), 'Wrong sponsored counter');
  assert(same(await sponsorRead('entryPoint'), manifest.entryPoint), 'Wrong sponsor EntryPoint');
  const path = resolve(stateDir, 'operations.private.json');
  const db = await readJson(path, { version: 1, chainId: manifest.chainId, paymaster: manifest.paymaster, operations: {} });
  assert(db.chainId === manifest.chainId && same(db.paymaster, manifest.paymaster), 'State belongs to another deployment');
  let writes = Promise.resolve();
  const checkpoint = () => {
    const snapshot = JSON.parse(json(db));
    const result = writes.then(() => saveJson(path, snapshot));
    writes = result.catch(() => {}); return result;
  };
  let queue = Promise.resolve();
  const serial = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  const running = new Set();
  const nonceOf = address => client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'getNonce', args: [address, 0n] });
  const countOf = address => client.readContract({ address: manifest.counter, abi: counterAbi, functionName: 'counts', args: [address] });
  const usedBudget = () => Object.values(db.operations).reduce((sum, op) =>
    sum + BigInt(op.networkFeeWei ?? (activeStates.includes(op.status) ? op.reserveWei ?? '0' : '0')), 0n);

  async function checkAccount(owner, address) {
    const code = await client.getCode({ address });
    if (!code || code === '0x') return false;
    const [storedOwner, ep, implementation] = await Promise.all([
      client.readContract({ address, abi: accountAbi, functionName: 'owner' }),
      client.readContract({ address, abi: accountAbi, functionName: 'entryPoint' }),
      client.getStorageAt({ address, slot: implementationSlot }),
    ]);
    if (!same(storedOwner, owner) || !same(ep, manifest.entryPoint)
      || !same(`0x${implementation.slice(-40)}`, manifest.accountImplementation)) {
      throw new ApiError(409, 'This smart account is not supported by the demo.');
    }
    return true;
  }

  async function reserveFor(op) {
    // Reserve for the known calldata, a worst-case 65-byte owner signature,
    // and 256 nonzero bytes for the transaction envelope. Replacing the
    // entire payload with nonzero bytes greatly overstates DogeOS data fees.
    const packed = packOperation({ ...op, signature: `0x${'ff'.repeat(65)}` });
    const data = encodeFunctionData({ abi: entry.abi, functionName: 'handleOps', args: [[packed], executor] });
    const bytes = Math.ceil(((data.length - 2) / 2 + 256) / 256) * 256;
    if (bytes > 4096) throw new ApiError(400, 'Operation too large.');
    const l1 = manifest.chainId === 31337 ? 0n : await client.readContract({
      address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [`0x${'ff'.repeat(256)}${data.slice(2)}`],
    });
    const gas = ['verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit']
      .reduce((sum, key) => sum + BigInt(op[key]), 100_000n);
    const reserve = gas * BigInt(op.maxFeePerGas) + l1 * 125n / 100n;
    if (reserve > limits.maxNetworkFee) throw new ApiError(503, 'The current network fee exceeds the demo budget.');
    return reserve;
  }

  async function config() {
    const [deposit, balance, totalOperations] = await Promise.all([
      sponsorRead('getDeposit'), client.getBalance({ address: executor }), sponsorRead('totalOperations'),
    ]);
    return { chainId: manifest.chainId, chainName: 'DogeOS Chikyu', rpcUrl: manifest.rpcUrl,
      explorerUrl: manifest.explorerUrl, entryPoint: manifest.entryPoint, entryPointVersion: '0.7',
      accountFactory: manifest.accountFactory, accountSalt: String(accountSalt), counter: manifest.counter,
      paymaster: manifest.paymaster, quoteSigner: signer.address, executor,
      operationsEnabled: deposit >= limits.maxCost && balance >= limits.maxNetworkFee
        && totalOperations < BigInt(limits.maxOperations) && usedBudget() < limits.totalNetworkBudget,
      operationsRemaining: Math.max(0, limits.maxOperations - Number(totalOperations)),
      operationsPerAccount: limits.perAccount, requiredConfirmations,
      funding: 'paymaster', paymasterBalanceDoge: formatEther(deposit), userChargeDoge: '0' };
  }

  async function prepare(input) {
    return serial(async () => {
      const owner = ownerAddress(input);
      const owned = Object.values(db.operations).filter(op => same(op.owner, owner));
      const active = owned.find(op => activeStates.includes(op.status));
      if (active) return publicOperation(active);
      const block = await client.getBlock();
      const prior = owned.find(op => op.status === 'prepared' && op.validUntil > Number(block.timestamp) + 30);
      if (prior) return publicOperation(prior);
      if (!(await config()).operationsEnabled) throw new ApiError(503, 'Sponsorship is currently paused.');
      if (Object.keys(db.operations).length >= limits.maxPreparations) throw new ApiError(429, 'The demo preparation limit has been reached.');
      const ownerCode = await client.getCode({ address: owner });
      if (ownerCode && ownerCode !== '0x') throw new ApiError(400, 'Connect an EOA wallet for this demo.');
      const account = getAddress(await client.readContract({ address: manifest.accountFactory, abi: factoryAbi,
        functionName: 'getAddress', args: [owner, accountSalt] }));
      if (await sponsorRead('operationsBy', [account]) >= BigInt(limits.perAccount)) throw new ApiError(429, 'This account has used its three sponsored operations.');
      const deployed = await checkAccount(owner, account);
      const [nonce, count, prices] = await Promise.all([nonceOf(account), countOf(account), rpc('pimlico_getUserOperationGasPrice')]);
      const price = prices.fast ?? prices.standard;
      const maxFee = BigInt(price.maxFeePerGas) * 120n / 100n;
      if (maxFee <= 0n || maxFee > limits.maxFeePerGas) throw new ApiError(503, 'Gas prices exceed the demo limit.');
      const quote = { validUntil: Number(block.timestamp) + limits.quoteSeconds,
        maxCost: limits.maxCost, maxFeePerGas: limits.maxFeePerGas, maxGas: limits.maxGas };
      const op = { sender: account, nonce: numberToHex(nonce),
        ...(deployed ? {} : { factory: manifest.accountFactory, factoryData: factoryCall(owner) }),
        callData: incrementCall(manifest.counter), verificationGasLimit: '0x7a120', callGasLimit: '0x186a0',
        preVerificationGas: '0x30d40', maxFeePerGas: numberToHex(maxFee), maxPriorityFeePerGas: price.maxPriorityFeePerGas,
        paymaster: manifest.paymaster, paymasterVerificationGasLimit: '0x30d40', paymasterPostOpGasLimit: '0x0',
        paymasterData: '0x', signature: stubSignature };
      const digest = quoteHash(op, quote, manifest);
      const chainDigest = await sponsorRead('quoteHash', [packOperation(op), quote]);
      assert.equal(chainDigest, digest, 'Paymaster quote hash mismatch');
      op.paymasterData = encodeQuote(quote, await signer.signMessage({ message: { raw: digest } }));
      const estimate = await rpc('eth_estimateUserOperationGas', [op, manifest.entryPoint]);
      for (const key of ['verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit']) {
        if (estimate[key] !== undefined) op[key] = numberToHex(BigInt(estimate[key]) * 115n / 100n + 1000n);
      }
      op.signature = '0x';
      checkIntent(op, owner, manifest);
      const hash = operationHash(op, manifest);
      assert.equal(hash, await client.readContract({ address: manifest.entryPoint, abi: entry.abi,
        functionName: 'getUserOpHash', args: [packOperation(op)] }), 'UserOperation hash mismatch');
      const result = { id: randomUUID(), status: 'prepared', chainId: manifest.chainId, owner, account,
        counter: manifest.counter, paymaster: manifest.paymaster, counterBefore: count.toString(),
        userOpHash: hash, userOperation: op, validUntil: quote.validUntil,
        expiresAt: new Date(quote.validUntil * 1000).toISOString(), startBlock: block.number.toString(),
        requiredConfirmations, confirmations: 0, reserveWei: (await reserveFor(op)).toString(), userChargeDoge: '0' };
      db.operations[result.id] = result;
      await checkpoint();
      return publicOperation(result);
    });
  }

  async function inspectReceipt(op, hash) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !same(receipt.to, manifest.entryPoint)) throw new Error('Unexpected bundle receipt');
    const matches = parseEventLogs({ abi: entry.abi, logs: receipt.logs, eventName: 'UserOperationEvent', strict: true })
      .filter(log => same(log.address, manifest.entryPoint) && same(log.args.userOpHash, op.userOpHash));
    assert.equal(matches.length, 1, 'Missing exact UserOperation event');
    const event = matches[0].args;
    assert(same(event.sender, op.account) && same(event.paymaster, manifest.paymaster)
      && event.nonce === BigInt(op.userOperation.nonce), 'Mismatched operation receipt');
    const raw = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (manifest.chainId !== 31337) assert(raw.l1Fee !== undefined, 'Missing DogeOS data fee');
    const l1 = BigInt(raw.l1Fee ?? 0);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1;
    op.transactionHash = hash; op.blockNumber = receipt.blockNumber.toString();
    op.networkFeeWei = fee.toString(); op.networkFeeDoge = formatEther(fee);
    op.l1DataFeeDoge = formatEther(l1); op.paymasterChargeDoge = formatEther(event.actualGasCost);
    if (!event.success) {
      op.status = 'failed'; op.failure = 'The sponsored action reverted onchain.';
      delete op.signature; await checkpoint(); return true;
    }
    const increments = parseEventLogs({ abi: counterAbi, logs: receipt.logs, eventName: 'Incremented', strict: true })
      .filter(log => same(log.address, manifest.counter) && same(log.args.account, op.account));
    assert.equal(increments.length, 1, 'Missing counter event');
    assert(increments[0].args.count > BigInt(op.counterBefore), 'Counter did not increase');
    assert(await countOf(op.account) >= increments[0].args.count, 'Counter state disagrees with receipt');
    op.counterAfter = increments[0].args.count.toString();
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    op.confirmations = Number(latest - receipt.blockNumber + 1n);
    op.status = op.confirmations >= requiredConfirmations ? 'confirmed' : 'included';
    if (op.status === 'confirmed') { delete op.signature; delete op.diagnostic; }
    await checkpoint();
    return true;
  }

  async function findReceipt(op) {
    if (op.transactionHash) {
      try { return await inspectReceipt(op, op.transactionHash); }
      catch { /* A reorg or a temporary read failure must not produce success. */ }
    }
    let result;
    try { result = await rpc('eth_getUserOperationReceipt', [op.userOpHash]); } catch { /* Use the chain below. */ }
    if (result?.receipt?.transactionHash) return inspectReceipt(op, result.receipt.transactionHash);
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    let from = BigInt(op.scanBlock ?? op.startBlock);
    if (from > latest) from = latest;
    const to = from + 399n < latest ? from + 399n : latest;
    const event = entry.abi.find(item => item.type === 'event' && item.name === 'UserOperationEvent');
    const logs = await client.getLogs({ address: manifest.entryPoint, event, args: { userOpHash: op.userOpHash }, fromBlock: from, toBlock: to });
    if (logs.length) return inspectReceipt(op, logs[0].transactionHash);
    op.lastScannedBlock = to.toString();
    op.scanBlock = (to > 18n ? to - 18n : 0n).toString();
    if (op.status === 'included') { op.status = 'submitted'; op.confirmations = 0; }
    await checkpoint(); return false;
  }

  async function processOperation(op) {
    if (running.has(op.id) || !activeStates.includes(op.status)) return;
    running.add(op.id);
    try {
      if (await findReceipt(op)) return;
      const nonce = await nonceOf(op.account);
      const block = await client.getBlock();
      if (nonce !== BigInt(op.userOperation.nonce)) return; // Reconcile the exact receipt, never sign another operation.
      if (Number(block.timestamp) > op.validUntil) {
        const stableNumber = block.number - BigInt(requiredConfirmations - 1);
        if (stableNumber >= 0n && BigInt(op.lastScannedBlock ?? 0) >= stableNumber) {
          const stable = await client.getBlock({ blockNumber: stableNumber });
          const stableNonce = await client.readContract({ address: manifest.entryPoint, abi: entry.abi,
            functionName: 'getNonce', args: [op.account, 0n], blockNumber: stableNumber });
          if (Number(stable.timestamp) > op.validUntil && stableNonce === BigInt(op.userOperation.nonce)) {
            op.status = 'expired'; delete op.signature; await checkpoint();
          }
        }
        return; // Do not release a possibly submitted operation before the scan and confirmation window agree.
      }
      if ((op.sendAttempts ?? 0) >= 2) return;
      if (op.lastSendAt && Date.now() - op.lastSendAt < 30_000) return;
      checkIntent(op.userOperation, op.owner, manifest);
      await verifyOwner(op.userOpHash, op.signature, op.owner);
      assert.equal(operationHash(op.userOperation, manifest), op.userOpHash, 'Saved operation changed');
      await checkAccount(op.owner, op.account);
      op.sendAttempts = (op.sendAttempts ?? 0) + 1; op.lastSendAt = Date.now(); await checkpoint();
      const hash = await rpc('eth_sendUserOperation', [{ ...op.userOperation, signature: op.signature }, manifest.entryPoint]);
      assert(same(hash, op.userOpHash), 'Bundler returned another hash');
      op.accepted = true; delete op.diagnostic; await checkpoint();
    } catch (error) {
      op.diagnostic = safeError(error); await checkpoint();
      // Unknown submission outcomes remain pending and recover by the same hash.
      if (!op.sendAttempts) { op.status = 'failed'; op.failure = 'The operation could not be submitted.'; delete op.signature; await checkpoint(); }
    } finally { running.delete(op.id); }
  }

  async function submit(id, signature) {
    return serial(async () => {
      const op = db.operations[id];
      if (!op) throw new ApiError(404, 'Operation not found.');
      await verifyOwner(op.userOpHash, signature, op.owner);
      if (activeStates.includes(op.status) || op.status === 'confirmed') return publicOperation(op);
      if (op.status !== 'prepared') throw new ApiError(409, 'Prepare a new operation.');
      if (Object.values(db.operations).some(other => activeStates.includes(other.status))) throw new ApiError(409, 'Another operation is confirming. Try again shortly.');
      const block = await client.getBlock();
      if (Number(block.timestamp) + 15 >= op.validUntil) throw new ApiError(409, 'The sponsorship quote expired. Prepare again.');
      if (await nonceOf(op.account) !== BigInt(op.userOperation.nonce)) throw new ApiError(409, 'The account nonce changed. Prepare again.');
      checkIntent(op.userOperation, op.owner, manifest);
      await checkAccount(op.owner, op.account);
      const reserve = await reserveFor(op.userOperation);
      if (usedBudget() + reserve > limits.totalNetworkBudget
        || await client.getBalance({ address: executor }) < reserve
        || await sponsorRead('getDeposit') < limits.maxCost) throw new ApiError(503, 'Sponsorship budget is unavailable.');
      op.signature = signature; op.status = 'submitted'; op.reserveWei = reserve.toString();
      await checkpoint();
      void processOperation(op);
      return publicOperation(op);
    });
  }
  return { config, prepare, submit,
    status(id) { const op = db.operations[id]; if (!op) throw new ApiError(404, 'Operation not found.'); return publicOperation(op); },
    async tick() { await Promise.all(Object.values(db.operations).filter(op => activeStates.includes(op.status)).map(processOperation)); },
  };
}
