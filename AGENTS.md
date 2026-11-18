# Current demo deployment

The canonical frontend for External Rule, Onchain Rule, Randomness and AA is
https://dogeos-demos.vercel.app. All four routes share one Vercel project and
one DogeOS SDK client. The deployed frontend source is on
`feat/aa-testnet-aws-vercel` (PR #8).

- AA runs on AWS EKS, cluster `mydoge-wallet-staging-eks`, namespace
  `dogeos-aa-testnet`. It uses EntryPoint v0.9, salt 0 and account-paid DOGE;
  this testnet demo has no gas sponsorship or EIP-7702.
- Randomness runs on the same AWS staging EKS cluster, namespace
  `dogeos-randomness-testnet`, deployment `keeper`. Its HTTPS status is served
  by Vercel at `/api/randomness/status`; the signing key stays in EKS.
  It uses Scroll-style prepaid delivery (estimated cost plus 50%) and a general
  coordinator-event keeper with fee collection. All four Randomness contract
  components are upgradeable; addresses and upgrade owners are recorded in
  `randomness/deployments/chikyu.json`. See `docs/randomness-aws.md`
  and `docs/randomness-scroll-validation.json` for current operation.
- Questing and SDK authentication use their existing shared services.
- External Rule still needs its partner API configuration and quest ID.

On 2026-11-17, the duplicate Railway services `partner-demos` and
`partner-sponsorship`, and their `partner-operations` volume, were deleted.
`partner-demos-lab.up.railway.app` and
`partner-sponsorship.railway.internal` are retired endpoints. Do not use old
receipt URLs or earlier deployment notes as current hosting instructions.

The `feat/partner-aa-7702` branch and its Railway services are a separate
devnet experiment. The older `chikyu-aa-lab` is also outside these four demos;
neither is the backend for the canonical Vercel AA demo.

The former Randomness `keeper` service in Railway project `anyrand-chikyu-demo`
was also deleted on 2026-11-17 after a successful AWS fulfillment and restart
check. `keeper-production-fd08a51c.up.railway.app` is retired.

Use `docs/aa-aws-vercel.md` for current hosting and `docs/account-abstraction.md`
for the AA flow. Validation JSON files retain historical URLs and receipts.
