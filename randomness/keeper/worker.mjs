import { parseEther } from 'viem';
import { fetchRound, signatureToEvm } from '../lib/drand.mjs';
import { sendContract } from '../lib/transactions.mjs';

export function createKeeper({ publicClient, walletClient, account, demo, coordinator, beacon,
  minConfirmations = 18, minBalanceDoge = '2', maxAutoFulfillments = 100, maxCostDoge = '0.2', local = false,
  getRound = fetchRound, log = console.log }) {
  const status = { startedAt: new Date().toISOString(), lastPollAt: null, lastSuccessAt: null, lastTransaction: null,
    lastError: null, pending: 0, completedAutomatic: 0, scanned: 0, state: 'starting', wallet: account.address,
    minConfirmations, maxAutoFulfillments, minBalanceDoge, maxCostDoge };
  let running = false;
  // No durable cursor is required: replay the on-chain request index on restart.
  // Cache terminal requests, but refresh their recent tail across possible reorgs.
  const terminal = new Map();
  async function tick() {
    if (running) return;
    running = true;
    try {
      const [head, balance, count, pendingNonce, confirmedNonce] = await Promise.all([
        publicClient.getBlock(), publicClient.getBalance({ address: account.address }),
        publicClient.readContract({ ...demo, functionName: 'rollCount' }),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      ]);
      status.lastPollAt = new Date().toISOString();
      status.balanceWei = balance.toString(); status.head = head.number.toString();
      status.pending = 0; status.completedAutomatic = 0; status.scanned = Number(count);
      const candidates = [];
      for (let i = 0n; i < count; i++) {
        const cached = terminal.get(i.toString());
        if (cached && head.number > cached.observedAt + 20n) {
          if (cached.automatic && cached.fulfilled) status.completedAutomatic++;
          continue;
        }
        const id = await publicClient.readContract({ ...demo, functionName: 'requestIds', args: [i] });
        const roll = await publicClient.readContract({ ...demo, functionName: 'getRoll', args: [id] });
        const state = await publicClient.readContract({ ...coordinator, functionName: 'getRequestState', args: [id] });
        if (state !== 1) {
          terminal.set(i.toString(), { automatic: roll.automatic, fulfilled: state === 2, observedAt: cached?.observedAt ?? head.number });
          if (roll.automatic && state === 2) status.completedAutomatic++;
          continue;
        }
        terminal.delete(i.toString());
        if (!roll.automatic) continue;
        status.pending++;
        if (head.number - roll.requestBlock + 1n >= BigInt(minConfirmations)) candidates.push({ id, roll });
      }
      for (const key of terminal.keys()) if (BigInt(key) >= count) terminal.delete(key);
      status.lastError = null;
      if (balance < parseEther(minBalanceDoge)) { status.state = 'low-balance'; return; }
      if (status.completedAutomatic >= maxAutoFulfillments) { status.state = 'budget-limit'; return; }
      if (pendingNonce !== confirmedNonce) { status.state = 'transaction-pending'; return; }
      status.state = 'watching';
      const [genesis, period, pubKeyHash, callbackGasLimit] = await Promise.all([
        publicClient.readContract({ ...demo, functionName: 'genesis' }),
        publicClient.readContract({ ...demo, functionName: 'period' }),
        publicClient.readContract({ ...demo, functionName: 'pubKeyHash' }),
        publicClient.readContract({ ...demo, functionName: 'CALLBACK_GAS_LIMIT' }),
      ]);
      for (const { id, roll } of candidates) {
        if (head.timestamp < genesis + (roll.round - 1n) * period) continue;
        const round = await getRound(roll.round);
        const signature = signatureToEvm(round.signature);
        await publicClient.readContract({ ...beacon, functionName: 'verifyBeaconRound', args: [roll.round, signature] });
        // Simulation checks the committed requester, round, key and gas limit too.
        const result = await sendContract({ publicClient, walletClient, account, contract: coordinator,
          functionName: 'fulfillRandomness', args: [id, demo.address, pubKeyHash, roll.round, callbackGasLimit, signature],
          local, maxCost: maxCostDoge, onSubmitted: hash => { status.state = 'submitting'; status.lastTransaction = hash; } });
        status.lastSuccessAt = new Date().toISOString(); status.lastTransaction = result.hash;
        log(JSON.stringify({ event: 'fulfilled', requestId: id.toString(), round: roll.round.toString(), hash: result.hash }));
        // One transaction per tick: recheck nonce, balance and budget before the next.
        break;
      }
    } catch (error) {
      status.lastError = (error.shortMessage || error.message).slice(0, 400);
      status.state = 'retrying';
      log(JSON.stringify({ event: 'retry', error: status.lastError }));
    } finally { running = false; }
  }
  return { tick, status };
}
