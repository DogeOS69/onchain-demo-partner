'use client';
import { useLab } from './use-lab';
import { config } from './chain';
export default function Page() {
  const lab = useLab();
  const roll = lab.active;
  return <section className="card"><h1>Randomness</h1><p>Roll a die using a future drand round, verified on Chikyū.</p>
    <div className="row"><label>Proof delivery <select value={lab.mode} disabled={!!lab.busy} onChange={e => lab.setMode(e.target.value as 'auto' | 'manual')}><option value="auto">Automatic</option><option value="manual">Manual</option></select></label><button disabled={!!lab.busy} onClick={lab.account ? lab.requestRoll : lab.connect}>{lab.busy || (lab.account ? 'Roll die' : 'Connect wallet')}</button></div>
    {roll && <div className="result"><div className="result-label">Request #{roll.id.toString()} · round {roll.round.toString()}</div>{roll.fulfilled ? <div className="result-value">{roll.face}</div> : <p className="status">{lab.remaining > 0 ? `Waiting for the round · ${lab.remaining}s` : !lab.ready ? `Confirming request · ${lab.confirmations}/18` : 'Waiting for the proof…'}</p>}
      {!roll.fulfilled && !roll.automatic && <button disabled={!lab.ready || !!lab.busy} onClick={lab.fulfill}>Submit proof</button>}
      {roll.fulfilled && <button className="secondary" disabled={!!lab.busy} onClick={lab.verify}>Verify result</button>}
      {lab.proof?.id === roll.id && <p className="status ok">BLS signature and onchain result verified.</p>}
    </div>}
    <div aria-live="polite">{lab.error && <p className="status err" role="alert">{lab.error}</p>}{lab.rpcError && <p className="status err">{lab.rpcError}</p>}</div>
    {roll && lab.links[roll.id.toString()]?.request && <a href={`${config.explorer}/tx/${lab.links[roll.id.toString()].request}`} target="_blank" rel="noreferrer">View request ↗</a>}
    <details><summary>How it works &amp; recent results</summary><p>Your wallet pays for the request transaction. In automatic mode, the demo’s keeper pays to deliver the proof. In manual mode, your wallet submits it. This example uses drand evmnet and Anyrand’s onchain BLS verification.</p><dl><dt>Consumer</dt><dd>{config.consumer}</dd><dt>Coordinator</dt><dd>{config.coordinator}</dd><dt>Keeper</dt><dd>{lab.keeperOnline ? 'Available' : 'Unavailable'}</dd></dl>
      <div className="row">{lab.rolls.map(item => <button className="secondary mini" key={item.id.toString()} onClick={() => lab.select(item.id)}>#{item.id.toString()}{item.fulfilled ? ` · ${item.face}` : ' · pending'}</button>)}</div>
    </details></section>;
}
