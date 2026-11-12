# Randomness backend

The `/randomness` route in `../web` uses the shared DogeOS SDK connection. This directory contains the already deployed Anyrand contracts, the bounded keeper, and their tests. The deployment in `deployments/chikyu.json` is the same one used by the original randomness demo; copying the source here does not redeploy it or start a second keeper.

```bash
npm ci
npm run compile
npm test
npm run status
```

For a separate deployment, configure `.env.example`, use a dedicated funded Chikyū key, run `npm run deploy`, and update the frontend with `npm run sync:web`. Run a single keeper for that deployment with `npm run keeper`; use the included Dockerfile and Railway config for a continuously running instance. Never run two keepers with the same signing key.

The player pays the request transaction gas. Automatic mode lets the keeper submit the future drand round's BLS proof; manual mode asks the SDK wallet to submit it. Both modes use the same onchain verifier and consumer callback. The UI verifies the proof and recomputes the result. The keeper waits for 18 confirmations, checks fees including the DogeOS data fee, and stops at its configured funding and operation limits.

This is drand evmnet plus Anyrand verification, not an official managed VRF service. The demo uses no stakes, prizes, or value-bearing outcomes. The coordinator is upgradeable and controlled by the deployment owner. Before a production integration, review its trust assumptions, key custody, availability and upgrade policy. Upstream sources and commit are recorded in `vendor/anyrand/UPSTREAM.json`; their original license headers are preserved.
