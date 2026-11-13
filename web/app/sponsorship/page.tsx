'use client';
import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnectors, useWalletConnect } from '@dogeos/dogeos-sdk';
import { recoverMessageAddress, type Address, type Hex } from 'viem';
import { api, manifest, same, verifyIntent, verifyReceipt, type Operation } from './verify';
const active = (op?: Operation | null) => !!op && ['submitted','included'].includes(op.status);
const key = (owner: string) => `sponsored-counter:${manifest.paymaster}:${owner.toLowerCase()}`;
export default function Page() {
  const { address } = useAccount(); const { connectors } = useConnectors(); const { openModal } = useWalletConnect();
  const [op, setOp] = useState<Operation | null>(null); const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [verifiedCount, setVerifiedCount] = useState<string>();
  const ownerRef = useRef(address); ownerRef.current = address;
  const busyRef = useRef(false);
  useEffect(() => {
    let cancelled = false; setOp(null); setVerifiedCount(undefined); setError('');
    if (!address) return;
    let saved: { id: string; hash: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem(key(address)) ?? 'null'); } catch { /* optional persistence */ }
    if (saved) void api(`operations/${saved.id}`).then(value => {
      if (!cancelled && same(value.owner, address) && value.userOpHash === saved?.hash) setOp(value);
    }).catch(() => { if (!cancelled) setError('Could not recover your last operation. Refresh before creating another.'); });
    return () => { cancelled = true; };
  }, [address]);
  useEffect(() => {
    if (!op || !['submitted','included','confirmed'].includes(op.status)) return;
    let cancelled = false, reading = false;
    const update = async () => {
      if (reading) return; reading = true;
      try {
        const next = await api(`operations/${op.id}`);
        if (!same(next.owner, ownerRef.current) || next.userOpHash !== op.userOpHash) throw new Error('Operation identity changed.');
        let count: string | undefined;
        if (next.status === 'confirmed') count = await verifyReceipt(next);
        if (!cancelled) { setOp(next); setVerifiedCount(count); setError(''); }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { reading = false; }
    };
    void update(); const timer = setInterval(update, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [op?.id, op?.status]);
  async function increment() {
    if (!address) { openModal(); return; }
    if (busyRef.current || active(op)) return;
    busyRef.current = true; const owner = address as Address; setError(''); setVerifiedCount(undefined);
    try {
      const provider = connectors?.evm?.provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined;
      if (!provider) throw new Error('Connect a wallet through the DogeOS SDK.');
      const checkWallet = async () => {
        const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
        if (!same(ownerRef.current, owner) || !same(accounts[0], owner)) throw new Error('Wallet changed. Prepare again.');
        if (Number(await provider.request({ method: 'eth_chainId' })) !== manifest.chainId) throw new Error('Switch your wallet to Chikyū.');
      };
      await checkWallet(); setBusy('Preparing…');
      const prepared = await api('prepare', { owner }); setOp(prepared);
      try { localStorage.setItem(key(owner), JSON.stringify({ id: prepared.id, hash: prepared.userOpHash })); } catch { /* optional */ }
      if (active(prepared)) return;
      await verifyIntent(prepared, owner); await checkWallet(); setBusy('Sign in your wallet…');
      const signature = await provider.request({ method: 'personal_sign', params: [prepared.userOpHash, owner] }) as Hex;
      if (!same(await recoverMessageAddress({ message: { raw: prepared.userOpHash }, signature }), owner)) throw new Error('Wallet returned an invalid signature.');
      await checkWallet(); setBusy('Submitting…');
      // Keep the exact operation ID before broadcasting. A lost HTTP response is not a reason to sign a new nonce.
      setOp({ ...prepared, status: 'submitted' });
      const submitted = await api('submit', { id: prepared.id, signature });
      if (same(ownerRef.current, owner)) setOp(submitted);
    } catch (e) {
      const message = (e as Error).message;
      setError(/rejected|denied|4001/i.test(message) ? 'Signature cancelled. You can try again.' : message);
    } finally { setBusy(''); busyRef.current = false; }
  }
  const status = verifiedCount ? 'Confirmed on Chikyū.' : op?.status === 'included' ? `Included · ${op.confirmations}/18 confirmations` : op?.status === 'submitted' ? 'Waiting for the sponsored transaction…' : op?.status === 'expired' ? 'Quote expired. You can prepare a new operation.' : op?.status === 'failed' ? op.failure : '';
  return <section className="card"><h1>Gas sponsorship</h1><p>Increment a counter. The demo pays the gas; your wallet can have zero DOGE.</p>
    <div className="row"><button onClick={increment} disabled={!!busy || active(op)}>{busy || (active(op) ? 'Confirming…' : address ? 'Increment counter' : 'Connect wallet')}</button><span className="badge">Your cost: 0 DOGE</span></div>
    <div aria-live="polite">{status && <p className={`status ${verifiedCount ? 'ok' : ''}`}>{status}</p>}{error && <p className="status err" role="alert">{error}</p>}</div>
    {verifiedCount && <div className="result"><div className="result-label">Your smart account’s counter</div><div className="result-value">{verifiedCount}</div></div>}
    {op?.transactionHash && <a href={`${manifest.explorerUrl}/tx/${op.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    <details><summary>How it works &amp; contract details</summary><p>The SDK wallet signs an ERC-4337 UserOperation. A SimpleAccount calls the counter, Alto submits it, and the paymaster covers the EntryPoint charge. The demo also funds the bundler’s DogeOS data fee. Limit: three operations per smart account, subject to the shared demo budget.</p>
      <dl><dt>EntryPoint</dt><dd>{manifest.entryPoint} · v0.7</dd><dt>Paymaster</dt><dd>{manifest.paymaster}</dd><dt>Counter</dt><dd>{manifest.counter}</dd>{op && <><dt>Smart account</dt><dd>{op.account}</dd><dt>UserOperation</dt><dd>{op.userOpHash}</dd></>}{op?.networkFeeDoge && <><dt>Total network fee</dt><dd>{op.networkFeeDoge} DOGE</dd><dt>Paymaster charge</dt><dd>{op.paymasterChargeDoge} DOGE</dd><dt>L1 data fee</dt><dd>{op.l1DataFeeDoge} DOGE</dd></>}</dl>
    </details></section>;
}
