"use client";

// Re-export the WalletConnectProvider as the default export so
// `next/dynamic` can lazy-load it without SSR.
//
// The DogeOS SDK touches `document` at module init, which crashes Next.js
// server prerendering. Splitting this off lets the rest of the app stay
// statically renderable.

import { WalletConnectProvider as WCP } from "@dogeos/dogeos-sdk";

export default WCP;
