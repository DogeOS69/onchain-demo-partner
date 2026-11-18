import { encodeFunctionData, formatEther, parseEther, serializeTransaction, keccak256, toHex } from 'viem';
import { constants, zstdCompressSync } from 'node:zlib';
import { oracle, waitSuccess } from './chain.mjs';

// Incompressible signature placeholders; Galileo charges compressed signed RLP.
const signature = { r: keccak256(toHex('randomness r')), s: keccak256(toHex('randomness s')), yParity: 1 };
export async function estimateTotal(publicClient, account, { to, data, value = 0n }, { local = false, gasPrice: quotedGasPrice } = {}) {
  const gasPrice = quotedGasPrice ?? await publicClient.getGasPrice();
  const estimated = await publicClient.estimateGas({ account, to, data, value, gasPrice });
  const gas = estimated * 130n / 100n + 10_000n;
  let l1Fee = 0n;
  if (!local) {
    const [nonce, chainId, galileo] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }), publicClient.getChainId(),
      publicClient.readContract({ ...oracle, functionName: 'isGalileo' }),
    ]);
    const envelope = serializeTransaction({ type: 'eip1559', chainId, nonce, to, data, value, gas,
      maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }, signature);
    const payload = galileo ? `0x${zstdCompressSync(Buffer.from(envelope.slice(2), 'hex'), {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    }).toString('hex')}` : envelope;
    l1Fee = await publicClient.readContract({ ...oracle, functionName: 'getL1Fee', args: [payload] }) * 125n / 100n;
  }
  return { gas, gasPrice, l1Fee, upperCost: gas * gasPrice + l1Fee + value };
}

export async function sendContract({ publicClient, walletClient, account, contract, functionName, args, value = 0n, maxCost = process.env.MAX_TX_COST_DOGE || '0.2', local = false, onSubmitted, gasPrice, estimate: preparedEstimate }) {
  const data = encodeFunctionData({ abi: contract.abi, functionName, args });
  const tx = { to: contract.address, data, value };
  const estimate = preparedEstimate ?? await estimateTotal(publicClient, account, tx, { local, gasPrice });
  await publicClient.call({ ...tx, account, gasPrice: estimate.gasPrice });
  if (estimate.upperCost > parseEther(maxCost)) throw new Error(`Estimated cost ${formatEther(estimate.upperCost)} DOGE exceeds ${maxCost} DOGE cap`);
  const hash = await walletClient.sendTransaction({ ...tx, gas: estimate.gas,
    maxFeePerGas: estimate.gasPrice, maxPriorityFeePerGas: estimate.gasPrice, type: 'eip1559' });
  onSubmitted?.(hash);
  const receipt = await waitSuccess(publicClient, hash);
  const raw = await publicClient.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  const networkCost = receipt.gasUsed * receipt.effectiveGasPrice + BigInt(raw.l1Fee ?? 0);
  return { hash, receipt, estimate, networkCost };
}
