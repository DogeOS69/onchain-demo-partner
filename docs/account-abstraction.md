# Account abstraction on Chikyū

The [hosted example](https://partner-demos-lab.up.railway.app/aa) uses ERC-4337 EntryPoint v0.7, SimpleAccount and Alto. The connected DogeOS SDK wallet owns the smart account. Its address is derived from that owner and **salt `0`** using the pinned factory. The user adds test DOGE to that address and signs an operation that increments a counter. The smart account pays the gas, including account deployment on its first operation and the DogeOS data fee.

The scope is account abstraction with user-paid gas. There is no paymaster, sponsor signing key, sponsored quota or EIP-7702 authorization. The former `/sponsorship` page redirects to `/aa`. Accounts created with the previous salt keep their addresses and balances; this change does not migrate their assets.

## Contracts and SDK

Chain ID: `6281971`. RPC: `https://rpc.testnet.dogeos.com`. The [deployment manifest](../aa/config/chikyu.json) pins addresses and runtime hashes. The browser has a reviewed copy in [deployment.json](../web/app/aa/deployment.json).

| Contract | Address |
| --- | --- |
| EntryPoint v0.7 | `0x799ccb45f55ba51050fec1d2a1b30b65f99c4e81` |
| SimpleAccountFactory | `0x10f2e1986d392d4f5e63ea8a8d60c8da73f7dd2f` |
| SimpleAccount implementation | `0x30aACD0f45bc25878b264baf36A83858a2169ba0` |
| Counter | `0x935b84fc676958daf32ce333302f3b396bb4b7cb` |

This EntryPoint has a custom address. Configure it explicitly when using a compatible bundler. Salt alone does not determine interoperability: the owner, factory and account initialization must also agree. The SDK supplies the connected EVM provider and wallet signature; this example implements the ERC-4337 flow around it.

## Flow and fees

1. Connect the SDK wallet. The browser derives the salt-0 smart account and reads its native DOGE balance plus its own EntryPoint deposit.
2. `POST /api/aa/prepare` with `{ "owner": "0x…" }` prepares the fixed counter action. A simulation-only balance override allows a preview before funding; it transfers no funds.
3. Review the maximum gas charge. If needed, the funding button asks the owner's wallet to transfer DOGE to its smart account. It rounds the shortfall up to 0.01 DOGE. Users can also send DOGE directly to the displayed account address.
4. The browser verifies the account, factory, counter calldata, nonce, gas limits and operation hash before `personal_sign`. It posts only `{ id, signature }` to `/api/aa/submit`.
5. The service checks real account funds before broadcasting. Poll `/api/aa/operations/:id` for the exact operation. Success requires the EntryPoint event, a zero paymaster, the counter event/state and 18 confirmations. The browser independently verifies the receipt and actual account charge.

The account's native balance funds any missing EntryPoint prefund. Unused prefund remains in that account's EntryPoint deposit and is available to later operations. The owner's EOA pays only for its explicit funding transfer; the smart account pays for the UserOperation.

Chikyū charges a data fee in addition to execution gas. The service estimates it using the network fee oracle and includes it in `preVerificationGas`, with 25% data-fee headroom and a serialized signed transaction envelope. With Galileo active, the oracle receives zstd-compressed RLP; signature placeholders use distinct incompressible bytes. Both UserOperation fee caps are equal, fixing its EntryPoint gas price. The displayed maximum includes this buffer; the preverification component is charged in full, so it is not a promise of exact network-cost pass-through. The receipt exposes both the account charge and the total network cost.

Alto uses `skip-local-gas-calculations=true` to estimate bundle gas from the RPC and bid the network gas price. This prevents data-fee reimbursement from being spent again as an inflated L2 tip. The executor still needs working capital to submit a transaction and gets reimbursed by the account. This is a single-operation, single-executor testnet demo with a maximum account charge of 0.5 DOGE per operation.

Prepared previews expire after five minutes. **A submitted SimpleAccount signature does not expire onchain.** Lost or ambiguous responses remain pending, including across restarts; the service reconciles or retries the same operation hash and does not issue a replacement operation on that nonce merely because time passed. File state is persisted separately from the previous sponsored demo.

## Run and deploy

Use Node.js 24 or later (the backend uses native zstd compression).

```bash
npm --prefix aa ci
npm --prefix aa test
npm --prefix web ci
npm --prefix web run build
```

Set `BUNDLER_EXECUTOR_PRIVATE_KEY` on the backend, or `AA_KEY_FILE` to a private JSON containing `executorPrivateKey`. The executor must match the manifest. Use `AA_STATE_DIR=/data`, `PORT=4341`, and `WEB_ORIGIN` for the web origin. No quote-signing key is required.

Start with `npm --prefix aa start`. Set `AA_API_URL=http://127.0.0.1:4341` on the web server, plus the existing SDK client configuration, then run `npm --prefix web run dev`. SDK public settings require a rebuild when changed. The restricted API accepts only this counter flow; Alto listens only on loopback.

Railway runs the backend and web separately. The existing private service is still named `partner-sponsorship` for deployment continuity; the web uses `AA_API_URL=http://partner-sponsorship.railway.internal:4341`. It now runs the `aa/` Dockerfile. Keep its existing `/data` volume and one replica. Deploy `web/` with its own Dockerfile. Old paymaster contracts and their funds are not used or withdrawn by this change.

## Verification

The backend tests run a real Anvil chain and Alto process: salt-0 derivation, failure without account funds, account-paid deployment/execution, exact balance/deposit accounting, replay protection, signature and intent checks, real bundling, restart recovery and pending recovery beyond the preview TTL. A pricing regression checks that data-fee reimbursement cannot inflate the bundle tip, including retries.

For the real testnet browser flow, install root dependencies and Chromium, build the web app with a registered client ID and `NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=false`, then set `WEB_URL` and `TEST_KEY_FILE` to a private JSON containing a dedicated test owner's `privateKey`, fund that owner's EOA with enough test DOGE for the displayed maximum and its funding transfer, then run `npm run test:browser:aa`. It uses the actual SDK picker with an injected test provider, approves a bounded funding transfer and signs one UserOperation. Signing stays in the Node test runner. It verifies account payment of the full network fee, zero paymaster, reload recovery and the shared SDK connection. For testing against the published backend, a local web build can proxy to `AA_API_URL=https://partner-demos-lab.up.railway.app/api/aa`. The public deployment uses Google/X login; this browser test does not complete OAuth or exercise a human wallet extension.

Historical results for the previous sponsored implementation remain in `docs/validation.json`; they do not describe the current payment flow. Current release evidence is recorded separately in `docs/aa-validation.json`.
