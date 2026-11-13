import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, parseAbi } from 'viem';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const chainId = 6281971;
export const rpcUrl = 'https://rpc.testnet.dogeos.com';
export const explorerUrl = 'https://dogeos-testnet.l2scan.co';
export const feeOracle = '0x5300000000000000000000000000000000000002';
export const accountSalt = 20261112n;
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
export const oracleAbi = parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);
export const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const reader = () => createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 1, timeout: 20_000 }) });
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
  const path = name === 'CounterPaymaster'
    ? new URL('../artifacts/CounterPaymaster.json', import.meta.url)
    : new URL(`../node_modules/@account-abstraction/contracts/artifacts/${name}.json`, import.meta.url);
  return readJson(path);
}
