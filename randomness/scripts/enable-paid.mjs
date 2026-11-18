import fs from 'node:fs';
import path from 'node:path';
import { encodeDeployData, getContractAddress, keccak256, parseEther, formatEther } from 'viem';
import { clients, assertChikyu, artifact, contract, readDeployment, deploymentPath, root, writeJson, waitSuccess } from '../lib/chain.mjs';
import { estimateTotal, sendContract } from '../lib/transactions.mjs';

// Run only while the signing keeper is stopped, using the existing testnet
// coordinator owner. This preserves the original AnyRand implementation.
if (process.env.KEEPER_STOPPED !== 'true') throw new Error('Stop the signing keeper and set KEEPER_STOPPED=true');
const c = clients({ signing: true }); await assertChikyu(c.publicClient);
const d = readDeployment(), coordinator = contract(d, 'Coordinator');
const owner = await c.publicClient.readContract({ ...coordinator, functionName: 'owner' });
if (owner.toLowerCase() !== c.account.address.toLowerCase()) throw new Error('The configured key must own this testnet coordinator');
const evidenceFile = path.join(root, '.runtime', 'paid-activation.json');
const evidence = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile)) : { coordinator: coordinator.address, previousConsumer: d.contracts.RandomnessDemo };
const nextArtifact = artifact('RandomnessDemo');
if (!evidence.consumer) {
  if (!evidence.signedDeployment) {
    const data = encodeDeployData({ abi: nextArtifact.abi, bytecode: nextArtifact.bytecode, args: [coordinator.address, d.contracts.DrandBeacon.address] });
    const estimate = await estimateTotal(c.publicClient, c.account, { data });
    if (estimate.upperCost > parseEther('3')) throw new Error('Consumer deployment exceeds 3 DOGE cap');
    const nonce = await c.publicClient.getTransactionCount({ address: c.account.address, blockTag: 'pending' });
    const raw = await c.walletClient.signTransaction({ data, nonce, gas: estimate.gas,
      maxFeePerGas: estimate.gasPrice, maxPriorityFeePerGas: estimate.gasPrice, type: 'eip1559' });
    evidence.signedDeployment = { raw, hash: keccak256(raw), address: getContractAddress({ from: c.account.address, nonce: BigInt(nonce) }), estimatedCostDoge: formatEther(estimate.upperCost) };
    writeJson(evidenceFile, evidence);
  }
  const pending = evidence.signedDeployment;
  let receipt = await c.publicClient.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
  if (!receipt) {
    try { await c.publicClient.sendRawTransaction({ serializedTransaction: pending.raw }); }
    catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
    receipt = await waitSuccess(c.publicClient, pending.hash);
  }
  if (receipt.status !== 'success') throw new Error('Consumer deployment reverted');
  evidence.consumer = { address: receipt.contractAddress, transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), estimatedCostDoge: pending.estimatedCostDoge };
  delete evidence.signedDeployment;
  writeJson(evidenceFile, evidence);
}
const multiplier = await c.publicClient.readContract({ ...coordinator, functionName: 'requestPremiumMultiplierBps' });
if (multiplier !== 15000n) {
  if (multiplier !== 0n) throw new Error(`Unexpected existing multiplier ${multiplier}`);
  const result = await sendContract({ ...c, contract: coordinator, functionName: 'setRequestPremiumMultiplierBps', args: [15000n] });
  evidence.activation = { transactionHash: result.hash, blockNumber: result.receipt.blockNumber.toString() };
  writeJson(evidenceFile, evidence);
}
d.retiredConsumers ??= [];
if (!d.retiredConsumers.some(v => v.address.toLowerCase() === evidence.previousConsumer.address.toLowerCase())) d.retiredConsumers.push({ ...evidence.previousConsumer, reason: 'Replaced by the paid consumer with bounded payment and immediate excess refund' });
d.contracts.RandomnessDemo = evidence.consumer;
d.policy = { ...d.policy, requestPremiumMultiplierBps: 15000, delivery: 'automatic', paymentHeadroomBps: 2500,
  maxPaymentDoge: '0.5', withdrawMinDoge: '0.1', maxAutoFulfillments: 0 };
d.paidActivation = evidence.activation;
delete d.railway;
writeJson(deploymentPath(), d);
console.log(JSON.stringify({ coordinator: coordinator.address, consumer: evidence.consumer, multiplier: 15000, activation: evidence.activation }, null, 2));
