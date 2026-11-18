import { decodeEventLog, encodeFunctionData, parseEther, parseAbi } from 'viem';
import { fetchRound, signatureToEvm } from '../lib/drand.mjs';
import { estimateTotal, sendContract } from '../lib/transactions.mjs';

// Confirmed coordinator events rebuild accounting on restart. Latest request
// state prevents replay while a fulfillment is still awaiting confirmations.
export function createKeeper({ publicClient, walletClient, account, coordinator,
  deploymentBlock = 0n, minConfirmations = 18, minBalanceDoge = '2', maxAutoFulfillments = 0,
  maxCostDoge = '0.2', autoWithdraw = true, withdrawMinDoge = '0.1', local = false,
  getRound = fetchRound, log = console.log }) {
  const status = { startedAt: new Date().toISOString(), lastPollAt: null, lastSuccessAt: null,
    lastTransaction: null, lastError: null, pending: 0, completedAutomatic: 0, failedCallbacks: 0,
    scanned: 0, state: 'starting', wallet: account.address, minConfirmations,
    maxAutoFulfillments, minBalanceDoge, maxCostDoge, autoWithdraw, withdrawMinDoge,
    delivery: 'paid-coordinator-requests' };
  const events = new Map(), costs = new Map();
  let cursor = null, running = false;
  const firstBlock = BigInt(deploymentBlock);
  const beaconAbi = parseAbi(['function genesisTimestamp() view returns(uint256)', 'function period() view returns(uint256)']);
  async function networkCost(hash) {
    if (!costs.has(hash)) {
      const r = await publicClient.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (!r) throw new Error(`Receipt not yet available: ${hash}`);
      costs.set(hash, BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + BigInt(r.l1Fee ?? 0));
    }
    return costs.get(hash);
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const [head, balance, pendingNonce, confirmedNonce, owner, multiplier] = await Promise.all([
        publicClient.getBlock(), publicClient.getBalance({ address: account.address }),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
        publicClient.readContract({ ...coordinator, functionName: 'owner' }),
        publicClient.readContract({ ...coordinator, functionName: 'requestPremiumMultiplierBps' }),
      ]);
      const confirmedHead = head.number >= BigInt(minConfirmations - 1) ? head.number - BigInt(minConfirmations - 1) : 0n;
      status.lastPollAt = new Date().toISOString(); status.balanceWei = balance.toString();
      status.head = head.number.toString(); status.confirmedHead = confirmedHead.toString();
      status.requestPremiumMultiplierBps = Number(multiplier);
      let from = cursor === null ? firstBlock : cursor > 32n ? cursor - 32n : firstBlock;
      if (from < firstBlock) from = firstBlock;
      // Re-read an overlap and drop orphaned events after shallow reorgs.
      for (const [key, event] of events) if (event.blockNumber >= from) events.delete(key);
      for (; from <= confirmedHead; from += 5000n) {
        const to = from + 4999n < confirmedHead ? from + 4999n : confirmedHead;
        const logs = await publicClient.getLogs({ address: coordinator.address, fromBlock: from, toBlock: to });
        for (const entry of logs) {
          let decoded;
          try { decoded = decodeEventLog({ abi: coordinator.abi, ...entry }); } catch { continue; }
          if (!['RandomnessRequested', 'RandomnessFulfilled', 'ETHWithdrawn'].includes(decoded.eventName)) continue;
          events.set(`${entry.transactionHash}:${entry.logIndex}`, { ...entry, ...decoded });
        }
      }
      cursor = confirmedHead;
      const requests = [], fulfilled = new Map(); let withdrawals = 0n, withdrawalCost = 0n;
      for (const event of events.values()) {
        if (event.eventName === 'RandomnessRequested' && event.args.feePaid > 0n) requests.push(event);
        if (event.eventName === 'RandomnessFulfilled') fulfilled.set(event.args.requestId.toString(), event);
        if (event.eventName === 'ETHWithdrawn') {
          withdrawals += event.args.amount;
          withdrawalCost += await networkCost(event.transactionHash);
        }
      }
      requests.sort((a, b) => a.args.requestId < b.args.requestId ? -1 : 1);
      let reserved = 0n, collected = 0n, fulfillmentCost = 0n;
      status.completedAutomatic = 0; status.failedCallbacks = 0;
      const pending = [];
      for (const request of requests) {
        collected += request.args.feePaid;
        const result = fulfilled.get(request.args.requestId.toString());
        if (result) {
          if (result.args.callbackSuccess) status.completedAutomatic++;
          else status.failedCallbacks++;
          fulfillmentCost += await networkCost(result.transactionHash);
        } else { reserved += request.args.feePaid; pending.push(request); }
      }
      const coordinatorBalance = await publicClient.getBalance({ address: coordinator.address, blockNumber: confirmedHead });
      const available = coordinatorBalance > reserved ? coordinatorBalance - reserved : 0n;
      Object.assign(status, { scanned: requests.length, pending: pending.length, lastError: null,
        feesCollectedWei: collected.toString(), feesWithdrawnWei: withdrawals.toString(),
        pendingFeeReserveWei: reserved.toString(), availableFeesWei: available.toString(),
        coordinatorBalanceWei: coordinatorBalance.toString(), fulfillmentCostWei: fulfillmentCost.toString(),
        withdrawalCostWei: withdrawalCost.toString(), owner,
        withdrawalRequired: available >= parseEther(withdrawMinDoge) && owner.toLowerCase() !== account.address.toLowerCase() });
      if (pendingNonce !== confirmedNonce) { status.state = 'transaction-pending'; return; }
      // AnyRand pays withdrawals to its owner. The testnet owner is the keeper;
      // a future multisig owner must arrange replenishment separately.
      if (autoWithdraw && available >= parseEther(withdrawMinDoge) && owner.toLowerCase() === account.address.toLowerCase()) {
        status.state = 'collecting-fees';
        // Confirmed accounting can lag a previous withdrawal. Never withdraw
        // money reserved for pending requests or submit a duplicate collection.
        const [currentBalance, recentWithdrawals] = await Promise.all([
          publicClient.getBalance({ address: coordinator.address }),
          confirmedHead < head.number ? publicClient.getLogs({ address: coordinator.address,
            event: coordinator.abi.find(e => e.type === 'event' && e.name === 'ETHWithdrawn'),
            fromBlock: confirmedHead + 1n, toBlock: head.number }) : [],
        ]);
        if (recentWithdrawals.length === 0 && currentBalance >= available + reserved) {
          const result = await sendContract({ publicClient, walletClient, account, contract: coordinator,
            functionName: 'withdrawETH', args: [available], local, maxCost: maxCostDoge });
          status.lastWithdrawal = result.hash;
          log(JSON.stringify({ event: 'fees-collected', amountWei: available.toString(), hash: result.hash }));
          return;
        }
      }
      if (balance < parseEther(minBalanceDoge)) { status.state = 'low-balance'; return; }
      if (maxAutoFulfillments > 0 && status.completedAutomatic + status.failedCallbacks >= maxAutoFulfillments) {
        status.state = 'budget-limit'; return;
      }
      status.state = 'watching';
      for (const request of pending) {
        const { requestId, requester, pubKeyHash, round, callbackGasLimit, feePaid } = request.args;
        const state = await publicClient.readContract({ ...coordinator, functionName: 'getRequestState', args: [requestId] });
        if (state !== 1) continue;
        try {
          const beaconAddress = await publicClient.readContract({ ...coordinator, functionName: 'beacon', args: [pubKeyHash] });
          const [genesis, period] = await Promise.all(['genesisTimestamp', 'period'].map(functionName =>
            publicClient.readContract({ address: beaconAddress, abi: beaconAbi, functionName })));
          if (head.timestamp < genesis + (round - 1n) * period) continue;
          const proof = await getRound(round);
          const args = [requestId, requester, pubKeyHash, round, callbackGasLimit, signatureToEvm(proof.signature)];
          const data = encodeFunctionData({ abi: coordinator.abi, functionName: 'fulfillRandomness', args });
          const estimate = await estimateTotal(publicClient, account, { to: coordinator.address, data }, { local });
          if (estimate.upperCost > feePaid || estimate.upperCost > parseEther(maxCostDoge)) {
            status.state = 'waiting-gas'; status.lastError = `Request ${requestId}: fulfillment exceeds its paid budget or keeper cap`; continue;
          }
          const result = await sendContract({ publicClient, walletClient, account, contract: coordinator,
            functionName: 'fulfillRandomness', args, estimate, local, maxCost: maxCostDoge,
            onSubmitted: hash => { status.state = 'submitting'; status.lastTransaction = hash; } });
          status.lastSuccessAt = new Date().toISOString(); status.lastTransaction = result.hash;
          costs.set(result.hash, result.networkCost);
          log(JSON.stringify({ event: 'fulfilled', requestId: requestId.toString(), requester, hash: result.hash,
            feePaidWei: feePaid.toString(), networkCostWei: result.networkCost.toString() }));
          break;
        } catch (error) {
          status.lastError = (error.shortMessage || error.message).slice(0, 400);
          log(JSON.stringify({ event: 'request-retry', requestId: requestId.toString(), error: status.lastError }));
        }
      }
    } catch (error) {
      status.lastError = (error.shortMessage || error.message).slice(0, 400); status.state = 'retrying';
      log(JSON.stringify({ event: 'retry', error: status.lastError }));
    } finally { running = false; }
  }
  return { tick, status };
}
