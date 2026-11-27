import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Executor } from '../node_modules/@pimlico/alto/esm/executor/executor.js';

test('data-fee reimbursement does not become an L2 priority fee, including retries', () => {
  const executor = new Executor({ config: { getLogger: () => ({}), skipLocalGasCalculations: true } });
  const networkGasPrice = { maxFeePerGas: 100n, maxPriorityFeePerGas: 2n };
  for (const submissionAttempts of [0, 1, 3]) {
    assert.deepEqual(executor.getBundleGasPrice({ bundle: { submissionAttempts }, networkGasPrice,
      networkBaseFee: 10n, totalBeneficiaryFees: 100_000_000_000_000_000n, bundleGasUsed: 200_000n }), networkGasPrice);
  }
});
