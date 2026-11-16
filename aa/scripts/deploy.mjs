import assert from 'node:assert/strict';
import { readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { concat, createWalletClient, encodeDeployData, formatEther, getContractAddress,
  getCreate2Address, http, keccak256, parseEther, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, assertNetwork, chain, feeOracle, genesisHash, oracleAbi, readJson,
  reader, root, rpcUrl, saveJson, same } from '../lib/chain.mjs';
import { arachnid, arachnidCodeHash, canonicalEntryPoint, entryPointCodeHashes, entryPointSalt } from '../lib/deployment.mjs';
import { oraclePayload } from '../lib/data-fee.mjs';

// Only this testnet is authorized here. Mainnet preinstalls use their own pipeline.
const client = reader();
await assertNetwork(client, { chainId: chain.id, genesisHash });
assert.equal(keccak256(await client.getCode({ address: arachnid })), arachnidCodeHash);
const file = resolve(root, 'config/chikyu.json');
const previous = await readJson(file);
const keys = await readJson(process.env.AA_DEPLOY_KEY_FILE);
const account = privateKeyToAccount(keys.deployerPrivateKey ?? keys.privateKey);
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const apply = process.argv.includes('--apply');
const stateFile = resolve(root, '.runtime/deployment-09.private.json');
const state = await readJson(stateFile, { genesisHash, deployer: account.address, contracts: {} });
assert(same(state.deployer, account.address) && state.genesisHash === genesisHash, 'Deployment identity changed');
const entry = await artifact('EntryPoint');
assert(same(getCreate2Address({ from: arachnid, salt: entryPointSalt, bytecode: entry.bytecode }), canonicalEntryPoint));
const contractArtifact = async (name) => {
  const path = name === 'EntryPointSimulations09' ? 'EntryPointSimulations.sol/EntryPointSimulations09.json' : 'PimlicoSimulations.sol/PimlicoSimulations.json';
  const value = JSON.parse(await readFile(resolve(root, 'node_modules/@pimlico/alto/esm/contracts', path), 'utf8'));
  return { abi: value.abi, bytecode: typeof value.bytecode === 'string' ? value.bytecode : value.bytecode.object };
};
let dryNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
let total = 0n;
async function deploy(name, contract, args = [], canonical) {
  const data = canonical ? concat([entryPointSalt, contract.bytecode]) : encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode, args });
  const saved = state.contracts[name];
  const address = canonical ?? saved?.address;
  const code = address && await client.getCode({ address });
  if (code && code !== '0x' && !saved?.pending) {
    if (saved) assert.equal(saved.creationDataHash, keccak256(data), 'Saved deployment intent changed');
    const expected = canonical ? entryPointCodeHashes[chain.id] : saved.runtimeCodeHash;
    assert.equal(keccak256(code), expected, name + ' code changed');
    const result = saved ?? { address, runtimeCodeHash: expected, bytecodeHash: keccak256(contract.bytecode), creationDataHash: keccak256(data), preinstalled: true };
    if (apply) { state.contracts[name] = result; await saveJson(stateFile, state); }
    return result;
  }
  let pending = saved?.pending;
  if (!pending) {
    const nonce = apply ? await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) : dryNonce++;
    const gas = canonical ? 7_000_000n : name === 'SimpleAccountFactory' ? 3_000_000n : 7_000_000n;
    const gasPrice = await client.getGasPrice();
    assert(gasPrice > 0n && gasPrice <= 500_000_000n, 'Unexpected gas price');
    const raw = await wallet.signTransaction({ ...(canonical ? { to: arachnid } : {}), data, nonce,
      gas, maxFeePerGas: gasPrice * 2n + 100n, maxPriorityFeePerGas: 100n, type: 'eip1559' });
    const galileo = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'isGalileo' });
    const l1 = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [oraclePayload(raw, galileo)] });
    const cost = gas * (gasPrice * 2n + 100n) + l1 * 125n / 100n;
    assert(cost < parseEther('8'), name + ' exceeds the 8 DOGE deployment limit');
    total += cost;
    console.log(name + ': upper estimate ' + formatEther(cost) + ' DOGE');
    if (!apply) return { address: canonical ?? getContractAddress({ from: account.address, nonce: BigInt(nonce) }), planned: true };
    assert(await client.getBalance({ address: account.address }) > cost + parseEther('0.25'), 'Insufficient testnet DOGE');
    pending = { raw, hash: keccak256(raw), creationDataHash: keccak256(data),
      address: canonical ?? getContractAddress({ from: account.address, nonce: BigInt(nonce) }) };
    state.contracts[name] = { pending }; await saveJson(stateFile, state);
  }
  assert.equal(pending.creationDataHash, keccak256(data), 'Pending deployment intent changed');
  let receipt = await client.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: pending.raw }); }
    catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
  }
  receipt = await client.waitForTransactionReceipt({ hash: pending.hash, confirmations: 18, timeout: 180_000 });
  assert.equal(receipt.status, 'success', name + ' reverted; inspect before retrying');
  const deployed = await client.getCode({ address: pending.address });
  assert(deployed && deployed !== '0x', 'Missing deployed code');
  if (canonical) assert.equal(keccak256(deployed), entryPointCodeHashes[chain.id]);
  const result = { address: pending.address, bytecodeHash: keccak256(contract.bytecode), creationDataHash: keccak256(data),
    runtimeCodeHash: keccak256(deployed), transactionHash: pending.hash, blockNumber: String(receipt.blockNumber) };
  state.contracts[name] = result; await saveJson(stateFile, state);
  console.log(name + ': ' + result.address + ' · ' + result.transactionHash);
  return result;
}
// Existing counter and Pimlico helper remain compatible, but verify them before reusing.
for (const name of ['Counter', 'PimlicoSimulations']) {
  const c = previous.contracts[name];
  assert.equal(keccak256(await client.getCode({ address: c.address })), c.runtimeCodeHash, name + ' changed');
}
const ep = await deploy('EntryPoint', entry, [], canonicalEntryPoint);
const factory = await deploy('SimpleAccountFactory', await artifact('SimpleAccountFactory'), [canonicalEntryPoint]);
const simulation = await deploy('EntryPointSimulations09', await contractArtifact('EntryPointSimulations09'));
if (!apply) {
  console.log('Dry run only. Total upper estimate: ' + formatEther(total) + ' DOGE. Deployer: ' + account.address);
  process.exit(0);
}
const implementation = await client.readContract({ address: factory.address,
  abi: parseAbi(['function accountImplementation() view returns (address)']), functionName: 'accountImplementation' });
const implementationCode = await client.getCode({ address: implementation });
assert(same(await client.readContract({ address: implementation, abi: parseAbi(['function entryPoint() view returns (address)']), functionName: 'entryPoint' }), canonicalEntryPoint));
const manifest = { ...previous, genesisHash, entryPointVersion: '0.9', entryPoint: ep.address,
  accountFactory: factory.address, accountImplementation: implementation, entryPointSimulations: simulation.address,
  deployer: account.address, deploymentBlock: simulation.blockNumber, preinstallsVersion: 'v0.2.2',
  upstreamCommit: 'b36a1ed52ae00da6f8a4c8d50181e2877e4fa410',
  contracts: { EntryPoint: ep, SimpleAccountFactory: factory, EntryPointSimulations09: simulation,
    SimpleAccount: { address: implementation, runtimeCodeHash: keccak256(implementationCode) },
    Counter: previous.contracts.Counter, PimlicoSimulations: previous.contracts.PimlicoSimulations } };
if (previous.entryPointVersion === '0.7') await copyFile(file, resolve(root, 'config/chikyu-07-retired.json'));
await saveJson(file, manifest);
await saveJson(resolve(root, '../web/app/aa/deployment.json'), manifest);
console.log('Verified v0.9 deployment; backend and frontend manifests updated.');
