import { formatEther } from 'viem';
import { clients, assertChikyu, readDeployment, contract, stringify } from '../lib/chain.mjs';
const { publicClient } = clients(); await assertChikyu(publicClient);
const d = readDeployment(), demo = contract(d, 'RandomnessDemo');
const ids = await publicClient.readContract({ ...demo, functionName: 'recentIds', args: [10n] });
const rolls = await Promise.all(ids.map(async id => ({ id, ...await publicClient.readContract({ ...demo, functionName: 'getRoll', args: [id] }) })));
console.log(stringify({ chainId: d.chainId, contracts: d.contracts, balanceDoge: formatEther(await publicClient.getBalance({ address: d.deployer })), rolls }));
