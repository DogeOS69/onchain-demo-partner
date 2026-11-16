import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function compile() {
  const entries = [
    'contracts/RandomnessDemo.sol',
    'vendor/anyrand/contracts/Anyrand.sol',
    'vendor/anyrand/contracts/beacon/DrandBeacon.sol',
    'vendor/anyrand/contracts/networks/GasStationScroll.sol',
    'vendor/anyrand/contracts/networks/GasStationEthereum.sol',
    '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol',
    'test/MockCoordinator.sol',
  ];
  const sources = {};
  const resolve = name => fs.readFileSync(path.join(root, name.startsWith('@') || name.startsWith('solady/') ? 'node_modules' : '', name), 'utf8');
  for (const name of entries) sources[name] = { content: resolve(name) };
  const input = {
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    try { const content = resolve(name); sources[name] = { content }; return { contents: content }; }
    catch { return { error: `Cannot resolve ${name}` }; }
  } }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  const artifacts = {};
  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, c] of Object.entries(contracts)) {
      if (!c.evm.bytecode.object) continue;
      const artifact = { contractName, sourceName, compiler: solc.version(), abi: c.abi,
        bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}` };
      artifacts[contractName] = artifact;
      fs.writeFileSync(path.join(root, 'artifacts', `${contractName}.json`), JSON.stringify(artifact, null, 2) + '\n');
    }
  }
  // Fully expanded standard JSON input, suitable for explorer verification.
  fs.writeFileSync(path.join(root, 'artifacts', 'standard-input.json'), JSON.stringify({ ...input, sources }, null, 2) + '\n');
  return artifacts;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifacts = compile();
  console.log(JSON.stringify({ compiler: solc.version(), target: 'cancun', contracts: Object.keys(artifacts) }));
}
