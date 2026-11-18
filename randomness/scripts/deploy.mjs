import fs from 'node:fs';
import { encodeFunctionData, formatEther } from 'viem';
import { chain, clients, assertChikyu, artifact, writeJson, deploymentPath } from '../lib/chain.mjs';
import { fetchInfo, publicKeyToEvm } from '../lib/drand.mjs';
import { deploymentWriter, proxyInfo } from '../lib/deployment.mjs';

const c = clients({ signing: true });
const { publicClient, account } = c;
await assertChikyu(publicClient);
const file = deploymentPath();
const info = await fetchInfo();
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (existing && (existing.chainId !== chain.id || existing.deployer.toLowerCase() !== account.address.toLowerCase())) throw new Error('Deployment manifest chain/deployer mismatch');
if (existing?.contracts?.RandomnessDemo && !existing.contracts.RandomnessDemo.proxyType && !existing.contracts.RandomnessDemoImplementation) throw new Error('Existing direct contracts: stop the keeper and use scripts/make-upgradeable.mjs');
const deployment = existing ?? {
  chainId: chain.id, network: chain.name, rpcUrl: chain.rpcUrls.default.http[0], explorer: chain.blockExplorers.default.url,
  deployer: account.address, createdAt: new Date().toISOString(), beacon: info,
  policy: { delaySeconds: 90, minConfirmations: 18, callbackGasLimit: 150000, requestPremiumMultiplierBps: 15000,
    delivery: 'automatic', paymentHeadroomBps: 2500, maxPaymentDoge: '0.5', withdrawMinDoge: '0.1', maxAutoFulfillments: 0 }, contracts: {},
};
writeJson(file, deployment);
const deploy = deploymentWriter(c, deployment, file, 'deploy-upgradeable');
const beaconImpl = await deploy('DrandBeaconImplementation', 'DrandBeacon', [publicKeyToEvm(info.public_key), BigInt(info.genesis_time), BigInt(info.period)]);
const beacon = await deploy('DrandBeacon', 'TransparentUpgradeableProxy', [beaconImpl, account.address, '0x']);
const gasImpl = await deploy('GasStationScrollImplementation', 'GasStationScroll', []);
const gasStation = await deploy('GasStationScroll', 'TransparentUpgradeableProxy', [gasImpl, account.address, '0x']);
const implementation = await deploy('Anyrand', 'Anyrand', []);
const init = encodeFunctionData({ abi: artifact('Anyrand').abi, functionName: 'init', args: [beacon, 15000n, 200000n, 300n, gasStation, 1000000000000n] });
const coordinator = await deploy('Coordinator', 'ERC1967Proxy', [implementation, init]);
const consumerImpl = await deploy('RandomnessDemoImplementation', 'RandomnessDemo', []);
const consumerInit = encodeFunctionData({ abi: artifact('RandomnessDemo').abi, functionName: 'initialize', args: [coordinator, beacon] });
await deploy('RandomnessDemo', 'TransparentUpgradeableProxy', [consumerImpl, account.address, consumerInit]);
for (const name of ['Coordinator', 'DrandBeacon', 'GasStationScroll', 'RandomnessDemo']) {
  Object.assign(deployment.contracts[name], await proxyInfo(publicClient, deployment.contracts[name].address, name === 'Coordinator' ? 'uups' : 'transparent'));
}
deployment.complete = true;
deployment.upgradeability = { owner: account.address, custody: 'Existing testnet owner EOA; production multisig not configured',
  coordinator: 'UUPS', otherComponents: 'OpenZeppelin TransparentUpgradeableProxy + individual ProxyAdmin' };
deployment.balanceAfterDeploymentDoge = formatEther(await publicClient.getBalance({ address: account.address }));
writeJson(file, deployment);
console.log(`Deployment complete. Remaining balance: ${deployment.balanceAfterDeploymentDoge} DOGE`);
