import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'contracts/CounterPaymaster.sol';
const input = {
  language: 'Solidity', sources: { [name]: { content: readFileSync(resolve(root, name), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import(path) {
  try { return { contents: readFileSync(resolve(root, 'node_modules', path), 'utf8') }; }
  catch { return { error: `Import not found: ${path}` }; }
} }));
for (const error of output.errors ?? []) {
  if (error.severity === 'error') throw new Error(error.formattedMessage);
}
const result = output.contracts[name].CounterPaymaster;
const artifact = { contractName: 'CounterPaymaster', compiler: solc.version(),
  abi: result.abi, bytecode: `0x${result.evm.bytecode.object}`,
  deployedBytecode: `0x${result.evm.deployedBytecode.object}`, settings: input.settings };
const destination = resolve(root, 'artifacts/CounterPaymaster.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(artifact, null, 2) + '\n');
console.log(`Compiled CounterPaymaster (${artifact.compiler})`);
