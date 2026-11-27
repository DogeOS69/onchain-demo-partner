import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concat, createPublicClient, createWalletClient, defineChain, encodeFunctionData,
  http, keccak256, numberToHex, parseEther, parseEventLogs, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
import { accountAbi, accountSalt, artifact, counterAbi, factoryAbi } from '../lib/chain.mjs';
import { checkIntent, factoryCall, incrementCall, limits, maxCost, operationHash, operationTypedData, packOperation, verifyOwner } from '../lib/user-operation.mjs';
import { launchAlto } from '../lib/alto.mjs';
import { createEngine } from '../lib/engine.mjs';
import { arachnid, arachnidRuntime, canonicalEntryPoint, entryPointCodeHashes, entryPointSalt } from '../lib/deployment.mjs';

let anvil, client, wallet, admin, entry, factory, manifest, counter, localRpc;
const chain = defineChain({ id: 31337, name: 'Isolated test', fees: { defaultPriorityFee: 100n }, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const owner = privateKeyToAccount(generatePrivateKey());
const testFees = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 100n };

before(async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  anvil = spawn(process.execPath, ['node_modules/@foundry-rs/anvil/bin.mjs', '--host', '127.0.0.1',
    '--port', String(port), '--chain-id', '31337', '--base-fee', '10000000', '--gas-price', '10000000', '--no-priority-fee', '--silent'],
    { stdio: 'ignore' });
  const rpc = `http://127.0.0.1:${port}`;
  localRpc = rpc;
  client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 1000 }), pollingInterval: 20 });
  for (let attempt = 0; ; attempt++) {
    try { assert.equal(await client.getChainId(), 31337); break; }
    catch (error) { if (attempt >= 50) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  // Anvil's first default account, used only against the loopback test chain.
  admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  wallet = createWalletClient({ account: admin, chain, transport: http(rpc) });
  entry = await artifact('EntryPoint'); factory = await artifact('SimpleAccountFactory');
  const deploy = async (contract, args = []) => {
    const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode, args, ...testFees });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const source = 'pragma solidity ^0.8.0; contract Counter { mapping(address => uint256) public counts; event Incremented(address indexed account, uint256 count); function increment() external { emit Incremented(msg.sender, ++counts[msg.sender]); } }';
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'C.sol': { content: source } }, settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const c = compiled.contracts['C.sol'].Counter;
  counter = await deploy({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` });
  await client.request({ method: 'anvil_setCode', params: [arachnid, arachnidRuntime] });
  const entryDeployment = await wallet.sendTransaction({ to: arachnid, data: concat([entryPointSalt, entry.bytecode]), ...testFees });
  await client.waitForTransactionReceipt({ hash: entryDeployment });
  const ep = canonicalEntryPoint;
  assert.equal(keccak256(await client.getCode({ address: ep })), entryPointCodeHashes[31337]);
  const fac = await deploy(factory, [ep]);
  const implementation = await client.readContract({ address: fac, abi: factory.abi, functionName: 'accountImplementation' });
  manifest = { chainId: 31337, entryPointVersion: '0.9', entryPoint: ep, accountFactory: fac, counter, accountImplementation: implementation };

});

after(() => { anvil?.kill('SIGTERM'); });

async function makeOperation({ accountOwner = owner } = {}) {
  const sender = await client.readContract({ address: manifest.accountFactory, abi: factoryAbi, functionName: 'getAddress', args: [accountOwner.address, accountSalt] });
  const code = await client.getCode({ address: sender });
  const nonce = await client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'getNonce', args: [sender, 0n] });
  const op = { sender, nonce: numberToHex(nonce),
    ...(code && code !== '0x' ? {} : { factory: manifest.accountFactory, factoryData: factoryCall(accountOwner.address) }),
    callData: incrementCall(counter), verificationGasLimit: '0x7a120', callGasLimit: '0x186a0', preVerificationGas: '0x186a0',
    maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x5f5e100', signature: '0x' };
  op.signature = await accountOwner.signTypedData(operationTypedData(op, manifest));
  return op;
}
async function fund(address, value = parseEther('0.1')) {
  const hash = await wallet.sendTransaction({ to: address, value, ...testFees });
  await client.waitForTransactionReceipt({ hash });
}
async function available(address) {
  return await client.getBalance({ address }) + await client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'balanceOf', args: [address] });
}

async function execute(op) {
  const packed = packOperation(op);
  const localHash = operationHash(op, manifest);
  assert.equal(localHash, await client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'getUserOpHash', args: [packed] }));
  const { request } = await client.simulateContract({ account: admin, address: manifest.entryPoint,
    abi: entry.abi, functionName: 'handleOps', args: [[packed], admin.address] });
  const hash = await wallet.writeContract({ ...request, ...testFees });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}

test('salt 0 derives the account, which pays its own deployment and counter operation', async () => {
  assert.equal(accountSalt, 0n);
  const op = await makeOperation();
  assert.equal(await client.getBalance({ address: owner.address }), 0n);
  assert.equal(await available(op.sender), 0n);
  await assert.rejects(execute(op), 'an unfunded account cannot pay');
  await fund(op.sender);
  const before = await available(op.sender);
  const receipt = await execute(op);
  const [event] = parseEventLogs({ abi: entry.abi, logs: receipt.logs, eventName: 'UserOperationEvent' });
  assert.equal(event.args.paymaster, zeroAddress);
  assert.equal(event.args.success, true);
  assert(event.args.actualGasCost > 0n);
  assert.equal(before - await available(op.sender), event.args.actualGasCost);
  assert.equal(await client.getBalance({ address: owner.address }), 0n);
  assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'counts', args: [op.sender] }), 1n);
  await assert.rejects(execute(op), 'a mined operation cannot be replayed');
});

test('the demo rejects changed intent, another salt, a paymaster and excessive costs', async () => {
  const op = await makeOperation({ accountOwner: privateKeyToAccount(generatePrivateKey()) });
  for (const change of [
    { callData: encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [admin.address, 1n, '0x'] }) },
    { factoryData: encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owner.address, 1n] }) },
    { paymaster: admin.address }, { paymasterData: '0x' },
    { preVerificationGas: numberToHex(limits.maxCost) },
    { verificationGasLimit: numberToHex(limits.maxGas + 1n) },
  ]) assert.throws(() => checkIntent({ ...op, ...change }, owner.address, manifest));
});

test('only the owner signature can execute the account', async () => {
  const op = await makeOperation();
  op.signature = await privateKeyToAccount(generatePrivateKey()).signTypedData(operationTypedData(op, manifest));
  await assert.rejects(verifyOwner(operationHash(op, manifest), op.signature, owner.address));
  await assert.rejects(execute(op));
  op.signature = await owner.signMessage({ message: { raw: operationHash(op, manifest) } });
  await assert.rejects(verifyOwner(operationHash(op, manifest), op.signature, owner.address), 'old personal_sign signatures are not v0.9 signatures');
  await assert.rejects(execute(op));
  op.signature = await owner.signTypedData(operationTypedData(op, { ...manifest, chainId: 1 }));
  await assert.rejects(verifyOwner(operationHash(op, manifest), op.signature, owner.address), 'typed signatures bind the chain');
  await assert.rejects(execute(op));
});

test('the final v0.9 factory prevents direct account-creation front-running', async () => {
  const fresh = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(client.simulateContract({ account: admin, address: manifest.accountFactory,
    abi: factory.abi, functionName: 'createAccount', args: [fresh.address, 0n] }));
});

test('Alto estimates and includes a real self-funded UserOperation; recovery does not send twice', { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-aa-test-'));
  let bundler;
  try {
    const deploy = async (url) => {
      const { readFile } = await import('node:fs/promises');
      const contract = JSON.parse(await readFile(url, 'utf8'));
      const bytecode = typeof contract.bytecode === 'string' ? contract.bytecode : contract.bytecode.object;
      const hash = await wallet.deployContract({ abi: contract.abi, bytecode, ...testFees });
      return (await client.waitForTransactionReceipt({ hash })).contractAddress;
    };
    const pimlicoSimulations = await deploy(new URL('../node_modules/@pimlico/alto/esm/contracts/PimlicoSimulations.sol/PimlicoSimulations.json', import.meta.url));
    const entryPointSimulations = await deploy(new URL('../node_modules/@pimlico/alto/esm/contracts/EntryPointSimulations.sol/EntryPointSimulations09.json', import.meta.url));
    const implementation = await client.readContract({ address: manifest.accountFactory, abi: factory.abi, functionName: 'accountImplementation' });
    const local = { ...manifest, rpcUrl: localRpc, explorerUrl: 'http://localhost', accountImplementation: implementation,
      pimlicoSimulations, entryPointSimulations };
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    bundler = await launchAlto({ manifest: local, executorPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', stateDir: dir, port });
    const engine = await createEngine({ manifest: local, executor: admin.address,
      rpc: bundler.rpc, stateDir: dir, client, requiredConfirmations: 1 });
    const testOwner = privateKeyToAccount(generatePrivateKey());
    const prepared = await engine.prepare(testOwner.address);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.userOperation.paymaster, undefined);
    assert.equal(packOperation(prepared.userOperation).paymasterAndData, '0x');
    assert.equal(await client.getBalance({ address: testOwner.address }), 0n);
    const signature = await testOwner.signTypedData(operationTypedData(prepared.userOperation, local));
    await assert.rejects(engine.submit(prepared.id, await owner.signTypedData(operationTypedData(prepared.userOperation, local))));
    await assert.rejects(engine.submit(prepared.id, signature), /Add DOGE/);
    await fund(prepared.account);
    const accountBefore = await available(prepared.account);
    const submitted = await engine.submit(prepared.id, signature);
    assert.equal(submitted.status, 'submitted');
    for (let i = 0; i < 80; i++) {
      await engine.tick();
      if (engine.status(prepared.id).status === 'confirmed') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const confirmed = engine.status(prepared.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.counterAfter, '1');
    assert(Number(confirmed.userChargeDoge) > 0);
    assert.equal(accountBefore - await available(prepared.account), parseEther(confirmed.userChargeDoge));
    assert.equal(confirmed.feeCovered, true);
    assert(parseEther(confirmed.userChargeDoge) <= maxCost(prepared.userOperation));
    assert.equal(await client.getBalance({ address: testOwner.address }), 0n);
    const restarted = await createEngine({ manifest: local, executor: admin.address,
      rpc: bundler.rpc, stateDir: dir, client, requiredConfirmations: 1 });
    assert.equal(restarted.status(prepared.id).transactionHash, confirmed.transactionHash);
    assert.equal((await restarted.submit(prepared.id, signature)).transactionHash, confirmed.transactionHash);
    assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'counts', args: [prepared.account] }), 1n);

    // Without a paymaster, the signature has no onchain expiry. An ambiguous
    // send must stay pending beyond the preparation TTL, also after a restart.
    const rejectRpc = async (method, params) => {
      if (method === 'eth_sendUserOperation') throw new Error('transport outcome unknown');
      return bundler.rpc(method, params);
    };
    const recovery = await createEngine({ manifest: local, executor: admin.address,
      rpc: rejectRpc, stateDir: dir, client, requiredConfirmations: 3 });
    const expired = await recovery.prepare(testOwner.address);
    await recovery.submit(expired.id, await testOwner.signTypedData(operationTypedData(expired.userOperation, local)));
    await new Promise(resolve => setTimeout(resolve, 150));
    await client.request({ method: 'evm_increaseTime', params: [310] });
    await client.request({ method: 'evm_mine', params: [] });
    await recovery.tick();
    assert.equal(recovery.status(expired.id).status, 'submitted');
    await client.request({ method: 'evm_mine', params: [] });
    await client.request({ method: 'evm_mine', params: [] });
    await recovery.tick();
    assert.equal(recovery.status(expired.id).status, 'submitted');
    const next = await recovery.prepare(testOwner.address);
    assert.equal(next.id, expired.id);
    assert.equal(next.userOperation.nonce, expired.userOperation.nonce);
    const recovered = await createEngine({ manifest: local, executor: admin.address,
      rpc: bundler.rpc, stateDir: dir, client, requiredConfirmations: 1 });
    assert.equal((await recovered.prepare(testOwner.address)).id, expired.id);
    // Its original signature is still valid and the exact operation can recover.
    await execute({ ...expired.userOperation, signature: await testOwner.signTypedData(operationTypedData(expired.userOperation, local)) });
    await recovered.tick();
    assert.equal(recovered.status(expired.id).status, 'confirmed');
    assert.equal(recovered.status(expired.id).counterAfter, '2');

  } finally {
    if (bundler) {
      bundler.child.kill('SIGTERM');
      await new Promise(resolve => bundler.child.once('exit', resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
