import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { formatEther, getAddress, keccak256, numberToHex, parseEventLogs, zeroAddress } from 'viem';
import { accountAbi, accountSalt, artifact, counterAbi, factoryAbi, feeOracle, json,
  oracleAbi, readJson, reader, same, saveJson, safeError } from './chain.mjs';
import { ApiError, checkIntent, executionGas, factoryCall, incrementCall, limits, maxCost,
  operationHash, ownerAddress, packOperation, publicOperation, stubSignature, verifyOwner } from './user-operation.mjs';

import { bundleEnvelope, oraclePayload } from './data-fee.mjs';

const feeModel = 'chikyu-zstd-v1';
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const activeStates = ['submitted', 'included'];

export async function createEngine({ manifest, executor, rpc, stateDir,
  client = reader(), requiredConfirmations = 18 }) {
  assert.equal(await client.getChainId(), manifest.chainId, 'Wrong chain');
  const entry = await artifact('EntryPoint');
  for (const contract of Object.values(manifest.contracts ?? {})) {
    assert.equal(keccak256(await client.getCode({ address: contract.address })), contract.runtimeCodeHash,
      'A configured contract has different code');
  }
  const path = resolve(stateDir, 'aa-operations-v1.private.json');
  const db = await readJson(path, { version: 1, chainId: manifest.chainId, entryPoint: manifest.entryPoint,
    accountFactory: manifest.accountFactory, accountSalt: String(accountSalt), operations: {} });
  assert(db.chainId === manifest.chainId && same(db.entryPoint, manifest.entryPoint)
    && same(db.accountFactory, manifest.accountFactory) && db.accountSalt === String(accountSalt), 'State belongs to another deployment');
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
  const depositOf = address => client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'balanceOf', args: [address] });
  async function availableOf(address) {
    const [balance, deposit] = await Promise.all([client.getBalance({ address }), depositOf(address)]);
    return balance + deposit;
  }

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

  async function dataFeeFor(op) {
    if (manifest.chainId === 31337) return 0n;
    const [nonce, galileo] = await Promise.all([
      client.getTransactionCount({ address: executor, blockTag: 'pending' }),
      client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'isGalileo' }),
    ]);
    const envelope = bundleEnvelope(op, manifest, entry.abi, executor, nonce);
    if ((envelope.length - 2) / 2 > 4096) throw new ApiError(400, 'Operation too large.');
    return client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee',
      args: [oraclePayload(envelope, galileo)] });
  }

  async function reserveFor(op) {
    // Preparation adds 25% headroom; submission may consume that headroom
    // when fees rise instead of demanding a fresh 25% margin every time.
    const dataFee = await dataFeeFor(op);
    const price = BigInt(op.maxFeePerGas);
    if (BigInt(op.preVerificationGas) * price < dataFee + 100_000n * price)
      throw new ApiError(409, 'The network fee changed. Prepare again before signing.');
    return (executionGas(op) + 100_000n) * price + dataFee;
  }
  async function config() {
    return { chainId: manifest.chainId, chainName: 'DogeOS Chikyu', rpcUrl: manifest.rpcUrl,
      explorerUrl: manifest.explorerUrl, entryPoint: manifest.entryPoint, entryPointVersion: '0.7',
      accountFactory: manifest.accountFactory, accountSalt: String(accountSalt), counter: manifest.counter,
      executor, operationsEnabled: await client.getBalance({ address: executor }) >= limits.maxCost,
      requiredConfirmations, funding: 'account' };
  }
  async function prepare(input) {
    return serial(async () => {
      const owner = ownerAddress(input);
      const owned = Object.values(db.operations).filter(op => same(op.owner, owner));
      const active = owned.find(op => activeStates.includes(op.status));
      if (active) return publicOperation(active);
      const block = await client.getBlock();
      const prior = owned.find(op => op.status === 'prepared' && op.feeModel === feeModel && op.validUntil > Number(block.timestamp) + 30);
      if (prior && await nonceOf(prior.account) === BigInt(prior.userOperation.nonce)) {
        try { await reserveFor(prior.userOperation); return publicOperation(prior); } catch { /* Refresh changed fees. */ }
      }
      if (!(await config()).operationsEnabled) throw new ApiError(503, 'The bundler is temporarily unavailable.');
      if (Object.keys(db.operations).length >= limits.maxPreparations) throw new ApiError(429, 'The demo preparation limit has been reached.');
      const ownerCode = await client.getCode({ address: owner });
      if (ownerCode && ownerCode !== '0x') throw new ApiError(400, 'Connect an EOA wallet for this demo.');
      const account = getAddress(await client.readContract({ address: manifest.accountFactory, abi: factoryAbi,
        functionName: 'getAddress', args: [owner, accountSalt] }));
      const deployed = await checkAccount(owner, account);
      const [nonce, count, prices] = await Promise.all([nonceOf(account), countOf(account), rpc('pimlico_getUserOperationGasPrice')]);
      const price = prices.fast ?? prices.standard;
      const maxFee = BigInt(price.maxFeePerGas) * 120n / 100n;
      if (maxFee <= 0n || maxFee > limits.maxFeePerGas) throw new ApiError(503, 'Gas prices exceed the demo limit.');
      // Equal fee caps fix the EntryPoint gas price, so data-fee reimbursement
      // remains correct even though the bundler transaction uses a lower tip.
      const op = { sender: account, nonce: numberToHex(nonce),
        ...(deployed ? {} : { factory: manifest.accountFactory, factoryData: factoryCall(owner) }),
        callData: incrementCall(manifest.counter), verificationGasLimit: '0x7a120', callGasLimit: '0x186a0',
        preVerificationGas: '0x30d40', maxFeePerGas: numberToHex(maxFee), maxPriorityFeePerGas: numberToHex(maxFee),
        signature: stubSignature };
      // Balance override is simulation-only, allowing a fee preview before funding.
      const estimate = await rpc('eth_estimateUserOperationGas', [op, manifest.entryPoint,
        { [account]: { balance: numberToHex(limits.maxCost) } }]);
      for (const key of ['verificationGasLimit', 'callGasLimit'])
        op[key] = numberToHex(BigInt(estimate[key]) * 115n / 100n + 1000n);
      const estimatePvg = BigInt(estimate.preVerificationGas) * 115n / 100n + 1000n;
      const basePvg = estimatePvg > 100_000n ? estimatePvg : 100_000n;
      op.preVerificationGas = numberToHex(basePvg);
      // The encoded PVG itself changes calldata; converge conservatively.
      let covered = false;
      for (let i = 0; i < 8; i++) {
        const dataFee = (await dataFeeFor(op)) * 125n / 100n;
        const needed = basePvg + (dataFee + maxFee - 1n) / maxFee;
        if (BigInt(op.preVerificationGas) >= needed) { covered = true; break; }
        op.preVerificationGas = numberToHex(needed);
      }
      if (!covered) throw new ApiError(503, 'Network fees are changing. Try again shortly.');
      op.signature = '0x';
      checkIntent(op, owner, manifest);
      const hash = operationHash(op, manifest);
      assert.equal(hash, await client.readContract({ address: manifest.entryPoint, abi: entry.abi,
        functionName: 'getUserOpHash', args: [packOperation(op)] }), 'UserOperation hash mismatch');
      const validUntil = Number(block.timestamp) + limits.preparationSeconds;
      const result = { id: randomUUID(), status: 'prepared', feeModel, chainId: manifest.chainId, owner, account,
        counter: manifest.counter, counterBefore: count.toString(),
        userOpHash: hash, userOperation: op, validUntil,
        expiresAt: new Date(validUntil * 1000).toISOString(), startBlock: block.number.toString(),
        requiredConfirmations, confirmations: 0, reserveWei: (await reserveFor(op)).toString() };
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
    assert(same(event.sender, op.account) && same(event.paymaster, zeroAddress)
      && event.nonce === BigInt(op.userOperation.nonce), 'Mismatched operation receipt');
    const raw = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (manifest.chainId !== 31337) assert(raw.l1Fee !== undefined, 'Missing DogeOS data fee');
    const l1 = BigInt(raw.l1Fee ?? 0);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1;
    op.transactionHash = hash; op.blockNumber = receipt.blockNumber.toString();
    op.networkFeeWei = fee.toString(); op.networkFeeDoge = formatEther(fee);
    op.l1DataFeeDoge = formatEther(l1); op.userChargeDoge = formatEther(event.actualGasCost);
    op.feeCovered = event.actualGasCost >= fee;
    if (!event.success) {
      op.status = 'failed'; op.failure = 'The counter action reverted onchain.';
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
      if (nonce !== BigInt(op.userOperation.nonce)) return; // Reconcile the exact receipt before releasing this account.
      // SimpleAccount signatures have no onchain expiry. Never release a nonce
      // merely because a preparation TTL passed after an ambiguous submission.
      if ((op.sendAttempts ?? 0) >= 2) return;
      if (op.lastSendAt && Date.now() - op.lastSendAt < 30_000) return;
      checkIntent(op.userOperation, op.owner, manifest);
      await verifyOwner(op.userOpHash, op.signature, op.owner);
      assert.equal(operationHash(op.userOperation, manifest), op.userOpHash, 'Saved operation changed');
      await checkAccount(op.owner, op.account);
      await reserveFor(op.userOperation);
      if (await availableOf(op.account) < maxCost(op.userOperation)) throw new Error('Account funds changed before submission');
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
      if (op.status !== 'prepared' || op.feeModel !== feeModel) throw new ApiError(409, 'Prepare a new operation.');
      if (Object.values(db.operations).some(other => activeStates.includes(other.status))) throw new ApiError(409, 'Another operation is confirming. Try again shortly.');
      const block = await client.getBlock();
      if (Number(block.timestamp) + 15 >= op.validUntil) throw new ApiError(409, 'The fee preview expired. Prepare again.');
      if (await nonceOf(op.account) !== BigInt(op.userOperation.nonce)) throw new ApiError(409, 'The account nonce changed. Prepare again.');
      checkIntent(op.userOperation, op.owner, manifest);
      await checkAccount(op.owner, op.account);
      const reserve = await reserveFor(op.userOperation);
      if (await client.getBalance({ address: executor }) < reserve) throw new ApiError(503, 'The bundler is temporarily unavailable.');
      if (await availableOf(op.account) < maxCost(op.userOperation))
        throw new ApiError(409, 'Add DOGE to your smart account before signing.');
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
