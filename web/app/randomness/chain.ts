import { createPublicClient, defineChain, http, parseAbi, type Address } from 'viem';
import deployment from './deployment.json';

export const config = deployment;
export const chain = defineChain({ id: config.chainId, name: 'DogeOS Chikyu',
  nativeCurrency: { name: 'DOGE', symbol: 'DOGE', decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: 'L2Scan', url: config.explorer } }, testnet: true });
export const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15000, batch: { batchSize: 15, wait: 20 } }), pollingInterval: 2000 });
export const demo = { address: config.consumer as Address, abi: parseAbi([
  'function requestRoll(bool automatic) payable returns (uint256)',
  'function quote() view returns (uint256)',
  'function rollCount() view returns (uint256)',
  'function recentIds(uint256 limit) view returns (uint256[])',
  'function pubKeyHash() view returns (bytes32)',
  'function diceFace(uint256 word) pure returns (uint8)',
  'struct Roll { address player; uint64 requestedAt; uint64 requestBlock; uint64 round; bool automatic; bool fulfilled; uint8 face; uint256 word; }',
  'function getRoll(uint256 id) view returns (Roll)',
  'event RollRequested(uint256 indexed requestId, address indexed player, bool automatic, uint256 round)',
  'event RollFulfilled(uint256 indexed requestId, address indexed player, uint256 word, uint8 face)',
]) };
export const coordinator = { address: config.coordinator as Address, abi: parseAbi([
  'function getRequestState(uint256 id) view returns (uint8)',
  'function fulfillRandomness(uint256 id, address requester, bytes32 pubKeyHash, uint256 round, uint256 callbackGasLimit, uint256[2] signature)',
  'event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackSuccess, uint256 actualGasUsed)',
]) };
export const beacon = { address: config.beacon as Address, abi: parseAbi(['function verifyBeaconRound(uint256 round, uint256[2] signature) view']) };
export type Roll = { id: bigint; player: Address; requestedAt: bigint; requestBlock: bigint; round: bigint; automatic: boolean; fulfilled: boolean; face: number; word: bigint; state: number };
export async function readRoll(id: bigint): Promise<Roll> {
  const [roll, state] = await Promise.all([
    client.readContract({ ...demo, functionName: 'getRoll', args: [id] }),
    client.readContract({ ...coordinator, functionName: 'getRequestState', args: [id] }),
  ]);
  return { id, ...roll, state };
}
export async function fetchProof(round: bigint) {
  let lastError: unknown;
  for (const relay of ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh']) {
    try {
      const response = await fetch(`${relay}/v2/beacons/${config.beaconHash}/rounds/${round}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`drand: HTTP ${response.status}`);
      const data = await response.json() as { round: number; signature: string };
      if (BigInt(data.round) !== round || !/^[0-9a-f]{128}$/i.test(data.signature)) throw new Error('La prueba recibida no corresponde a esta ronda.');
      const signature: readonly [bigint, bigint] = [BigInt(`0x${data.signature.slice(0, 64)}`), BigInt(`0x${data.signature.slice(64)}`)];
      await client.readContract({ ...beacon, functionName: 'verifyBeaconRound', args: [round, signature] });
      return { signature, hex: `0x${data.signature}` };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
