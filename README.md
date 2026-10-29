# DogeOS Partner Quest Demo

A minimal reference dApp for integrating **Smart Contract Event** and **External Rule** quests with DogeOS. Start in staging, test the complete player flow, then coordinate your production launch with your DogeOS contact.

## Choose your integration

| Your user completes… | Use | How DogeOS learns about it |
| --- | --- | --- |
| An onchain action that emits a contract event | [Smart Contract Event](docs/smart-contract-events.md) | DogeOS detects the configured event. No partner API key or eligibility request is needed. |
| An action verified by your backend | [External Rule](docs/external-rules.md) | Your backend calls `mark-eligible` using a partner API key; the user then clicks **Verify** in Questing. |

Event detection, eligibility, and reward completion are separate steps. For onchain quests, the configured claim mode determines whether the player needs to click **Verify**.

## Documentation

| I want to… | Read |
| --- | --- |
| Register a contract and create an event quest | [Smart Contract Event guide](docs/smart-contract-events.md) |
| Connect my backend to an offchain quest | [External Rule guide](docs/external-rules.md) |
| Look up authentication, payloads, responses, and errors | [Partner API reference](docs/api-reference.md) |
| Run this demo locally | [Run the demo](docs/run-demo.md) |
| Move a tested integration to production | [Going live](docs/going-live.md) |
| Import the API contract into tooling or an agent | [OpenAPI 3.1 document](docs/openapi.json) |

## Start in staging

- **Partner Admin CMS:** <https://thegrandheist-admin.vercel.app/>
- **Player app:** <https://thegrandheist.vercel.app/>
- **Partner API base URL:** `https://quest-api-staging.dogeos.com`

Staging is a separate testing environment. Quest IDs, partner keys, configuration, and eligibility data do not automatically carry over to production.

For a local walkthrough, follow [Run the demo](docs/run-demo.md). You can test either integration independently; an External Rule does not require deploying a contract.

## Code map for developers and agents

| Path | Purpose |
| --- | --- |
| [`contracts/src/EventEmitter.sol`](contracts/src/EventEmitter.sol) | `trigger()` emits `Triggered(address indexed user, uint256 count)`. |
| [`contracts/deploy.sh`](contracts/deploy.sh) | Deploys the example contract and writes its address to `contracts/deployments/<chainId>.json`. |
| [`web/app/page.tsx`](web/app/page.tsx) | Wallet connection and the two demo actions. |
| [`web/app/api/partner-complete-quest/route.ts`](web/app/api/partner-complete-quest/route.ts) | Server-side example of forwarding eligibility to DogeOS. |
| [`web/.env.example`](web/.env.example) | Public browser settings and private backend settings. |
| [`docs/openapi.json`](docs/openapi.json) | Machine-readable contract for the DogeOS partner endpoint, not the demo's local route. |

The partner API key must stay server-side. The demo route simulates task completion and does not authenticate the caller or prove that a task was completed; replace that behavior before exposing it to real users. See [Going live](docs/going-live.md).

The web demo pins `@dogeos/dogeos-sdk@3.3.0-beta.0`. Use the lockfile to reproduce it, and review SDK compatibility with DogeOS before a production release. [SDK documentation](https://sdk.dogeos.com/).

MIT.
