"use client";

import { useCallback, useState } from "react";
import {
  encodeFunctionData,
  createPublicClient,
  http,
  serializeTransaction,
  type Abi,
} from "viem";
import { useAccount, useConnectors, ChainTypeEnum } from "@dogeos/dogeos-sdk";
import { dogeosChain } from "./chain";

// Drop-in replacement for wagmi's `useWriteContract` that routes through
// the DogeOS SDK's wallet provider (Tomo adapter).
//
// Why we can't use wagmi here:
//   wagmi.useWriteContract needs an active wagmi connector to sign with.
//   The DogeOS SDK opens its own modal and connects via Tomo's adapter —
//   it does NOT register a wagmi connector. So `useWriteContract` from
//   wagmi throws "Connector not connected" the moment you call it.
//
// What we do instead:
//   `useConnectors()` from the SDK exposes the EVM provider (EIP-1193
//   compatible) of the currently connected wallet. We use it directly with
//   `eth_sendTransaction`, after auto-switching to the demo chain if the
//   wallet is on the wrong one.
//
//   Tomo's embedded wallet routes some RPC calls through its own backend
//   proxy (mydoge-wallet.tomo.inc), which doesn't have routing for the
//   DogeOS testnet today. To sidestep that, we pre-fetch nonce / gas /
//   gasPrice from the **public DogeOS RPC** (which works) and pass them
//   explicitly. Tomo then has nothing left to fetch and the tx flies.
//   External wallets (MetaMask) ignore the pre-fill and work either way.

export type WriteArgs = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

export type WriteState = {
  writeContract: (args: WriteArgs) => Promise<void>;
  data?: `0x${string}`;
  error: Error | null;
  isPending: boolean;
};

const publicClient = createPublicClient({
  chain: dogeosChain,
  transport: http(),
});

function toHex(n: bigint): `0x${string}` {
  return `0x${n.toString(16)}`;
}

export function useWriteTx(): WriteState {
  const { connectors } = useConnectors();
  const { chainId, switchChain } = useAccount();
  const [data, setData] = useState<`0x${string}` | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setPending] = useState(false);

  const writeContract = useCallback(
    async (write: WriteArgs) => {
      setError(null);
      setData(undefined);
      setPending(true);

      try {
        const provider = connectors?.evm?.provider as
          | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
          | undefined;

        if (!provider) {
          throw new Error(
            "No EVM provider connected. Open the wallet modal and connect a wallet."
          );
        }

        // First: register the chain with the wallet so its internal RPC
        // proxy knows where to fetch nonce/gas. Without this the Tomo
        // embedded wallet falls back to `mydoge-wallet.tomo.inc/rpc/v1/eth`
        // which doesn't have DogeOS testnet → 500 on eth_getTransactionCount.
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${dogeosChain.id.toString(16)}`,
                chainName: dogeosChain.name,
                nativeCurrency: dogeosChain.nativeCurrency,
                rpcUrls: dogeosChain.rpcUrls.default.http,
                blockExplorerUrls: dogeosChain.blockExplorers
                  ? [dogeosChain.blockExplorers.default.url]
                  : undefined,
              },
            ],
          });
        } catch {
          // Wallet may already have it / may not support add → ignore.
        }

        // Auto-switch to the demo chain if needed.
        if (chainId && Number(chainId) !== dogeosChain.id) {
          if (!switchChain) {
            throw new Error(
              `Wallet is on chain ${chainId}, demo expects ${dogeosChain.id}. Switch manually.`
            );
          }
          await switchChain({
            chainType: ChainTypeEnum.EVM,
            chainInfo: {
              id: dogeosChain.id,
              name: dogeosChain.name,
              nativeCurrency: dogeosChain.nativeCurrency,
              rpcUrls: dogeosChain.rpcUrls,
              blockExplorers: dogeosChain.blockExplorers,
            } as never,
          });
        }

        const accounts = (await provider.request({
          method: "eth_requestAccounts",
        })) as `0x${string}`[];
        if (!accounts?.[0]) throw new Error("Wallet returned no accounts");
        const from = accounts[0];

        const calldata = encodeFunctionData({
          abi: write.abi,
          functionName: write.functionName,
          args: write.args as readonly unknown[] | undefined,
        });

        // Pre-fetch nonce / fees / gas from the public DogeOS RPC so the
        // wallet has nothing to look up. DogeOS is EIP-1559 (Prague) —
        // legacy gasPrice txs are rejected with "insufficient funds".
        // We must send type-2 with maxFeePerGas / maxPriorityFeePerGas.
        const [nonce, block, gas] = await Promise.all([
          publicClient.getTransactionCount({ address: from }),
          publicClient.getBlock({ blockTag: "latest" }),
          publicClient.estimateGas({
            account: from,
            to: write.address,
            data: calldata,
            value: write.value,
          }).catch(() => 500_000n),
        ]);

        const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
        const maxPriorityFeePerGas = 100n; // testnet has near-zero tips
        const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;

        const txParams: Record<string, unknown> = {
          from,
          to: write.address,
          data: calldata,
          value: toHex(write.value ?? 0n),
          nonce: toHex(BigInt(nonce)),
          maxFeePerGas: toHex(maxFeePerGas),
          maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
          gas: toHex(gas),
          type: "0x2",
        };

        // Plan A: eth_sendTransaction (wallet builds + signs + broadcasts).
        // Plan B: if Plan A fails because the wallet's RPC proxy can't see
        // DogeOS testnet (or signs for the wrong chain), try eth_signTransaction
        // (wallet just signs the pre-built tx) then we broadcast through OUR
        // publicClient. Patterns cover both old (mydoge-wallet.tomo.inc) and
        // current (wallet.tomo.inc) Tomo proxies and the "wrong-chain signing"
        // case where the embedded wallet ignores switchChain and signs for
        // mainnet — surfaces as "insufficient funds" from the proxy.
        let hash: `0x${string}`;
        try {
          hash = (await provider.request({
            method: "eth_sendTransaction",
            params: [txParams],
          })) as `0x${string}`;
        } catch (sendErr) {
          const m = (sendErr as Error).message ?? "";
          const lower = m.toLowerCase();
          const looksLikeProxyFailure =
            lower.includes("tomo.inc") ||
            lower.includes("failed to get nonce") ||
            lower.includes("internal server error") ||
            lower.includes("transaction creation failed") ||
            lower.includes("insufficient funds");
          if (!looksLikeProxyFailure) throw sendErr;

          // Plan B
          const signedRaw = await provider.request({
            method: "eth_signTransaction",
            params: [
              {
                ...txParams,
                chainId: toHex(BigInt(dogeosChain.id)),
              },
            ],
          });

          // Normalize wallet response into a serialized 0x-hex tx that
          // sendRawTransaction can broadcast.
          let serialized: `0x${string}`;
          if (typeof signedRaw === "string" && signedRaw.startsWith("0x")) {
            serialized = signedRaw as `0x${string}`;
          } else if (signedRaw && typeof signedRaw === "object") {
            const o = signedRaw as Record<string, unknown>;
            // Tomo's embedded wallet returns the **parsed** tx as an object
            // with r/s/v/yParity plus all the original fields. We just
            // re-RLP-encode it with viem.
            if (o.r && o.s) {
              serialized = serializeTransaction(
                {
                  to: write.address,
                  value: write.value ?? 0n,
                  nonce: Number(nonce),
                  gas,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                  data: calldata,
                  chainId: dogeosChain.id,
                  type: "eip1559",
                },
                {
                  r: o.r as `0x${string}`,
                  s: o.s as `0x${string}`,
                  yParity: (o.yParity as 0 | 1 | undefined) ??
                    (BigInt(o.v as string | number | bigint) % 2n === 0n ? 1 : 0),
                }
              );
            } else {
              const candidate =
                (o.rlp_signed_tx as string | undefined) ??
                (o.signedTransaction as string | undefined) ??
                (o.raw as string | undefined) ??
                (o.signed as string | undefined);
              if (!candidate || !candidate.startsWith("0x")) {
                throw new Error(
                  "eth_signTransaction returned an object I couldn't decode: " +
                    JSON.stringify(o, (_k, v) =>
                      typeof v === "bigint" ? v.toString() : v
                    )
                );
              }
              serialized = candidate as `0x${string}`;
            }
          } else {
            throw new Error(
              "eth_signTransaction returned unexpected: " + String(signedRaw)
            );
          }

          hash = await publicClient.sendRawTransaction({
            serializedTransaction: serialized,
          });
        }

        setData(hash);
      } catch (e) {
        const msg = ((e as Error).message ?? String(e)).toLowerCase();
        // Both Plan A and Plan B failed on the embedded wallet → tell the
        // user to use MetaMask instead. Plan B's eth_signTransaction may
        // not be exposed by all wallets.
        if (msg.includes("tomo.inc") || msg.includes("failed to get nonce")) {
          setError(
            new Error(
              "The embedded wallet couldn't sign on DogeOS testnet. " +
                "Disconnect and reconnect with MetaMask (External Wallet)."
            )
          );
        } else {
          setError(e as Error);
        }
      } finally {
        setPending(false);
      }
    },
    [connectors, chainId, switchChain]
  );

  return { writeContract, data, error, isPending };
}
