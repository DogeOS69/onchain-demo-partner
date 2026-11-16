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

The checked-in Chikyū manifest is a record of confirmed deployments. While it
says 0.7, **the v0.9 network rollout is pending**; do not deploy this backend or
frontend over the live demo. The backend fails closed on an old manifest.
The local contract/bundler tests exercise v0.9 independently.

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
state also has a separate v0.9 filename.

## Validation

`npm test` in `aa/` verifies the exact canonical runtime, real Alto submission,
owner signatures, wrong-chain rejection, factory front-run prevention,
account-funded fees, replay rejection and restart recovery. `npm run build`
in `web/` checks the frontend. Network and browser receipts must be recorded
after deployment; the existing `aa-validation.json` documents the old 0.7 run.

Sources: [preinstalls addition](https://github.com/DogeOS69/dogeos-preinstalls/pull/12),
[upstream v0.9](https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.9.0).
