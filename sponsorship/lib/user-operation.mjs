import { concat, decodeAbiParameters, encodeAbiParameters, encodeFunctionData,
  getAddress, isAddress, keccak256, numberToHex, recoverMessageAddress, slice, zeroAddress } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { accountAbi, counterAbi, accountSalt, factoryAbi, same } from './chain.mjs';

export const limits = Object.freeze({ maxGas: 1_500_000n, maxFeePerGas: 500_000_000n,
  maxCost: 2_000_000_000_000_000n, quoteSeconds: 300,
  maxNetworkFee: 500_000_000_000_000_000n, totalNetworkBudget: 3_000_000_000_000_000_000n,
  maxPreparations: 500, maxOperations: 50, perAccount: 3 });
export const stubSignature = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';
export const quoteType = { type: 'tuple', components: [
  { name: 'validUntil', type: 'uint48' }, { name: 'maxCost', type: 'uint128' },
  { name: 'maxFeePerGas', type: 'uint128' }, { name: 'maxGas', type: 'uint128' },
] };
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function ownerAddress(value) {
  if (!isAddress(value ?? '', { strict: false }) || same(value, zeroAddress)) throw new ApiError(400, 'Invalid wallet address.');
  return getAddress(value);
}
export function incrementCall(counter) {
  return encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [counter, 0n,
    encodeFunctionData({ abi: counterAbi, functionName: 'increment' })] });
}
export function factoryCall(owner) {
  return encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owner, accountSalt] });
}
export function packOperation(op) {
  return {
    sender: op.sender, nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData]) : '0x', callData: op.callData,
    accountGasLimits: concat([numberToHex(BigInt(op.verificationGasLimit), { size: 16 }), numberToHex(BigInt(op.callGasLimit), { size: 16 })]),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: concat([numberToHex(BigInt(op.maxPriorityFeePerGas), { size: 16 }), numberToHex(BigInt(op.maxFeePerGas), { size: 16 })]),
    paymasterAndData: concat([op.paymaster,
      numberToHex(BigInt(op.paymasterVerificationGasLimit), { size: 16 }),
      numberToHex(BigInt(op.paymasterPostOpGasLimit), { size: 16 }), op.paymasterData]),
    signature: op.signature ?? '0x',
  };
}
export function quoteHash(op, quote, manifest) {
  const packed = packOperation(op);
  return keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
    { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, quoteType,
  ], [BigInt(manifest.chainId), manifest.entryPoint, manifest.paymaster, op.sender,
    packed.nonce, keccak256(packed.initCode), keccak256(op.callData), quote]));
}
export function encodeQuote(quote, signature) {
  return encodeAbiParameters([quoteType, { type: 'bytes' }], [quote, signature]);
}
export function parseQuote(data) {
  const [quote, signature] = decodeAbiParameters([quoteType, { type: 'bytes' }], data);
  return { quote, signature };
}
export function operationHash(op, manifest) {
  const value = { ...op };
  for (const field of ['nonce', 'verificationGasLimit', 'callGasLimit', 'preVerificationGas',
    'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit']) {
    value[field] = BigInt(value[field]);
  }
  if (!value.factory) { delete value.factory; delete value.factoryData; }
  return getUserOperationHash({ chainId: manifest.chainId, entryPointAddress: manifest.entryPoint,
    entryPointVersion: '0.7', userOperation: value });
}
export function checkIntent(op, owner, manifest) {
  if (!same(op.paymaster, manifest.paymaster) || op.callData !== incrementCall(manifest.counter))
    throw new ApiError(400, 'The sponsored action changed.');
  if (op.factory && (!same(op.factory, manifest.accountFactory) || op.factoryData !== factoryCall(owner)))
    throw new ApiError(400, 'The smart-account owner or factory changed.');
  if (BigInt(op.paymasterPostOpGasLimit) !== 0n) throw new ApiError(400, 'Unexpected post-operation charge.');
  const { quote } = parseQuote(op.paymasterData);
  const gas = ['verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit']
    .reduce((total, field) => total + BigInt(op[field]), 0n);
  if (gas > limits.maxGas || gas > quote.maxGas || quote.maxGas > limits.maxGas
    || BigInt(op.maxFeePerGas) <= 0n || BigInt(op.maxFeePerGas) > quote.maxFeePerGas
    || quote.maxFeePerGas > limits.maxFeePerGas || quote.maxCost > limits.maxCost
    || BigInt(op.maxPriorityFeePerGas) > BigInt(op.maxFeePerGas)) throw new ApiError(400, 'Gas budget exceeded.');
  return quote;
}
export async function verifyOwner(hash, signature, owner) {
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(signature)) throw new ApiError(400, 'Invalid wallet signature.');
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130), 16);
  if (s > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n || ![27, 28].includes(v))
    throw new ApiError(400, 'Noncanonical wallet signature.');
  const signer = await recoverMessageAddress({ message: { raw: hash }, signature }).catch(() => null);
  if (!same(signer, owner)) throw new ApiError(400, 'The connected wallet did not sign this operation.');
}
export function publicOperation(value) {
  const fields = ['id', 'status', 'chainId', 'owner', 'account', 'counter', 'counterBefore', 'counterAfter',
    'userOpHash', 'expiresAt', 'transactionHash', 'blockNumber', 'paymaster', 'networkFeeDoge',
    'paymasterChargeDoge', 'userChargeDoge', 'l1DataFeeDoge', 'failure', 'confirmations', 'requiredConfirmations'];
  return { ...Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]])),
    userOperation: { ...value.userOperation, signature: '0x' } };
}
