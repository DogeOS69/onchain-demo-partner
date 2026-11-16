import { createPublicClient, defineChain, encodeFunctionData, formatEther, http, keccak256,
  parseAbi, parseEther, parseEventLogs, zeroAddress, type Address, type Hex } from 'viem';
import { getUserOperationHash, getUserOperationTypedData } from 'viem/account-abstraction';

export type Manifest = {
  chainId: number; chainName: string; genesisHash: Hex; rpcUrl: string;
  entryPointVersion: string; entryPoint: Address; delegate: Address; counter: Address;
  accountMode: string; deploymentStatus: string; requiredConfirmations: number;
  contracts: Record<string, { address: Address; runtimeCodeHash: Hex }>;
};
export type Operation = { id: string; status: string; chainId: number; owner: Address; account: Address;
  counter: Address; counterBefore: string; counterAfter?: string; userOpHash: Hex;
  expiresAt: string; transactionHash?: Hex; confirmations: number; requiredConfirmations: number;
  maxChargeDoge: string; networkFeeDoge?: string; userChargeDoge?: string; failure?: string;
  userOperation: Record<string, Hex> };
export type ActivationQuote = { owner: Address; delegate: Address; chainId: number; genesisHash: Hex;
  nonce: number; authorizationNonce: number; gas: Hex; maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex; reserveWei: string; maxChargeDoge: string; expiresAt: number };
export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export const accountAbi = parseAbi(['function execute(address,uint256,bytes)', 'function entryPoint() view returns (address)']);
export const counterAbi = parseAbi(['function increment()', 'function counts(address) view returns (uint256)', 'event Incremented(address indexed account,uint256 count)']);
export const entryAbi = parseAbi(['function getNonce(address,uint192) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
export const chainOf = (m: Manifest) => defineChain({ id: m.chainId, name: m.chainName, testnet: true,
  nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 }, rpcUrls: { default: { http: [m.rpcUrl] } } });
export const rpcOf = (m: Manifest) => createPublicClient({ chain: chainOf(m), transport: http(m.rpcUrl), pollingInterval: 1000 });
export function validateManifest(m: Manifest) {
  const local = m.chainId === 31337 && typeof window !== 'undefined' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)
    && new URL(m.rpcUrl).hostname === '127.0.0.1';
  ensure(local || (m.chainId === 6281971 && m.rpcUrl === 'https://rpc.devnet.doge.xyz'
    && m.genesisHash === '0x4d6ef3d0349760195375877b4b3d9c0a5107c6df559e075b67e95d48962be868'), 'This demo only supports DogeOS devnet.');
  ensure(m.deploymentStatus === 'verified' && m.accountMode === 'eip7702' && m.entryPointVersion === '0.9'
    && same(m.entryPoint, '0x433709009B8330FDa32311DF1C2AFA402eD8D009')
    && (local || m.requiredConfirmations === 18), 'Deployment is not ready.');
  for (const name of ['EntryPoint', 'Simple7702Account', 'Counter'])
    ensure(m.contracts[name]?.runtimeCodeHash, 'Missing deployment verification.');
  ensure(m.contracts.EntryPoint.runtimeCodeHash === (local
    ? '0x94c969b899cb2a68ac9c124d8ee104a047771ee988f155b4e4683c254291f805'
    : '0x723352984e0761e22ca9ae376a4c0fc95dc291c10a38bafd66201daf084f378d')
    && m.contracts.Simple7702Account.runtimeCodeHash === '0x3b1d0694cb8bf1d50d33d679486a47499227b5e2434ee48fe5c9a3b0dc0ca9de'
    && m.contracts.Counter.runtimeCodeHash === '0x3ff8cfc73f069a8ec58a1c7f3059993dcbd3cc8dfebeb0a4b0ddb2241320da0a',
  'Contract code is not the pinned demo implementation.');
  ensure(same(m.contracts.EntryPoint.address, m.entryPoint) && same(m.contracts.Simple7702Account.address, m.delegate)
    && same(m.contracts.Counter.address, m.counter), 'Deployment addresses disagree.');
}
export async function verifyNetwork(m: Manifest) {
  validateManifest(m);
  const rpc = rpcOf(m);
  ensure(await rpc.getChainId() === m.chainId && same((await rpc.getBlock({ blockNumber: 0n })).hash, m.genesisHash),
    'Wrong RPC network. Devnet and testnet share a chain ID.');
  for (const c of Object.values(m.contracts))
    ensure(keccak256((await rpc.getCode({ address: c.address })) ?? '0x') === c.runtimeCodeHash, 'A deployed contract changed.');
}
export async function accountInfo(m: Manifest, owner: Address) {
  const rpc = rpcOf(m);
  const [balance, deposit, code, count] = await Promise.all([rpc.getBalance({ address: owner }),
    rpc.readContract({ address: m.entryPoint, abi: entryAbi, functionName: 'balanceOf', args: [owner] }),
    rpc.getCode({ address: owner }),
    rpc.readContract({ address: m.counter, abi: counterAbi, functionName: 'counts', args: [owner] })]);
  const activated = same(code, '0xef0100' + m.delegate.slice(2));
  ensure(!code || code === '0x' || activated, 'This account has a different delegation. It will not be replaced.');
  return { balance, deposit, available: balance + deposit, activated, count };
}
export function maxCost(op: Operation['userOperation']) {
  return (BigInt(op.verificationGasLimit) + BigInt(op.callGasLimit) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas);
}
export function typedDataOf(op: Operation['userOperation'], m: Manifest) {
  const value: Record<string, unknown> = { ...op };
  for (const key of ['nonce','verificationGasLimit','callGasLimit','preVerificationGas','maxFeePerGas','maxPriorityFeePerGas']) value[key] = BigInt(op[key]);
  return getUserOperationTypedData({ chainId: m.chainId, entryPointAddress: m.entryPoint, userOperation: value as never });
}
export function hashOf(op: Operation['userOperation'], m: Manifest) {
  const value: Record<string, unknown> = { ...op };
  for (const key of ['nonce','verificationGasLimit','callGasLimit','preVerificationGas','maxFeePerGas','maxPriorityFeePerGas']) value[key] = BigInt(op[key]);
  return getUserOperationHash({ chainId: m.chainId, entryPointAddress: m.entryPoint, entryPointVersion: '0.9', userOperation: value as never });
}
export async function verifyIntent(result: Operation, owner: Address, m: Manifest) {
  await verifyNetwork(m);
  const rpc = rpcOf(m), op = result.userOperation;
  ensure(result.chainId === m.chainId && same(result.owner, owner) && same(op.sender, owner) && same(result.account, owner), 'Unexpected account.');
  ensure(!Object.keys(op).some(k => k.startsWith('paymaster')) && !op.eip7702Auth && !op.factory && !op.factoryData, 'Unexpected deployment or sponsorship.');
  ensure(same(result.counter, m.counter) && op.callData === encodeFunctionData({ abi: accountAbi, functionName: 'execute',
    args: [m.counter, 0n, encodeFunctionData({ abi: counterAbi, functionName: 'increment' })] }), 'Unexpected action.');
  ensure((await accountInfo(m, owner)).activated, 'Activate 7702 first.');
  ensure(same(await rpc.readContract({ address: owner, abi: accountAbi, functionName: 'entryPoint' }), m.entryPoint), 'Wrong delegate EntryPoint.');
  ensure(await rpc.readContract({ address: m.entryPoint, abi: entryAbi, functionName: 'getNonce', args: [owner, 0n] }) === BigInt(op.nonce), 'Account nonce changed.');
  const block = await rpc.getBlock(), expires = Date.parse(result.expiresAt) / 1000;
  ensure(expires > Number(block.timestamp) + 15 && expires <= Number(block.timestamp) + 310, 'Fee preview expired. Prepare again.');
  ensure(BigInt(op.verificationGasLimit) + BigInt(op.callGasLimit) <= 1_500_000n
    && BigInt(op.preVerificationGas) >= 0n && BigInt(op.maxFeePerGas) > 0n && BigInt(op.maxFeePerGas) <= 500_000_000n
    && BigInt(op.maxPriorityFeePerGas) === BigInt(op.maxFeePerGas) && maxCost(op) <= parseEther('0.5')
    && result.maxChargeDoge === formatEther(maxCost(op)), 'Unexpected gas budget.');
  ensure(hashOf(op, m) === result.userOpHash, 'UserOperation hash does not match.');
}
export async function verifyReceipt(op: Operation, m: Manifest) {
  ensure(op.transactionHash && same(op.owner, op.account) && hashOf(op.userOperation, m) === op.userOpHash, 'Operation identity changed.');
  const rpc = rpcOf(m), receipt = await rpc.getTransactionReceipt({ hash: op.transactionHash });
  ensure(receipt.status === 'success' && same(receipt.to, m.entryPoint), 'Bundle failed.');
  const events = parseEventLogs({ abi: entryAbi, logs: receipt.logs, eventName: 'UserOperationEvent' })
    .filter(e => same(e.address, m.entryPoint) && e.args.userOpHash === op.userOpHash);
  const event = events[0]?.args;
  ensure(events.length === 1 && event.success && same(event.sender, op.account) && same(event.paymaster, zeroAddress)
    && event.nonce === BigInt(op.userOperation.nonce), 'Account operation failed.');
  ensure(op.userChargeDoge === formatEther(event.actualGasCost) && event.actualGasCost <= maxCost(op.userOperation), 'Account charge changed.');
  const counts = parseEventLogs({ abi: counterAbi, logs: receipt.logs, eventName: 'Incremented' })
    .filter(e => same(e.address, m.counter) && same(e.args.account, op.account));
  ensure(counts.length === 1 && counts[0].args.count > BigInt(op.counterBefore), 'Counter did not increase.');
  ensure(await rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n >= BigInt(m.requiredConfirmations), 'Waiting for confirmations.');
  return counts[0].args.count.toString();
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/aa/' + path, { method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Demo unavailable.');
  return value;
}
