// Isolated browser-test fixture. Never used by the devnet service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { concat, createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, saveJson, json } from '../lib/chain.mjs';
import { launchAlto } from '../lib/alto.mjs';
import { createEngine } from '../lib/engine.mjs';
import { activationQuote } from '../lib/activation.mjs';
import { arachnid, arachnidRuntime, canonicalEntryPoint, entryPointSalt, entryPointCodeHashes } from '../lib/deployment.mjs';

const rpcUrl = 'http://127.0.0.1:18546';
const chain = defineChain({ id: 31337, name: 'Local 7702 simulation', nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const anvil = spawn(process.execPath, ['node_modules/@foundry-rs/anvil/bin.mjs', '--host', '127.0.0.1',
  '--port', '18546', '--chain-id', '31337', '--base-fee', '10000000', '--gas-price', '10000000',
  '--no-priority-fee', '--block-time', '1', '--silent'], { stdio: 'ignore' });
const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 1000 }), pollingInterval: 100 });
for (let i = 0; ; i++) {
  try { assert.equal(await client.getChainId(), 31337); break; }
  catch (e) { if (i >= 50) throw e; await new Promise(r => setTimeout(r, 100)); }
}
const adminKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const admin = privateKeyToAccount(adminKey);
const wallet = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
const fees = { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 100n };
await mkdir('.runtime/local-7702', { recursive: true, mode: 0o700 });
const stateDir = await mkdtemp('.runtime/local-7702/run-');
let alto, timer, server;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(timer); alto?.child.kill('SIGTERM'); anvil.kill('SIGTERM'); server?.close();
  setTimeout(() => process.exit(0), 200).unref();
});
const contracts = {};
const deploy = async (name, contract, args = []) => {
  const bytecode = typeof contract.bytecode === 'string' ? contract.bytecode : contract.bytecode.object;
  const hash = await wallet.deployContract({ abi: contract.abi, bytecode, args, ...fees });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  const address = receipt.contractAddress;
  contracts[name] = { address, runtimeCodeHash: keccak256(await client.getCode({ address })) };
  return address;
};
const entry = await artifact('EntryPoint');
await client.request({ method: 'anvil_setCode', params: [arachnid, arachnidRuntime] });
const epHash = await wallet.sendTransaction({ to: arachnid, data: concat([entryPointSalt, entry.bytecode]), ...fees });
await client.waitForTransactionReceipt({ hash: epHash });
assert.equal(keccak256(await client.getCode({ address: canonicalEntryPoint })), entryPointCodeHashes[31337]);
contracts.EntryPoint = { address: canonicalEntryPoint, runtimeCodeHash: entryPointCodeHashes[31337] };
const delegate = await deploy('Simple7702Account', await artifact('Simple7702Account'), [canonicalEntryPoint]);
const counter = await deploy('Counter', await artifact('Counter'));
const load = async path => JSON.parse(await readFile(new URL('../node_modules/@pimlico/alto/esm/contracts/' + path, import.meta.url), 'utf8'));
const pimlicoSimulations = await deploy('PimlicoSimulations', await load('PimlicoSimulations.sol/PimlicoSimulations.json'));
const entryPointSimulations = await deploy('EntryPointSimulations09', await load('EntryPointSimulations.sol/EntryPointSimulations09.json'));
const manifest = { chainId: 31337, chainName: chain.name, rpcUrl,
  genesisHash: (await client.getBlock({ blockNumber: 0n })).hash,
  entryPoint: canonicalEntryPoint, entryPointVersion: '0.9', delegate, counter,
  accountMode: 'eip7702', deploymentStatus: 'verified', executor: admin.address,
  pimlicoSimulations, entryPointSimulations, contracts };
await saveJson('.runtime/local-7702/manifest.json', manifest);
await saveJson(stateDir + '/manifest.json', manifest);
alto = await launchAlto({ manifest, executorPrivateKey: adminKey, stateDir, port: 43372 });
const engine = await createEngine({ manifest, executor: admin.address, client, rpc: alto.rpc, stateDir, requiredConfirmations: 2 });
timer = setInterval(() => void engine.tick().catch(e => console.error(e.message)), 500);
server = createServer(async (req, res) => {
  try {
    const route = req.url; let input;
    if (req.method === 'POST') { const parts = []; for await (const p of req) parts.push(p); input = JSON.parse(Buffer.concat(parts).toString()); }
    let value;
    if (route === '/config') value = await engine.config();
    else if (route === '/activation/quote') value = await activationQuote(input.owner, manifest, client);
    else if (route === '/prepare') value = await engine.prepare(input.owner);
    else if (route === '/submit') value = await engine.submit(input.id, input.signature);
    else if (route.startsWith('/operations/')) value = engine.status(route.split('/')[2]);
    else throw new Error('Not found');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(json(value));
  } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
}).listen(4342, '127.0.0.1', () => console.log('Local-only 7702 fixture ready at http://127.0.0.1:4342'));
