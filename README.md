# DogeOS Partner Demos

Four examples on DogeOS Chikyū testnet, sharing one DogeOS SDK connection.
**[Open the demos](https://dogeos-demos.vercel.app)** · [Current branch and review](https://github.com/DogeOS69/onchain-demo-partner/pull/8).

## Demos and hosting

| Demo | What it demonstrates | Where it runs | Integration guide |
| --- | --- | --- | --- |
| [External Rule](https://dogeos-demos.vercel.app/external) | Backend-verified quest eligibility | Vercel server route → Questing staging API | [Quest integration](docs/quest-integration.md#external-rule) |
| [Onchain Rule](https://dogeos-demos.vercel.app/onchain) | Contract events tracked by Questing | Vercel + Chikyū contract | [Quest integration](docs/quest-integration.md#smart-contract-event) |
| [Account Abstraction](https://dogeos-demos.vercel.app/aa) | Smart account pays for a counter operation in DOGE | Vercel → AWS EKS API + Alto bundler | [AA guide](docs/account-abstraction.md) |
| [Randomness](https://dogeos-demos.vercel.app/randomness) | Prepaid drand proof delivery and contract callback | Vercel + AWS EKS keeper + Chikyū contracts | [Randomness guide](randomness/README.md) |

AA uses ERC-4337, EntryPoint v0.9, salt `0` and EIP-712 signatures. The account pays
its own DOGE; this demo has no gas sponsorship or EIP-7702. The API permits the
counter example only. Requirements for a general bundler are in the AA guide.

Randomness uses AnyRand with a prepaid estimate plus a 50% service premium. Excess
request payment is refunded immediately; actual callback gas is not reconciled
later. The coordinator, demo consumer, drand verifier and gas estimator are
upgradeable. Current upgrade authority is the testnet owner wallet.

The frontend is Vercel project `dogeos-demos`. AA and Randomness use separate
namespaces in AWS cluster `mydoge-wallet-staging-eks`. Their former Railway copies
are retired. The separate 7702 devnet experiment is outside these four demos.

## Local setup

Use Node.js 24 or later. From the repository root:

```bash
cp web/.env.example web/.env.local
npm --prefix web ci
npm --prefix web run dev
```

Set the registered DogeOS SDK client ID and application origin in the
[environment template](web/.env.example); follow the selected integration guide
for contracts, backend settings and test DOGE. DogeOS manages Google/X OAuth;
provider secrets do not belong in the frontend.

External Rule still needs its partner API key and quest ID on the server.
The hosted Google/X sign-in flows start successfully; human sign-in followed by
a social-wallet transaction remains unverified. See the validation links below.

## Documentation map

| Need | Source |
| --- | --- |
| Deploy, configure and operate | [AA and Vercel](docs/aa-aws-vercel.md) · [Randomness keeper](docs/randomness-aws.md) |
| Contract addresses and configuration | [AA manifest](aa/config/chikyu.json) · [Randomness manifest](randomness/deployments/chikyu.json) |
| EntryPoint alignment | [v0.9 deployment](docs/entrypoint-09.md) |
| Quest API contract | [OpenAPI](docs/openapi.json) |
| Testnet receipts and verification scope | [AA](docs/aa-aws-vercel-validation.json) · [SDK login](docs/aa-aws-vercel-login-validation.json) · [Paid and upgradeable Randomness](docs/randomness-scroll-validation.json) |

Keep this README as the index. Update behavior and costs in the relevant integration
guide, hosting in the deployment guide, addresses in the manifests, and evidence in
validation files. Historical receipts retain old URLs; they do not define current
hosting. Commercial proposals and internal decisions belong in private documents.

MIT.
