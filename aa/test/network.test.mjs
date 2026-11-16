import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNetwork, genesisHash } from '../lib/chain.mjs';

test('equal chain IDs cannot hide a switch between Chikyū and devnet', async () => {
  const client = { getChainId: async () => 6281971,
    getBlock: async () => ({ hash: '0x4d6ef3d0349760195375877b4b3d9c0a5107c6df559e075b67e95d48962be868' }) };
  await assert.rejects(assertNetwork(client, { chainId: 6281971, genesisHash }), /genesis/);
  await assert.rejects(assertNetwork(client, { chainId: 6281971 }), /genesis/);
  await assertNetwork({ ...client, getBlock: async () => ({ hash: genesisHash }) }, { chainId: 6281971, genesisHash });
});
