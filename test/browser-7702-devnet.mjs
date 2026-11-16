import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, formatEther, http, parseEther, parseEventLogs, zeroAddress } from '../aa/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../aa/node_modules/viem/_esm/accounts/index.js';
import { entryPoint09Abi } from '../aa/node_modules/viem/_esm/account-abstraction/index.js';
import { counterAbi, readJson, saveJson } from '../aa/lib/chain.mjs';

// This test spends only an explicitly supplied, disposable devnet account's DOGE.
// Funding is separate; no faucet, Anvil RPC or deployment key is used here.
assert(process.env.WEB_URL && process.env.TEST_KEY_FILE, 'Set WEB_URL and TEST_KEY_FILE');
const base = new URL(process.env.WEB_URL).origin;
assert.equal(new URL(base).protocol, 'https:');
const manifest = await fetch(base + '/api/aa/config').then(async r => { assert(r.ok); return r.json(); });
assert.equal(manifest.chainId, 6281971);
assert.equal(manifest.genesisHash, '0x4d6ef3d0349760195375877b4b3d9c0a5107c6df559e075b67e95d48962be868');
assert.equal(manifest.rpcUrl, 'https://rpc.devnet.doge.xyz');
assert.equal(manifest.entryPointVersion, '0.9');
assert.equal(manifest.accountMode, 'eip7702');
const client = createPublicClient({ transport: http(manifest.rpcUrl) });
assert.equal(await client.getChainId(), manifest.chainId);
assert.equal((await client.getBlock({ blockNumber: 0n })).hash, manifest.genesisHash);
const keys = JSON.parse(await readFile(process.env.TEST_KEY_FILE, 'utf8'));
const secret = keys.browserPrivateKey ?? keys.privateKey;
const address = privateKeyToAccount(secret).address;
const prefix = 'dogeos-7702:' + manifest.genesisHash + ':';
const stateFile = 'aa/.runtime/browser-7702-devnet.private.json';
const balance = await client.getBalance({ address });
assert(balance > parseEther('0.05') && balance <= parseEther('2'), 'Fund the disposable account with about 1 devnet DOGE');
const available = async () => (await client.getBalance({ address })) + await client.readContract({
  address: manifest.entryPoint, abi: entryPoint09Abi, functionName: 'balanceOf', args: [address],
});
const state = await readJson(stateFile, { base, address, genesisHash: manifest.genesisHash,
  availableBefore: String(await available()),
  counterBefore: String(await client.readContract({ address: manifest.counter, abi: counterAbi, functionName: 'counts', args: [address] })),
  storage: { [prefix + 'key']: secret } });
assert.equal(state.base, base); assert.equal(state.address, address); assert.equal(state.genesisHash, manifest.genesisHash);
await saveJson(stateFile, state);
const target = String(BigInt(state.counterBefore) + 1n);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.setDefaultTimeout(90_000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(({ origin, storage }) => {
  if (location.origin === origin) for (const [key, value] of Object.entries(storage))
    if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
}, { origin: base, storage: state.storage });
async function checkpoint() {
  state.storage = await page.evaluate(prefix => Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith(prefix))), prefix);
  await saveJson(stateFile, state);
}
try {
  await page.goto(base + '/aa');
  await page.getByTestId('account-address').waitFor();
  assert.equal((await page.getByTestId('account-address').innerText()).toLowerCase(), address.toLowerCase());
  let activation = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), prefix + 'activation:' + address);
  if (!activation) {
    assert.equal((await client.getCode({ address })) ?? '0x', '0x', 'Use a fresh account or restore the saved activation checkpoint');
    assert.equal(await page.getByRole('button', { name: 'Increment with AA', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Activate 7702', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm 7702 activation' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Activate 7702', exact: true }).waitFor();
    assert.equal((await client.getCode({ address })) ?? '0x', '0x');
    state.previewCancellation = 'passed'; await checkpoint();
    await page.getByRole('button', { name: 'Activate 7702', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm 7702 activation' }).click();
    await page.waitForFunction(key => sessionStorage.getItem(key) !== null, prefix + 'activation:' + address);
    await checkpoint();
    await page.reload();
    activation = JSON.parse(state.storage[prefix + 'activation:' + address]);
  }
  await page.getByRole('button', { name: '7702 activated', exact: true }).waitFor({ timeout: 180_000 });
  state.activationReload = 'passed'; await checkpoint();
  assert.equal((await client.getCode({ address })).toLowerCase(), ('0xef0100' + manifest.delegate.slice(2)).toLowerCase());
  const activationReceipt = await client.getTransactionReceipt({ hash: activation.hash });
  assert.equal(activationReceipt.type, 'eip7702'); assert.equal(activationReceipt.status, 'success');
  assert.equal(activationReceipt.from.toLowerCase(), address.toLowerCase());
  assert.equal(activationReceipt.to.toLowerCase(), address.toLowerCase());
  let prepared = JSON.parse(state.storage[prefix + 'operation:' + address] ?? 'null');
  if (!prepared) {
    await page.getByRole('button', { name: 'Increment with AA', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm increment with AA', exact: true }).waitFor();
    await checkpoint();
    prepared = JSON.parse(state.storage[prefix + 'operation:' + address]);
    await page.reload();
  }
  const current = await fetch(base + '/api/aa/operations/' + prepared.id).then(r => r.json());
  if (current.status === 'prepared')
    await page.getByRole('button', { name: 'Confirm increment with AA', exact: true }).click();
  else assert(['submitted', 'included', 'confirmed'].includes(current.status), 'Inspect the existing operation before signing another');
  await page.waitForFunction(target => document.querySelector('.result-value')?.textContent === target, target, { timeout: 180_000 });
  await checkpoint(); await page.reload();
  await page.waitForFunction(target => document.querySelector('.result-value')?.textContent === target, target, { timeout: 180_000 });
  state.operationReload = 'passed'; await checkpoint();
  const op = await fetch(base + '/api/aa/operations/' + prepared.id).then(r => r.json());
  assert.equal(op.status, 'confirmed'); assert.equal(op.owner, op.account); assert.equal(op.counterAfter, target);
  const receipt = await client.getTransactionReceipt({ hash: op.transactionHash });
  const [event] = parseEventLogs({ abi: entryPoint09Abi, logs: receipt.logs, eventName: 'UserOperationEvent' });
  assert.equal(event.args.paymaster, zeroAddress); assert.equal(event.args.success, true);
  assert.equal(event.args.sender.toLowerCase(), address.toLowerCase());
  assert.equal(event.args.userOpHash, op.userOpHash);
  assert.equal(event.args.actualGasCost, parseEther(op.userChargeDoge));
  const rawReceipt = await client.request({ method: 'eth_getTransactionReceipt', params: [op.transactionHash] });
  const rawActivation = await client.request({ method: 'eth_getTransactionReceipt', params: [activation.hash] });
  const networkFee = receipt.gasUsed * receipt.effectiveGasPrice + BigInt(rawReceipt.l1Fee);
  const activationFee = activationReceipt.gasUsed * activationReceipt.effectiveGasPrice + BigInt(rawActivation.l1Fee);
  assert(event.args.actualGasCost >= networkFee, 'Account must cover bundler execution and data fees');
  assert(event.args.actualGasCost <= networkFee * 150n / 100n, 'Unexpected reimbursement overhead');
  assert.equal(BigInt(state.availableBefore) - await available(), activationFee + event.args.actualGasCost);
  assert.equal(await client.readContract({ address: manifest.counter, abi: counterAbi, functionName: 'counts', args: [address] }), BigInt(target));
  const head = await client.getBlockNumber({ cacheTime: 0 });
  assert(head - receipt.blockNumber + 1n >= BigInt(manifest.requiredConfirmations));
  assert.deepEqual(errors, []);
  await mkdir('test/results', { recursive: true });
  await page.screenshot({ path: 'test/results/7702-devnet.png', fullPage: true });
  const proof = { network: 'DogeOS devnet', url: base + '/aa', chainId: manifest.chainId, genesisHash: manifest.genesisHash,
    validatedAt: new Date().toISOString(), address, delegate: manifest.delegate, counterAddress: manifest.counter,
    entryPoint: manifest.entryPoint, entryPointVersion: manifest.entryPointVersion,
    activationTransaction: activation.hash, activationFeeDoge: formatEther(activationFee),
    counterTransaction: op.transactionHash, userOpHash: op.userOpHash, counterBefore: state.counterBefore, counterAfter: target,
    userChargeDoge: op.userChargeDoge, networkFeeDoge: formatEther(networkFee), paymaster: event.args.paymaster,
    requiredConfirmations: manifest.requiredConfirmations, previewCancellation: state.previewCancellation,
    activationReload: state.activationReload, operationReload: state.operationReload, pageErrors: errors };
  await writeFile('test/results/7702-devnet.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} catch (error) {
  const alerts = await page.getByRole('alert').allTextContents().catch(() => []);
  console.error('Browser alerts:', alerts.map(s => s.replace(/0x[0-9a-f]{64,}/gi, '[redacted]').slice(0, 500)));
  await mkdir('test/results', { recursive: true });
  await page.screenshot({ path: 'test/results/7702-devnet-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await checkpoint().catch(() => {});
  await browser.close();
}
