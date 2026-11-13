import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { launchAlto } from './lib/alto.mjs';
import { createEngine } from './lib/engine.mjs';
import { chainId, json, readJson, root, rpcUrl, safeError } from './lib/chain.mjs';
import { ApiError } from './lib/user-operation.mjs';

const manifest = await readJson(resolve(root, 'config/chikyu.json'));
assert(manifest.chainId === chainId && manifest.rpcUrl === rpcUrl, 'This server only serves Chikyu');
const stateDir = resolve(process.env.SPONSOR_STATE_DIR ?? resolve(root, '.runtime'));
const keys = process.env.SPONSOR_QUOTE_PRIVATE_KEY ? {
  quotePrivateKey: process.env.SPONSOR_QUOTE_PRIVATE_KEY,
  executorPrivateKey: process.env.BUNDLER_EXECUTOR_PRIVATE_KEY,
} : await readJson(process.env.SPONSOR_KEY_FILE ?? resolve(root, '.runtime/keys.json'));
const executor = privateKeyToAccount(keys.executorPrivateKey).address;
assert(executor.toLowerCase() === manifest.executor.toLowerCase(), 'Wrong bundler executor');
const webOrigin = process.env.WEB_ORIGIN ? new URL(process.env.WEB_ORIGIN).origin : undefined;
let engine, alto, timer, ready = false;
const rates = new Map();
let globalWrites = [];
const commonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
function respond(request, response, status, value) {
  const origin = request.headers.origin;
  response.writeHead(status, { ...commonHeaders,
    ...(webOrigin && origin === webOrigin ? { 'access-control-allow-origin': webOrigin, vary: 'Origin' } : {}) });
  response.end(json(value));
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'JSON is required.');
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 2048) throw new ApiError(413, 'Request too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ApiError(400, 'Invalid JSON.'); }
}
function limitWrites(request) {
  const now = Date.now();
  globalWrites = globalWrites.filter(t => t > now - 60_000);
  const key = request.socket.remoteAddress ?? 'unknown';
  const times = (rates.get(key) ?? []).filter(t => t > now - 60_000);
  if (times.length >= 12 || globalWrites.length >= 40) throw new ApiError(429, 'Wait a moment before trying again.');
  times.push(now); rates.set(key, times); globalWrites.push(now);
  if (rates.size > 1000) for (const [address, values] of rates) if (values.at(-1) < now - 60_000) rates.delete(address);
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://service.invalid').pathname;
    if (request.method === 'OPTIONS') {
      if (!webOrigin || request.headers.origin !== webOrigin) throw new ApiError(403, 'Origin is not allowed.');
      response.writeHead(204, { ...commonHeaders, 'access-control-allow-origin': webOrigin,
        'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Content-Type', vary: 'Origin' });
      return response.end();
    }
    if (request.method === 'GET' && path === '/health') return respond(request, response, ready ? 200 : 503, { ready, chainId });
    if (!ready) throw new ApiError(503, 'Sponsorship is starting. Try again shortly.');
    if (request.method === 'GET' && path === '/config') return respond(request, response, 200, await engine.config());
    if (request.method === 'POST') {
      if (request.headers.origin && request.headers.origin !== webOrigin) throw new ApiError(403, 'Origin is not allowed.');
      limitWrites(request);
      const input = await body(request);
      if (path === '/prepare') return respond(request, response, 200, await engine.prepare(input.owner));
      if (path === '/submit') {
        if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.id)) throw new ApiError(400, 'Invalid operation ID.');
        return respond(request, response, 202, await engine.submit(input.id, input.signature));
      }
    }
    const match = path.match(/^\/operations\/([0-9a-f-]{36})$/);
    if (request.method === 'GET' && match) return respond(request, response, 200, engine.status(match[1]));
    throw new ApiError(404, 'Not found.');
  } catch (error) {
    const expected = error instanceof ApiError;
    if (!expected) console.error(safeError(error));
    respond(request, response, expected ? error.status : 503,
      { error: expected ? error.message : 'Sponsorship is temporarily unavailable. Try again shortly.' });
  }
});
server.requestTimeout = 60_000; server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 4341), process.env.RAILWAY_SERVICE_ID ? '::' : '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  ready = false; clearInterval(timer); alto?.child.kill('SIGTERM'); server.close();
  setTimeout(() => process.exit(0), 1000).unref();
});
try {
  alto = await launchAlto({ manifest, executorPrivateKey: keys.executorPrivateKey, stateDir });
  alto.child.on('exit', () => { ready = false; server.close(() => process.exit(1)); });
  engine = await createEngine({ manifest, quotePrivateKey: keys.quotePrivateKey, executor, rpc: alto.rpc, stateDir });
  ready = true;
  timer = setInterval(() => void engine.tick().catch(error => console.error(safeError(error))), 4000);
  void engine.tick();
  console.log('Sponsored counter ready on Chikyu.');
} catch (error) {
  console.error(`Startup failed: ${safeError(error)}`);
  alto?.child.kill('SIGTERM'); server.close(() => process.exit(1));
}
