import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, parseAbi } from 'viem';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const chainId = 6281971;
export const rpcUrl = 'https://rpc.testnet.dogeos.com';
export const genesisHash = '0xf9f7c524dce38b51a4d28ec2f18680773e5ba9d3f5f430d0e05f92cfeb65b1bc';
export const explorerUrl = 'https://dogeos-testnet.l2scan.co';
export const feeOracle = '0x5300000000000000000000000000000000000002';
export const accountSalt = 0n;
export const chain = defineChain({ id: chainId, name: 'DogeOS Chikyu', testnet: true,
  nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: 'DogeOS Explorer', url: explorerUrl } } });
export const counterAbi = parseAbi([
  'function increment()', 'function counts(address) view returns (uint256)',
  'event Incremented(address indexed account, uint256 count)',
]);
export const accountAbi = parseAbi([
  'function execute(address dest, uint256 value, bytes func)',
  'function owner() view returns (address)', 'function entryPoint() view returns (address)',
]);
export const factoryAbi = parseAbi([
  'function getAddress(address owner, uint256 salt) view returns (address)',
  'function createAccount(address owner, uint256 salt) returns (address)',
]);
export const oracleAbi = parseAbi(['function getL1Fee(bytes data) view returns (uint256)', 'function isGalileo() view returns (bool)']);
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const reader = () => createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
export async function assertNetwork(client, manifest) {
  if (await client.getChainId() !== manifest.chainId) throw new Error('Wrong chain');
  if (manifest.chainId === 31337 && !manifest.genesisHash) return;
  if (!manifest.genesisHash || !same((await client.getBlock({ blockNumber: 0n })).hash, manifest.genesisHash))
    throw new Error('Wrong network genesis: DogeOS devnet and testnet share a chain ID');
}
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, json(value) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export function safeError(error) {
  return String(error?.shortMessage ?? error?.message ?? 'Operation failed')
    .replace(/0x[0-9a-f]{64,}/gi, '[redacted]').slice(0, 300);
}
export async function artifact(name) {
  const path = new URL(`../artifacts/${name}.json`, import.meta.url);
  return readJson(path);
}
