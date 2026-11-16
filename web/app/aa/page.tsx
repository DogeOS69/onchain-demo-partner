'use client';
import { useEffect, useRef, useState } from 'react';
import { createWalletClient, formatEther, http, keccak256, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { accountInfo, api, chainOf, ensure, maxCost, rpcOf, same, typedDataOf, validateManifest,
  verifyIntent, verifyNetwork, verifyReceipt, type ActivationQuote, type Manifest, type Operation } from './verify';

type Activation = { hash: Hex; raw: Hex };
type Info = Awaited<ReturnType<typeof accountInfo>>;
const active = (op?: Operation | null) => !!op && ['submitted', 'included'].includes(op.status);
export default function Page() {
  const [manifest, setManifest] = useState<Manifest>();
  const [wallet, setWallet] = useState<PrivateKeyAccount>();
  const [info, setInfo] = useState<Info>();
  const [quote, setQuote] = useState<ActivationQuote>();
  const [activation, setActivation] = useState<Activation>();
  const [activationDone, setActivationDone] = useState(false);
  const [op, setOp] = useState<Operation | null>(null);
  const [verifiedCount, setVerifiedCount] = useState<string>();
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false), reading = useRef(false);
  const key = (suffix: string) => 'dogeos-7702:' + manifest!.genesisHash + ':' + suffix;
  useEffect(() => {
    let cancelled = false;
    api<Manifest>('config').then(async m => {
      validateManifest(m); await verifyNetwork(m);
      if (cancelled) return;
      setManifest(m);
      const secret = sessionStorage.getItem('dogeos-7702:' + m.genesisHash + ':key') as Hex | null;
      if (secret) setWallet(privateKeyToAccount(secret));
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!manifest || !wallet) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key('activation:' + wallet.address)) ?? 'null');
      if (saved) setActivation(saved);
      const operation = JSON.parse(sessionStorage.getItem(key('operation:' + wallet.address)) ?? 'null');
      if (operation) void api<Operation>('operations/' + operation.id).then(value => {
        ensure(same(value.owner, wallet.address) && same(value.userOpHash, operation.hash), 'Saved operation changed.');
        setOp(value);
      }).catch(e => setError(e.message));
    } catch (e) { setError((e as Error).message); }
  }, [manifest, wallet]);
  useEffect(() => {
    if (!manifest || !wallet) return;
    let cancelled = false;
    const refresh = async () => {
      if (reading.current) return; reading.current = true;
      try {
        const current = await accountInfo(manifest, wallet.address);
        if (cancelled) return;
        setInfo(current);
        if (activation && !activationDone) {
          const rpc = rpcOf(manifest);
          const receipt = await rpc.getTransactionReceipt({ hash: activation.hash }).catch(() => null);
          if (receipt) {
            ensure(receipt.type === 'eip7702' && same(receipt.from, wallet.address) && same(receipt.to, wallet.address), 'Unexpected activation receipt.');
            ensure(current.activated, 'Activation was mined without the expected delegation.');
            const confirmations = Number(await rpc.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n);
            if (!cancelled) {
              setNotice(confirmations >= manifest.requiredConfirmations
                ? (receipt.status === 'success' ? '7702 activated. Your address stayed the same.' : 'Delegation is active even though execution reverted.')
                : 'Activation included · ' + confirmations + '/' + manifest.requiredConfirmations + ' confirmations');
              setActivationDone(confirmations >= manifest.requiredConfirmations);
            }
          }
        }
        if (op && ['submitted', 'included', 'confirmed'].includes(op.status)) {
          const result = await api<Operation>('operations/' + op.id);
          ensure(same(result.owner, wallet.address) && result.userOpHash === op.userOpHash, 'Operation identity changed.');
          const count = result.status === 'confirmed' ? await verifyReceipt(result, manifest) : undefined;
          if (!cancelled) { setOp(result); setVerifiedCount(count); }
        }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { reading.current = false; }
    };
    void refresh(); const timer = setInterval(refresh, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [manifest, wallet, activation?.hash, activationDone, op?.id, op?.status]);
  function createAccount() {
    if (!manifest) return;
    try {
      const secret = generatePrivateKey();
      sessionStorage.setItem(key('key'), secret);
      setWallet(privateKeyToAccount(secret)); setError('');
    } catch { setError('This demo needs session storage to retain the temporary wallet across reloads.'); }
  }
  async function activate() {
    if (!manifest || !wallet || lock.current) return;
    lock.current = true; setBusy('Checking activation…'); setError('');
    try {
      await verifyNetwork(manifest);
      const rpc = rpcOf(manifest);
      if (activation && !activationDone) {
        ensure(keccak256(activation.raw) === activation.hash, 'Saved transaction changed.');
        try { await rpc.sendRawTransaction({ serializedTransaction: activation.raw }); }
        catch (e) { if (!/already known|nonce too low/i.test((e as Error).message)) throw e; }
        setNotice('Checking the same activation transaction.'); return;
      }
      if (!quote || quote.expiresAt < Date.now()) {
        setQuote(await api<ActivationQuote>('activation/quote', { owner: wallet.address }));
        return;
      }
      const current = await accountInfo(manifest, wallet.address);
      ensure(!current.activated, 'Already activated.');
      ensure(current.balance <= parseEther('2'), 'Use only a small devnet balance in this disposable demo account (at most 2 DOGE).');
      ensure(same(quote.owner, wallet.address) && same(quote.delegate, manifest.delegate) && quote.chainId === manifest.chainId
        && quote.genesisHash === manifest.genesisHash && quote.authorizationNonce === quote.nonce + 1, 'Activation details changed.');
      ensure(quote.nonce === await rpc.getTransactionCount({ address: wallet.address, blockTag: 'pending' }), 'Wallet nonce changed. Refresh the preview.');
      ensure(BigInt(quote.gas) === 100_000n && BigInt(quote.maxFeePerGas) > 0n && BigInt(quote.maxFeePerGas) <= 500_000_000n
        && BigInt(quote.maxPriorityFeePerGas) === 100n && BigInt(quote.reserveWei) <= parseEther('0.5')
        && BigInt(quote.reserveWei) >= BigInt(quote.gas) * BigInt(quote.maxFeePerGas), 'Unexpected activation fee.');
      ensure(current.balance >= BigInt(quote.reserveWei), 'Add devnet DOGE to this account first.');
      const auth = await wallet.signAuthorization({ address: manifest.delegate, chainId: manifest.chainId, nonce: quote.authorizationNonce });
      const signer = createWalletClient({ account: wallet, chain: chainOf(manifest), transport: http(manifest.rpcUrl) });
      const raw = await signer.signTransaction({ type: 'eip7702', to: wallet.address, data: '0x', value: 0n,
        nonce: quote.nonce, authorizationList: [auth], gas: BigInt(quote.gas),
        maxFeePerGas: BigInt(quote.maxFeePerGas), maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas) });
      const saved = { raw, hash: keccak256(raw) };
      sessionStorage.setItem(key('activation:' + wallet.address), JSON.stringify(saved));
      setActivation(saved); setQuote(undefined); setNotice('Activation submitted. Waiting for the network…');
      await rpc.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) { setError((e as Error).message); setQuote(undefined); }
    finally { lock.current = false; setBusy(''); }
  }
  async function increment() {
    if (!manifest || !wallet || lock.current || active(op)) return;
    lock.current = true; setBusy('Preparing…'); setError('');
    try {
      if (!op || op.status !== 'prepared' || Date.parse(op.expiresAt) < Date.now() + 15_000) {
        const prepared = await api<Operation>('prepare', { owner: wallet.address });
        if (prepared.status === 'prepared') await verifyIntent(prepared, wallet.address, manifest);
        sessionStorage.setItem(key('operation:' + wallet.address), JSON.stringify({ id: prepared.id, hash: prepared.userOpHash }));
        setOp(prepared); setVerifiedCount(undefined); return;
      }
      await verifyIntent(op, wallet.address, manifest);
      ensure((await accountInfo(manifest, wallet.address)).available >= maxCost(op.userOperation), 'Add devnet DOGE to this account first.');
      const signature = await wallet.signTypedData(typedDataOf(op.userOperation, manifest));
      setOp({ ...op, status: 'submitted' });
      setBusy('Submitting…');
      setOp(await api<Operation>('submit', { id: op.id, signature }));
    } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(''); }
  }
  const activated = info?.activated && (!activation || activationDone);
  const preview = op?.status === 'prepared' && Date.parse(op.expiresAt) > Date.now() + 15_000;
  return <section className="card">
    <h1>7702 account abstraction</h1>
    <p>Activate account abstraction on the same wallet address, then increment the counter. Your account pays both steps in DOGE.</p>
    {!manifest && <p className="status">Waiting for the verified devnet deployment and bundler.</p>}
    {manifest && <p className="status">{manifest.chainId === 31337 ? 'Local simulation · not devnet' : 'DogeOS devnet'} · EntryPoint 0.9</p>}
    {!wallet ? <button disabled={!manifest} onClick={createAccount}>Create temporary devnet account</button> : <>
      <p>This is a disposable lab wallet, separate from your SDK wallet. Its key stays in this tab’s session storage. Closing the tab may lose access; use only devnet DOGE.</p>
      <dl><dt>Your address · unchanged by 7702</dt><dd data-testid="account-address">{wallet.address}</dd>
        <dt>Wallet balance</dt><dd>{formatEther(info?.balance ?? 0n)} DOGE</dd>
        <dt>Available for account operations</dt><dd>{formatEther(info?.available ?? 0n)} DOGE</dd>
        <dt>Account status</dt><dd>{activated ? '7702 active' : activation ? 'Activation confirming' : 'Regular EOA'}</dd></dl>
      <p>Send about 1 DOGE from the devnet faucet or a devnet wallet to this address before starting.</p>
      <div className="row">
        <button onClick={activate} disabled={!!busy || !!activated || active(op)}>
          {activated ? '7702 activated' : activation ? 'Check activation' : quote ? 'Confirm 7702 activation' : 'Activate 7702'}
        </button>
        <button onClick={increment} disabled={!!busy || !activated || active(op)}>
          {active(op) ? 'Confirming increment…' : preview ? 'Confirm increment with AA' : 'Increment with AA'}
        </button>
      </div>
      {quote && <p className="status">Activation estimate including the data fee and buffer: {quote.maxChargeDoge} DOGE. Confirm to delegate this account to the demo contract.</p>}
      {preview && <p className="status">Maximum account charge: {op!.maxChargeDoge} DOGE. Confirm to sign the counter operation.</p>}
      {verifiedCount && <div className="result"><div className="result-label">Confirmed counter</div><div className="result-value">{verifiedCount}</div><p>Gas paid by this account: {op?.userChargeDoge} DOGE</p></div>}
      <details><summary>Receipts and delegation</summary><dl>
        <dt>Delegate</dt><dd>{manifest?.delegate}</dd><dt>EntryPoint</dt><dd>{manifest?.entryPoint}</dd>
        <dt>Counter</dt><dd>{manifest?.counter}</dd><dt>Activation transaction</dt><dd>{activation?.hash ?? 'Not submitted'}</dd>
        <dt>Counter transaction</dt><dd>{op?.transactionHash ?? 'Not submitted'}</dd><dt>UserOperation</dt><dd>{op?.userOpHash ?? 'Not prepared'}</dd>
      </dl><p>Delegation persists after this transaction. It does not transfer assets from an older smart account. No paymaster or sponsored gas is used.</p></details>
    </>}
    <div aria-live="polite">{busy && <p className="status">{busy}</p>}{notice && <p className="status">{notice}</p>}{error && <p role="alert" className="status err">{error}</p>}</div>
  </section>;
}
