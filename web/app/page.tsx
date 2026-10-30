"use client";

import { useEffect, useRef, useState } from "react";
import { useReadContract, useWaitForTransactionReceipt, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { useAccount, useWalletConnect, ChainTypeEnum } from "@dogeos/dogeos-sdk";
import { contracts, dogeosChain } from "./chain";
import { eventEmitterAbi } from "./abis";
import { useWriteTx } from "./useWriteTx";

function short(addr?: string) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function explorerLink(hash?: string) {
  if (!hash) return undefined;
  const base = dogeosChain.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : undefined;
}

const dogeosChainInfo = {
  id: dogeosChain.id,
  name: dogeosChain.name,
  nativeCurrency: dogeosChain.nativeCurrency,
  rpcUrls: dogeosChain.rpcUrls,
  blockExplorers: dogeosChain.blockExplorers,
} as never;

function ConnectBar() {
  const { address, chainId, switchChain } = useAccount();
  const { openModal, isConnected, isConnecting, disconnect } = useWalletConnect();
  const { data: nativeBalance } = useBalance({
    address: (address as `0x${string}`) || undefined,
    chainId: dogeosChain.id,
  });

  const lastAttempted = useRef<number | null>(null);
  const wrong = chainId && Number(chainId) !== dogeosChain.id;
  useEffect(() => {
    if (!isConnected || !wrong || !switchChain) return;
    if (lastAttempted.current === Number(chainId)) return;
    lastAttempted.current = Number(chainId);
    switchChain({ chainType: ChainTypeEnum.EVM, chainInfo: dogeosChainInfo });
  }, [isConnected, wrong, chainId, switchChain]);

  if (!isConnected || !address) {
    return (
      <div className="connect-bar">
        <div className="wallet-info">Not connected</div>
        <button onClick={() => openModal()} disabled={isConnecting}>
          {isConnecting ? "Connecting…" : "Connect Wallet"}
        </button>
      </div>
    );
  }

  return (
    <div className="connect-bar">
      <div className="wallet-info">
        <div className="addr addr-row">
          <span style={{ userSelect: "all" }}>{address}</span>
          <button
            className="secondary mini"
            onClick={() => navigator.clipboard?.writeText(address)}
          >
            Copy
          </button>
        </div>
        <div className="balance">
          {nativeBalance
            ? `${Number(formatUnits(nativeBalance.value, 18)).toFixed(4)} ${nativeBalance.symbol}`
            : "…"}
        </div>
        {wrong ? (
          <div className="status err">
            Wrong network — please approve the switch in your wallet.{" "}
            <button
              className="secondary mini"
              onClick={() =>
                switchChain?.({ chainType: ChainTypeEnum.EVM, chainInfo: dogeosChainInfo })
              }
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      <button className="secondary" onClick={() => disconnect()}>
        Disconnect
      </button>
    </div>
  );
}

function TxStatus({ hash, error }: { hash?: `0x${string}`; error?: Error | null }) {
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash });
  if (error) return <div className="status err">{error.message.split("\n")[0]}</div>;
  if (!hash) return null;
  if (isLoading)
    return (
      <div className="status">
        Pending…{" "}
        <a href={explorerLink(hash)} target="_blank" rel="noreferrer">
          {short(hash)}
        </a>
      </div>
    );
  if (isSuccess)
    return (
      <div className="status ok">
        Confirmed →{" "}
        <a href={explorerLink(hash)} target="_blank" rel="noreferrer">
          {short(hash)}
        </a>
      </div>
    );
  return <div className="status">Submitted: {short(hash)}</div>;
}

function TriggerEventCard() {
  const { address } = useAccount();
  const { writeContract, data: hash, error, isPending } = useWriteTx();
  const { data: count } = useReadContract({
    address: contracts.eventEmitter,
    abi: eventEmitterAbi,
    functionName: "callsBy",
    args: address ? [address as `0x${string}`] : undefined,
    query: { enabled: !!address, refetchInterval: 4000 },
  });

  return (
    <div className="card">
      <h3>Smart Contract Event</h3>
      <p className="desc">
        Calls <code>trigger()</code> on EventEmitter to fire a{" "}
        <code>Triggered</code> event. Drives the{" "}
        <strong>Smart Contract Event</strong> quest. DogeOS detects the event;
        open the player app and click Verify if the quest requires manual
        verification.
      </p>
      <div className="row">
        <button
          onClick={() =>
            writeContract({
              address: contracts.eventEmitter,
              abi: eventEmitterAbi,
              functionName: "trigger",
            })
          }
          disabled={isPending || !address}
        >
          {isPending ? "Confirming…" : "Trigger event"}
        </button>
        <span className="addr">
          Your calls: {count !== undefined ? String(count as bigint) : "—"}
        </span>
      </div>
      <TxStatus hash={hash} error={error} />
    </div>
  );
}

function ExternalQuestCard() {
  const { address } = useAccount();
  const [pending, setPending] = useState(false);
  const [marked, setMarked] = useState<null | { questId: string }>(null);
  const [error, setError] = useState<string | null>(null);

  if (!address) return null;

  const handle = async () => {
    setPending(true);
    setError(null);
    setMarked(null);
    try {
      const resp = await fetch("/api/partner-complete-quest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `Request failed: ${resp.status}`);
      setMarked({ questId: data.questId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="card">
      <h3>External Quest</h3>
      <p className="desc">
        Simulates a partner backend calling <code>mark-eligible</code> after
        the user finished a task on the partner&apos;s site. The user then
        clicks Verify in the player app to claim.
      </p>
      <div className="row">
        <button onClick={handle} disabled={pending}>
          {pending ? "Marking…" : "Mark me eligible (partner action)"}
        </button>
      </div>
      {error ? <div className="status err">{error}</div> : null}
      {marked ? (
        <div className="status ok">
          ✅ Eligible. Open the player app and click Verify on quest{" "}
          <span className="addr">{marked.questId.slice(0, 8)}…</span>.
        </div>
      ) : null}
    </div>
  );
}

export default function Page() {
  return (
    <main className="partner-demo">
      <h1>DogeOS Onchain Quest Demo</h1>
      <p className="subtitle">
        Each card drives one quest on {dogeosChain.name}. Complete the action
        here, then check the quest in the player app.
      </p>
      <ConnectBar />
      <TriggerEventCard />
      <ExternalQuestCard />
    </main>
  );
}
