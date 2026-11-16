import { constants, zstdCompressSync } from 'node:zlib';
import { concat, encodeFunctionData, keccak256, serializeTransaction, toHex } from 'viem';
import { executionGas, packOperation } from './user-operation.mjs';

// Distinct, incompressible placeholders approximate both signatures. Repeated
// ff/00 bytes compress unrealistically well and would underquote Galileo fees.
const word = label => keccak256(toHex(label));
const ownerSignature = concat([word('aa owner r'), word('aa owner s'), '0x1b']);
const transactionSignature = { r: word('aa executor r'), s: word('aa executor s'), yParity: 1 };
export function bundleEnvelope(op, manifest, entryAbi, executor, nonce) {
  const data = encodeFunctionData({ abi: entryAbi, functionName: 'handleOps',
    args: [[packOperation({ ...op, signature: ownerSignature })], executor] });
  return serializeTransaction({ type: 'eip1559', chainId: manifest.chainId, nonce,
    to: manifest.entryPoint, data, value: 0n, gas: executionGas(op) + 100_000n,
    maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
  }, transactionSignature);
}
export function oraclePayload(envelope, galileo) {
  if (!galileo) return envelope;
  // Galileo's oracle expects zstd-compressed, signed RLP (not raw calldata).
  // https://github.com/DogeOS69/scroll-contracts/blob/main/src/L2/predeploys/L1GasPriceOracle.sol
  const bytes = zstdCompressSync(Buffer.from(envelope.slice(2), 'hex'), {
    params: { [constants.ZSTD_c_compressionLevel]: 3 },
  });
  return `0x${bytes.toString('hex')}`;
}
