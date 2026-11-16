import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, http, parseEther, parseEventLogs, zeroAddress } from '../aa/node_modules/viem/_esm/index.js';
import { counterAbi } from '../aa/lib/chain.mjs';
import { entryPoint09Abi } from '../aa/node_modules/viem/_esm/account-abstraction/index.js';

const base = process.env.WEB_URL ?? 'http://127.0.0.1:5191';
const configResponse = await fetch(base + '/api/aa/config');
assert(configResponse.ok);
const manifest = await configResponse.json();
assert.equal(manifest.chainId, 31337, 'This browser test funds only an isolated Anvil chain');
assert.equal(new URL(manifest.rpcUrl).hostname, '127.0.0.1');
const client = createPublicClient({ transport: http(manifest.rpcUrl) });
assert.equal((await client.getBlock({ blockNumber: 0n })).hash, manifest.genesisHash);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(base + '/aa');
  await page.getByRole('button', { name: 'Create temporary devnet account' }).click();
  const address = await page.getByTestId('account-address').innerText();
  assert.match(address, /^0x[0-9a-fA-F]{40}$/);
  await client.request({ method: 'anvil_setBalance', params: [address, '0x' + parseEther('1').toString(16)] });
  assert.equal((await client.getCode({ address })) ?? '0x', '0x');
  assert.equal(await page.getByRole('button', { name: 'Increment with AA', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Activate 7702', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 7702 activation' }).waitFor();
  // Cancelling a preview by reloading must not sign or activate anything.
  await page.reload();
  await page.getByRole('button', { name: 'Activate 7702', exact: true }).waitFor();
  assert.equal(await page.getByTestId('account-address').innerText(), address);
  assert.equal((await client.getCode({ address })) ?? '0x', '0x');
  await page.getByRole('button', { name: 'Activate 7702', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm 7702 activation' }).click();
  await page.waitForFunction(() => Object.keys(sessionStorage).some(k => k.includes(':activation:')));
  await page.reload();
  await page.getByRole('button', { name: '7702 activated', exact: true }).waitFor({ timeout: 60_000 });
  assert.equal(await page.getByTestId('account-address').innerText(), address);
  assert.equal((await client.getCode({ address })).toLowerCase(), ('0xef0100' + manifest.delegate.slice(2)).toLowerCase());
  const activation = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.includes(':activation:')))));
  const activationReceipt = await client.getTransactionReceipt({ hash: activation.hash });
  assert.equal(activationReceipt.type, 'eip7702'); assert.equal(activationReceipt.status, 'success');
  assert.equal(activationReceipt.from.toLowerCase(), address.toLowerCase());
  await page.getByRole('button', { name: 'Increment with AA', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm increment with AA', exact: true }).waitFor();
  const prepared = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.includes(':operation:')))));
  await page.reload();
  await page.getByRole('button', { name: 'Confirm increment with AA', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Confirm increment with AA', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.result-value')?.textContent === '1', undefined, { timeout: 60_000 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.result-value')?.textContent === '1', undefined, { timeout: 60_000 });
  const op = await fetch(base + '/api/aa/operations/' + prepared.id).then(r => r.json());
  assert.equal(op.status, 'confirmed'); assert.equal(op.owner, op.account); assert.equal(op.counterAfter, '1');
  const receipt = await client.getTransactionReceipt({ hash: op.transactionHash });
  const [event] = parseEventLogs({ abi: entryPoint09Abi, logs: receipt.logs, eventName: 'UserOperationEvent' });
  assert.equal(event.args.paymaster, zeroAddress); assert.equal(event.args.success, true);
  assert.equal(event.args.actualGasCost, parseEther(op.userChargeDoge));
  assert.equal(await client.readContract({ address: manifest.counter, abi: counterAbi, functionName: 'counts', args: [address] }), 1n);
  assert.deepEqual(errors, []);
  await mkdir('test/results', { recursive: true });
  await page.screenshot({ path: 'test/results/7702-local.png', fullPage: true });
  const proof = { network: 'isolated Anvil, not devnet', chainId: 31337, genesisHash: manifest.genesisHash,
    address, delegate: manifest.delegate, entryPoint: manifest.entryPoint, activationTransaction: activation.hash,
    counterTransaction: op.transactionHash, userOpHash: op.userOpHash, counter: '1',
    userChargeDoge: op.userChargeDoge, paymaster: event.args.paymaster, previewCancellation: 'passed',
    activationReload: 'passed', operationReload: 'passed', pageErrors: errors };
  await writeFile('test/results/7702-local.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally { await browser.close(); }
