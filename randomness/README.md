# Randomness backend

The `/randomness` demo uses the DogeOS SDK and the upstream Anyrand contracts,
with Scroll-style prepaid delivery: estimated fulfillment cost multiplied by
1.5, paid in native testnet DOGE. The requester also pays its request transaction
gas. Upstream Solidity files are unchanged; the pinned source is recorded in
`vendor/anyrand/UPSTREAM.json`.

```bash
# Node 24 or newer
npm ci
npm run compile
npm test
npm run status
```

The paid dice consumer accepts a maximum payment, computes the actual request
quote onchain, forwards exactly that fee to Anyrand and immediately refunds the
excess. The 25% payment headroom is separate from Anyrand's 50% service premium.
The prepaid delivery fee is not reconciled against actual callback gas later.
The paid UI offers automatic delivery only. Historical free/manual requests
remain on the retired consumer in the deployment manifest.

The keeper indexes confirmed `RandomnessRequested` events from the coordinator,
so it can fulfill paid requests from other contracts, not just the dice demo.
It waits for 18 confirmations and the future drand round, verifies through the
original coordinator, and skips requests when their prepaid fee or the 0.2 DOGE
operator cap would not cover its conservative network cost estimate. Failed
callbacks are charged and terminal under upstream Anyrand semantics; there is
no automatic callback retry. A gas-price spike or unavailable beacon can delay
delivery; prepayment is not a guarantee of instant completion or an automatic
refund entitlement.

On this testnet the coordinator owner is also the funded keeper wallet. The
keeper withdraws completed-request fees once at least 0.1 DOGE is available,
reserving fees for pending requests. Confirmed events rebuild collected fees,
withdrawals and network costs after restarts. Recent withdrawals are checked
before another collection. The old 100-operation cap is disabled; the minimum
wallet balance and per-transaction caps remain. If ownership moves to a multisig,
automatic collection stops and status reports that withdrawal/replenishment is
required. The mainnet admin multisig and commercial revenue split are not set
by this demo.

The original `GasStationScroll` is retained and quotes execution plus data cost.
The keeper separately estimates compressed signed-transaction data under Galileo
with 25% data-fee headroom, and records actual receipt costs including `l1Fee`.
The receipt validation compares the quote with the observed network charge;
testnet observations are not a future mainnet price guarantee.

All four application components are upgradeable: the original Anyrand coordinator
uses UUPS; the dice consumer, drand verifier and GasStationScroll use OpenZeppelin
5.0.2 transparent proxies, each with a ProxyAdmin. The deployment manifest records
proxy, implementation, admin and upgrade-owner addresses. The verifier and gas
estimator retain unmodified upstream implementations. The verifier's SSTORE2 data
pointer is immutable in implementation code, which works through delegatecall.
The consumer uses a locked implementation and atomic proxy initialization.

For a new deployment use a dedicated funded Chikyu key and `npm run deploy`.
For the one-time migration from direct components, stop the signing keeper and
run `KEEPER_STOPPED=true node scripts/make-upgradeable.mjs`, then
`npm run sync:web`. `enable-paid.mjs` is an alias for this migration. It preserves
the coordinator address, wraps the existing verifier and estimator implementations,
and deploys the consumer implementation and initialized proxy. Older consumer
requests stay at their historical addresses in `retiredConsumers`; no past data
is claimed to have moved into the new proxy. Never run two signing processes
with the same key. See the [AWS runbook](../docs/randomness-aws.md).

For later updates, keep the proxy addresses and use the recorded ProxyAdmin's
`upgradeAndCall(proxy, newImplementation, initializationData)` for the three
transparent proxies. Use `upgradeToAndCall(newImplementation, initializationData)`
on the coordinator for its UUPS implementation. Only the corresponding owner can
perform an upgrade. Do not put a UUPS implementation behind the transparent
proxies or reuse the one-time migration to perform a later upgrade.

Before any upgrade, compare storage layouts, run the integration tests with the
replacement implementation, and preserve the verifier's drand key, genesis and
period while requests are pending. Storage layouts are included in artifacts.
The tests exercise authorized and unauthorized upgrades of all four components,
locked initializers, preservation of payments and request history, and fulfillment
of requests created before an upgrade. A proxy does not make incompatible storage
changes safe; upgrade authority can change validation and payment behavior.

This uses drand evmnet and Anyrand verification. It is a testnet integration with
no stakes or prizes. The existing testnet owner also controls the three ProxyAdmins.
Production needs its own admin custody, availability, load, callback and security
review; admin ownership can be transferred to the selected multisig before launch.
