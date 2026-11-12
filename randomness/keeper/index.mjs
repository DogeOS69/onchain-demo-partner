import http from 'node:http';
import { clients, assertChikyu, readDeployment, contract } from '../lib/chain.mjs';
import { createKeeper } from './worker.mjs';

const c = clients({ signing: true });
await assertChikyu(c.publicClient);
const deployment = readDeployment();
if (!deployment.complete) throw new Error('Incomplete deployment manifest');
const worker = createKeeper({ ...c, demo: contract(deployment, 'RandomnessDemo'), coordinator: contract(deployment, 'Coordinator'),
  beacon: contract(deployment, 'DrandBeacon'), minConfirmations: Number(process.env.MIN_CONFIRMATIONS || 18),
  minBalanceDoge: process.env.MIN_BALANCE_DOGE || '2', maxCostDoge: process.env.MAX_TX_COST_DOGE || '0.2',
  maxAutoFulfillments: Number(process.env.MAX_AUTO_FULFILLMENTS || 100) });
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET' || !['/health', '/status', '/'].includes(req.url)) { res.writeHead(404); res.end('{"error":"Not found"}'); return; }
  res.end(JSON.stringify({ ...worker.status, chainId: deployment.chainId, consumer: deployment.contracts.RandomnessDemo.address }));
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; server.close(); });
console.log(JSON.stringify({ event: 'started', wallet: c.account.address, consumer: deployment.contracts.RandomnessDemo.address }));
let failures = 0;
while (!stopped) {
  await worker.tick();
  failures = worker.status.lastError ? Math.min(4, failures + 1) : 0;
  if (!stopped) await new Promise(resolve => setTimeout(resolve, Math.min(60000, Number(process.env.KEEPER_POLL_MS || 4000) * 2 ** failures)));
}
