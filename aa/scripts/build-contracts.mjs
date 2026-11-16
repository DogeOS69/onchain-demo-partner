import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { entryPoint09Abi } from 'viem/account-abstraction';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = resolve(root, 'vendor/account-abstraction');
const provenance = JSON.parse(readFileSync(resolve(vendor, 'SOURCE.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = {};
for (const [path, expected] of Object.entries(provenance.files)) {
  const bytes = readFileSync(resolve(vendor, path));
  assert.equal(sha256(bytes), expected, `Upstream source changed: ${path}`);
  sources[path] = { content: bytes.toString() };
}
const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
  settings: { evmVersion: 'cancun', viaIR: true, optimizer: { enabled: true, runs: 1000000 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import(path) {
  try { return { contents: readFileSync(resolve(root, 'node_modules', path), 'utf8') }; }
  catch { return { error: `Unknown import: ${path}` }; }
} }));
const errors = output.errors?.filter(error => error.severity === 'error') ?? [];
assert.equal(errors.length, 0, errors.map(error => error.formattedMessage).join('\n'));
const destination = resolve(root, 'artifacts');
mkdirSync(destination, { recursive: true });
for (const name of ['SimpleAccount', 'SimpleAccountFactory', 'Simple7702Account']) {
  const compiled = output.contracts[`accounts/${name}.sol`][name];
  writeFileSync(resolve(destination, `${name}.json`), JSON.stringify({ contractName: name,
    abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`, upstreamCommit: provenance.commit }));
}
// Use the exact creation bytes shipped by DogeOS preinstalls, including the
// canonical compiler metadata. Recompilation is not substituted for this pin.
const creation = readFileSync(resolve(vendor, 'entry-point-v09.bin'));
assert.equal(sha256(creation), provenance.entryPointCreation.sha256, 'EntryPoint creation code changed');
writeFileSync(resolve(destination, 'EntryPoint.json'), JSON.stringify({
  contractName: 'EntryPoint', abi: entryPoint09Abi, bytecode: `0x${creation.toString('hex')}`,
  upstreamCommit: provenance.commit, entryPointVersion: '0.9',
}));
console.log('Built final v0.9 accounts; verified the DogeOS canonical EntryPoint creation bytes.');
