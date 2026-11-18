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
  budget from the contracts on restart. It needs no persistent volume or
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

The contracts, consumer callback, 18-confirmation wait, 100-fulfillment cap,
2 DOGE minimum balance and 0.2 DOGE transaction-cost cap are unchanged.

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
