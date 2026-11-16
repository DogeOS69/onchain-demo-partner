import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const chain = defineChain({
  id: 6281971, name: 'DogeOS Chikyu', nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.dogeos.com'] } },
  blockExplorers: { default: { name: 'L2Scan', url: 'https://dogeos-testnet.l2scan.co' } }, testnet: true,
});
export const oracle = { address: '0x5300000000000000000000000000000000000002', abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']) };
export const artifact = name => JSON.parse(fs.readFileSync(path.join(root, 'artifacts', `${name}.json`), 'utf8'));
export const deploymentPath = () => path.resolve(root, process.env.DEPLOYMENT_FILE || 'deployments/chikyu.json');
export const readDeployment = () => JSON.parse(fs.readFileSync(deploymentPath(), 'utf8'));
export const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export function clients({ signing = false, rpcUrl = process.env.RPC_URL || chain.rpcUrls.default.http[0] } = {}) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }), pollingInterval: 2000 });
  if (!signing) return { publicClient };
  let key = process.env.PRIVATE_KEY;
  if (!key && process.env.KEY_FILE) key = JSON.parse(fs.readFileSync(process.env.KEY_FILE, 'utf8')).privateKey;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set PRIVATE_KEY or KEY_FILE to a dedicated Chikyu testnet wallet.');
  const account = privateKeyToAccount(key);
  return { publicClient, account, walletClient: createWalletClient({ chain, account, transport: http(rpcUrl) }) };
}
export async function assertChikyu(publicClient) {
  const id = await publicClient.getChainId();
  if (id !== chain.id) throw new Error(`Wrong chain ${id}; only Chikyu ${chain.id} is allowed.`);
}
export const contract = (d, name) => ({ address: d.contracts[name].address, abi: artifact(name === 'Coordinator' ? 'Anyrand' : name).abi });
export async function waitSuccess(publicClient, hash, confirmations = 1) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
