import fs from 'node:fs';
import path from 'node:path';
import { encodeDeployData, encodeFunctionData, getContractAddress, keccak256, formatEther, parseEther } from 'viem';
import { root, chain, clients, assertChikyu, artifact, writeJson, deploymentPath, waitSuccess } from '../lib/chain.mjs';
import { fetchInfo, publicKeyToEvm } from '../lib/drand.mjs';
import { estimateTotal } from '../lib/transactions.mjs';

const { publicClient, walletClient, account } = clients({ signing: true });
await assertChikyu(publicClient);
const file = deploymentPath();
const info = await fetchInfo();
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (existing && (existing.chainId !== chain.id || existing.deployer.toLowerCase() !== account.address.toLowerCase())) throw new Error('Deployment manifest chain/deployer mismatch');
const deployment = existing ?? {
  chainId: chain.id, network: chain.name, rpcUrl: chain.rpcUrls.default.http[0], explorer: chain.blockExplorers.default.url,
  deployer: account.address, createdAt: new Date().toISOString(), beacon: info,
  policy: { delaySeconds: 90, minConfirmations: 18, callbackGasLimit: 150000, requestPremiumMultiplierBps: 0 }, contracts: {},
};
writeJson(file, deployment);
async function deploy(name, artifactName, args) {
  const saved = deployment.contracts[name];
  if (saved?.address && await publicClient.getCode({ address: saved.address })) {
    console.log(`Reuse ${name}: ${saved.address}`); return saved.address;
  }
  const pendingFile = path.join(root, '.runtime', `deploy-${name}.json`);
  let pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : null;
  if (!pending) {
    const a = artifact(artifactName);
    const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
    const estimate = await estimateTotal(publicClient, account, { data });
    if (estimate.upperCost > parseEther('5')) throw new Error(`${name}: cost exceeds 5 DOGE deployment cap`);
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < estimate.upperCost + parseEther('5')) throw new Error(`${name}: insufficient testnet DOGE with 5 DOGE keeper reserve`);
    const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
    const raw = await walletClient.signTransaction({ data, nonce, gas: estimate.gas, gasPrice: estimate.gasPrice, type: 'legacy' });
    pending = { raw, hash: keccak256(raw), address: getContractAddress({ from: account.address, nonce: BigInt(nonce) }), estimatedCostDoge: formatEther(estimate.upperCost) };
    writeJson(pendingFile, pending); // Persist before broadcast: retries use exactly the same signed transaction.
    console.log(`${name}: estimated upper cost ${pending.estimatedCostDoge} DOGE`);
  }
  let receipt = await publicClient.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
  if (!receipt) {
    try { await publicClient.sendRawTransaction({ serializedTransaction: pending.raw }); }
    catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
    receipt = await waitSuccess(publicClient, pending.hash);
  }
  if (receipt.status !== 'success') throw new Error(`${name}: deployment reverted ${pending.hash}; inspect before retrying`);
  deployment.contracts[name] = { address: receipt.contractAddress, transactionHash: pending.hash, blockNumber: receipt.blockNumber.toString(), estimatedCostDoge: pending.estimatedCostDoge, gasUsed: receipt.gasUsed.toString() };
  writeJson(file, deployment);
  fs.unlinkSync(pendingFile);
  console.log(`${name}: ${receipt.contractAddress} (${pending.hash})`);
  return receipt.contractAddress;
}
const beacon = await deploy('DrandBeacon', 'DrandBeacon', [publicKeyToEvm(info.public_key), BigInt(info.genesis_time), BigInt(info.period)]);
const gasStation = await deploy('GasStationScroll', 'GasStationScroll', []);
const implementation = await deploy('Anyrand', 'Anyrand', []);
const init = encodeFunctionData({ abi: artifact('Anyrand').abi, functionName: 'init', args: [beacon, 0n, 200000n, 300n, gasStation, 1000000000000n] });
const coordinator = await deploy('Coordinator', 'ERC1967Proxy', [implementation, init]);
await deploy('RandomnessDemo', 'RandomnessDemo', [coordinator, beacon]);
deployment.complete = true;
deployment.balanceAfterDeploymentDoge = formatEther(await publicClient.getBalance({ address: account.address }));
writeJson(file, deployment);
console.log(`Deployment complete. Remaining balance: ${deployment.balanceAfterDeploymentDoge} DOGE`);
