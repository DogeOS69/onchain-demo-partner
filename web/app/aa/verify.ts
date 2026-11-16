import { createPublicClient, encodeFunctionData, formatEther, http, keccak256, parseAbi,
  parseEther, parseEventLogs, zeroAddress, type Address, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import deployment from './deployment.json';
import { dogeosChain } from '../chain';
export const manifest = deployment;
export type Operation = { id: string; status: string; chainId: number; owner: Address; account: Address;
  counter: Address; counterBefore: string; counterAfter?: string; userOpHash: Hex;
  expiresAt: string; transactionHash?: Hex; confirmations: number; requiredConfirmations: number;
  maxChargeDoge: string; networkFeeDoge?: string; userChargeDoge?: string; l1DataFeeDoge?: string; failure?: string;
  userOperation: Record<string, Hex> };
export const rpc = createPublicClient({ chain: dogeosChain, transport: http(manifest.rpcUrl) });
const factory = parseAbi(['function getAddress(address,uint256) view returns (address)', 'function createAccount(address,uint256) returns (address)']);
const account = parseAbi(['function execute(address,uint256,bytes)', 'function owner() view returns (address)', 'function entryPoint() view returns (address)']);
const counter = parseAbi(['function increment()', 'function counts(address) view returns (uint256)', 'event Incremented(address indexed account,uint256 count)']);
const entry = parseAbi(['function getNonce(address,uint192) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function maxCost(op: Operation['userOperation']) {
  return (BigInt(op.verificationGasLimit) + BigInt(op.callGasLimit) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas);
}
export async function accountInfo(owner: Address) {
  const address = await rpc.readContract({ address: manifest.accountFactory as Address, abi: factory, functionName: 'getAddress', args: [owner, 0n] });
  const [balance, deposit] = await Promise.all([rpc.getBalance({ address }),
    rpc.readContract({ address: manifest.entryPoint as Address, abi: entry, functionName: 'balanceOf', args: [address] })]);
  return { address, balance, deposit, available: balance + deposit };
}
export function hashOf(op: Operation['userOperation']) {
  ensure(!Object.keys(op).some(k => k.startsWith('paymaster')) && !op.eip7702Auth, 'Unexpected account configuration.');
  const value: Record<string, unknown> = { ...op };
  for (const key of ['nonce','verificationGasLimit','callGasLimit','preVerificationGas','maxFeePerGas','maxPriorityFeePerGas']) value[key] = BigInt(op[key]);
  return getUserOperationHash({ chainId: manifest.chainId, entryPointAddress: manifest.entryPoint as Address,
    entryPointVersion: '0.7', userOperation: value as never });
}
export async function verifyIntent(result: Operation, owner: Address) {
  const op = result.userOperation;
  ensure(result.chainId === 6281971 && await rpc.getChainId() === 6281971 && same(result.owner, owner), 'Wallet or network changed.');
  ensure(same(result.counter, manifest.counter), 'Counter configuration changed.');
  ensure(op.callData === encodeFunctionData({ abi: account, functionName: 'execute', args: [manifest.counter as Address, 0n, encodeFunctionData({ abi: counter, functionName: 'increment' })] }), 'Unexpected counter action.');
  const canonical = (await accountInfo(owner)).address;
  ensure(same(op.sender, canonical) && same(result.account, canonical), 'Unexpected smart account.');
  const code = await rpc.getCode({ address: canonical });
  if (!code || code === '0x') {
    ensure(same(op.factory, manifest.accountFactory) && op.factoryData === encodeFunctionData({ abi: factory, functionName: 'createAccount', args: [owner, 0n] }), 'Unexpected account deployment.');
  } else {
    ensure(!op.factory && !op.factoryData, 'Account is already deployed. Prepare again.');
    const [storedOwner, ep, implementation] = await Promise.all([
      rpc.readContract({ address: canonical, abi: account, functionName: 'owner' }),
      rpc.readContract({ address: canonical, abi: account, functionName: 'entryPoint' }),
      rpc.getStorageAt({ address: canonical, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }),
    ]);
    ensure(same(storedOwner, owner) && same(ep, manifest.entryPoint) && same(`0x${implementation?.slice(-40)}`, manifest.accountImplementation), 'Unsupported account implementation.');
  }
  for (const contract of Object.values(manifest.contracts)) ensure(keccak256((await rpc.getCode({ address: contract.address as Address })) ?? '0x') === contract.runtimeCodeHash, 'A deployed contract changed.');
  ensure(await rpc.readContract({ address: manifest.entryPoint as Address, abi: entry, functionName: 'getNonce', args: [canonical, 0n] }) === BigInt(op.nonce), 'Account nonce changed. Prepare again.');
  const block = await rpc.getBlock();
  const expires = Date.parse(result.expiresAt) / 1000;
  ensure(expires > Number(block.timestamp) + 15 && expires <= Number(block.timestamp) + 310, 'Fee preview expired. Prepare again.');
  ensure(BigInt(op.verificationGasLimit) + BigInt(op.callGasLimit) <= 1500000n
    && BigInt(op.preVerificationGas) >= 0n && BigInt(op.maxFeePerGas) > 0n && BigInt(op.maxFeePerGas) <= 500000000n
    && BigInt(op.maxPriorityFeePerGas) === BigInt(op.maxFeePerGas) && maxCost(op) <= parseEther('0.5')
    && result.maxChargeDoge === formatEther(maxCost(op)), 'Unexpected gas budget.');
  ensure(hashOf(op) === result.userOpHash, 'UserOperation hash does not match.');
}
export async function verifyReceipt(op: Operation) {
  ensure(op.transactionHash, 'No transaction receipt yet.');
  ensure(hashOf(op.userOperation) === op.userOpHash && same(op.counter, manifest.counter), 'Operation details changed.');
  const receipt = await rpc.getTransactionReceipt({ hash: op.transactionHash });
  ensure(receipt.status === 'success' && same(receipt.to, manifest.entryPoint), 'Bundle was not successful.');
  const events = parseEventLogs({ abi: entry, logs: receipt.logs, eventName: 'UserOperationEvent' }).filter(event => same(event.address, manifest.entryPoint) && event.args.userOpHash === op.userOpHash);
  const event = events[0]?.args;
  ensure(events.length === 1 && event.success && same(event.sender, op.account) && same(event.paymaster, zeroAddress) && event.nonce === BigInt(op.userOperation.nonce), 'Account operation was not successful.');
  ensure(op.userChargeDoge === formatEther(event.actualGasCost) && event.actualGasCost <= maxCost(op.userOperation), 'Account gas charge does not match.');
  const counts = parseEventLogs({ abi: counter, logs: receipt.logs, eventName: 'Incremented' }).filter(event => same(event.address, manifest.counter) && same(event.args.account, op.account));
  ensure(counts.length === 1 && counts[0].args.count > BigInt(op.counterBefore), 'Counter did not increase.');
  ensure(await rpc.readContract({ address: manifest.counter as Address, abi: counter, functionName: 'counts', args: [op.account] }) >= counts[0].args.count, 'Counter state disagrees.');
  ensure(await rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n >= 18n, 'Waiting for 18 confirmations.');
  return counts[0].args.count.toString();
}
export async function api(path: string, body?: unknown): Promise<Operation> {
  const response = await fetch(`/api/aa/${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Account abstraction is unavailable.');
  return result;
}
