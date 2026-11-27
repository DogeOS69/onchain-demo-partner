import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { clients, assertChikyu, artifact, contract, readDeployment, deploymentPath, root, writeJson } from '../lib/chain.mjs';
import { deploymentWriter, proxyInfo } from '../lib/deployment.mjs';
import { sendContract } from '../lib/transactions.mjs';

if (process.env.KEEPER_STOPPED !== 'true') throw new Error('Stop the signing keeper and set KEEPER_STOPPED=true');
const c = clients({ signing: true }); await assertChikyu(c.publicClient);
const d = readDeployment(), coordinator = contract(d, 'Coordinator');
const read = (target, functionName, args = []) => c.publicClient.readContract({ ...target, functionName, args });
const owner = await read(coordinator, 'owner');
assert.equal(owner.toLowerCase(), c.account.address.toLowerCase(), 'The key must own the testnet coordinator');
const evidenceFile = path.join(root, '.runtime', 'upgradeable-migration.json');
const state = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile)) : {
  chainId: d.chainId, coordinator: coordinator.address, owner, startedAt: new Date().toISOString(),
  previous: structuredClone(d.contracts), contracts: {}, calls: {},
};
assert.equal(state.coordinator.toLowerCase(), coordinator.address.toLowerCase());
assert.equal(state.owner.toLowerCase(), owner.toLowerCase());
writeJson(evidenceFile, state);
const deploy = deploymentWriter(c, state, evidenceFile, 'upgradeable');
// These upstream implementations have no mutable proxy storage. DrandBeacon's
// SSTORE2 pointer is immutable in implementation code, so delegatecall preserves
// its original key and timing. No upstream Solidity change is needed.
state.contracts.DrandBeaconImplementation ??= state.previous.DrandBeacon;
state.contracts.GasStationScrollImplementation ??= state.previous.GasStationScroll;
assert.ok(!state.contracts.DrandBeaconImplementation.proxyType, 'Expected a direct beacon implementation');
assert.ok(!state.contracts.GasStationScrollImplementation.proxyType, 'Expected a direct gas station implementation');
const beacon = await deploy('DrandBeacon', 'TransparentUpgradeableProxy', [state.contracts.DrandBeaconImplementation.address, owner, '0x']);
const gasStation = await deploy('GasStationScroll', 'TransparentUpgradeableProxy', [state.contracts.GasStationScrollImplementation.address, owner, '0x']);
const beaconContract = { address: beacon, abi: artifact('DrandBeacon').abi };
const oldBeacon = { address: state.previous.DrandBeacon.address, abi: beaconContract.abi };
for (const field of ['publicKey', 'publicKeyHash', 'genesisTimestamp', 'period']) {
  assert.equal(await read(beaconContract, field), await read(oldBeacon, field), `Beacon ${field} must not change`);
}
const consumerImpl = await deploy('RandomnessDemoImplementation', 'RandomnessDemo');
const init = encodeFunctionData({ abi: artifact('RandomnessDemo').abi, functionName: 'initialize', args: [coordinator.address, beacon] });
await deploy('RandomnessDemo', 'TransparentUpgradeableProxy', [consumerImpl, owner, init]);

const update = async (functionName, value) => {
  const result = await sendContract({ ...c, contract: coordinator, functionName, args: [value] });
  state.calls[functionName] = { transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString() };
  writeJson(evidenceFile, state);
};
const hash = await read(beaconContract, 'publicKeyHash');
if ((await read(coordinator, 'beacon', [hash])).toLowerCase() !== beacon.toLowerCase()) await update('setBeacon', beacon);
if ((await read(coordinator, 'gasStation')).toLowerCase() !== gasStation.toLowerCase()) await update('setGasStation', gasStation);
if (await read(coordinator, 'requestPremiumMultiplierBps') !== 15000n) await update('setRequestPremiumMultiplierBps', 15000n);
for (const name of ['DrandBeacon', 'GasStationScroll', 'RandomnessDemo']) {
  const meta = await proxyInfo(c.publicClient, state.contracts[name].address);
  assert.equal(meta.upgradeOwner.toLowerCase(), owner.toLowerCase());
  assert.equal(meta.implementation.toLowerCase(), state.contracts[`${name}Implementation`].address.toLowerCase());
  Object.assign(state.contracts[name], meta);
}
Object.assign(d.contracts.Coordinator, await proxyInfo(c.publicClient, coordinator.address, 'uups'));
d.retiredConsumers ??= [];
const previous = state.previous.RandomnessDemo;
if (!d.retiredConsumers.some(v => v.address.toLowerCase() === previous.address.toLowerCase())) {
  d.retiredConsumers.push({ ...previous, reason: 'Direct consumer replaced by an initialized upgradeable proxy; historical requests remain at this address' });
}
Object.assign(d.contracts, state.contracts);
d.policy = { ...d.policy, requestPremiumMultiplierBps: 15000, delivery: 'automatic', paymentHeadroomBps: 2500,
  maxPaymentDoge: '0.5', withdrawMinDoge: '0.1', maxAutoFulfillments: 0 };
d.upgradeability = { migratedAt: new Date().toISOString(), owner, custody: 'Existing testnet owner EOA; production multisig not configured',
  coordinator: 'UUPS', otherComponents: 'OpenZeppelin TransparentUpgradeableProxy + individual ProxyAdmin', calls: state.calls };
if (state.calls.setRequestPremiumMultiplierBps) d.paidActivation = state.calls.setRequestPremiumMultiplierBps;
delete d.railway;
state.completedAt = d.upgradeability.migratedAt;
writeJson(evidenceFile, state);
writeJson(deploymentPath(), d);
console.log(JSON.stringify({ coordinator: coordinator.address, consumer: state.contracts.RandomnessDemo, upgradeability: d.upgradeability }, null, 2));
