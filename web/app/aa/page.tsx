'use client';
import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnectors, useWalletConnect } from '@dogeos/dogeos-sdk';
import { formatEther, numberToHex, parseEther, recoverAddress, type Address, type Hex } from 'viem';
import { accountInfo, api, manifest, maxCost, rpc, same, typedDataOf, verifyIntent, verifyReceipt, type Operation } from './verify';
const active = (op?: Operation | null) => !!op && ['submitted','included'].includes(op.status);
const key = (owner: string) => `aa-counter:${manifest.chainId}:${manifest.accountFactory}:0:${owner.toLowerCase()}`;
type Info = Awaited<ReturnType<typeof accountInfo>>;
export default function Page() {
  const { address } = useAccount(); const { connectors } = useConnectors(); const { openModal } = useWalletConnect();
  const [op, setOp] = useState<Operation | null>(null); const [info, setInfo] = useState<Info>();
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const [verifiedCount, setVerifiedCount] = useState<string>(); const [fundingTx, setFundingTx] = useState<Hex>();
  const ownerRef = useRef(address); ownerRef.current = address;
  const busyRef = useRef(false);
  const expired = !!op && Date.parse(op.expiresAt) < Date.now() + 15_000;
  const preview = op?.status === 'prepared' && !expired;
  const cost = preview ? maxCost(op.userOperation) : 0n;
  const shortfall = info && cost > info.available ? cost - info.available : 0n;
  // Round the shortfall up to 0.01 DOGE, leaving change in the user's account.
  const unit = parseEther('0.01'); const topUp = (shortfall + unit - 1n) / unit * unit;
  useEffect(() => {
    let cancelled = false; setOp(null); setInfo(undefined); setVerifiedCount(undefined); setFundingTx(undefined); setError('');
    if (!address) return;
    const refresh = async () => { try { const value = await accountInfo(address as Address); if (!cancelled) setInfo(value); }
      catch { if (!cancelled) setError('Could not read your smart account balance.'); } };
    void refresh(); const timer = setInterval(refresh, 10000);
    let saved: { id: string; hash: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem(key(address)) ?? 'null'); } catch { /* optional persistence */ }
    if (saved) void api(`operations/${saved.id}`).then(value => {
      if (!cancelled && same(value.owner, address) && value.userOpHash === saved?.hash) setOp(value);
    }).catch(() => { if (!cancelled) setError('Could not recover your last operation. Refresh before creating another.'); });
    return () => { cancelled = true; clearInterval(timer); };
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
  async function run(action: 'prepare' | 'fund' | 'sign') {
    if (!address) { openModal(); return; }
    if (busyRef.current || active(op)) return;
    busyRef.current = true; const owner = address as Address; setError('');
    try {
      if (action === 'prepare') {
        setBusy('Preparing…'); setVerifiedCount(undefined);
        const prepared = await api('prepare', { owner });
        if (!same(ownerRef.current, owner)) return;
        if (prepared.status === 'prepared') await verifyIntent(prepared, owner);
        setOp(prepared); setInfo(await accountInfo(owner));
        try { localStorage.setItem(key(owner), JSON.stringify({ id: prepared.id, hash: prepared.userOpHash })); } catch { /* optional */ }
        return;
      }
      const provider = connectors?.evm?.provider as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | undefined;
      if (!provider) throw new Error('Connect a wallet through the DogeOS SDK.');
      const checkWallet = async () => {
        const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
        if (!same(ownerRef.current, owner) || !same(accounts[0], owner)) throw new Error('Wallet changed. Prepare again.');
        if (Number(await provider.request({ method: 'eth_chainId' })) !== manifest.chainId) throw new Error('Switch your wallet to Chikyū.');
        const genesis = await provider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] }) as { hash: string };
        if (!same(genesis?.hash, manifest.genesisHash)) throw new Error('Switch to the Chikyū testnet RPC. Devnet uses the same chain ID.');
      };
      await checkWallet();
      if (!op || !preview) throw new Error('Prepare an increment first.');
      await verifyIntent(op, owner);
      const current = await accountInfo(owner); setInfo(current);
      if (action === 'fund') {
        const missing = cost - current.available;
        if (missing <= 0n) return;
        const value = (missing + unit - 1n) / unit * unit;
        await checkWallet(); setBusy('Confirm funding in your wallet…');
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: current.address, value: numberToHex(value) }] }) as Hex;
        if (same(ownerRef.current, owner)) setFundingTx(hash);
        setBusy('Confirming funding…');
        const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 120000 });
        if (receipt.status !== 'success') throw new Error('Funding transaction failed.');
        if (same(ownerRef.current, owner)) setInfo(await accountInfo(owner));
        return;
      }
      if (current.available < cost) throw new Error('Add DOGE to your smart account first.');
      await checkWallet(); setBusy('Sign in your wallet…');
      const payload = JSON.stringify(typedDataOf(op.userOperation), (_, value) => typeof value === 'bigint' ? value.toString() : value);
      const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [owner, payload] }) as Hex;
      if (!same(await recoverAddress({ hash: op.userOpHash, signature }), owner)) throw new Error('Wallet returned an invalid signature.');
      await checkWallet(); setBusy('Submitting…');
      // Persist the ID before broadcasting; lost responses must recover this exact operation.
      setOp({ ...op, status: 'submitted' });
      const submitted = await api('submit', { id: op.id, signature });
      if (same(ownerRef.current, owner)) setOp(submitted);
    } catch (e) {
      if (same(ownerRef.current, owner)) setError(/rejected|denied|4001/i.test((e as Error).message) ? 'Wallet request cancelled. You can try again.' : (e as Error).message);
    } finally { setBusy(''); busyRef.current = false; }
  }
  const status = verifiedCount ? 'Confirmed on Chikyū.' : op?.status === 'included' ? `Included · ${op.confirmations}/18 confirmations` : op?.status === 'submitted' ? 'Waiting for the account transaction…' : op?.status === 'failed' ? op.failure : expired && op?.status === 'prepared' ? 'Fee preview expired. Prepare again.' : '';
  if (manifest.entryPointVersion !== '0.9') return <section className="card"><h1>Account abstraction · v0.9</h1><p>The v0.9 contracts are awaiting deployment on Chikyū. Transactions will be enabled once the deployment is verified.</p></section>;
  return <section className="card"><h1>Account abstraction</h1><p>Increment a counter from your smart account. Your smart account pays gas in DOGE.</p>
    {info && <dl><dt>Your smart account</dt><dd><a href={`${manifest.explorerUrl}/address/${info.address}`} target="_blank" rel="noreferrer">{info.address}</a></dd><dt>Available for gas</dt><dd>{formatEther(info.available)} DOGE</dd></dl>}
    {preview && <p className="status">Maximum gas charge: <strong>{formatEther(cost)} DOGE</strong>. Includes the DogeOS data fee and a fee buffer. Any unused prefund stays available to your account.</p>}
    <div className="row">
      {!preview || active(op) ? <button onClick={() => run('prepare')} disabled={!!busy || active(op)}>{busy || (active(op) ? 'Confirming…' : address ? 'Prepare increment' : 'Connect wallet')}</button>
        : shortfall > 0n ? <button onClick={() => run('fund')} disabled={!!busy || !info}>{busy || `Add ${formatEther(topUp)} DOGE from wallet`}</button>
        : <button onClick={() => run('sign')} disabled={!!busy || !info}>{busy || 'Sign and increment'}</button>}
    </div>
    <div aria-live="polite">{status && <p className={`status ${verifiedCount ? 'ok' : ''}`}>{status}</p>}{error && <p className="status err" role="alert">{error}</p>}</div>
    {fundingTx && !op?.transactionHash && <p><a href={`${manifest.explorerUrl}/tx/${fundingTx}`} target="_blank" rel="noreferrer">View funding transaction ↗</a></p>}
    {verifiedCount && <div className="result"><div className="result-label">Your smart account’s counter</div><div className="result-value">{verifiedCount}</div><p>Gas paid by your account: {op?.userChargeDoge} DOGE</p></div>}
    {op?.transactionHash && <a href={`${manifest.explorerUrl}/tx/${op.transactionHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    <details><summary>How it works &amp; contract details</summary><p>Your SDK wallet controls a SimpleAccount derived with salt 0. Add test DOGE to that address, then sign an ERC-4337 UserOperation to increment the counter. The first operation also deploys the account. The bundler submits the transaction and receives its gas payment from your account.</p>
      <dl><dt>Owner wallet</dt><dd>{address ?? 'Connect your wallet'}</dd><dt>Factory · salt 0</dt><dd>{manifest.accountFactory}</dd><dt>EntryPoint · v0.9</dt><dd>{manifest.entryPoint}</dd><dt>Counter</dt><dd>{manifest.counter}</dd>{op && <><dt>UserOperation</dt><dd>{op.userOpHash}</dd></>}{op?.networkFeeDoge && <><dt>Total network fee</dt><dd>{op.networkFeeDoge} DOGE</dd><dt>Account gas charge</dt><dd>{op.userChargeDoge} DOGE</dd><dt>DogeOS data fee</dt><dd>{op.l1DataFeeDoge} DOGE</dd></>}</dl>
    </details></section>;
}
