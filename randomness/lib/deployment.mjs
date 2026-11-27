import fs from 'node:fs';
import path from 'node:path';
import { encodeDeployData, getContractAddress, keccak256, formatEther, parseEther, getAddress } from 'viem';
import { artifact, root, writeJson, waitSuccess } from './chain.mjs';
import { estimateTotal } from './transactions.mjs';

export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export async function proxyInfo(publicClient, address, kind = 'transparent') {
  const at = async slot => getAddress(`0x${(await publicClient.getStorageAt({ address, slot })).slice(-40)}`);
  const implementation = await at(IMPLEMENTATION_SLOT);
  if (kind === 'uups') return { proxyType: 'uups', implementation,
    upgradeOwner: await publicClient.readContract({ address, abi: artifact('Anyrand').abi, functionName: 'owner' }) };
  const admin = await at(ADMIN_SLOT);
  const upgradeOwner = await publicClient.readContract({ address: admin, abi: artifact('ProxyAdmin').abi, functionName: 'owner' });
  return { proxyType: 'transparent', implementation, admin, upgradeOwner };
}

// The public manifest never contains signed raw transactions. Persist those in
// ignored .runtime files before broadcast so a retry cannot deploy a second copy.
export function deploymentWriter(c, state, file, prefix) {
  return async (name, artifactName, args = []) => {
    const saved = state.contracts[name];
    if (saved?.address) {
      const code = await c.publicClient.getCode({ address: saved.address });
      if (!code || code === '0x') throw new Error(`${name}: saved address has no code`);
      return saved.address;
    }
    const pendingFile = path.join(root, '.runtime', `${prefix}-${name}.json`);
    let pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile)) : null;
    if (!pending) {
      const a = artifact(artifactName);
      const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args });
      const estimate = await estimateTotal(c.publicClient, c.account, { data });
      if (estimate.upperCost > parseEther('5')) throw new Error(`${name}: exceeds 5 DOGE deployment cap`);
      if (await c.publicClient.getBalance({ address: c.account.address }) < estimate.upperCost + parseEther('5')) throw new Error(`${name}: insufficient balance with 5 DOGE keeper reserve`);
      const nonce = await c.publicClient.getTransactionCount({ address: c.account.address, blockTag: 'pending' });
      const raw = await c.walletClient.signTransaction({ data, nonce, gas: estimate.gas,
        maxFeePerGas: estimate.gasPrice, maxPriorityFeePerGas: estimate.gasPrice, type: 'eip1559' });
      pending = { raw, hash: keccak256(raw), address: getContractAddress({ from: c.account.address, nonce: BigInt(nonce) }),
        estimatedCostDoge: formatEther(estimate.upperCost) };
      writeJson(pendingFile, pending);
    }
    let receipt = await c.publicClient.getTransactionReceipt({ hash: pending.hash }).catch(() => null);
    if (!receipt) {
      try { await c.publicClient.sendRawTransaction({ serializedTransaction: pending.raw }); }
      catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
      receipt = await waitSuccess(c.publicClient, pending.hash);
    }
    if (receipt.status !== 'success') throw new Error(`${name}: deployment reverted ${pending.hash}`);
    state.contracts[name] = { address: receipt.contractAddress, transactionHash: pending.hash,
      blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), estimatedCostDoge: pending.estimatedCostDoge };
    writeJson(file, state);
    fs.unlinkSync(pendingFile);
    console.log(`${name}: ${receipt.contractAddress} (${pending.hash})`);
    return receipt.contractAddress;
  };
}
