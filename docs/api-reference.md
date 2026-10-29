# External Rule partner API reference

[Documentation home](../README.md) · [External Rule walkthrough](external-rules.md) · [OpenAPI 3.1](openapi.json)

This reference describes the DogeOS partner endpoint. The demo's `/api/partner-complete-quest` route is a separate local adapter with a different response envelope.

## Environments and authentication

| Environment | Base URL |
| --- | --- |
| Staging | `https://quest-api-staging.dogeos.com` |
| Production | `https://quest-api.dogeos.com` |

Use `X-Partner-API-Key: <raw partner key>`. The key must belong to the partner that owns the quest in the same environment. Keep it server-side. This endpoint does not use the player's JWT as its partner credential.

## POST `/v2/partner-api/quests/{questId}/mark-eligible`

Record that a wallet is eligible to verify an `external_rule` quest.

### Path and headers

| Name | Location | Required | Description |
| --- | --- | --- | --- |
| `questId` | Path | Yes | UUID of an existing, non-deleted External Rule quest owned by your partner. |
| `X-Partner-API-Key` | Header | Yes | Raw partner key generated in the CMS. |
| `Content-Type` | Header | Yes | `application/json`. |

### JSON body

| Field | Required | Description |
| --- | --- | --- |
| `walletAddress` | Yes | String containing an EVM address: lowercase `0x` prefix followed by 40 hexadecimal characters. Surrounding whitespace is trimmed and storage/response addresses are lowercased. |
| `metadata` | No | Audit context. Prefer a JSON object; the current backend accepts any JSON value. Omitted or `null` metadata becomes `{}`. |

```json
{
  "walletAddress": "0x22a4839d6d0342283d42a0e973e3183fc14e4637",
  "metadata": { "score": 100, "internalUserId": "user_abc123" }
}
```

`metadata.nativeAppEvidence` is reserved for the separately configured MyDoge native-app integration. Do not include that field in a general partner signal.

### Success: HTTP 200

```json
{
  "data": {
    "marked": true,
    "questId": "013f60a4-3a6e-4bb1-888b-435a845534a8",
    "walletAddress": "0x22a4839d6d0342283d42a0e973e3183fc14e4637"
  },
  "status": 200
}
```

The user still completes the quest through Questing verification. This response does not confirm reward delivery.

### Handler validation errors: HTTP 422

The current Quest API returns `422 Unprocessable Entity` for these validation failures, including missing or invalid partner keys. They are not HTTP `400` responses.

Example:

```json
{
  "message": "Validation error: Missing X-Partner-API-Key header",
  "status": 422,
  "code": null,
  "retryable": null,
  "recommendedAction": null,
  "source": null
}
```

The following messages are prefixed with `Validation error: ` in the response:

| Message | Cause / correction |
| --- | --- |
| `Missing X-Partner-API-Key header` | Add a non-empty API key header. |
| `Invalid or revoked API key` | Use an active key from this environment. |
| `walletAddress must be a 0x-prefixed 40-character hex string` | Supply the player's EVM address. |
| `Quest {id} not found` | Check the UUID and environment; the quest must exist and not be deleted. |
| `This quest is not owned by any partner` | Ask DogeOS to confirm partner ownership. |
| `This API key does not have access to that quest` | The key and quest belong to different partners. |
| `Quest type '{type}' does not support partner-marked eligibility. Only external_rule quests use this flow.` | Use an `external_rule` quest; onchain event quests do not use this endpoint. |
| `Native app evidence is required only for the configured MyDoge quest` | Remove the reserved `nativeAppEvidence` field for a general partner quest, or use the separately agreed native-app integration. |

### Request parsing and other failures

Requests can fail before the handler runs. Invalid UUIDs or malformed JSON can return `400`; missing/wrong field types can return `422`; a missing or unsupported JSON content type can return `415`. These framework rejections may be plain text and need not use the JSON error envelope above. Infrastructure and server failures can also have other statuses and response formats.

Check the HTTP status and content type before parsing a body. Do not assume every error has `message`, `code`, or `retryable` fields.

## Retries and eligibility lifetime

- Eligibility is keyed by **quest ID + normalized wallet address**. Sending the same signal again upserts that record rather than creating another one.
- A repeated signal refreshes its timestamp, records the current key, and **replaces** metadata. Omitting metadata on a retry therefore replaces the previous value with `{}`.
- After a network failure or transient server error, retry with bounded backoff using the same quest, wallet, and metadata. Correct validation errors before retrying.
- This endpoint does not itself grant another reward on a retry. Quest verification and reward rules remain separate.
- The general eligibility lookup checks whether the record exists; it is not consumed by verification and has no expiry check. Do not assume one eligibility signal proves a new action in each daily or weekly period. Agree recurring-action requirements with DogeOS before launch.
- There is no eligibility-revocation endpoint documented here. Coordinate corrections with DogeOS.

## Contract provenance

Reviewed on **2026-10-29** against Quest API staging source at [`6d1cbbd884d22c83746162fb0bb1a4a194f8e783`](https://github.com/DogeOS69/dogeos-quests/tree/6d1cbbd884d22c83746162fb0bb1a4a194f8e783). The implementation is in `apps/api/src/services/external_rewards/eligibility.rs`, `apps/api/src/db/quest_external_eligibility.rs`, and `apps/api/src/config/error.rs`. Access to that repository may be restricted; the request contract is reproduced in this page and [OpenAPI](openapi.json).

Keep this reference and the OpenAPI document aligned when the backend contract changes. Confirm production behavior as part of the [launch walkthrough](going-live.md).
