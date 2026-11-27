# EntryPoint alignment

Target: the canonical final EntryPoint **v0.9.0** included in DogeOS preinstalls
**v0.2.2**, the image pinned by the reviewed mainnet launch configuration.
The pipeline also includes 0.6, 0.7 and 0.8; it does not mandate one version
for every application.

- EntryPoint: `0x433709009B8330FDa32311DF1C2AFA402eD8D009`.
- Preinstalls commit: `b24d252b97c46b750e8f96779bbb4a48222908fe`.
- Upstream final release: `b36a1ed52ae00da6f8a4c8d50181e2877e4fa410`.
- Bundler: Alto 0.0.21, with its v0.9 simulation contract.
- SimpleAccount signatures: EIP-712; the earlier personal-sign format is rejected.
- Factory: final upstream v0.9, creation restricted to EntryPoint's SenderCreator.
- Account salt remains 0. The account pays execution and DogeOS data fees in DOGE.
- No paymaster, sponsorship or 7702 activation in this branch.

The npm package `@account-abstraction/contracts@0.9.0` was not published at the
time of this change. The available RC's creation bytes differ from the final
release. Instead, account sources and their hashes are vendored from the exact
final release. EntryPoint uses the exact creation bytes shipped by preinstalls.
`npm ci` checks provenance and builds the accounts reproducibly with pinned
Solidity and OpenZeppelin versions.

## Deployment

The v0.9 rollout is live at <https://dogeos-demos.vercel.app/aa>.
The checked-in Chikyū and browser manifests record confirmed deployments from
2026-11-16 UTC; their contents and every runtime hash were verified against the
network. The backend rejects manifests from another version or network.

| Contract | Deployment transaction |
| --- | --- |
| EntryPoint v0.9 | `0xcca5b5f5f93c1c83abb151f6f225dea56564fbef3f735f07e733142cec65d3a7` |
| SimpleAccountFactory | `0x14ebd1f2829489b1109b377bcc1e729dd80fedddb51bec8a2f148ca2d29caf68` |
| EntryPointSimulations09 | `0xde71fc0a3fb8ed68cea2974ae3fc0e51c1efe7faa5a367977f0842018cd7958c` |

All three passed 18 confirmations. Their combined execution and data fees were
`11.881803582743836723 DOGE`; this is the observed cost, not a fixed quote.
Existing counter and Pimlico simulation code was verified and reused.

The deploy script is restricted to the Chikyū genesis hash. Testnet and devnet
currently share chain ID 6281971, so a chain-ID check alone is insufficient.

From `aa/`, using an ignored key file with `privateKey` or `deployerPrivateKey`:

```sh
AA_DEPLOY_KEY_FILE=/secure/testnet-key.json node scripts/deploy.mjs
AA_DEPLOY_KEY_FILE=/secure/testnet-key.json node scripts/deploy.mjs --apply
npm test
```

The first command only quotes costs. The second deploys canonical EntryPoint,
the factory and EntryPointSimulations09, records signed transactions before
broadcast, waits for confirmations, and updates both manifests only after
verification. The counter and PimlicoSimulations helper are reused after checking
their runtime hashes. The old manifest is archived as `chikyu-07-retired.json`.
Funding is test DOGE only. No mainnet deployment is performed.

Changing the factory changes the salt-0 account address. Assets in a previous
0.7 account stay there; this change does not migrate them. Backend operation
state also has a separate v0.9 filename, `aa-operations-09.private.json`, on the
existing `/data` volume. Before deployment, the old state held two confirmed
operations and no submitted or included operations.

The following IDs record the original rollout. Both Railway services were
deleted on 2026-11-17; current hosting is documented in [aa-aws-vercel.md](aa-aws-vercel.md).

| Component | Historical Railway deployment (retired) |
| --- | --- |
| Backend | `b1653106-3ad7-45ee-9147-2d34dcef1cb6` |
| Web | `49313124-01c5-470b-8282-7ab025dba9c4` |

## Validation

`npm test` in `aa/` verifies the exact canonical runtime, real Alto submission,
owner signatures, wrong-chain rejection, factory front-run prevention,
account-funded fees, replay rejection and restart recovery. `npm run build`
in `web/` checks the frontend. The [v0.9 proof](aa-validation.json) records the
real Chikyū account creation and counter increment through the published
backend, EIP-712 signing, account-paid fees, zero paymaster, cancellation and
reload recovery. Browser automation uses the real SDK with an injected test
provider and a local build of the same UI; it does not complete Google/X OAuth.
The public web build retains Google/X login. Historical v0.7 receipts remain
in [aa-07-validation.json](aa-07-validation.json).

Sources: [preinstalls addition](https://github.com/DogeOS69/dogeos-preinstalls/pull/12),
[upstream v0.9](https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.9.0).
