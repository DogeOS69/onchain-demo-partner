# Account abstraction on Chikyū

The [hosted example](https://partner-demos-lab.up.railway.app/aa) runs canonical **EntryPoint v0.9**, aligned with DogeOS preinstalls v0.2.2. Contracts, backend and web were deployed and verified on Chikyū on 2026-11-16 UTC; see [entrypoint-09.md](entrypoint-09.md) and the [validation receipts](aa-validation.json).

The connected DogeOS SDK wallet owns the smart account. Its address is derived from that owner and **salt `0`** using the pinned factory. The user adds test DOGE to that address and signs an operation that increments a counter. The smart account pays the gas, including account deployment on its first operation and the DogeOS data fee.

The scope is account abstraction with user-paid gas. There is no paymaster, sponsor signing key, sponsored quota or EIP-7702 authorization. The former `/sponsorship` page redirects to `/aa`. Accounts created with the previous salt keep their addresses and balances; this change does not migrate their assets.

## Contracts and SDK

Chain ID: `6281971`. RPC: `https://rpc.testnet.dogeos.com`. The [deployment manifest](../aa/config/chikyu.json) pins addresses and runtime hashes. The browser has a reviewed copy in [deployment.json](../web/app/aa/deployment.json).

The following are the verified **v0.9 live deployment** addresses.

| Contract | Address |
| --- | --- |
| EntryPoint v0.9 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |
| SimpleAccountFactory | `0xc991D3F45eE3dBb2cB270E48195384154C9d40bb` |
| SimpleAccount implementation | `0xE1D56b7F2eC2DA5fDc0A7C2958C9b2Ff1d0b4b2D` |
| Counter | `0x935b84fc676958daf32ce333302f3b396bb4b7cb` |

The old v0.7 deployment is archived in [chikyu-07-retired.json](../aa/config/chikyu-07-retired.json). The new EntryPoint uses its canonical CREATE2 address. Configure the chosen EntryPoint and version explicitly in the bundler and SDK. Salt alone does not determine interoperability: the owner, factory and account initialization must also agree. Changing the factory changes the smart-account address and does not move existing assets.

## Flow and fees

1. Connect the SDK wallet. The browser derives the salt-0 smart account and reads its native DOGE balance plus its own EntryPoint deposit.
2. `POST /api/aa/prepare` with `{ "owner": "0x…" }` prepares the fixed counter action. A simulation-only balance override allows a preview before funding; it transfers no funds.
3. Review the maximum gas charge. If needed, the funding button asks the owner's wallet to transfer DOGE to its smart account. It rounds the shortfall up to 0.01 DOGE. Users can also send DOGE directly to the displayed account address.
4. The browser verifies the account, factory, counter calldata, nonce, gas limits, genesis hash and operation hash before `eth_signTypedData_v4` (EIP-712). It posts only `{ id, signature }` to `/api/aa/submit`. Old `personal_sign` signatures are rejected.
5. The service checks real account funds before broadcasting. Poll `/api/aa/operations/:id` for the exact operation. Success requires the EntryPoint event, a zero paymaster, the counter event/state and 18 confirmations. The browser independently verifies the receipt and actual account charge.

The account's native balance funds any missing EntryPoint prefund. Unused prefund remains in that account's EntryPoint deposit and is available to later operations. The owner's EOA pays only for its explicit funding transfer; the smart account pays for the UserOperation.

Chikyū charges a data fee in addition to execution gas. The service estimates it using the network fee oracle and includes it in `preVerificationGas`, with 25% data-fee headroom and a serialized signed transaction envelope. With Galileo active, the oracle receives zstd-compressed RLP; signature placeholders use distinct incompressible bytes. Both UserOperation fee caps are equal, fixing its EntryPoint gas price. The displayed maximum includes this buffer; the preverification component is charged in full, so it is not a promise of exact network-cost pass-through. The receipt exposes both the account charge and the total network cost.

Alto uses `skip-local-gas-calculations=true` to estimate bundle gas from the RPC and bid the network gas price. This prevents data-fee reimbursement from being spent again as an inflated L2 tip. The executor still needs working capital to submit a transaction and gets reimbursed by the account. This is a single-operation, single-executor testnet demo with a maximum account charge of 0.5 DOGE per operation.

Prepared previews expire after five minutes. **A submitted SimpleAccount signature does not expire onchain.** Lost or ambiguous responses remain pending, including across restarts; the service reconciles or retries the same operation hash and does not issue a replacement operation on that nonce merely because time passed. File state is persisted separately from the previous sponsored demo.

## Run and deploy

Use Node.js 24 or later (the backend uses native zstd compression). Complete the v0.9 contract deployment in [entrypoint-09.md](entrypoint-09.md) before starting or publishing this branch.

```bash
npm --prefix aa ci
npm --prefix aa test
npm --prefix web ci
npm --prefix web run build
```

Set `BUNDLER_EXECUTOR_PRIVATE_KEY` on the backend, or `AA_KEY_FILE` to a private JSON containing `executorPrivateKey`. The executor must match the manifest. Use `AA_STATE_DIR=/data`, `PORT=4341`, and `WEB_ORIGIN` for the web origin. No quote-signing key is required.

Start with `npm --prefix aa start`. Set `AA_API_URL=http://127.0.0.1:4341` on the web server, plus the existing SDK client configuration, then run `npm --prefix web run dev`. SDK public settings require a rebuild when changed. The restricted API accepts only this counter flow; Alto listens only on loopback.

Railway runs the backend and web separately. The existing private service is still named `partner-sponsorship` for deployment continuity; the web uses `AA_API_URL=http://partner-sponsorship.railway.internal:4341`. It now runs the `aa/` Dockerfile. Keep its existing `/data` volume and one replica. Deploy `web/` with its own Dockerfile. Old paymaster contracts and their funds are not used or withdrawn by this change.

## Operator handoff

Alto is pinned to `0.0.21`, with `entrypoint-simulation-contract-v9` pointing
to `0xA81301127785225E5A190B3D0adE652a9BE53D26`. Preserve the manifest's
EntryPoint, version, factory, chain ID and genesis when handing this to Unifra.
The public Chikyū RPC returned `Method not found` for `debug_traceCall` during
rollout. This restricted lab therefore uses `safe-mode=false`, one executor,
private Alto RPC and an API that only allows the counter action.

A general public bundler needs compatible tracing and validation, mempool
policy, funded executor/nonce management, durable operation recovery, monitoring
and capacity limits. The DogeOS Galileo compressed data-fee calculation must
also remain in place so the account covers the network cost. The lab is evidence
of the integration, not a production availability or security commitment.

## Verification

The backend tests run a real Anvil chain and Alto process: salt-0 derivation, failure without account funds, account-paid deployment/execution, exact balance/deposit accounting, replay protection, signature and intent checks, real bundling, restart recovery and pending recovery beyond the preview TTL. A pricing regression checks that data-fee reimbursement cannot inflate the bundle tip, including retries.

For the real testnet browser flow, install root dependencies and Chromium, build the web app with a registered client ID and `NEXT_PUBLIC_SOCIAL_LOGIN_ENABLED=false`, then set `WEB_URL` and `TEST_KEY_FILE` to a private JSON containing a dedicated test owner's `privateKey`, fund that owner's EOA with enough test DOGE for the displayed maximum and its funding transfer, then run `npm run test:browser:aa`. It uses the actual SDK picker with an injected test provider, approves a bounded funding transfer and signs one UserOperation. Signing stays in the Node test runner. It verifies account payment of the full network fee, zero paymaster, reload recovery and the shared SDK connection. For testing against the published backend, a local web build can proxy to `AA_API_URL=https://partner-demos-lab.up.railway.app/api/aa`. The public deployment uses Google/X login; this browser test does not complete OAuth or exercise a human wallet extension.

`docs/aa-validation.json` records the **v0.9** network and browser proof.
The earlier self-paid v0.7 proof remains in `docs/aa-07-validation.json`;
historical sponsored results remain in `docs/validation.json`.
