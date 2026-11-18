# Randomness keeper on AWS

The Chikyu keeper runs in the existing `mydoge-wallet-staging-eks` cluster
in `us-east-2`, namespace `dogeos-randomness-testnet`, deployment `keeper`.
It is independent of the AA deployment in `dogeos-aa-testnet`.

The web app reads status through its own HTTPS endpoint:
`https://dogeos-demos.vercel.app/api/randomness/status`. That Vercel route
fetches the server-only `RANDOMNESS_KEEPER_URL`. The current upstream is
`http://mydoge-staging-randomness-1991598588.us-east-2.elb.amazonaws.com`.
The dedicated ALB exposes only the exact `/status` path. Its upstream
transport is HTTP and carries public status data, without signing keys or
authentication secrets. RPC and drand connections use HTTPS. No CloudFront
distribution is needed for this keeper.

## Runtime

- One signing replica, `Recreate` updates, and a 240-second termination grace
  period to let an in-flight fulfillment finish.
- The existing funded keeper address is
  `0x4518A4baA6BE1a6977F589168cfF6Ce68101703C`.
- Secret `keeper-runtime` contains `PRIVATE_KEY`, `RPC_URL`,
  `MIN_CONFIRMATIONS`, `MIN_BALANCE_DOGE`, `MAX_TX_COST_DOGE`,
  `MAX_AUTO_FULFILLMENTS` and `KEEPER_POLL_MS`. Never commit these values.
- The worker reconstructs pending requests and its cumulative fulfillment
  accounting from confirmed coordinator events on restart. It needs no persistent volume or
  database. Do not run another keeper using this signing key.
- The official Node 24 image is pinned by digest. An init container fetches
  a full pinned public source commit and installs the locked production
  dependencies without lifecycle scripts. Startup requires GitHub and npm
  access, as in the AA testnet deployment.

## Deployment

Provision the namespace and its secret, then render and apply:

```bash
SOURCE_COMMIT=<full-reviewed-commit> node deploy/aws/render-keeper.mjs > /tmp/keeper.json
kubectl --context mydoge-wallet-staging apply -f /tmp/keeper.json
kubectl --context mydoge-wallet-staging rollout status deployment/keeper -n dogeos-randomness-testnet
```

Set `KEEPER_REPLICAS=0` when preparing a migration while the previous keeper
is still running. Stop the old signing process before scaling the new one
to one replica. The renderer rejects values greater than one.

Set `RANDOMNESS_KEEPER_URL` in Vercel and deploy `web/`. The checked-in
frontend configuration uses `/api/randomness`, so its browser requests stay
on the demo's origin. Verify a recent `/status` poll and an automatic request
whose fulfillment receipt succeeds on Chikyu before deleting an old service.

## Paid delivery model

The current keeper fulfills paid requests from the Anyrand coordinator, including
other consumer contracts. The coordinator uses a 15000-basis-point multiplier:
estimated fulfillment cost plus 50%. The new dice consumer forwards the fee and
refunds excess payment during the request. The original AnyRand coordinator,
beacon and GasStationScroll code remain unchanged.

The 18-confirmation wait, 2 DOGE minimum wallet balance and 0.2 DOGE transaction
cost cap remain. `MAX_AUTO_FULFILLMENTS=0` disables the former cumulative cap.
The renderer explicitly sets `AUTO_WITHDRAW=true` and `WITHDRAW_MIN_DOGE=0.1`.
It collects only fees available after reserving pending requests, using upstream
`withdrawETH`. Current testnet owner and keeper are the same wallet; if a
multisig becomes owner, it must handle withdrawals and keeper replenishment.

Status includes `feesCollectedWei`, `feesWithdrawnWei`, `pendingFeeReserveWei`,
`availableFeesWei`, `fulfillmentCostWei`, `withdrawalCostWei`, `lastWithdrawal`
and `withdrawalRequired`. `waiting-gas`, `low-balance` and `retrying` need operator
attention. Costs include DogeOS data fees. The worker reconstructs its event
index on restart, with a 32-block overlap and paginated RPC scans; this remains
a single-instance testnet service, not a production SLA.

All four contract components are upgradeable. The coordinator remains at its
original UUPS proxy. The consumer, drand verifier and gas estimator use transparent
proxies with individual ProxyAdmins; addresses and owners are recorded in
`randomness/deployments/chikyu.json`. The existing testnet keeper/owner controls
these admins. The one-time migration changed the three direct component addresses;
subsequent compatible upgrades keep the proxy addresses and stored state. Historical
consumer data remains at the retired addresses. See `randomness/README.md` for the
upgrade entrypoints and compatibility requirements.

The public frontend stays at `/randomness`; the consumer address changed.
Historical migration receipts below describe the earlier free demo. See
[randomness-scroll-validation.json](randomness-scroll-validation.json) for paid
requests, fee collection and restart evidence.

## Shared staging cluster

This cluster also hosts staging wallet/gateway, user and security services,
embedded wallet/social relay, push and WebSocket services, token platform,
image management, AI Feed and Meilisearch, the job scheduler and Kubernetes
system components. Questing staging runs separately in ECS, cluster
`dogeos-quest-api-staging-cluster` in `us-east-1`.

## Migration validation and retirement

The former Railway `keeper` service in `anyrand-chikyu-demo` was stopped
before the AWS keeper started and deleted on 2026-11-17 after validation.
Its former `keeper-production-fd08a51c.up.railway.app` URL returns 404.
The project has no remaining services or keeper volumes.

A real automatic request (#8) completed through the AWS keeper and returned
die face 4. Replacing the pod recovered five cumulative automatic
fulfillments without sending a duplicate transaction. The published Vercel
app shows the keeper available and the result, with no requests to Railway.
Five Randomness integration tests, TypeScript checking, and the Vercel
production build passed. See [validation receipts](randomness-aws-validation.json).
