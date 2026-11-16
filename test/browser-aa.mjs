import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, http, parseEther, parseAbi, parseEventLogs, zeroAddress } from '../aa/node_modules/viem/_esm/index.js';
import { generatePrivateKey, privateKeyToAccount } from '../aa/node_modules/viem/_esm/accounts/index.js';
// Build the web app with a registered client ID and NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=false.
// AA_API_URL may point to the hosted /api/aa endpoint for a live-backend test.
const base = process.env.WEB_URL || 'http://127.0.0.1:5190';
assert(process.env.TEST_KEY_FILE);
let keys = await readFile(process.env.TEST_KEY_FILE, 'utf8').then(JSON.parse).catch(() => null);
if (!keys) { keys = { privateKey: generatePrivateKey() }; await writeFile(process.env.TEST_KEY_FILE, JSON.stringify(keys), { mode: 0o600 }); }
const owner = privateKeyToAccount(keys.privateKey);
const manifest = JSON.parse(await readFile(new URL('../aa/config/chikyu.json', import.meta.url), 'utf8'));
const { chain } = await import('../aa/lib/chain.mjs');
const rpc = createPublicClient({ chain, transport: http(manifest.rpcUrl) });
const wallet = createWalletClient({ account: owner, chain, transport: http(manifest.rpcUrl) });
const account = await rpc.readContract({ address: manifest.accountFactory,
  abi: parseAbi(['function getAddress(address,uint256) view returns (address)']), functionName: 'getAddress', args: [owner.address, 0n] });
const ownerBefore = await rpc.getBalance({ address: owner.address });
assert(ownerBefore > 0n, 'Fund the dedicated test owner before this real testnet test.');
const depositAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const accountBefore = await rpc.getBalance({ address: account }) + await rpc.readContract({ address: manifest.entryPoint, abi: depositAbi, functionName: 'balanceOf', args: [account] });
await mkdir('test/results', { recursive: true });
let funded = 0n;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [], methods = []; let connected = false, rejectFunding = true, rejectSignature = true;
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
  if (method === 'personal_sign') { if (rejectSignature) { rejectSignature = false; throw Object.assign(new Error('User rejected signature'), { code: 4001 }); } assert(/^0x[0-9a-f]{64}$/i.test(params[0])); assert.equal(params[1].toLowerCase(), owner.address.toLowerCase()); return owner.signMessage({ message: { raw: params[0] } }); }
  if (method === 'eth_sendTransaction') {
    if (rejectFunding) { rejectFunding = false; throw Object.assign(new Error('User rejected funding'), { code: 4001 }); }
    const tx = params[0];
    assert.equal(tx.from.toLowerCase(), owner.address.toLowerCase());
    assert.equal(tx.to.toLowerCase(), account.toLowerCase());
    assert(!tx.data || tx.data === '0x');
    const value = BigInt(tx.value);
    assert(value > 0n && funded + value <= parseEther('0.5'), 'Bounded smart-account funding only.');
    funded += value;
    return wallet.sendTransaction({ to: account, value });
  }
  if (['eth_signTransaction','eth_sendRawTransaction'].includes(method)) throw new Error('Unexpected wallet request');
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
await page.goto(`${base}/aa`);
async function connectSdk() {
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().click();
  const externalLink = page.getByText('Or connect a wallet', { exact: true });
  if (await externalLink.isVisible()) await externalLink.click();
  await page.getByText('MetaMask', { exact: true }).first().waitFor();
  await page.screenshot({ path: 'test/results/sdk-wallet-picker.png', fullPage: true });
  await page.getByText('MetaMask', { exact: true }).first().click();
}
await connectSdk();
await page.getByRole('button', { name: 'Prepare increment', exact: true }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: 'Prepare increment', exact: true }).click();
const addFunds = page.getByRole('button', { name: /^Add .* DOGE from wallet$/ });
await addFunds.waitFor({ timeout: 90000 });
await page.screenshot({ path: 'test/results/aa-fee-preview.png', fullPage: true });
assert(!methods.includes('personal_sign'));
await addFunds.click();
await page.getByRole('alert').filter({ hasText: 'Wallet request cancelled.' }).waitFor();
await addFunds.click();
await page.getByRole('button', { name: 'Sign and increment', exact: true }).waitFor({ timeout: 90000 });
await page.getByRole('button', { name: 'Sign and increment', exact: true }).click();
await page.getByRole('alert').filter({ hasText: 'Wallet request cancelled.' }).waitFor();
await page.getByRole('button', { name: 'Sign and increment', exact: true }).click();
const confirmed = page.getByText('Confirmed on Chikyū.', { exact: true });
await Promise.race([confirmed.waitFor({ timeout: 210000 }), page.locator('main [role=alert]').waitFor({ timeout: 210000 }).then(async () => { throw new Error(await page.locator('main [role=alert]').innerText()); })]);
const count = await page.locator('.result-value').innerText();
const transactionUrl = await page.getByRole('link', { name: 'View transaction' }).getAttribute('href');
await page.screenshot({ path: 'test/results/aa-confirmed.png', fullPage: true });
await page.setViewportSize({ width: 360, height: 800 });
assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await page.screenshot({ path: 'test/results/aa-mobile.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.reload();
await page.waitForTimeout(4000);
const reconnectedAfterReload = await page.getByRole('button', { name: 'Connect Wallet', exact: true }).first().isVisible();
if (reconnectedAfterReload) await connectSdk();
await page.getByText('Confirmed on Chikyū.', { exact: true }).waitFor({ timeout: 45000 });
assert.equal(await page.locator('.result-value').innerText(), count);
await page.getByRole('link', { name: 'Randomness', exact: true }).click();
assert(await page.getByRole('button', { name: 'Disconnect', exact: true }).isVisible());
await page.getByRole('link', { name: 'Account abstraction', exact: true }).click();
await page.getByText('Confirmed on Chikyū.', { exact: true }).waitFor({ timeout: 45000 });
const ownerAfter = await rpc.getBalance({ address: owner.address });
assert(ownerAfter < ownerBefore && funded > 0n);
const hash = transactionUrl.split('/').at(-1);
const receipt = await rpc.getTransactionReceipt({ hash });
const eventAbi = parseAbi(['event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)']);
const [event] = parseEventLogs({ abi: eventAbi, logs: receipt.logs, eventName: 'UserOperationEvent' });
assert.equal(event.args.sender.toLowerCase(), account.toLowerCase());
assert.equal(event.args.paymaster, zeroAddress);
assert(event.args.success && event.args.actualGasCost > 0n);
const raw = await rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] });
const networkFee = receipt.gasUsed * receipt.effectiveGasPrice + BigInt(raw.l1Fee);
assert(event.args.actualGasCost >= networkFee, 'The smart account must cover the full network fee.');
assert(event.args.actualGasCost <= networkFee * 150n / 100n, 'Gas quote must account for compression, without excessive headroom.');
const deposit = await rpc.readContract({ address: manifest.entryPoint, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [account] });
assert.equal(accountBefore + funded - await rpc.getBalance({ address: account }) - deposit, event.args.actualGasCost);
await mkdir('test/results', { recursive: true });
await writeFile('test/results/browser-aa.json', JSON.stringify({ base, owner: owner.address, account, salt: 0, count, transactionUrl, errors,
  userChargeWei: String(event.args.actualGasCost), networkFeeWei: String(networkFee), l1FeeWei: String(BigInt(raw.l1Fee)), fundedWei: String(funded), accountBeforeWei: String(accountBefore),
  personalSignCount: methods.filter(m => m === 'personal_sign').length, ownerTransactionRequests: methods.filter(m => ['eth_sendTransaction','eth_signTransaction','eth_sendRawTransaction'].includes(m)), reloadRecovered: true, reconnectedAfterReload, sharedSdkConnection: true, fundingCancellationRecovered: true, signatureCancellationRecovered: true }, null, 2));
await browser.close(); assert.equal(errors.length, 0, errors.join('\n')); console.log(`PASS: SDK wallet → funded smart account → self-paid counter ${count} → reload recovery; ${transactionUrl}`);
