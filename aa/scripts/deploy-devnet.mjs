import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createWalletClient, encodeDeployData, formatEther, getContractAddress, http, keccak256, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, assertNetwork, feeOracle, oracleAbi, readJson, reader, root, saveJson, same } from '../lib/chain.mjs';
import { canonicalEntryPoint, counterCodeHash, delegateCodeHash, entryPointCodeHashes } from '../lib/deployment.mjs';
import { oraclePayload } from '../lib/data-fee.mjs';

const file = resolve(root, 'config/devnet.json');
const manifest = await readJson(file);
assert(manifest.chainId === 6281971 && manifest.rpcUrl === 'https://rpc.devnet.doge.xyz'
  && manifest.genesisHash === '0x4d6ef3d0349760195375877b4b3d9c0a5107c6df559e075b67e95d48962be868', 'Devnet only');
const client = reader(manifest);
await assertNetwork(client, manifest);
assert.equal(keccak256(await client.getCode({ address: canonicalEntryPoint })), entryPointCodeHashes[manifest.chainId]);
const keys = await readJson(process.env.AA_DEPLOY_KEY_FILE ?? resolve(root, '.runtime/devnet-keys.private.json'));
const account = privateKeyToAccount(keys.deployerPrivateKey);
const executor = privateKeyToAccount(keys.executorPrivateKey).address;
assert(same(executor, manifest.executor), 'Use the dedicated devnet executor');
const wallet = createWalletClient({ account, chain: client.chain, transport: http(manifest.rpcUrl) });
const apply = process.argv.includes('--apply');
const stateFile = resolve(root, '.runtime/deployment-devnet.private.json');
const state = await readJson(stateFile, { genesisHash: manifest.genesisHash, deployer: account.address, contracts: {} });
assert(same(state.deployer, account.address) && state.genesisHash === manifest.genesisHash, 'Deployment identity changed');
let dryNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' }), total = 0n;
async function send(name, { data, to, value = 0n, gas, expectedHash, bytecode }) {
  const intent = JSON.stringify({ dataHash: keccak256(data), to: to ?? null, value: String(value) });
  const saved = state.contracts[name];
  if (saved?.transactionHash) {
    assert.equal(saved.intent, intent, 'Saved deployment intent changed');
    const receipt = await client.getTransactionReceipt({ hash: saved.transactionHash });
    assert.equal(receipt.status, 'success');
    if (saved.address) assert.equal(keccak256(await client.getCode({ address: saved.address })), saved.runtimeCodeHash);
    return saved;
  }
  let pending = saved?.pending;
  if (!pending) {
    const nonce = apply ? await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) : dryNonce++;
    const price = await client.getGasPrice();
    assert(price > 0n && price * 2n + 100n <= 500_000_000n, 'Unexpected gas price');
    const raw = await wallet.signTransaction({ ...(to ? { to } : {}), data, value, nonce, gas,
      maxFeePerGas: price * 2n + 100n, maxPriorityFeePerGas: 100n, type: 'eip1559' });
    const galileo = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'isGalileo' });
    const l1 = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [oraclePayload(raw, galileo)] });
    const cost = gas * (price * 2n + 100n) + l1 * 125n / 100n;
    assert(cost < parseEther('8'), name + ' exceeds the 8 DOGE fee limit');
    total += cost + value;
    console.log(name + ': upper estimate ' + formatEther(cost) + ' DOGE' + (value ? ' + ' + formatEther(value) + ' DOGE funding' : ''));
    if (!apply) return { planned: true };
    assert(await client.getBalance({ address: account.address }) > cost + value + parseEther('0.25'), 'Insufficient devnet DOGE');
    pending = { raw, hash: keccak256(raw), intent, ...(to ? {} : { address: getContractAddress({ from: account.address, nonce: BigInt(nonce) }) }) };
    state.contracts[name] = { pending }; await saveJson(stateFile, state);
  }
  assert.equal(pending.intent, intent, 'Pending deployment intent changed');
  let receipt = await client.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: pending.raw }); }
    catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
  }
  receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations: 18, timeout: 180_000 });
  assert.equal(receipt.status, 'success', name + ' reverted; inspect before retrying');
  const runtimeCodeHash = pending.address ? keccak256(await client.getCode({ address: pending.address })) : undefined;
  if (expectedHash) assert.equal(runtimeCodeHash, expectedHash);
  const result = { address: pending.address, runtimeCodeHash, intent, transactionHash: pending.hash, blockNumber: String(receipt.blockNumber),
    creationDataHash: keccak256(data), ...(bytecode ? { bytecodeHash: keccak256(bytecode) } : {}) };
  state.contracts[name] = result; await saveJson(stateFile, state);
  console.log(name + ': ' + pending.hash);
  return result;
}
async function deploy(name, contract, args = [], expectedHash) {
  const bytecode = typeof contract.bytecode === 'string' ? contract.bytecode : contract.bytecode.object;
  return send(name, { data: encodeDeployData({ abi: contract.abi, bytecode, args }), bytecode,
    gas: name === 'EntryPointSimulations09' ? 7_000_000n : 3_000_000n, expectedHash });
}
const load = async path => JSON.parse(await readFile(resolve(root, 'node_modules/@pimlico/alto/esm/contracts', path), 'utf8'));
const delegate = await deploy('Simple7702Account', await artifact('Simple7702Account'), [canonicalEntryPoint], delegateCodeHash);
const counter = await deploy('Counter', await artifact('Counter'), [], counterCodeHash);
const simulations = await deploy('EntryPointSimulations09', await load('EntryPointSimulations.sol/EntryPointSimulations09.json'));
const pimlico = await deploy('PimlicoSimulations', await load('PimlicoSimulations.sol/PimlicoSimulations.json'));
if (await client.getBalance({ address: executor }) < parseEther('0.5'))
  await send('ExecutorFunding', { to: executor, value: parseEther('2'), data: '0x', gas: 21_000n });
if (!apply) {
  console.log('Dry run only. Total upper estimate: ' + formatEther(total) + ' DOGE. Deployer: ' + account.address);
  process.exit(0);
}
assert(await client.getBalance({ address: executor }) >= parseEther('0.5'), 'Executor needs devnet DOGE');
await saveJson(file, { ...manifest, deploymentStatus: 'verified', delegate: delegate.address, counter: counter.address,
  entryPointSimulations: simulations.address, pimlicoSimulations: pimlico.address, deployer: account.address,
  contracts: { EntryPoint: { address: canonicalEntryPoint, runtimeCodeHash: entryPointCodeHashes[manifest.chainId], preinstalled: true },
    Simple7702Account: delegate, Counter: counter, EntryPointSimulations09: simulations, PimlicoSimulations: pimlico } });
console.log('Devnet deployment verified. No browser account has been activated.');
