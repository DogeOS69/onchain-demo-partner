import { decodeEventLog, decodeFunctionResult, encodeFunctionData } from 'viem';
import { clients, assertChikyu, readDeployment, contract, stringify } from '../lib/chain.mjs';
import { sendContract } from '../lib/transactions.mjs';
const c = clients({ signing: true }); await assertChikyu(c.publicClient);
const demo = contract(readDeployment(), 'RandomnessDemo');
if (process.argv.includes('--manual')) throw new Error('The paid demo uses automatic delivery');
const automatic = true;
const gasPrice = await c.publicClient.getGasPrice();
const quote = await c.publicClient.call({ account: c.account, to: demo.address, data: encodeFunctionData({ abi: demo.abi, functionName: 'quote' }), gasPrice });
const fee = decodeFunctionResult({ abi: demo.abi, functionName: 'quote', data: quote.data });
const value = (fee * 125n + 99n) / 100n;
const result = await sendContract({ ...c, contract: demo, functionName: 'requestRoll', args: [automatic], value, gasPrice });
const events = result.receipt.logs.filter(l => l.address.toLowerCase() === demo.address.toLowerCase()).map(l => decodeEventLog({ abi: demo.abi, ...l }));
const event = events.find(e => e.eventName === 'RollRequested'), payment = events.find(e => e.eventName === 'RequestPayment');
console.log(stringify({ ...event.args, consumer: demo.address, hash: result.hash, block: result.receipt.blockNumber,
  feePaidWei: payment.args.feePaid, refundedWei: payment.args.refunded, maximumPaymentWei: value, networkCostWei: result.networkCost }));
