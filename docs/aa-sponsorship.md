# AA and gas sponsorship on Chikyū

The [hosted example](https://partner-demos-lab.up.railway.app/sponsorship) uses ERC-4337 **EntryPoint v0.7**, a SimpleAccount, a dedicated CounterPaymaster, and the Alto bundler. The connected SDK wallet signs a UserOperation that increments a counter. Neither the owner wallet nor its smart account needs DOGE. This is a bounded testnet reference, not an official DogeOS paymaster product or a production provider commitment.

## What is deployed

| Component | Address |
| --- | --- |
| EntryPoint v0.7 | `0x799ccb45f55ba51050fec1d2a1b30b65f99c4e81` |
| SimpleAccountFactory | `0x10f2e1986d392d4f5e63ea8a8d60c8da73f7dd2f` |
| Counter | `0x935b84fc676958daf32ce333302f3b396bb4b7cb` |
| CounterPaymaster | `0x2be7db35831a06de47b5b5c55858cb14ecc308dd` |
| Quote signer | `0x47bd6E3E0a8a17aC866A8d3f49D927b97F28a005` |
| Bundler executor | `0x0FDd7B8DDE2A4634B3328AE0Db2f375688A101aF` |

Chain ID: `6281971`. RPC: `https://rpc.testnet.dogeos.com`. [The deployment manifest](../sponsorship/config/chikyu.json) includes code hashes and funding/deployment transactions. The factory salt is `20261112`, separate from the earlier AA lab.

A live verification created a fresh smart account and incremented it in [transaction 0x99db…956cf](https://dogeos-testnet.l2scan.co/tx/0x99db84c55b0cb03327eae49402b8c7cd983f9358274b315fc95a049f74f956cf). Both owner and smart-account balances were zero before and after. Total network fee: **0.05002925563803966 DOGE**; EntryPoint paymaster charge: **0.000005634929051744 DOGE**; L1 data fee: **0.05002396940322962 DOGE**. These are measured values for that transaction, not a fixed quote for later requests.

The paymaster pays the EntryPoint charge from its deposit. The separately funded executor pays the outer transaction and its DogeOS data fee. That data fee is not fully reimbursed by standard EntryPoint gas accounting; this demo explicitly budgets and pays it. Randomness's keeper is a different process and uses a different wallet.

## Flow and API example

1. The SDK exposes the active EIP-1193 provider via `useConnectors().connectors.evm.provider`.
2. `POST /api/sponsorship/prepare` takes `{ "owner": "0x…" }`. The service derives the canonical account, reads its nonce and count, signs a five-minute sponsor quote, estimates gas and reserves the fee budget.
3. The browser independently verifies the pinned contracts, canonical account and owner, exact counter calldata, nonce, quote signature, limits and UserOperation hash.
4. The owner signs the complete UserOperation hash with `personal_sign`. The browser sends only `{ id, signature }` to `POST /api/sponsorship/submit`.
5. Poll `GET /api/sponsorship/operations/:id`. Success requires the exact EntryPoint event with the expected paymaster, the counter event/state, and 18 confirmations. The browser verifies the receipt independently.

```ts
import { api, verifyIntent } from './app/sponsorship/verify';

// `owner` and `provider` come from the active DogeOS SDK connection.
const prepared = await api('prepare', { owner });
await verifyIntent(prepared, owner);
// Also recheck eth_accounts and eth_chainId immediately before signing.
const signature = await provider.request({
  method: 'personal_sign',
  params: [prepared.userOpHash, owner],
});
const operation = await api('submit', { id: prepared.id, signature });
// Persist id + userOpHash before submit; recover the same operation on a timeout.
const status = await api(`operations/${operation.id}`);
```

Use [the complete component](../web/app/sponsorship/page.tsx) for account-change handling, cancellation, persistence, receipt verification and unknown submission outcomes. The raw bundler is bound to loopback and is never exposed through the web proxy. The server cannot accept arbitrary destinations or arbitrary UserOperations through this API.

## Limits and custody

- Only `SimpleAccount.execute(counter, 0, increment())` is sponsored; no token transfer, approval or value transfer is allowed by the paymaster.
- The paymaster permits 50 operations globally and three per account. Failed execution can still consume gas and quota. A new address is not proof of a new person.
- Signed limits: 1,500,000 total gas, 500,000,000 wei max fee per gas and 0.002 DOGE EntryPoint prefund cap. Quotes bind chain, EntryPoint, paymaster, account, nonce, creation data and calldata. The account owner signs the complete final operation, including gas parameters.
- The service caps its recorded network spend at 3 DOGE and reserves at most 0.5 DOGE per operation, including estimated L1 data fees. The executor was funded with 3.5 DOGE; the paymaster received a 0.1 DOGE deposit and a 0.1 DOGE stake. There is no automatic refill.
- One service replica and one executor serialize submissions. State is persisted in a private volume. Do not delete it, run another instance with the same key, or redeploy into an empty volume without reconciling spend and pending operations.
- Interrupted submissions retain the same signed hash. Expiry releases the slot only after a complete event scan, an unused nonce, and the confirmation window. Neither a timeout nor a rejected HTTP response is treated as onchain success.
- Owner, quote signer and executor keys are separate. The owner controls withdrawal of deposit/stake; the quote signer authorizes the restricted action; the executor pays outer transactions. No private key is in the web bundle or example archive.

The custom paymaster is not audited. The public Chikyū RPC used here does not provide the tracing required for full bundler storage validation, so this restricted Alto instance runs with `safe-mode=false`. It accepts only the server-constructed counter operation and checks deployed code/ownership; it must not be turned into a general public bundler. An estimator warning about the second paymaster validation can occur because Alto probes nonzero post-operation gas while this paymaster requires zero; the final operation has zero post-operation gas and is separately simulated and verified.

## Run locally

```bash
npm --prefix sponsorship ci
npm --prefix sponsorship run compile
npm --prefix sponsorship test
npm --prefix web ci
cp web/.env.example web/.env.local
```

For your own paymaster, set `SPONSOR_KEY_FILE` to a private path outside the repo. `npm --prefix sponsorship run deploy:contracts` generates isolated keys if absent and prints an estimate without sending. `FUNDING_KEY_FILE` is a private JSON file containing a dedicated Chikyū funding wallet's `privateKey`. Adding `-- --deploy` funds the isolated deployer with 5 testnet DOGE, deploys the paymaster, funds the executor, deposits and stakes, and records resumable transaction checkpoints. The funding wallet must retain at least 2 DOGE. The script rejects other chains and checks bounded fee estimates before signing.

After deployment copy `sponsorship/config/chikyu.json` to `web/app/sponsorship/deployment.json`. Pin this reviewed manifest in the frontend; never let an untrusted server choose the addresses to sign for.

Start the service with `SPONSOR_KEY_FILE=/private/path/keys.json npm --prefix sponsorship start`. Set `SPONSOR_API_URL=http://127.0.0.1:4341`, `WEB_ORIGIN=http://localhost:3000`, and the registered public SDK client ID in `web/.env.local`, then run `npm --prefix web run dev`. Social/email login also needs `NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=true` and the exact origin registered for that client. With it disabled, the SDK offers external wallets.

## Hosting

The current web and sponsorship service run in separate Railway services in the AA lab environment. Only the web has a public domain. It reaches `http://partner-sponsorship.railway.internal:4341` through the private network. The sponsor has one replica and a `/data` volume. The older AA lab and randomness keeper remain separate deployments.

The Next.js app also works with Vercel: use `web/` as the project root and set its public SDK settings at build time plus `WEB_ORIGIN` and `SPONSOR_API_URL` at runtime. The current private Railway address cannot be reached from Vercel; for that move, provision an authenticated HTTPS connection to the restricted sponsor API, add its server credential to the Next.js proxy, and keep the raw bundler private. Do not point the frontend at a general signing or bundling endpoint.

Set `SPONSOR_QUOTE_PRIVATE_KEY`, `BUNDLER_EXECUTOR_PRIVATE_KEY`, `SPONSOR_STATE_DIR=/data`, `WEB_ORIGIN` and `PORT=4341` on the sponsor. Use the included Dockerfiles; they account for the workspace's restrictive source-file permissions and the volume's ownership. Keys belong only in the secret store. Keep both services at one replica unless replacing the file-backed state and executor locking with a coordinated implementation.

## Validation and provider handoff

`npm --prefix sponsorship test` runs six integration groups against Anvil, including a real Alto process: zero-fund creation/execution; wrong destination/value/call; bad, expired and cross-chain sponsor signatures; nonce and gas bounds; owner signature and quota; restart/replay plus expiry recovery. `npm --prefix web run build` checks the Next.js build and TypeScript.

Browser checks require `npm ci` at the repository root and `npx playwright install chromium`. Run `npm run test:browser` against a running web app. The AA browser test additionally needs `TEST_KEY_FILE=/private/path/test-owner.json` and `WEB_URL=…`; it creates an unfunded test-only owner if missing and performs a real sponsored operation through an injected test provider selected in the actual SDK UI. Signing remains in the Node test runner, never in the browser bundle. This tests the EIP-1193 SDK path, not a human's MetaMask extension or OAuth login.

Before a managed AA provider can replace the demo, ask it to confirm Chikyū chain ID/RPC, EntryPoint v0.7 and factory support, tracing/ERC-7562 validation, UserOperation gas estimates including DogeOS L1 data fees, quote format and validity, signer/custody model, idempotent recovery, account quotas, spend limits, metrics and availability. Confirm independently whether it supports both testnet and mainnet; this demo establishes only Chikyū behavior.

For randomness, the corresponding handoff needs the drand network/public key, future-round selection, onchain verifier/callback ABI, proof-delivery and fee policy, availability, and upgrade controls. There is no required coupling between an AA provider and the randomness keeper.

References: [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337), [Alto source](https://github.com/pimlicolabs/alto), [DogeOS SDK configuration](https://docs.dogeos.com/en/sdk/configuration), [Anyrand source](https://github.com/frogworksio/anyrand).
