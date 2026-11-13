"use client";

import { ReactNode, useState } from "react";
import type { ChainType, WalletConnectKitConfig } from "@dogeos/dogeos-sdk";
import dynamic from "next/dynamic";
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { dogeosChain } from "./chain";

// The DogeOS SDK touches `document` at module init, which crashes Next.js
// server prerendering. Lazy-import via a default-export wrapper so
// `next/dynamic` can disable SSR for just this subtree.
const WalletConnectProvider = dynamic(() => import("./sdk-wrapper"), { ssr: false });

const wagmiConfig = createConfig({
  chains: [dogeosChain],
  transports: { [dogeosChain.id]: http() },
  ssr: true,
});

// CRITICAL: tell the SDK about DogeOS testnet. Without `chains.evm` the SDK
// falls back to its default chain registry (mainnet only) and routes RPC
// calls through Tomo's proxy, which doesn't know about DogeOS testnet →
// you get HTTP 500s on `eth_getTransactionCount`, `eth_sendTransaction`,
// etc. Passing the chain here makes the SDK route directly to the RPC URL
// below.
const dogeConfig: WalletConnectKitConfig = {
  clientId: process.env.NEXT_PUBLIC_DOGEOS_CLIENT_ID ?? "",
  // Match Questing: Google/X sign-in connects the EVM wallet.
  defaultConnectChain: "evm" as ChainType,
  login: process.env.NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED === "true"
    ? { basicLogins: [], socialLogins: [{ type: "google" }, { type: "x" }] }
    : { basicLogins: ["externalWallets"], socialLogins: [] },
  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  // Keep the SDK's default light modal and DogeOS yellow, as used in Questing.
  chains: {
    evm: [
      {
        id: dogeosChain.id,
        name: dogeosChain.name,
        rpcUrls: dogeosChain.rpcUrls,
        nativeCurrency: dogeosChain.nativeCurrency,
        blockExplorers: dogeosChain.blockExplorers,
      },
    ],
  },
  metadata: {
    name: "DogeOS Demos",
    description: "Small integration examples on DogeOS Chikyu.",
    url: typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
    icons: [typeof window !== "undefined" ? `${window.location.origin}/brand/doge.png` : "/brand/doge.png"],
  },
};

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletConnectProvider config={dogeConfig}>
          {children}
        </WalletConnectProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
