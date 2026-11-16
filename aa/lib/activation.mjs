import { concat, formatEther, keccak256, numberToHex, serializeTransaction, toHex } from 'viem';
import { assertNetwork, feeOracle, oracleAbi, reader, same } from './chain.mjs';
import { ApiError, limits, ownerAddress } from './user-operation.mjs';
import { oraclePayload } from './data-fee.mjs';

export async function activationQuote(input, manifest, client = reader(manifest)) {
  await assertNetwork(client, manifest);
  const owner = ownerAddress(input);
  if (manifest.accountMode !== 'eip7702') throw new ApiError(400, '7702 is not enabled.');
  const code = await client.getCode({ address: owner });
  if (code && code !== '0x') throw new ApiError(409, same(code, concat(['0xef0100', manifest.delegate]))
    ? 'This wallet is already activated.' : 'This wallet already has another delegation or contract.');
  const delegateCode = await client.getCode({ address: manifest.delegate });
  if (!delegateCode || keccak256(delegateCode) !== manifest.contracts.Simple7702Account.runtimeCodeHash)
    throw new ApiError(409, 'Delegate code changed.');
  const [nonce, price] = await Promise.all([
    client.getTransactionCount({ address: owner, blockTag: 'pending' }), client.getGasPrice(),
  ]);
  const maxFeePerGas = price * 2n + 100n;
  if (maxFeePerGas > limits.maxFeePerGas) throw new ApiError(503, 'Gas prices exceed the demo limit.');
  const gas = 100_000n;
  const stub = label => keccak256(toHex(label));
  const raw = serializeTransaction({ type: 'eip7702', chainId: manifest.chainId, nonce,
    to: owner, data: '0x', value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 100n,
    authorizationList: [{ address: manifest.delegate, chainId: manifest.chainId, nonce: nonce + 1,
      r: stub('7702 auth r'), s: stub('7702 auth s'), yParity: 0 }],
  }, { r: stub('7702 transaction r'), s: stub('7702 transaction s'), yParity: 1 });
  let l1 = 0n;
  if (manifest.chainId !== 31337) {
    const galileo = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'isGalileo' });
    l1 = await client.readContract({ address: feeOracle, abi: oracleAbi, functionName: 'getL1Fee', args: [oraclePayload(raw, galileo)] });
  }
  const reserve = gas * maxFeePerGas + l1 * 150n / 100n;
  if (reserve > limits.maxCost) throw new ApiError(503, 'Activation cost exceeds the demo limit.');
  return { owner, delegate: manifest.delegate, chainId: manifest.chainId, genesisHash: manifest.genesisHash,
    nonce, authorizationNonce: nonce + 1, gas: numberToHex(gas), maxFeePerGas: numberToHex(maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(100n), reserveWei: String(reserve),
    maxChargeDoge: formatEther(reserve), expiresAt: Date.now() + 60_000 };
}
