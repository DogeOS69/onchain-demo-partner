"use client";
import { useCallback, useEffect, useRef } from "react";
import { useBalance } from "wagmi";
import { formatUnits } from "viem";
import { useAccount, useWalletConnect, ChainTypeEnum } from "@dogeos/dogeos-sdk";
import { dogeosChain } from "./chain";
const dogeosChainInfo = dogeosChain as never;
export function ConnectBar() {
  const { address, chainId, switchChain } = useAccount();
  const { openModal, isConnected, isConnecting, disconnect } = useWalletConnect();
  const { data: nativeBalance } = useBalance({
    address: (address as `0x${string}`) || undefined,
    chainId: dogeosChain.id,
  });

  const switchNetwork = useCallback(async () => {
    try { await switchChain?.({ chainType: ChainTypeEnum.EVM, chainInfo: dogeosChainInfo }); }
    catch { /* A declined switch leaves the explicit retry control available. */ }
  }, [switchChain]);
  const lastAttempted = useRef<number | null>(null);
  const wrong = chainId && Number(chainId) !== dogeosChain.id;
  useEffect(() => {
    if (!isConnected || !wrong || !switchChain) return;
    if (lastAttempted.current === Number(chainId)) return;
    lastAttempted.current = Number(chainId);
    void switchNetwork();
  }, [isConnected, wrong, chainId, switchChain, switchNetwork]);

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
            onClick={() => navigator.clipboard?.writeText(address).catch(() => {})}
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
            Select Chikyū in your wallet to continue.{" "}
            <button
              className="secondary mini"
              onClick={() =>
                void switchNetwork()
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

