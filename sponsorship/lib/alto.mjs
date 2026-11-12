import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, saveJson } from './chain.mjs';

export function makeBundlerRpc(port = 43371) {
  let id = 0;
  return async (method, params = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/v2/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Bundler HTTP ${response.status}`);
    const value = await response.json();
    if (value.error) { const error = new Error(value.error.message); error.code = value.error.code; throw error; }
    return value.result;
  };
}
export async function launchAlto({ manifest, executorPrivateKey, stateDir, port = 43371 }) {
  const source = await readFile(resolve(root, 'node_modules/@pimlico/alto/esm/rpc/server.js'), 'utf8');
  assert(source.includes('host: "127.0.0.1"'), 'Apply the Alto loopback patch first');
  const configPath = resolve(stateDir, 'alto.private.json');
  await saveJson(configPath, {
    entrypoints: manifest.entryPoint, 'rpc-url': manifest.rpcUrl,
    'executor-private-keys': executorPrivateKey, 'utility-private-key': executorPrivateKey,
    'refilling-wallets': false, 'deploy-simulations-contract': false,
    'pimlico-simulation-contract': manifest.pimlicoSimulations,
    'entrypoint-simulation-contract-v7': manifest.entryPointSimulations,
    'safe-mode': false, 'eip-7702-support': false, 'enable-debug-endpoints': false,
    'chain-type': 'default', 'chain-native-decimals': 18, 'supports-eip7623': false,
    'max-gas-per-user-op': '1500000', 'max-executors': 1,
    'simulation-call-gas-limit': '200000', 'simulation-verification-gas-limit': '500000',
    'simulation-paymaster-verification-gas-limit': '200000', 'simulation-paymaster-post-op-gas-limit': '0',
    'binary-search-gas-allowance': '500000', 'binary-search-max-retries': 2,
    'v7-verification-gas-limit-multiplier': '130', 'v7-call-gas-limit-multiplier': '130',
    'block-time': 3000, 'block-polling-interval': 1000,
    // Chikyu accepts a 100 wei priority fee; avoid Ethereum-sized fallback tips.
    'static-max-priority-fee-per-gas': '0.0000001',
    'min-bundle-interval': 1000, 'max-bundle-interval': 2000,
    'send-handle-ops-retry-count': 1, 'max-block-range': 400,
    'mempool-max-parallel-ops': 1, 'mempool-max-queued-ops': 0,
    'enable-redis-receipt-cache': false, 'enable-horizontal-scaling': false,
    'log-level': 'warn', 'public-client-log-level': 'error', 'wallet-client-log-level': 'error',
    json: true, port, 'default-api-version': 'v2', 'enable-cors': false,
  });
  const child = spawn(process.execPath, [resolve(root, 'node_modules/@pimlico/alto/esm/cli/alto.js'), 'run', '--config', configPath], {
    cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk =>
    process.stderr.write(`[alto] ${chunk.toString().replace(/0x[0-9a-f]{64,}/gi, '[redacted]').slice(0, 2000)}`));
  const rpc = makeBundlerRpc(port);
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error('Bundler exited during startup');
    try {
      const points = await rpc('eth_supportedEntryPoints');
      assert.equal(points.length, 1);
      assert.equal(points[0].toLowerCase(), manifest.entryPoint.toLowerCase());
      return { child, rpc };
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  child.kill('SIGTERM');
  throw new Error('Bundler startup timed out');
}
