import { concat, createPublicClient, decodeAbiParameters, encodeAbiParameters, encodeFunctionData,
  http, keccak256, numberToHex, parseAbi, parseEventLogs, recoverMessageAddress, type Address, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import deployment from './deployment.json';
import { dogeosChain } from '../chain';
export const manifest = deployment;
export type Operation = { id: string; status: string; chainId: number; owner: Address; account: Address;
  counter: Address; paymaster: Address; counterBefore: string; counterAfter?: string; userOpHash: Hex;
  expiresAt: string; transactionHash?: Hex; confirmations: number; requiredConfirmations: number;
  networkFeeDoge?: string; paymasterChargeDoge?: string; l1DataFeeDoge?: string; failure?: string;
  userOperation: Record<string, Hex> };
export const rpc = createPublicClient({ chain: dogeosChain, transport: http(manifest.rpcUrl) });
const factory = parseAbi(['function getAddress(address,uint256) view returns (address)', 'function createAccount(address,uint256) returns (address)']);
const account = parseAbi(['function execute(address,uint256,bytes)', 'function owner() view returns (address)', 'function entryPoint() view returns (address)']);
const counter = parseAbi(['function increment()', 'function counts(address) view returns (uint256)', 'event Incremented(address indexed account,uint256 count)']);
const entry = parseAbi(['function getNonce(address,uint192) view returns (uint256)', 'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
const quoteType = { type: 'tuple', components: [{ name: 'validUntil', type: 'uint48' }, { name: 'maxCost', type: 'uint128' }, { name: 'maxFeePerGas', type: 'uint128' }, { name: 'maxGas', type: 'uint128' }] } as const;
export const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
export function hashOf(op: Operation['userOperation']) {
  const value: Record<string, unknown> = { ...op };
  for (const key of ['nonce','verificationGasLimit','callGasLimit','preVerificationGas','maxFeePerGas','maxPriorityFeePerGas','paymasterVerificationGasLimit','paymasterPostOpGasLimit']) value[key] = BigInt(op[key]);
  return getUserOperationHash({ chainId: manifest.chainId, entryPointAddress: manifest.entryPoint as Address,
    entryPointVersion: '0.7', userOperation: value as never });
}
export async function verifyIntent(result: Operation, owner: Address) {
  const op = result.userOperation;
  ensure(result.chainId === 6281971 && await rpc.getChainId() === 6281971 && same(result.owner, owner), 'Wallet or network changed.');
  ensure(same(result.counter, manifest.counter) && same(result.paymaster, manifest.paymaster) && same(op.paymaster, manifest.paymaster), 'Sponsor configuration changed.');
  ensure(op.callData === encodeFunctionData({ abi: account, functionName: 'execute', args: [manifest.counter as Address, 0n, encodeFunctionData({ abi: counter, functionName: 'increment' })] }), 'Unexpected sponsored action.');
  const canonical = await rpc.readContract({ address: manifest.accountFactory as Address, abi: factory, functionName: 'getAddress', args: [owner, BigInt(manifest.accountSalt)] });
  ensure(same(op.sender, canonical) && same(result.account, canonical), 'Unexpected smart account.');
  const code = await rpc.getCode({ address: canonical });
  if (!code || code === '0x') {
    ensure(same(op.factory, manifest.accountFactory) && op.factoryData === encodeFunctionData({ abi: factory, functionName: 'createAccount', args: [owner, BigInt(manifest.accountSalt)] }), 'Unexpected account deployment.');
  } else {
    ensure(!op.factory, 'Account is already deployed. Prepare again.');
    const [storedOwner, ep, implementation] = await Promise.all([
      rpc.readContract({ address: canonical, abi: account, functionName: 'owner' }),
      rpc.readContract({ address: canonical, abi: account, functionName: 'entryPoint' }),
      rpc.getStorageAt({ address: canonical, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }),
    ]);
    ensure(same(storedOwner, owner) && same(ep, manifest.entryPoint) && same(`0x${implementation?.slice(-40)}`, manifest.accountImplementation), 'Unsupported account implementation.');
  }
  for (const contract of Object.values(manifest.contracts)) ensure(keccak256((await rpc.getCode({ address: contract.address as Address })) ?? '0x') === contract.runtimeCodeHash, 'A deployed contract changed.');
  ensure(await rpc.readContract({ address: manifest.entryPoint as Address, abi: entry, functionName: 'getNonce', args: [canonical, 0n] }) === BigInt(op.nonce), 'Account nonce changed. Prepare again.');
  const [quote, signature] = decodeAbiParameters([quoteType, { type: 'bytes' }], op.paymasterData);
  const block = await rpc.getBlock();
  ensure(quote.validUntil > Number(block.timestamp) + 15 && quote.validUntil <= Number(block.timestamp) + 310, 'Sponsorship quote expired.');
  const gas = ['verificationGasLimit','callGasLimit','preVerificationGas','paymasterVerificationGasLimit'].reduce((sum,key) => sum + BigInt(op[key]), 0n);
  ensure(gas <= quote.maxGas && quote.maxGas <= 1500000n && BigInt(op.maxFeePerGas) <= quote.maxFeePerGas && quote.maxFeePerGas <= 500000000n
    && quote.maxCost <= 2000000000000000n && BigInt(op.paymasterPostOpGasLimit) === 0n
    && BigInt(op.maxPriorityFeePerGas) <= BigInt(op.maxFeePerGas), 'Unexpected gas budget.');
  const digest = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, quoteType],
    [BigInt(manifest.chainId), manifest.entryPoint as Address, manifest.paymaster as Address, op.sender, BigInt(op.nonce), keccak256(op.factory ? concat([op.factory, op.factoryData]) : '0x'), keccak256(op.callData), quote]));
  ensure(same(await recoverMessageAddress({ message: { raw: digest }, signature }), manifest.quoteSigner), 'Invalid sponsorship signature.');
  ensure(hashOf(op) === result.userOpHash, 'UserOperation hash does not match.');
}
export async function verifyReceipt(op: Operation) {
  ensure(op.transactionHash, 'No transaction receipt yet.');
  ensure(hashOf(op.userOperation) === op.userOpHash && same(op.paymaster, manifest.paymaster) && same(op.counter, manifest.counter), 'Operation details changed.');
  const receipt = await rpc.getTransactionReceipt({ hash: op.transactionHash });
  ensure(receipt.status === 'success' && same(receipt.to, manifest.entryPoint), 'Bundle was not successful.');
  const events = parseEventLogs({ abi: entry, logs: receipt.logs, eventName: 'UserOperationEvent' }).filter(event => same(event.address, manifest.entryPoint) && event.args.userOpHash === op.userOpHash);
  const event = events[0]?.args;
  ensure(events.length === 1 && event.success && same(event.sender, op.account) && same(event.paymaster, manifest.paymaster) && event.nonce === BigInt(op.userOperation.nonce), 'Sponsored operation was not successful.');
  const counts = parseEventLogs({ abi: counter, logs: receipt.logs, eventName: 'Incremented' }).filter(event => same(event.address, manifest.counter) && same(event.args.account, op.account));
  ensure(counts.length === 1 && counts[0].args.count > BigInt(op.counterBefore), 'Counter did not increase.');
  ensure(await rpc.readContract({ address: manifest.counter as Address, abi: counter, functionName: 'counts', args: [op.account] }) >= counts[0].args.count, 'Counter state disagrees.');
  ensure(await rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n >= 18n, 'Waiting for 18 confirmations.');
  return counts[0].args.count.toString();
}
export async function api(path: string, body?: unknown): Promise<Operation> {
  const response = await fetch(`/api/sponsorship/${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Sponsorship is unavailable.');
  return result;
}
