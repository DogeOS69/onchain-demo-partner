# Going live

[Documentation home](../README.md) · [Smart Contract Event](smart-contract-events.md) · [External Rule](external-rules.md)

After the complete integration works in staging, contact your DogeOS representative with your staging quest IDs and intended launch date. Coordinate the production configuration and activation before announcing the quest.

## 1. Confirm production quest setup

Confirm the production quest IDs, partner ownership, rewards, claim mode, frequency, availability dates, and publication status. Staging is a separate environment; quests and configuration are not automatically copied into production.

## 2. Configure the selected integration

| Setting | Staging | Production |
| --- | --- | --- |
| Player app | <https://thegrandheist.vercel.app/> | <https://quest.dogeos.com/> |
| Partner API | `https://quest-api-staging.dogeos.com` | `https://quest-api.dogeos.com` |
| Quest ID | Staging quest UUID | Confirmed production quest UUID |
| Partner API key, for External Rule | Staging partner key | Key generated for your partner in production |
| Contract tracking, for Smart Contract Event | Staging contract/event setup | Network, address, ABI, event, wallet mapping, and tracking setup confirmed with DogeOS |

### External Rule

Update the backend's API URL, quest UUID, and key together:

```text
POST https://quest-api.dogeos.com/v2/partner-api/quests/{PRODUCTION_QUEST_ID}/mark-eligible
```

Keep the production key in server-side secret storage. Eligibility written in staging does not make the user eligible in production.

Authenticate the user, associate the correct wallet with their account, and validate the actual action before sending eligibility. The demo's unauthenticated “mark me eligible” route is only a simulation. For recurring actions, confirm the intended eligibility policy with DogeOS; see [eligibility lifetime](api-reference.md#retries-and-eligibility-lifetime).

### Smart Contract Event

Confirm the network, deployed contract address, ABI, unique event name, and wallet-address mapping for production tracking. Do not assume that the demo's testnet settings are the correct production-chain settings. Create and activate tracking before the test action; do not rely on historical events being detected.

This flow does not require a partner key or a `mark-eligible` request.

## 3. Review the demo dependencies and configuration

The demo pins `@dogeos/dogeos-sdk@3.3.0-beta.0`. Confirm the supported stable SDK version with DogeOS, review the [SDK documentation](https://sdk.dogeos.com/), and test any update. Confirm the production SDK client ID, app origin, wallet connection settings, and network configuration.

## 4. Run an agreed production test

Use a designated test account during the agreed launch window:

1. Perform the required action on the configured network or partner platform.
2. For External Rule, confirm a successful eligibility response from the production API. For Smart Contract Event, confirm the successful transaction and event.
3. Open the production quest at <https://quest.dogeos.com/>, click **Verify** if required, and confirm completion and the expected reward.
4. Record the quest ID, EVM wallet, timestamp, and relevant transaction hash or internal action ID for support. Do not include secrets.

## 5. Confirm launch readiness

Confirm with DogeOS that the production quest is published, available during the agreed window, and ready for users before announcing it.
