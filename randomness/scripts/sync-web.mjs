import fs from 'node:fs';
import path from 'node:path';
import { root, readDeployment } from '../lib/chain.mjs';
const d = readDeployment();
if (!d.complete) throw new Error('Deploy the contracts before configuring the web app.');
const config = { chainId: d.chainId, rpcUrl: d.rpcUrl, explorer: d.explorer,
  consumer: d.contracts.RandomnessDemo.address, coordinator: d.contracts.Coordinator.address, beacon: d.contracts.DrandBeacon.address,
  deploymentBlock: d.contracts.RandomnessDemo.blockNumber, genesis: d.beacon.genesis_time, period: d.beacon.period,
  beaconHash: d.beacon.chain_hash, minConfirmations: d.policy.minConfirmations,
  keeperUrl: process.env.KEEPER_URL || d.keeperUrl || '', requestDelay: d.policy.delaySeconds,
};
fs.mkdirSync(path.join(root, '..', 'web', 'app', 'randomness'), { recursive: true });
fs.writeFileSync(path.join(root, '..', 'web', 'app', 'randomness', 'deployment.json'), JSON.stringify(config, null, 2) + '\n');
console.log(`Web configured for consumer ${config.consumer}`);
