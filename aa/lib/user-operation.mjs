import { concat, encodeFunctionData, formatEther, getAddress, isAddress,
  numberToHex, recoverMessageAddress, zeroAddress } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import { accountAbi, counterAbi, accountSalt, factoryAbi, same } from './chain.mjs';

export const limits = Object.freeze({ maxGas: 1_500_000n, maxFeePerGas: 500_000_000n,
  maxCost: 500_000_000_000_000_000n, preparationSeconds: 300, maxPreparations: 5000 });
export const stubSignature = '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';
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
export function executionGas(op) { return BigInt(op.verificationGasLimit) + BigInt(op.callGasLimit); }
export function maxCost(op) { return (executionGas(op) + BigInt(op.preVerificationGas)) * BigInt(op.maxFeePerGas); }
export function requireSelfPayment(op) {
  if (Object.keys(op).some(k => k.startsWith('paymaster')) || op.eip7702Auth)
    throw new ApiError(400, 'This demo requires a self-funded SimpleAccount.');
}
export function packOperation(op) {
  requireSelfPayment(op);
  return {
    sender: op.sender, nonce: BigInt(op.nonce),
    initCode: op.factory ? concat([op.factory, op.factoryData]) : '0x', callData: op.callData,
    accountGasLimits: concat([numberToHex(BigInt(op.verificationGasLimit), { size: 16 }), numberToHex(BigInt(op.callGasLimit), { size: 16 })]),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: concat([numberToHex(BigInt(op.maxPriorityFeePerGas), { size: 16 }), numberToHex(BigInt(op.maxFeePerGas), { size: 16 })]),
    paymasterAndData: '0x', signature: op.signature ?? '0x',
  };
}
export function operationHash(op, manifest) {
  requireSelfPayment(op);
  const value = { ...op };
  for (const field of ['nonce', 'verificationGasLimit', 'callGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas']) value[field] = BigInt(value[field]);
  if (!value.factory) { delete value.factory; delete value.factoryData; }
  return getUserOperationHash({ chainId: manifest.chainId, entryPointAddress: manifest.entryPoint,
    entryPointVersion: '0.7', userOperation: value });
}
export function checkIntent(op, owner, manifest) {
  requireSelfPayment(op);
  if (op.callData !== incrementCall(manifest.counter)) throw new ApiError(400, 'The counter action changed.');
  if (op.factory ? !same(op.factory, manifest.accountFactory) || op.factoryData !== factoryCall(owner) : !!op.factoryData)
    throw new ApiError(400, 'The smart-account owner or factory changed.');
  if (executionGas(op) > limits.maxGas || BigInt(op.preVerificationGas) < 0n
    || BigInt(op.maxFeePerGas) <= 0n || BigInt(op.maxFeePerGas) > limits.maxFeePerGas
    || BigInt(op.maxPriorityFeePerGas) !== BigInt(op.maxFeePerGas) || maxCost(op) > limits.maxCost)
    throw new ApiError(400, 'Gas budget exceeded.');
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
    'userOpHash', 'expiresAt', 'transactionHash', 'blockNumber', 'networkFeeDoge',
    'userChargeDoge', 'l1DataFeeDoge', 'feeCovered', 'failure', 'confirmations', 'requiredConfirmations'];
  return { ...Object.fromEntries(fields.filter(k => value[k] !== undefined).map(k => [k, value[k]])),
    maxChargeDoge: formatEther(maxCost(value.userOperation)),
    userOperation: { ...value.userOperation, signature: '0x' } };
}
