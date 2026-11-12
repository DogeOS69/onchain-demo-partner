import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, defineChain, http } from '../sponsorship/node_modules/viem/_esm/index.js';
import { privateKeyToAccount } from '../sponsorship/node_modules/viem/_esm/accounts/index.js';
assert(process.env.TEST_KEY_FILE, 'Use a private, funded testnet wallet file');
const owner = privateKeyToAccount(JSON.parse(await readFile(process.env.TEST_KEY_FILE, 'utf8')).privateKey);
const base = process.env.WEB_URL || 'http://127.0.0.1:5190';
const chain = defineChain({ id: 6281971, name: 'Chikyu', nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.dogeos.com'] } } });
const client = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account: owner, chain, transport: http() });
assert.equal(await client.getChainId(), 6281971);
const before = await client.getBalance({ address: owner.address }); assert(before > 100000000000000000n);
const allowed = ['0xb5f4756ef5be714bd35fcf976da52f1f7ad11f66','0x07e3afc00f61da98d5e00cfca2b0fa25ece1b18b','0xd96ae24e41474401294f2de1b1e8270941e8d193'];
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], transactions = []; let connected = false;
page.on('pageerror', e => errors.push(e.message));
await page.exposeBinding('testWalletRequest', async (_, { method, params = [] }) => {
  if (method === 'eth_accounts') return connected ? [owner.address] : [];
  if (method === 'eth_requestAccounts') { connected = true; return [owner.address]; }
  if (method === 'eth_chainId') return '0x5fdaf3';
  if (method === 'net_version') return '6281971';
  if (['wallet_switchEthereumChain','wallet_addEthereumChain'].includes(method)) return null;
  if (['wallet_requestPermissions','wallet_getPermissions'].includes(method)) { connected = true; return [{ parentCapability: 'eth_accounts' }]; }
  if (method === 'eth_sendTransaction') {
    const tx = params[0]; assert.equal(tx.from.toLowerCase(), owner.address.toLowerCase());
    assert(allowed.includes(tx.to.toLowerCase())); assert.equal(BigInt(tx.value ?? 0), 0n);
    assert(BigInt(tx.maxFeePerGas) <= 500000000n && BigInt(tx.gas) <= 2500000n);
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0n, type: 'eip1559', nonce: Number(tx.nonce),
      gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    transactions.push({ to: tx.to, hash }); console.log(`Sent ${hash}`); return hash;
  }
  assert(!['personal_sign','eth_signTransaction','eth_sendRawTransaction'].includes(method), `Unexpected signing method ${method}`);
  return client.request({ method, params });
});
await page.addInitScript(() => {
  const listeners = new Map();
  const provider = { isMetaMask: true, isConnected: () => true, _metamask: { isUnlocked: async () => true }, request: args => window.testWalletRequest(args),
    on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
    removeListener(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); }, removeAllListeners() { listeners.clear(); } };
  window.ethereum = provider;
  const detail = { info: { uuid: 'd3184cf1-bf4d-4f08-898e-bebdd81cdad1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.metamask' }, provider };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
});
await mkdir('test/results', { recursive: true });
await page.goto(`${base}/onchain`);
await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
const external = page.getByText('Or connect a wallet', { exact: true }); if (await external.isVisible()) await external.click();
await page.getByText('MetaMask', { exact: true }).first().click();
await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
let automatic, manual;
if (process.env.RECOVER_ROLLS) {
  [automatic, manual] = process.env.RECOVER_ROLLS.split(',');
  assert(/^\d+$/.test(automatic) && /^\d+$/.test(manual));
  await page.getByRole('link', { name: 'Randomness', exact: true }).click();
  await page.locator('summary').click();
  await page.getByRole('button', { name: new RegExp(`^#${manual} ·`) }).click();
  await page.locator('summary').click();
} else {
if (!process.env.SKIP_ONCHAIN) {
await page.getByRole('button', { name: 'Trigger event', exact: true }).click();
await page.locator('main .status.ok').waitFor({ timeout: 60000 });
console.log('Onchain rule transaction confirmed.');
}
await page.getByRole('link', { name: 'Randomness', exact: true }).click();
await page.getByRole('button', { name: 'Roll die', exact: true }).click();
await page.locator('main .result-label').waitFor({ timeout: 60000 });
automatic = (await page.locator('main .result-label').innerText()).match(/Request #(\d+)/)[1];
await page.getByRole('button', { name: 'Roll die', exact: true }).waitFor();
await page.locator('select').selectOption('manual');
await page.getByRole('button', { name: 'Roll die', exact: true }).click();
await page.getByRole('button', { name: 'Submit proof', exact: true }).waitFor({ timeout: 60000 });
manual = (await page.locator('main .result-label').innerText()).match(/Request #(\d+)/)[1];
}
assert.notEqual(manual, automatic);
await page.waitForFunction(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Submit proof'); return b && !b.disabled; }, undefined, { timeout: 180000 });
await page.getByRole('button', { name: 'Submit proof', exact: true }).click();
await Promise.race([
  page.getByRole('button', { name: 'Verify result', exact: true }).waitFor({ timeout: 60000 }),
  page.locator('main [role=alert]').waitFor({ timeout: 60000 }).then(async () => { await page.screenshot({ path: 'test/results/randomness-error.png', fullPage: true }); throw new Error(await page.locator('main [role=alert]').innerText()); }),
]);
await page.getByRole('button', { name: 'Verify result', exact: true }).click();
await page.getByText('BLS signature and onchain result verified.', { exact: true }).waitFor({ timeout: 45000 });
const manualFace = await page.locator('.result-value').innerText();
await page.locator('summary').click();
await page.getByRole('button', { name: new RegExp(`^#${automatic} ·`) }).click();
await page.getByRole('button', { name: 'Verify result', exact: true }).waitFor({ timeout: 60000 });
await page.getByRole('button', { name: 'Verify result', exact: true }).click();
await page.getByText('BLS signature and onchain result verified.', { exact: true }).waitFor({ timeout: 45000 });
const automaticFace = await page.locator('.result-value').innerText();
await page.screenshot({ path: 'test/results/randomness-confirmed.png', fullPage: true });
await writeFile('test/results/browser-chain.json', JSON.stringify({ base, owner: owner.address, automatic, automaticFace, manual, manualFace, transactions, errors, balanceBefore: String(before), balanceAfter: String(await client.getBalance({ address: owner.address })) }, null, 2));
await browser.close(); assert.equal(errors.length, 0, errors.join('\n')); console.log('PASS: SDK chain flows, with both randomness proofs independently verified.');
