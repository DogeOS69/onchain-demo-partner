"use client";

import { useEffect, useRef, useState } from "react";
import { useReadContract, useWaitForTransactionReceipt, useBalance } from "wagmi";
import { formatUnits } from "viem";
import { useAccount, useWalletConnect, useConnectors, ChainTypeEnum } from "@dogeos/dogeos-sdk";
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

export function TriggerEventCard() {
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
      <h1>Onchain rule</h1>
      <p className="desc">Emit an event on Chikyū, then verify the onchain quest in the player app.</p>
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

export function ExternalQuestCard() {
  const { address } = useAccount();
  const { connectors } = useConnectors();
  const [pending, setPending] = useState(false);
  const [marked, setMarked] = useState<null | { questId: string }>(null);
  const [error, setError] = useState<string | null>(null);

  const { openModal } = useWalletConnect();

  const handle = async () => {
    if (!address) { openModal(); return; }
    setPending(true);
    setError(null);
    setMarked(null);
    try {
      const provider = connectors?.evm?.provider as { request: (args: { method: string; params: unknown[] }) => Promise<unknown> } | undefined;
      if (!provider) throw new Error("Connect a wallet through the SDK.");
      const ready = await fetch("/api/partner-complete-quest").then(r => r.json());
      if (!ready.ready) throw new Error("This external quest demo has not been configured yet.");
      const issuedAt = Math.floor(Date.now() / 1000);
      const message = `Complete the external-rule demo\nWallet: ${address.toLowerCase()}\nOrigin: ${window.location.origin}\nQuest: ${ready.questId}\nIssued at: ${issuedAt}`;
      const hex = `0x${Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const signature = await provider.request({ method: 'personal_sign', params: [hex, address] });
      const resp = await fetch("/api/partner-complete-quest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: address, issuedAt, signature }),
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
      <h1>External rule</h1>
      <p className="desc">
        Simulates a partner backend calling <code>mark-eligible</code> after
        the user finished a task on the partner&apos;s site. The user then
        clicks Verify in the player app to claim.
      </p>
      <div className="row">
        <button onClick={handle} disabled={pending}>
          {pending ? "Marking…" : (address ? "Complete demo action" : "Connect wallet")}
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

