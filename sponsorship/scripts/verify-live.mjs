import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { resolve } from 'node:path';
import { readJson, reader, saveJson, root } from '../lib/chain.mjs';
import { operationHash } from '../lib/user-operation.mjs';
const keyPath = process.env.TEST_KEY_FILE;
assert(keyPath, 'Set TEST_KEY_FILE outside the repository');
let saved = await readJson(keyPath, null);
if (!saved) { saved = { privateKey: generatePrivateKey() }; await saveJson(keyPath, saved); }
const owner = privateKeyToAccount(saved.privateKey);
const client = reader(); const manifest = await readJson(resolve(root, 'config/chikyu.json'));
const base = process.env.SPONSOR_API_URL ?? 'http://127.0.0.1:4341';
async function api(path, input) {
  const r = await fetch(`${base}/${path}`, { method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(60000) });
  const result = await r.json(); assert(r.ok, result.error); return result;
}
const ownerBefore = await client.getBalance({ address: owner.address }); assert.equal(ownerBefore, 0n);
const prepared = await api('prepare', { owner: owner.address });
assert.equal(prepared.userOpHash, operationHash(prepared.userOperation, manifest));
const accountBefore = await client.getBalance({ address: prepared.account }); assert.equal(accountBefore, 0n);
console.log(JSON.stringify({ owner: owner.address, account: prepared.account, id: prepared.id, userOpHash: prepared.userOpHash }));
const signature = await owner.signMessage({ message: { raw: prepared.userOpHash } });
let op = await api('submit', { id: prepared.id, signature });
for (let i = 0; i < 120 && !['confirmed','failed','expired'].includes(op.status); i++) {
  await new Promise(resolve => setTimeout(resolve, 3000)); op = await api(`operations/${op.id}`);
  if (i % 10 === 0) console.log(`Status: ${op.status}; confirmations: ${op.confirmations}`);
}
assert.equal(op.status, 'confirmed');
const [ownerAfter, accountAfter] = await Promise.all([client.getBalance({ address: owner.address }), client.getBalance({ address: op.account })]);
assert.equal(ownerAfter, 0n); assert.equal(accountAfter, 0n);
assert.equal((await api('submit', { id: op.id, signature })).transactionHash, op.transactionHash);
await saveJson(resolve(root, 'test/results/chikyu.json'), { ...op, verifiedAt: new Date().toISOString(), ownerBefore: String(ownerBefore), ownerAfter: String(ownerAfter), accountBefore: String(accountBefore), accountAfter: String(accountAfter), replayReturnedSameTransaction: true });
console.log(`PASS: ${op.transactionHash}; total network fee ${op.networkFeeDoge} DOGE; user cost 0 DOGE`);
