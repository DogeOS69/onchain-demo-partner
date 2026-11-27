import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifact, readJson } from '../lib/chain.mjs';
import { bundleEnvelope, oraclePayload } from '../lib/data-fee.mjs';

test('Galileo compressed-envelope quotes cover a real receipt without the old multi-fold overcharge', async () => {
  const f = await readJson(new URL('./fixtures/chikyu-galileo.json', import.meta.url));
  const p = Object.fromEntries(Object.entries(f.parameters).map(([k,v]) => [k, BigInt(v)]));
  // Onchain L1GasPriceOracle._getL1FeeGalileo formula, at the recorded block.
  const oracle = data => {
    const size = BigInt((data.length - 2) / 2);
    const base = (p.commitScalar * p.l1BaseFee + p.blobScalar * p.l1BlobBaseFee) * size;
    return (base + base * size / p.penaltyFactor) / 1_000_000_000n;
  };
  const actual = BigInt(f.receiptL1Fee);
  const compressed = oracle(oraclePayload(f.serializedTransaction, true));
  assert(compressed >= actual * 98n / 100n && compressed <= actual * 102n / 100n);
  assert(oracle(f.serializedTransaction) > actual * 2n, 'The fixture captures the uncompressed estimation error.');
  const entry = await artifact('EntryPoint');
  const preview = bundleEnvelope(f.operation, f, entry.abi, f.executor, f.executorNonce);
  const quote = oracle(oraclePayload(preview, true)) * 125n / 100n;
  assert(quote >= actual, 'Signature placeholders and margin must cover the receipt.');
  assert(quote <= actual * 150n / 100n, 'The preview must not charge an uncompressed envelope.');
});
