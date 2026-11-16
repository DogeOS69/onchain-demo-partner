import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, zeroAddress, encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, root, waitSuccess } from '../lib/chain.mjs';
import { publicKeyToEvm, signatureToEvm, BEACON_HASH } from '../lib/drand.mjs';
import { createKeeper } from '../keeper/worker.mjs';

const info = JSON.parse(fs.readFileSync(new URL('./fixtures/evmnet-info.json', import.meta.url)));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/evmnet-round.json', import.meta.url)));
const round = BigInt(fixture.round), signature = signatureToEvm(fixture.signature);
const targetTime = BigInt(info.genesis_time) + (round - 1n) * BigInt(info.period);
const localChain = defineChain({ id: 31337, name: 'Anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:18545'] } } });
// Public Anvil development key. Never use this account on a public network.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicClient = createPublicClient({ chain: localChain, transport: http(), pollingInterval: 50 });
const walletClient = createWalletClient({ chain: localChain, account, transport: http() });
let anvil, demo, coordinator, beacon, pubKeyHash;
async function deploy(name, args = []) {
  const a = artifact(name);
  const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  return { address: (await waitSuccess(publicClient, hash)).contractAddress, abi: a.abi };
}
const read = (c, functionName, args = []) => publicClient.readContract({ ...c, functionName, args });
async function write(c, functionName, args = []) {
  const { request } = await publicClient.simulateContract({ ...c, functionName, args, account });
  return waitSuccess(publicClient, await walletClient.writeContract(request));
}
const setTime = n => publicClient.request({ method: 'evm_setNextBlockTimestamp', params: [Number(n)] });
const fulfillmentArgs = id => [id, demo.address, pubKeyHash, round, 150000n, signature];
function worker(overrides = {}) {
  return createKeeper({ publicClient, walletClient, account, demo, coordinator, beacon,
    minConfirmations: 18, minBalanceDoge: '0', local: true, log: () => {},
    getRound: async expected => { assert.equal(expected, round); return fixture; }, ...overrides });
}

before(async () => {
  anvil = spawn(process.execPath, ['node_modules/@foundry-rs/anvil/bin.mjs', '--host', '127.0.0.1', '--port', '18545', '--timestamp', String(targetTime - 200n), '--silent'], { cwd: root, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { await publicClient.getChainId(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(ready, 'Anvil started');
  beacon = await deploy('DrandBeacon', [publicKeyToEvm(info.public_key), BigInt(info.genesis_time), BigInt(info.period)]);
  const station = await deploy('GasStationEthereum');
  const implementation = await deploy('Anyrand');
  const init = encodeFunctionData({ abi: implementation.abi, functionName: 'init', args: [beacon.address, 0n, 200000n, 300n, station.address, 1000000000000n] });
  const proxy = await deploy('ERC1967Proxy', [implementation.address, init]);
  coordinator = { ...proxy, abi: implementation.abi };
  demo = await deploy('RandomnessDemo', [coordinator.address, beacon.address]);
  pubKeyHash = await read(demo, 'pubKeyHash');
});
after(() => { anvil?.kill('SIGTERM'); });

test('real pinned evmnet BN254 signature verifies; tampered round and signature revert', async () => {
  assert.equal(info.chain_hash, BEACON_HASH);
  await read(beacon, 'verifyBeaconRound', [round, signature]);
  await assert.rejects(read(beacon, 'verifyBeaconRound', [round + 1n, signature]));
  await assert.rejects(read(beacon, 'verifyBeaconRound', [round, [signature[0] + 1n, signature[1]]]));
  assert.throws(() => signatureToEvm('1234'));
});

test('automatic keeper waits, fulfills only automatic requests, and recovers without replay', async () => {
  await setTime(targetTime - 91n); await write(demo, 'requestRoll', [true]);
  await setTime(targetTime - 90n); await write(demo, 'requestRoll', [false]);
  assert.equal((await read(demo, 'getRoll', [1n])).round, round);
  assert.equal((await read(demo, 'getRoll', [2n])).round, round);
  const pendingWorker = worker(); await pendingWorker.tick();
  assert.equal(await read(coordinator, 'getRequestState', [1n]), 1);
  const wrongRequester = fulfillmentArgs(1n); wrongRequester[1] = account.address;
  await assert.rejects(publicClient.simulateContract({ ...coordinator, functionName: 'fulfillRandomness', args: wrongRequester, account }));
  const wrongRound = fulfillmentArgs(1n); wrongRound[3] += 1n;
  await assert.rejects(publicClient.simulateContract({ ...coordinator, functionName: 'fulfillRandomness', args: wrongRound, account }));
  await setTime(targetTime + 1n);
  await publicClient.request({ method: 'anvil_mine', params: ['0x14', '0x1'] });
  await pendingWorker.tick();
  assert.equal(pendingWorker.status.lastError, null);
  assert.equal(await read(coordinator, 'getRequestState', [1n]), 2);
  assert.equal(await read(coordinator, 'getRequestState', [2n]), 1, 'manual request remains pending');
  const auto = await read(demo, 'getRoll', [1n]);
  assert.equal(auto.fulfilled, true); assert.ok(auto.face >= 1 && auto.face <= 6);
  const restarted = worker(); await restarted.tick();
  assert.equal(restarted.status.lastTransaction, null, 'restart does not resend');
  assert.equal(restarted.status.completedAutomatic, 1);
  await assert.rejects(publicClient.simulateContract({ ...coordinator, functionName: 'fulfillRandomness', args: fulfillmentArgs(1n), account }));
});

test('manual proof completes the separate request and matches domain-separated output', async () => {
  await write(coordinator, 'fulfillRandomness', fulfillmentArgs(2n));
  const manual = await read(demo, 'getRoll', [2n]);
  const expected = BigInt(keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' },
  ], [signature[0], signature[1], 31337n, coordinator.address, 2n, demo.address])));
  assert.equal(manual.word, expected);
  assert.notEqual(manual.word, (await read(demo, 'getRoll', [1n])).word);
  assert.equal(manual.fulfilled, true);
  assert.equal(await read(coordinator, 'requests', [2n]), `0x${'0'.repeat(64)}`);
});

test('keeper enforces funding and cumulative automatic fulfillment caps', async () => {
  const limited = worker({ maxAutoFulfillments: 1 }); await limited.tick();
  assert.equal(limited.status.state, 'budget-limit');
  const unfunded = worker({ minBalanceDoge: '1000000000' }); await unfunded.tick();
  assert.equal(unfunded.status.state, 'low-balance');
});

test('consumer rejects forged/duplicate/unknown callbacks, but accepts random word zero', async () => {
  const mock = await deploy('MockCoordinator', [pubKeyHash]);
  const isolated = await deploy('RandomnessDemo', [mock.address, beacon.address]);
  await write(isolated, 'requestRoll', [true]);
  await assert.rejects(publicClient.simulateContract({ ...isolated, functionName: 'receiveRandomness', args: [1n, 123n], account }));
  await assert.rejects(publicClient.simulateContract({ ...mock, functionName: 'deliver', args: [isolated.address, 999n, 0n], account }));
  await write(mock, 'deliver', [isolated.address, 1n, 0n]);
  const roll = await read(isolated, 'getRoll', [1n]);
  assert.equal(roll.word, 0n); assert.equal(roll.fulfilled, true);
  assert.notEqual(roll.player, zeroAddress); assert.ok(roll.face >= 1 && roll.face <= 6);
  await assert.rejects(publicClient.simulateContract({ ...mock, functionName: 'deliver', args: [isolated.address, 1n, 999n], account }));
});
