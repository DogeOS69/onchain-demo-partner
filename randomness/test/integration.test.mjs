import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, root, waitSuccess } from '../lib/chain.mjs';
import { publicKeyToEvm, signatureToEvm, BEACON_HASH } from '../lib/drand.mjs';
import { createKeeper } from '../keeper/worker.mjs';
const info = JSON.parse(fs.readFileSync(new URL('./fixtures/evmnet-info.json', import.meta.url)));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/evmnet-round.json', import.meta.url)));
const round = BigInt(fixture.round), signature = signatureToEvm(fixture.signature);
const targetTime = BigInt(info.genesis_time) + (round - 1n) * BigInt(info.period);
const chain = defineChain({ id: 31337, name: 'Anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:18545'] } } });
// Public Anvil development key, never used on public networks.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicClient = createPublicClient({ chain, transport: http(), pollingInterval: 25, cacheTime: 0 });
const walletClient = createWalletClient({ chain, account, transport: http() });
const price = 1_000_000_000n;
let anvil, demo, coordinator, beacon, pubKeyHash, snapshot;
const read = (c, functionName, args = []) => publicClient.readContract({ ...c, functionName, args });
async function write(c, functionName, args = [], value = 0n, gasPrice = price) {
  const { request } = await publicClient.simulateContract({ ...c, functionName, args, account, value, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice });
  return waitSuccess(publicClient, await walletClient.writeContract(request));
}
async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  return { address: (await waitSuccess(publicClient, hash)).contractAddress, abi: a.abi };
}
const setTime = n => publicClient.request({ method: 'evm_setNextBlockTimestamp', params: [Number(n)] });
const mine = (count = 20) => publicClient.request({ method: 'anvil_mine', params: [`0x${count.toString(16)}`, '0x1'] });
function worker(overrides = {}) {
  return createKeeper({ publicClient, walletClient, account, coordinator,
    minConfirmations: 18, minBalanceDoge: '0', autoWithdraw: false, local: true, log: () => {},
    getRound: async expected => { assert.equal(expected, round); return fixture; }, ...overrides });
}
const fee = (gasLimit = 150000n, gasPrice = price) => (200000n + gasLimit) * gasPrice * 15000n / 10000n;
async function requestDemo(extra = 0n) { await setTime(targetTime - 91n); return write(demo, 'requestRoll', [true], fee() + extra); }
async function ready() { await setTime(targetTime + 1n); await mine(); }

before(async () => {
  anvil = spawn(process.execPath, ['node_modules/@foundry-rs/anvil/bin.mjs', '--host', '127.0.0.1', '--port', '18545', '--timestamp', String(targetTime - 200n), '--silent'], { cwd: root, stdio: 'ignore' });
  let started = false;
  for (let i = 0; i < 50; i++) { try { await publicClient.getChainId(); started = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert.ok(started);
  beacon = await deploy('DrandBeacon', [publicKeyToEvm(info.public_key), BigInt(info.genesis_time), BigInt(info.period)]);
  const station = await deploy('GasStationEthereum');
  const implementation = await deploy('Anyrand');
  const init = encodeFunctionData({ abi: implementation.abi, functionName: 'init', args: [beacon.address, 15000n, 200000n, 300n, station.address, 1000000000000n] });
  const proxy = await deploy('ERC1967Proxy', [implementation.address, init]);
  coordinator = { ...proxy, abi: implementation.abi };
  demo = await deploy('RandomnessDemo', [coordinator.address, beacon.address]);
  pubKeyHash = await read(demo, 'pubKeyHash');
});
after(() => anvil?.kill('SIGTERM'));
beforeEach(async () => { snapshot = await publicClient.request({ method: 'evm_snapshot' }); });
afterEach(async () => { await publicClient.request({ method: 'evm_revert', params: [snapshot] }); });

test('real drand proof verifies; modified round and signature fail', async () => {
  assert.equal(info.chain_hash, BEACON_HASH);
  await read(beacon, 'verifyBeaconRound', [round, signature]);
  await assert.rejects(read(beacon, 'verifyBeaconRound', [round + 1n, signature]));
  await assert.rejects(read(beacon, 'verifyBeaconRound', [round, [signature[0] + 1n, signature[1]]]));
});

test('consumer forwards the current fee and immediately refunds excess, tolerating gas changes within budget', async () => {
  const maximum = fee() * 125n / 100n, actualPrice = price * 110n / 100n;
  const beforeBalance = await publicClient.getBalance({ address: account.address });
  await setTime(targetTime - 91n);
  const receipt = await write(demo, 'requestRoll', [true], maximum, actualPrice);
  const paid = fee(150000n, actualPrice);
  assert.equal(await read(demo, 'feesPaid', [1n]), paid);
  assert.equal(await publicClient.getBalance({ address: coordinator.address }), paid);
  assert.equal(await publicClient.getBalance({ address: demo.address }), 0n);
  const afterBalance = await publicClient.getBalance({ address: account.address });
  assert.equal(beforeBalance - afterBalance, paid + receipt.gasUsed * receipt.effectiveGasPrice);
  const payment = receipt.logs.filter(l => l.address.toLowerCase() === demo.address.toLowerCase()).map(l => decodeEventLog({ abi: demo.abi, ...l })).find(e => e.eventName === 'RequestPayment');
  assert.equal(payment.args.refunded, maximum - paid);
  await assert.rejects(write(demo, 'requestRoll', [true], fee() - 1n));
  await assert.rejects(write(demo, 'requestRoll', [false], fee()));
  assert.equal(await read(coordinator, 'nextRequestId'), 2n);
});

test('refund cannot reenter requestRoll', async () => {
  const attacker = await deploy('RefundReentry');
  await setTime(targetTime - 91n);
  await write(attacker, 'request', [demo.address], fee() * 3n);
  assert.equal(await read(attacker, 'attempted'), true);
  assert.equal(await read(attacker, 'reentered'), false);
  assert.equal(await read(demo, 'rollCount'), 1n);
});

test('keeper handles two independent consumers, waits for confirmations and future round, and recovers without replay', async () => {
  const partner = await deploy('PartnerConsumer', [coordinator.address, false]);
  await requestDemo();
  await setTime(targetTime - 90n); await write(partner, 'request', [targetTime, 100000n], fee(100000n));
  const k = worker(); await k.tick(); assert.equal(k.status.scanned, 0);
  await mine(); await k.tick(); assert.equal(k.status.pending, 2); assert.equal(k.status.lastTransaction, null);
  await ready(); await k.tick(); assert.equal(k.status.lastError, null);
  assert.equal(await read(coordinator, 'getRequestState', [1n]), 2);
  await k.tick(); assert.equal(await read(coordinator, 'getRequestState', [2n]), 2);
  assert.equal(await read(partner, 'deliveries'), 1n);
  assert.equal((await read(demo, 'getRoll', [1n])).fulfilled, true);
  await mine(); const restarted = worker(); await restarted.tick();
  assert.equal(restarted.status.completedAutomatic, 2);
  assert.equal(restarted.status.pending, 0);
  assert.equal(restarted.status.lastTransaction, null);
  assert.equal(BigInt(restarted.status.feesCollectedWei), fee() + fee(100000n));
  assert.ok(BigInt(restarted.status.fulfillmentCostWei) > 0n);
});

test('collection reserves pending request fees and cannot repeat before confirmations, including after restart', async () => {
  const partner = await deploy('PartnerConsumer', [coordinator.address, false]);
  await requestDemo(); await setTime(targetTime - 90n);
  await write(partner, 'request', [targetTime + 120n, 100000n], fee(100000n));
  const k = worker({ autoWithdraw: true, withdrawMinDoge: '0.0001' });
  await mine(); await k.tick(); assert.equal(k.status.availableFeesWei, '0'); assert.equal(k.status.lastWithdrawal, undefined);
  await ready(); await k.tick(); await mine(); await k.tick();
  assert.ok(k.status.lastWithdrawal);
  assert.equal(await publicClient.getBalance({ address: coordinator.address }), fee(100000n));
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  const restarted = worker({ autoWithdraw: true, withdrawMinDoge: '0.0001' }); await restarted.tick();
  assert.equal(await publicClient.getTransactionCount({ address: account.address }), nonce);
  await mine(); await restarted.tick();
  assert.equal(restarted.status.feesWithdrawnWei, fee().toString());
  assert.equal(restarted.status.pendingFeeReserveWei, fee(100000n).toString());
});

test('callback failure is charged and terminal; keeper never repeats it', async () => {
  const partner = await deploy('PartnerConsumer', [coordinator.address, true]);
  await setTime(targetTime - 91n); await write(partner, 'request', [targetTime, 100000n], fee(100000n));
  await ready(); const k = worker(); await k.tick();
  assert.equal(await read(coordinator, 'getRequestState', [1n]), 3);
  await mine(); await k.tick(); assert.equal(k.status.failedCallbacks, 1); assert.equal(k.status.pending, 0);
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  await worker().tick(); assert.equal(await publicClient.getTransactionCount({ address: account.address }), nonce);
});

test('keeper pauses for gas above the prepaid budget, low balance, and configured spend caps', async () => {
  await requestDemo(); await ready();
  const expensive = worker({ publicClient: { ...publicClient, getGasPrice: async () => price * 20n } }); await expensive.tick();
  assert.equal(expensive.status.state, 'waiting-gas');
  assert.equal(await read(coordinator, 'getRequestState', [1n]), 1);
  const low = worker({ minBalanceDoge: '1000000000' }); await low.tick(); assert.equal(low.status.state, 'low-balance');
  const capped = worker({ maxCostDoge: '0.000000000001' }); await capped.tick(); assert.equal(capped.status.state, 'waiting-gas');
});

test('consumer rejects forged or duplicate callbacks and accepts random word zero', async () => {
  const mock = await deploy('MockCoordinator', [pubKeyHash]);
  const isolated = await deploy('RandomnessDemo', [mock.address, beacon.address]);
  await write(isolated, 'requestRoll', [true]);
  await assert.rejects(write(isolated, 'receiveRandomness', [1n, 1n]));
  await write(mock, 'deliver', [isolated.address, 1n, 0n]);
  assert.equal((await read(isolated, 'getRoll', [1n])).word, 0n);
  assert.equal((await read(isolated, 'getRoll', [1n])).fulfilled, true);
  await assert.rejects(write(mock, 'deliver', [isolated.address, 1n, 4n]));
});
