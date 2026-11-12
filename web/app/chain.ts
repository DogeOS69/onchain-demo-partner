import { defineChain } from "viem";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 6281971);
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.testnet.dogeos.com/";
const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL ?? "https://dogeos-testnet.l2scan.co";
const name = process.env.NEXT_PUBLIC_CHAIN_NAME ?? "DogeOS Chikyu";
const symbol = process.env.NEXT_PUBLIC_NATIVE_SYMBOL ?? "DOGE";

export const dogeosChain = defineChain({
  id: chainId,
  name,
  network: "dogeos-testnet",
  nativeCurrency: { name: "Dogecoin", symbol, decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
    public: { http: [rpcUrl] },
  },
  blockExplorers: explorerUrl
    ? { default: { name: "Explorer", url: explorerUrl } }
    : undefined,
});

export const contracts = {
  eventEmitter: (process.env.NEXT_PUBLIC_EVENT_EMITTER_ADDRESS ?? "0xB5F4756Ef5BE714Bd35fCf976da52F1F7aD11f66") as `0x${string}`,
};
