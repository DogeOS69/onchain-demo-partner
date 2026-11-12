import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../node_modules/@pimlico/alto/', import.meta.url);
const info = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
assert.equal(info.version, '0.0.21', 'Review the loopback patch when upgrading Alto');
const path = fileURLToPath(new URL('esm/rpc/server.js', directory));
const source = await readFile(path, 'utf8');
const before = 'this.fastify.listen({ port: this.config.port, host: "0.0.0.0" });';
const after = 'this.fastify.listen({ port: this.config.port, host: "127.0.0.1" });';
if (!source.includes(after)) {
  assert.equal(source.split(before).length, 2, 'Unexpected Alto listener');
  await writeFile(path, source.replace(before, after));
}
console.log('Alto listens on loopback only.');
