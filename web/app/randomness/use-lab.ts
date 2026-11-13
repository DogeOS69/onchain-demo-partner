"use client";
import { useAccount, useConnectors, useWalletConnect } from '@dogeos/dogeos-sdk';
import { useWriteTx } from '../useWriteTx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createWalletClient, custom, decodeEventLog, decodeFunctionResult, encodeFunctionData, encodeAbiParameters, formatEther, keccak256, toHex, type Address, type EIP1193Provider, type Hash } from 'viem';
import { chain, client, config, coordinator, demo, fetchProof, readRoll, type Roll } from './chain';

type Provider = EIP1193Provider & { on?: (event: string, listener: (...args: unknown[]) => void) => void; removeListener?: (event: string, listener: (...args: unknown[]) => void) => void };
type Keeper = { state: string; lastPollAt: string | null; completedAutomatic: number; maxAutoFulfillments: number; wallet: string; lastError?: string | null };
type TxLinks = Record<string, { request?: Hash; fulfill?: Hash }>;
export const short = (value: string, n = 6) => `${value.slice(0, n)}…${value.slice(-4)}`;
function errorText(error: unknown) {
  const e = error as { shortMessage?: string; message?: string; code?: number };
  if (e.code === 4001 || /rejected|denied|rechaz/i.test(e.shortMessage || e.message || '')) return 'You canceled the wallet request. You can try again.';
  return (e.shortMessage || e.message || 'Could not complete the action. Please try again.').slice(0, 240);
}


export function useLab() {
  const sdk = useAccount();
  const { connectors } = useConnectors();
  const { openModal } = useWalletConnect();
  const { writeContract } = useWriteTx();
  const account = (sdk.address || null) as Address | null;
  const walletChain = sdk.chainId ? Number(sdk.chainId) : null;
  const provider = () => connectors?.evm?.provider as Provider | undefined;
  const [balance, setBalance] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [rolls, setRolls] = useState<Roll[]>([]);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [extraRoll, setExtraRoll] = useState<Roll | null>(null);
  const [head, setHead] = useState<bigint>(0n);
  const [blockTime, setBlockTime] = useState(0);
  const [now, setNow] = useState(0);
  const [count, setCount] = useState<bigint>(0n);
  const [keeper, setKeeper] = useState<Keeper | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proof, setProof] = useState<{ id: bigint; hex: string } | null>(null);
  const [links, setLinks] = useState<TxLinks>({});
  const [loading, setLoading] = useState(true);
  const refreshLock = useRef(false);
  const selectedRef = useRef<bigint | null>(null);
  const active = rolls.find(r => r.id === selectedId) || (extraRoll?.id === selectedId ? extraRoll : null);
  const target = active ? config.genesis + (Number(active.round) - 1) * config.period : 0;
  const remaining = Math.max(0, target - now);
  const confirmations = active && head >= active.requestBlock ? Number(head - active.requestBlock + 1n) : 0;
  const ready = !!active && blockTime >= target && confirmations >= config.minConfirmations;
  const keeperFresh = !!keeper?.lastPollAt && now - Math.floor(Date.parse(keeper.lastPollAt) / 1000) < 45;
  const keeperOnline = keeperFresh && ['watching', 'submitting', 'transaction-pending'].includes(keeper!.state);
  const keeperLabel = keeperOnline ? 'Keeper active' : keeper?.state === 'low-balance' ? 'Keeper out of funds' : keeper?.state === 'budget-limit' ? 'Keeper limit reached' : 'Keeper unavailable';

  const refresh = useCallback(async (preferredId?: bigint) => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    try {
      const [ids, block, total] = await Promise.all([
        client.readContract({ ...demo, functionName: 'recentIds', args: [10n] }), client.getBlock(),
        client.readContract({ ...demo, functionName: 'rollCount' }),
      ]);
      const data = await Promise.all(ids.map(readRoll));
      setRolls(data); setHead(block.number); setBlockTime(Number(block.timestamp)); setCount(total); setRpcError(null);
      const wanted = preferredId ?? selectedRef.current;
      if (wanted && !ids.includes(wanted)) setExtraRoll(await readRoll(wanted));
      if (preferredId) { selectedRef.current = preferredId; setSelectedId(preferredId); }
    } catch (e) { setRpcError(`Could not refresh Chikyū data. ${errorText(e)}`); }
    finally { refreshLock.current = false; setLoading(false); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      setLinks(JSON.parse(localStorage.getItem('chikyu-transactions-v1') || '{}'));
      const saved = localStorage.getItem('chikyu-selected-v1');
      if (saved && /^\d+$/.test(saved)) { selectedRef.current = BigInt(saved); setSelectedId(BigInt(saved)); }
    } catch { /* Browsing also works without local storage. */ }
    const tick = () => { setNow(Math.floor(Date.now() / 1000)); void refresh(); };
    tick(); const timer = setInterval(tick, 5000);
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const checkKeeper = async () => {
      if (!config.keeperUrl) return;
      try {
        const r = await fetch(`${config.keeperUrl}/status`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error('Keeper unavailable');
        const data = await r.json() as Keeper;
        if (!cancelled) setKeeper(data);
      } catch { if (!cancelled) setKeeper(null); }
    };
    void checkKeeper(); const keeperTimer = setInterval(checkKeeper, 10000);
    return () => { cancelled = true; clearInterval(timer); clearInterval(clock); clearInterval(keeperTimer); };
  }, [refresh]);
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    client.getBalance({ address: account }).then(b => { if (!cancelled) setBalance(Number(formatEther(b)).toFixed(3)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [account, head]);

  function select(id: bigint) {
    selectedRef.current = id; setSelectedId(id); setProof(null); setError(null); setNotice(null);
    try { localStorage.setItem('chikyu-selected-v1', id.toString()); } catch { /* optional persistence */ }
  }
  function saveLink(id: bigint, kind: 'request' | 'fulfill', hash: Hash) {
    setLinks(previous => {
      const next = { ...previous, [id.toString()]: { ...previous[id.toString()], [kind]: hash } };
      try { localStorage.setItem('chikyu-transactions-v1', JSON.stringify(next)); } catch { /* optional persistence */ }
      return next;
    });
  }
  async function wallet() {
    const p = provider();
    if (!p) throw new Error('Connect a wallet to sign. You can explore the results without connecting.');
    const addresses = await p.request({ method: 'eth_requestAccounts' });
    if (!addresses.length) throw new Error('The wallet did not share an account.');
    if (Number(await p.request({ method: 'eth_chainId' })) !== chain.id) {
      try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chain.id) }] }); }
      catch (e) {
        if ((e as { code?: number }).code !== 4902) throw e;
        await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: toHex(chain.id), chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: [config.rpcUrl], blockExplorerUrls: [config.explorer] }] });
        await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chain.id) }] });
      }
    }
    const id = Number(await p.request({ method: 'eth_chainId' }));
    if (id !== chain.id) throw new Error('Select DogeOS Chikyū in your wallet.');
    if (!account || addresses[0].toLowerCase() !== account.toLowerCase()) throw new Error('Wallet changed. Try again.');
    return createWalletClient({ account: addresses[0], chain, transport: custom(p) });
  }
  async function connect() { openModal(); }
  async function requestRoll() {
    setError(null); setNotice(null); setProof(null); setBusy('Preparing request…');
    try {
      const w = await wallet(); const gasPrice = await client.getGasPrice();
      const quote = await client.call({ to: demo.address, data: encodeFunctionData({ abi: demo.abi, functionName: 'quote' }), gasPrice });
      if (!quote.data) throw new Error('Could not retrieve the fee quote.');
      const value = decodeFunctionResult({ abi: demo.abi, functionName: 'quote', data: quote.data });
      const { request } = await client.simulateContract({ ...demo, functionName: 'requestRoll', args: [mode === 'auto'], account: w.account, value, gasPrice });
      setBusy('Confirm the request in your wallet…');
      const hash = await writeContract({ address: request.address, abi: request.abi, functionName: request.functionName, args: request.args, value: request.value });
      if (!hash) throw new Error('The wallet did not submit the transaction.'); setBusy('Waiting for the transaction…');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180000 });
      if (receipt.status !== 'success') throw new Error('The transaction reverted. Check the explorer.');
      const events = receipt.logs.filter(l => l.address.toLowerCase() === demo.address.toLowerCase()).map(l => decodeEventLog({ abi: demo.abi, ...l }));
      const event = events.find(e => e.eventName === 'RollRequested');
      if (!event || event.eventName !== 'RollRequested') throw new Error('The request was not found in the transaction receipt.');
      const id = event.args.requestId;
      select(id); saveLink(id, 'request', hash); await refresh(id);
      setNotice(`Request #${id} confirmed. The round is now fixed in the contract.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function fulfill() {
    if (!active) return;
    const chosen = active;
    setError(null); setNotice(null); setBusy('Verifying the drand proof…');
    try {
      const w = await wallet(); const latest = await client.getBlock();
      if (latest.number - chosen.requestBlock + 1n < BigInt(config.minConfirmations) || Number(latest.timestamp) < target) throw new Error('Wait for the round and 18 confirmations before submitting the proof.');
      const { signature } = await fetchProof(chosen.round);
      const pubKeyHash = await client.readContract({ ...demo, functionName: 'pubKeyHash' });
      const { request } = await client.simulateContract({ ...coordinator, functionName: 'fulfillRandomness', args: [chosen.id, demo.address, pubKeyHash, chosen.round, 150000n, signature], account: w.account });
      setBusy('Confirm the proof submission in your wallet…');
      const hash = await writeContract({ address: request.address, abi: request.abi, functionName: request.functionName, args: request.args, value: request.value });
      if (!hash) throw new Error('The wallet did not submit the transaction.'); saveLink(chosen.id, 'fulfill', hash); setBusy('Verifying on Chikyū…');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180000 });
      if (receipt.status !== 'success') throw new Error('The proof submission reverted. Another participant may have submitted it first.');
      await refresh(chosen.id); setNotice('Proof submitted. Check the result recorded in the contract.');
    } catch (e) { setError(errorText(e)); await refresh(); } finally { setBusy(null); }
  }
  async function verify() {
    if (!active?.fulfilled) return;
    const chosen = active;
    setBusy('Checking the signature and result…'); setError(null); setNotice(null);
    try {
      const { signature, hex } = await fetchProof(chosen.round);
      const expected = BigInt(keccak256(encodeAbiParameters([
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' },
      ], [signature[0], signature[1], BigInt(chain.id), coordinator.address, chosen.id, demo.address])));
      const face = await client.readContract({ ...demo, functionName: 'diceFace', args: [expected] });
      if (expected !== chosen.word || face !== chosen.face) throw new Error('The stored result does not match the proof.');
      setProof({ id: chosen.id, hex }); setNotice('Valid BLS signature. The random value and die roll match the onchain result.');
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  return { account, walletChain, balance, mode, setMode, rolls, selectedId, active, remaining, confirmations, ready,
    count, keeper, keeperOnline, keeperLabel, busy, error, setError, rpcError, notice, proof, links, loading,
    refresh, select, connect, requestRoll, fulfill, verify };
}
