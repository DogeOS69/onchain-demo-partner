// Run against a local build with NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=false.
// Uses the real SDK and a test provider; never loads keys or broadcasts a tx.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPublicClient, http } from '../web/node_modules/viem/_esm/index.js';

const base = process.env.WEB_URL || 'http://127.0.0.1:5190';
const target = '0x5fdaf3';
const owner = '0x91279a099B18F4b3d80Eb54e6A16b50Fb79d4057';
const rpc = createPublicClient({ transport: http('https://rpc.testnet.dogeos.com/') });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const calls = [], errors = [], cases = [], forbidden = [];
let connected = false, activeChain = target, known = true, scenario = {};
page.on('pageerror', error => errors.push(error.message));

try {
  await page.exposeBinding('networkCheckRequest', async (_, { method, params = [] }) => {
    calls.push(method);
    try {
      let result;
      if (method === 'eth_accounts') result = connected ? [owner] : [];
      else if (method === 'eth_requestAccounts') { connected = true; result = [owner]; }
      else if (method === 'eth_chainId') result = activeChain;
      else if (method === 'net_version') result = String(Number(activeChain));
      else if (['wallet_requestPermissions', 'wallet_getPermissions'].includes(method)) {
        connected = true; result = [{ parentCapability: 'eth_accounts' }];
      } else if (method === 'wallet_switchEthereumChain') {
        assert.equal(params[0].chainId, target);
        if (scenario.rejectSwitch) throw Object.assign(new Error('User rejected network switch'), { code: 4001 });
        if (!known) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
        if (!scenario.ignoreSwitch) activeChain = target;
        result = null;
      } else if (method === 'wallet_addEthereumChain') {
        assert.equal(params[0].chainId, target);
        assert.deepEqual(params[0].rpcUrls, ['https://rpc.testnet.dogeos.com/']);
        if (scenario.rejectAdd) throw Object.assign(new Error('User rejected adding network'), { code: 4001 });
        known = true; result = null;
      } else if (method === 'eth_sendTransaction') {
        assert.equal(activeChain, target);
        // Exercise submission without signing or broadcasting anything.
        throw Object.assign(new Error(`Stopped before signing: ${scenario.name}`), { code: 4001 });
      } else if (/sign|send/i.test(method)) {
        forbidden.push(method);
        throw new Error(`Unexpected signing request: ${method}`);
      } else if (['eth_getBalance', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_call', 'eth_gasPrice', 'eth_getCode'].includes(method)) {
        result = await rpc.request({ method, params });
      } else {
        throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 4200 });
      }
      return { result };
    } catch (error) {
      // Preserve EIP-1193 codes across Playwright's binding boundary.
      return { error: { message: error.message, code: error.code ?? -32603 } };
    }
  });
  await page.addInitScript(() => {
    const listeners = new Map();
    const provider = {
      isMetaMask: true, isConnected: () => true, _metamask: { isUnlocked: async () => true },
      async request(args) {
        const response = await window.networkCheckRequest(args);
        if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code });
        return response.result;
      },
      on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); },
      removeListener(event, fn) { listeners.set(event, (listeners.get(event) || []).filter(item => item !== fn)); },
      removeAllListeners() { listeners.clear(); },
    };
    window.ethereum = provider;
    const detail = { info: { uuid: 'd3184cf1-bf4d-4f08-898e-bebdd81cdad1', name: 'MetaMask', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.metamask' }, provider };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })));
  });
  await page.goto(`${base}/onchain`);
  await page.getByRole('button', { name: 'Connect Wallet', exact: true }).click();
  await page.getByText('MetaMask', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();

  const add = 'wallet_addEthereumChain', change = 'wallet_switchEthereumChain', send = 'eth_sendTransaction';
  for (const item of [
    { name: 'already on Chikyu', expected: [send] },
    { name: 'repeat transaction on Chikyu', expected: [send] },
    { name: 'known network, stale React state', chain: '0x1', expected: [change, send] },
    { name: 'unknown network', chain: '0x1', unknown: true, expected: [change, add, change, send] },
    { name: 'rejected switch', chain: '0x1', rejectSwitch: true, error: 'User rejected network switch', expected: [change] },
    { name: 'rejected add', chain: '0x1', unknown: true, rejectAdd: true, error: 'User rejected adding network', expected: [change, add] },
    { name: 'wallet ignores switch', chain: '0x1', ignoreSwitch: true, error: 'Select DogeOS Chikyū in your wallet before sending a transaction.', expected: [change] },
    { name: 'invalid chain ID', chain: 'invalid', error: 'Wallet returned an invalid chain ID.', expected: [] },
  ]) {
    scenario = item;
    // Deliberately omit chainChanged to exercise stale SDK/React state.
    activeChain = item.chain ?? target;
    known = !item.unknown;
    const before = calls.length;
    await page.getByRole('button', { name: 'Trigger event', exact: true }).click();
    await page.locator('main .status.err').getByText(item.error ?? `Stopped before signing: ${item.name}`, { exact: true }).waitFor({ timeout: 30000 });
    const requests = calls.slice(before).filter(method => [add, change, send].includes(method));
    assert.deepEqual(requests, item.expected, item.name);
    cases.push({ name: item.name, requests });
    console.log(`PASS: ${item.name}`);
  }
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  await mkdir('test/results', { recursive: true });
  await writeFile('test/results/browser-network.json', JSON.stringify({ base, verifiedAt: new Date().toISOString(), cases, pageErrors: errors, signedTransactions: 0, broadcastTransactions: 0 }, null, 2));
  console.log(`PASS: ${cases.length} network scenarios with the real SDK. No transactions signed or broadcast.`);
} finally {
  await browser.close();
}
