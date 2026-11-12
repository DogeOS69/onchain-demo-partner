import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, http } from '../sponsorship/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../sponsorship/node_modules/viem/_esm/accounts/index.js';
const base = process.env.WEB_URL || 'http://127.0.0.1:5190';
assert(process.env.TEST_KEY_FILE);
let keys = await readFile(process.env.TEST_KEY_FILE, 'utf8').then(JSON.parse).catch(() => null);
if (!keys) { keys = { privateKey: generatePrivateKey() }; await writeFile(process.env.TEST_KEY_FILE, JSON.stringify(keys), { mode: 0o600 }); }
const owner = privateKeyToAccount(keys.privateKey);
const rpc = createPublicClient({ transport: http('https://rpc.testnet.dogeos.com') });
assert.equal(await rpc.getBalance({ address: owner.address }), 0n);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], methods = []; let connected = false;
page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR:', e.message); });
page.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE:', msg.text().slice(0, 300)); });
await page.exposeBinding('testWalletRequest', async (_, { method, params = [] }) => {
  methods.push(method);
  if (method === 'eth_accounts') return connected ? [owner.address] : [];
  if (method === 'eth_requestAccounts') { connected = true; return [owner.address]; }
  if (method === 'eth_chainId') return '0x5fdaf3';
  if (method === 'net_version') return '6281971';
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
  if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') { connected = true; return [{ parentCapability: 'eth_accounts' }]; }
  if (method === 'personal_sign') { assert(/^0x[0-9a-f]{64}$/i.test(params[0])); assert.equal(params[1].toLowerCase(), owner.address.toLowerCase()); return owner.signMessage({ message: { raw: params[0] } }); }
  if (['eth_sendTransaction','eth_signTransaction','eth_sendRawTransaction'].includes(method)) throw new Error('AA must never ask the owner to send a transaction');
  return rpc.request({ method, params });
});
await page.addInitScript(() => {
  const listeners = new Map();
  const provider = { isMetaMask: true, isConnected: () => true, _metamask: { isUnlocked: async () => true },
    request: args => window.testWalletRequest(args),
    on(event, fn) { const list = listeners.get(event) || []; list.push(fn); listeners.set(event, list); },
    removeListener(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); },
    removeAllListeners() { listeners.clear(); },
  };
  window.ethereum = provider;
  const detail = { info: { uuid: 'd3184cf1-bf4d-4f08-898e-bebdd81cdad1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.metamask' }, provider };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
});
await page.goto(`${base}/sponsorship`);
async function connectSdk() {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
  const externalLink = page.getByText('Or connect a wallet', { exact: true });
  if (await externalLink.isVisible()) await externalLink.click();
  await page.getByText('MetaMask', { exact: true }).first().waitFor();
  await page.screenshot({ path: 'test/results/sdk-wallet-picker.png', fullPage: true });
  await page.getByText('MetaMask', { exact: true }).first().click();
}
await connectSdk();
await page.getByRole('button', { name: 'Increment counter', exact: true }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Increment counter', exact: true }).click();
const confirmed = page.getByText('Confirmed on Chikyū.', { exact: true });
await Promise.race([confirmed.waitFor({ timeout: 210000 }), page.locator('main [role=alert]').waitFor({ timeout: 210000 }).then(async () => { throw new Error(await page.locator('main [role=alert]').innerText()); })]);
const count = await page.locator('.result-value').innerText();
const transactionUrl = await page.getByRole('link', { name: 'View transaction' }).getAttribute('href');
await page.screenshot({ path: 'test/results/aa-confirmed.png', fullPage: true });
await page.reload();
await page.waitForTimeout(4000);
const reconnectedAfterReload = await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().isVisible();
if (reconnectedAfterReload) await connectSdk();
await page.getByText('Confirmed on Chikyū.', { exact: true }).waitFor({ timeout: 45000 });
assert.equal(await page.locator('.result-value').innerText(), count);
await page.getByRole('link', { name: 'Randomness', exact: true }).click();
assert(await page.getByRole('button', { name: 'Disconnect', exact: true }).isVisible());
await page.getByRole('link', { name: 'Gas sponsorship', exact: true }).click();
await page.getByText('Confirmed on Chikyū.', { exact: true }).waitFor({ timeout: 45000 });
assert.equal(await rpc.getBalance({ address: owner.address }), 0n);
await mkdir('test/results', { recursive: true });
await writeFile('test/results/browser-aa.json', JSON.stringify({ base, owner: owner.address, count, transactionUrl, errors,
  personalSignCount: methods.filter(m => m === 'personal_sign').length, ownerTransactionRequests: methods.filter(m => ['eth_sendTransaction','eth_signTransaction','eth_sendRawTransaction'].includes(m)), reloadRecovered: true, reconnectedAfterReload, sharedSdkConnection: true }, null, 2));
await browser.close(); assert.equal(errors.length, 0, errors.join('\n')); console.log(`PASS: SDK wallet → sponsored counter ${count} → reload recovery; ${transactionUrl}`);
