import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createWalletClient, encodeDeployData, encodeFunctionData, formatEther, getContractAddress,
  http, keccak256, parseEther, serializeTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifact, chain, feeOracle, oracleAbi, readJson, reader, root, same, saveJson } from '../lib/chain.mjs';

const execute = process.argv.includes('--deploy');
const keyFile = process.env.SPONSOR_KEY_FILE;
assert(keyFile, 'Set SPONSOR_KEY_FILE to a private path outside the repository');
let keys = await readJson(keyFile, null);
if (!keys) {
  keys = { deployerPrivateKey: generatePrivateKey(), quotePrivateKey: generatePrivateKey(), executorPrivateKey: generatePrivateKey() };
  await saveJson(keyFile, keys);
}
const deployer = privateKeyToAccount(keys.deployerPrivateKey);
const signer = privateKeyToAccount(keys.quotePrivateKey);
const executor = privateKeyToAccount(keys.executorPrivateKey);
const client = reader();
assert.equal(await client.getChainId(), chain.id);
const base = await readJson(resolve(root, 'config/chikyu-base.json'));
const compiled = await artifact('CounterPaymaster');
const data = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode, args: [base.entryPoint, signer.address, base.counter] });
const gas = await client.estimateGas({ account: deployer.address, data }).catch(() => 2_500_000n);
const l1 = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [`0x${'ff'.repeat(256)}${data.slice(2)}`] });
const block = await client.getBlock();
const maxFeePerGas = (block.baseFeePerGas ?? 50_000_000n) * 2n + 100n;
assert(maxFeePerGas < 500_000_000n, 'Unexpected network gas price');
console.log(JSON.stringify({ chainId: chain.id, deployer: deployer.address, quoteSigner: signer.address,
  executor: executor.address, deploymentEstimateDoge: formatEther(gas * maxFeePerGas + l1),
  initialFundingDoge: '5', executorFundingDoge: '3.5', paymasterDepositDoge: '0.1', stakeDoge: '0.1' }, null, 2));
assert(gas * maxFeePerGas + l1 * 125n / 100n < parseEther('1.5'), 'Deployment exceeds the 1.5-DOGE cap');
if (!execute) process.exit(0);
const progressPath = `${keyFile}.deployment.private.json`;
const progress = await readJson(progressPath, { chainId: chain.id, deployer: deployer.address, transactions: {} });
assert.equal(progress.chainId, chain.id); assert(same(progress.deployer, deployer.address));
async function send(label, account, transaction, ceiling = parseEther('0.2')) {
  let record = progress.transactions[label];
  if (!record) {
    const pending = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    assert.equal(pending, await client.getTransactionCount({ address: account.address, blockTag: 'latest' }), 'Sender already has a pending transaction');
    const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });
    const latest = await client.getBlock();
    const prepared = await wallet.prepareTransactionRequest({ ...transaction, type: 'eip1559', nonce: pending,
      maxFeePerGas: (latest.baseFeePerGas ?? 50_000_000n) * 2n + 100n, maxPriorityFeePerGas: 100n });
    prepared.gas = prepared.gas * 120n / 100n;
    const bytes = serializeTransaction({ ...prepared, chainId: chain.id });
    const dataFee = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [`0x${'ff'.repeat(128)}${bytes.slice(2)}`] });
    const reserve = prepared.gas * prepared.maxFeePerGas + dataFee * 125n / 100n;
    assert(reserve < ceiling, `${label} exceeds the network fee cap`);
    assert(await client.getBalance({ address: account.address }) > (transaction.value ?? 0n) + reserve + (label === 'fund-deployer' ? parseEther('2') : 0n), 'Insufficient bounded funding');
    const raw = await wallet.signTransaction(prepared);
    record = { hash: keccak256(raw), raw, nonce: pending, from: account.address };
    progress.transactions[label] = record;
    await saveJson(progressPath, progress);
  }
  let receipt = await client.getTransactionReceipt({ hash: record.hash }).catch(() => null);
  if (!receipt) {
    await client.sendRawTransaction({ serializedTransaction: record.raw }).catch(async error => {
      if (!await client.getTransaction({ hash: record.hash }).catch(() => null)) throw error;
    });
    receipt = await client.waitForTransactionReceipt({ hash: record.hash, confirmations: 18, timeout: 180_000, pollingInterval: 3000 });
  } else {
    receipt = await client.waitForTransactionReceipt({ hash: record.hash, confirmations: 18, timeout: 180_000, pollingInterval: 3000 });
  }
  assert.equal(receipt.status, 'success', `${label} reverted`);
  record.blockNumber = String(receipt.blockNumber); await saveJson(progressPath, progress);
  console.log(`${label}: ${record.hash}`);
  return receipt;
}
if (!progress.transactions['fund-deployer'] && await client.getBalance({ address: deployer.address }) < parseEther('4.8')) {
  const funding = await readJson(process.env.FUNDING_KEY_FILE);
  await send('fund-deployer', privateKeyToAccount(funding.privateKey), { to: deployer.address, value: parseEther('5') });
} else if (progress.transactions['fund-deployer']) {
  const funding = await readJson(process.env.FUNDING_KEY_FILE);
  await send('fund-deployer', privateKeyToAccount(funding.privateKey), {});
}
const deployed = await send('deploy-paymaster', deployer, { data }, parseEther('1.5'));
const address = deployed.contractAddress ?? getContractAddress({ from: deployer.address, nonce: BigInt(progress.transactions['deploy-paymaster'].nonce) });
await send('fund-executor', deployer, { to: executor.address, value: parseEther('3.5') });
await send('deposit', deployer, { to: address, value: parseEther('0.1'), data: encodeFunctionData({ abi: compiled.abi, functionName: 'deposit' }) });
await send('stake', deployer, { to: address, value: parseEther('0.1'), data: encodeFunctionData({ abi: compiled.abi, functionName: 'addStake', args: [86400] }) });
const manifest = { ...base, paymaster: address, quoteSigner: signer.address, executor: executor.address,
  deployer: deployer.address, deploymentBlock: String(deployed.blockNumber),
  contracts: { ...base.contracts,
    SimpleAccount: { address: base.accountImplementation, runtimeCodeHash: keccak256(await client.getCode({ address: base.accountImplementation })) },
    Counter: { address: base.counter, runtimeCodeHash: keccak256(await client.getCode({ address: base.counter })) },
    CounterPaymaster: { address, runtimeCodeHash: keccak256(await client.getCode({ address })), transactionHash: deployed.transactionHash } },
  transactions: Object.fromEntries(Object.entries(progress.transactions).map(([name, tx]) => [name, { hash: tx.hash, blockNumber: tx.blockNumber }])) };
await saveJson(resolve(root, 'config/chikyu.json'), manifest);
console.log('Deployment verified with 18 confirmations. Public manifest saved.');
