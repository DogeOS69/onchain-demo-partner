'use client';
import { formatEther } from 'viem';
import { useLab } from './use-lab';
import { config } from './chain';
const doge = (value: bigint) => Number(formatEther(value)).toFixed(6);
export default function Page() {
  const lab = useLab();
  const roll = lab.active;
  return <section className="card"><h1>Randomness</h1><p>Roll a die using a future drand round, verified on Chikyū.</p>
    <p>Pay for proof delivery upfront in testnet DOGE. The keeper delivers the result automatically.</p>
    {lab.fee && <div className="result"><div>Estimated delivery fee: <strong>{doge(lab.fee.estimated)} DOGE</strong></div><p className="status">Includes a 50% service premium. Payment limit: {doge(lab.fee.maximum)} DOGE. Any excess is returned in the request transaction. Request gas is paid separately.</p></div>}
    {lab.feeError && <p className="status err" role="alert">{lab.feeError}</p>}
    <div className="row"><button disabled={!!lab.busy || (!!lab.account && (!lab.fee || !lab.keeperOnline))} onClick={lab.account ? lab.requestRoll : lab.connect}>{lab.busy || (lab.account ? 'Pay & roll die' : 'Connect wallet')}</button><span className="status">{lab.keeperLabel}</span></div>
    {roll && <div className="result"><div className="result-label">Request #{roll.id.toString()} · round {roll.round.toString()}</div>{roll.fulfilled ? <div className="result-value">{roll.face}</div> : roll.state === 3 ? <p className="status err">The proof was delivered, but the callback failed. The delivery fee was charged.</p> : <p className="status">{lab.remaining > 0 ? `Waiting for the round · ${lab.remaining}s` : lab.confirmations < 18 ? `Confirming request · ${lab.confirmations}/18` : !lab.ready ? 'Waiting for the next block…' : 'Waiting for the proof…'}</p>}
      <p className="status">Delivery fee paid: {doge(roll.feePaid)} DOGE</p>
      {roll.fulfilled && <button className="secondary" disabled={!!lab.busy} onClick={lab.verify}>Verify result</button>}
      {lab.proof?.id === roll.id && <p className="status ok">BLS signature and onchain result verified.</p>}
    </div>}
    <div aria-live="polite">{lab.error && <p className="status err" role="alert">{lab.error}</p>}{lab.rpcError && <p className="status err">{lab.rpcError}</p>}</div>
    {roll && lab.links[roll.id.toString()]?.request && <a href={`${config.explorer}/tx/${lab.links[roll.id.toString()].request}`} target="_blank" rel="noreferrer">View request ↗</a>}
    <details><summary>How it works &amp; recent results</summary><p>Your wallet pays the request gas and prepays the delivery fee: estimated verification, callback and data costs plus 50%. The keeper submits the proof and pays that transaction’s gas. Collected fees replenish the operator’s wallet. The delivery fee is quoted upfront; it is not reconciled against unused callback gas afterward.</p><p>Delivery waits for a future drand round and 18 confirmations. Gas-price spikes or service interruptions can delay the response.</p><dl><dt>Consumer</dt><dd>{config.consumer}</dd><dt>Coordinator</dt><dd>{config.coordinator}</dd><dt>Keeper</dt><dd>{lab.keeperOnline ? 'Available' : 'Unavailable'}</dd></dl>
      <div className="row">{lab.rolls.map(item => <button className="secondary mini" key={item.id.toString()} onClick={() => lab.select(item.id)}>#{item.id.toString()}{item.fulfilled ? ` · ${item.face}` : item.state === 3 ? ' · failed' : ' · pending'}</button>)}</div>
    </details></section>;
}
