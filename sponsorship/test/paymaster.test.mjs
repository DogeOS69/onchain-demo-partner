import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData,
  http, numberToHex, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
import { accountAbi, accountSalt, artifact, counterAbi, factoryAbi } from '../lib/chain.mjs';
import { encodeQuote, factoryCall, incrementCall, limits, operationHash, packOperation,
  quoteHash, verifyOwner } from '../lib/user-operation.mjs';
import { launchAlto } from '../lib/alto.mjs';
import { createEngine } from '../lib/engine.mjs';

let anvil, client, wallet, admin, sponsor, entry, factory, paymaster, manifest, counter, localRpc;
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
  sponsor = privateKeyToAccount(generatePrivateKey());
  entry = await artifact('EntryPoint'); factory = await artifact('SimpleAccountFactory'); paymaster = await artifact('CounterPaymaster');
  const deploy = async (contract, args = []) => {
    const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode, args, ...testFees });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const source = 'pragma solidity ^0.8.0; contract Counter { mapping(address => uint256) public counts; event Incremented(address indexed account, uint256 count); function increment() external { emit Incremented(msg.sender, ++counts[msg.sender]); } }';
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'C.sol': { content: source } }, settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  const c = compiled.contracts['C.sol'].Counter;
  counter = await deploy({ abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` });
  const ep = await deploy(entry);
  const fac = await deploy(factory, [ep]);
  const pm = await deploy(paymaster, [ep, sponsor.address, counter]);
  manifest = { chainId: 31337, entryPoint: ep, accountFactory: fac, counter, paymaster: pm };
  const deposit = await wallet.writeContract({ address: pm, abi: paymaster.abi, functionName: 'deposit', value: parseEther('1'), ...testFees });
  await client.waitForTransactionReceipt({ hash: deposit });
});

after(() => { anvil?.kill('SIGTERM'); });

async function makeOperation({ accountOwner = owner, quoteSigner = sponsor, mutate, quoteManifest } = {}) {
  const sender = await client.readContract({ address: manifest.accountFactory, abi: factoryAbi, functionName: 'getAddress', args: [accountOwner.address, accountSalt] });
  const code = await client.getCode({ address: sender });
  const nonce = await client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'getNonce', args: [sender, 0n] });
  const block = await client.getBlock();
  const quote = { validUntil: Number(block.timestamp) + 300, maxCost: limits.maxCost, maxFeePerGas: limits.maxFeePerGas, maxGas: limits.maxGas };
  const op = { sender, nonce: numberToHex(nonce), factory: code && code !== '0x' ? undefined : manifest.accountFactory,
    factoryData: code && code !== '0x' ? undefined : factoryCall(accountOwner.address), callData: incrementCall(counter),
    verificationGasLimit: '0x7a120', callGasLimit: '0x186a0', preVerificationGas: '0x186a0',
    maxFeePerGas: '0x5f5e100', maxPriorityFeePerGas: '0x64', paymaster: manifest.paymaster,
    paymasterVerificationGasLimit: '0x30d40', paymasterPostOpGasLimit: '0x0', paymasterData: '0x', signature: '0x' };
  if (mutate) await mutate(op, quote);
  const digest = quoteHash(op, quote, quoteManifest ?? manifest);
  if (!quoteManifest) {
    assert.equal(digest, await client.readContract({ address: manifest.paymaster, abi: paymaster.abi,
      functionName: 'quoteHash', args: [packOperation(op), quote] }));
  }
  op.paymasterData = encodeQuote(quote, await quoteSigner.signMessage({ message: { raw: digest } }));
  op.signature = await accountOwner.signMessage({ message: { raw: operationHash(op, manifest) } });
  return op;
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

test('a zero-balance owner deploys a zero-balance smart account and increments using the paymaster', async () => {
  const op = await makeOperation();
  assert.equal(await client.getBalance({ address: owner.address }), 0n);
  assert.equal(await client.getBalance({ address: op.sender }), 0n);
  const before = await client.readContract({ address: manifest.paymaster, abi: paymaster.abi, functionName: 'getDeposit' });
  await execute(op);
  assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'counts', args: [op.sender] }), 1n);
  assert.equal(await client.getBalance({ address: owner.address }), 0n);
  assert.equal(await client.getBalance({ address: op.sender }), 0n);
  assert.equal(await client.readContract({ address: manifest.entryPoint, abi: entry.abi, functionName: 'balanceOf', args: [op.sender] }), 0n);
  assert((await client.readContract({ address: manifest.paymaster, abi: paymaster.abi, functionName: 'getDeposit' })) < before);
  await assert.rejects(execute(op), 'a mined operation cannot be replayed');
});

test('the sponsor rejects another destination, value transfer and a different call', async () => {
  for (const [target, value, data] of [[admin.address, 0n, '0x'], [counter, 1n, encodeFunctionData({ abi: counterAbi, functionName: 'increment' })], [counter, 0n, '0x']]) {
    const op = await makeOperation({ mutate(op) { op.callData = encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [target, value, data] }); } });
    await assert.rejects(execute(op));
  }
});

test('invalid sponsor signatures, expired quotes and quotes for another chain are rejected', async () => {
  await assert.rejects(execute(await makeOperation({ quoteSigner: privateKeyToAccount(generatePrivateKey()) })));
  await assert.rejects(execute(await makeOperation({ mutate(op, quote) { quote.validUntil -= 1000; } })));
  await assert.rejects(execute(await makeOperation({ quoteManifest: { ...manifest, chainId: 31338 } })));
});

test('a quote cannot be used with another nonce and gas cannot exceed signed caps', async () => {
  const op = await makeOperation();
  op.nonce = '0x2';
  op.signature = await owner.signMessage({ message: { raw: operationHash(op, manifest) } });
  await assert.rejects(execute(op));
  await assert.rejects(execute(await makeOperation({ mutate(op) { op.maxFeePerGas = numberToHex(limits.maxFeePerGas + 1n); } })));
  await assert.rejects(execute(await makeOperation({ mutate(op) { op.verificationGasLimit = numberToHex(limits.maxGas + 1n); } })));
});

test('the owner must sign, and account sponsorship stops after three successful operations', async () => {
  const wrong = await makeOperation();
  wrong.signature = await sponsor.signMessage({ message: { raw: operationHash(wrong, manifest) } });
  await assert.rejects(verifyOwner(operationHash(wrong, manifest), wrong.signature, owner.address));
  await assert.rejects(execute(wrong));
  await execute(await makeOperation());
  await execute(await makeOperation());
  await assert.rejects(execute(await makeOperation()));
  assert.equal(await client.readContract({ address: manifest.paymaster, abi: paymaster.abi, functionName: 'operationsBy', args: [wrong.sender] }), 3n);
  assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'counts', args: [wrong.sender] }), 3n);
});

test('Alto estimates and includes a real sponsored UserOperation; recovery does not send twice', { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partner-sponsor-test-'));
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
    const entryPointSimulations = await deploy(new URL('../node_modules/@pimlico/alto/esm/contracts/EntryPointSimulations.sol/EntryPointSimulations07.json', import.meta.url));
    const implementation = await client.readContract({ address: manifest.accountFactory, abi: factory.abi, functionName: 'accountImplementation' });
    const local = { ...manifest, rpcUrl: localRpc, explorerUrl: 'http://localhost', accountImplementation: implementation,
      pimlicoSimulations, entryPointSimulations };
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    bundler = await launchAlto({ manifest: local, executorPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', stateDir: dir, port });
    const sponsorKey = generatePrivateKey();
    const signer = privateKeyToAccount(sponsorKey);
    const deployHash = await wallet.deployContract({ abi: paymaster.abi, bytecode: paymaster.bytecode, ...testFees,
      args: [local.entryPoint, signer.address, counter] });
    local.paymaster = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
    const fund = await wallet.writeContract({ address: local.paymaster, abi: paymaster.abi, functionName: 'deposit', value: parseEther('1'), ...testFees });
    await client.waitForTransactionReceipt({ hash: fund });
    const engine = await createEngine({ manifest: local, quotePrivateKey: sponsorKey, executor: admin.address,
      rpc: bundler.rpc, stateDir: dir, client, requiredConfirmations: 1 });
    const testOwner = privateKeyToAccount(generatePrivateKey());
    const prepared = await engine.prepare(testOwner.address);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.userOperation.paymaster, local.paymaster);
    assert.equal(await client.getBalance({ address: testOwner.address }), 0n);
    const signature = await testOwner.signMessage({ message: { raw: prepared.userOpHash } });
    await assert.rejects(engine.submit(prepared.id, await signer.signMessage({ message: { raw: prepared.userOpHash } })));
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
    assert.equal(confirmed.userChargeDoge, '0');
    assert(Number(confirmed.paymasterChargeDoge) > 0);
    assert.equal(await client.getBalance({ address: testOwner.address }), 0n);
    assert.equal(await client.getBalance({ address: prepared.account }), 0n);
    const restarted = await createEngine({ manifest: local, quotePrivateKey: sponsorKey, executor: admin.address,
      rpc: bundler.rpc, stateDir: dir, client, requiredConfirmations: 1 });
    assert.equal(restarted.status(prepared.id).transactionHash, confirmed.transactionHash);
    assert.equal((await restarted.submit(prepared.id, signature)).transactionHash, confirmed.transactionHash);
    assert.equal(await client.readContract({ address: counter, abi: counterAbi, functionName: 'counts', args: [prepared.account] }), 1n);

    // A rejected/unknown send must recover and release the global slot after
    // expiry, a complete receipt scan, and the configured confirmation window.
    const rejectRpc = async (method, params) => {
      if (method === 'eth_sendUserOperation') throw new Error('transport outcome unknown');
      return bundler.rpc(method, params);
    };
    const recovery = await createEngine({ manifest: local, quotePrivateKey: sponsorKey, executor: admin.address,
      rpc: rejectRpc, stateDir: dir, client, requiredConfirmations: 3 });
    const expired = await recovery.prepare(testOwner.address);
    await recovery.submit(expired.id, await testOwner.signMessage({ message: { raw: expired.userOpHash } }));
    await new Promise(resolve => setTimeout(resolve, 150));
    await client.request({ method: 'evm_increaseTime', params: [310] });
    await client.request({ method: 'evm_mine', params: [] });
    await recovery.tick();
    assert.equal(recovery.status(expired.id).status, 'submitted');
    await client.request({ method: 'evm_mine', params: [] });
    await client.request({ method: 'evm_mine', params: [] });
    await recovery.tick();
    assert.equal(recovery.status(expired.id).status, 'expired');
    const next = await recovery.prepare(testOwner.address);
    assert.notEqual(next.id, expired.id);
    assert.equal(next.userOperation.nonce, expired.userOperation.nonce);

  } finally {
    if (bundler) {
      bundler.child.kill('SIGTERM');
      await new Promise(resolve => bundler.child.once('exit', resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
