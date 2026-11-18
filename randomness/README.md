# Randomness backend

The `/randomness` demo uses the DogeOS SDK and the upstream Anyrand contracts,
with Scroll-style prepaid delivery: estimated fulfillment cost multiplied by
1.5, paid in native testnet DOGE. The requester also pays its request transaction
gas. Upstream Solidity files are unchanged; the pinned source is recorded in
`vendor/anyrand/UPSTREAM.json`.

```bash
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

For a new deployment use a dedicated funded Chikyu key and `npm run deploy`.
To migrate the current free deployment, stop its signing keeper and run
`KEEPER_STOPPED=true node scripts/enable-paid.mjs`, then `npm run sync:web`.
The migration preserves the coordinator, verifier and gas station, deploys only
the paid consumer, and sets the coordinator multiplier to 15000 basis points.
Never run two processes with the same signing key. See the [AWS runbook](../docs/randomness-aws.md).

This uses drand evmnet and Anyrand verification. It is a testnet integration with
no stakes or prizes. The coordinator remains upgradeable; production needs its
own availability, admin custody, load, callback and security review.
