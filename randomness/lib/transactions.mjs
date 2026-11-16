import { encodeFunctionData, formatEther, parseEther } from 'viem';
import { oracle, waitSuccess } from './chain.mjs';

export async function estimateTotal(publicClient, account, { to, data, value = 0n }, { local = false } = {}) {
  const gasPrice = await publicClient.getGasPrice();
  const estimated = await publicClient.estimateGas({ account, to, data, value, gasPrice });
  const gas = estimated * 130n / 100n + 10_000n;
  // Calldata plus a conservative all-nonzero envelope/signature allowance.
  const l1Fee = local ? 0n : await publicClient.readContract({ ...oracle, functionName: 'getL1Fee', args: [`${data}${'ff'.repeat(160)}`] });
  return { gas, gasPrice, l1Fee, upperCost: gas * gasPrice + l1Fee + value };
}

export async function sendContract({ publicClient, walletClient, account, contract, functionName, args, value = 0n, maxCost = process.env.MAX_TX_COST_DOGE || '0.2', local = false, onSubmitted }) {
  const data = encodeFunctionData({ abi: contract.abi, functionName, args });
  const tx = { to: contract.address, data, value };
  await publicClient.call({ ...tx, account });
  const estimate = await estimateTotal(publicClient, account, tx, { local });
  if (estimate.upperCost > parseEther(maxCost)) throw new Error(`Estimated cost ${formatEther(estimate.upperCost)} DOGE exceeds ${maxCost} DOGE cap`);
  const hash = await walletClient.sendTransaction({ ...tx, gas: estimate.gas, gasPrice: estimate.gasPrice });
  onSubmitted?.(hash);
  const receipt = await waitSuccess(publicClient, hash);
  return { hash, receipt, estimate };
}
