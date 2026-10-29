# Run the partner demo

[Documentation home](../README.md) · [Smart Contract Event](smart-contract-events.md) · [External Rule](external-rules.md)

This repository contains a Foundry contract in `contracts/` and a Next.js dApp in `web/`. The dApp uses the DogeOS SDK, wagmi, and viem. Follow either integration path, or both.

## Prerequisites

- Node.js and npm; use a Node version supported by the pinned Next.js version (Node 22 is a suitable baseline for this demo).
- Access to this repository and the [staging CMS](https://thegrandheist-admin.vercel.app/).
- A wallet that can connect to the demo and the [staging player app](https://thegrandheist.vercel.app/). Use the same EVM address in both.
- For contract deployment: [Foundry](https://getfoundry.sh/) and testnet DOGE from the [faucet](https://faucet.testnet.dogeos.com).

Clone the repository and enter it:

```bash
git clone https://github.com/DogeOS69/onchain-demo-partner.git
cd onchain-demo-partner
```

If you received a ZIP, extract it and use its root directory instead. The repository is private, so repository access is required for cloning.

## A. Prepare the Smart Contract Event example

Skip this section if you only want to test External Rule.

### Install contract dependencies

From the repository root:

```bash
cd contracts
forge install --root . --no-git foundry-rs/forge-std@v1.16.1
forge build
cp .env.example .env
```

`forge-std` is needed by the deployment script and is not bundled in this repository. The example contract does not import OpenZeppelin. The version above matches `contracts/foundry.lock`.

Edit `contracts/.env` and replace the `DEPLOYER_PRIVATE_KEY` placeholder with a development wallet's key. Fund that wallet on the testnet. Keep `.env` uncommitted.

| Testnet setting | Value |
| --- | --- |
| RPC URL | `https://rpc.testnet.dogeos.com/` |
| Chain ID | `6281971` |
| Explorer | <https://blockscout.testnet.dogeos.com> |
| Native token | `DOGE` |

### Deploy

Still inside `contracts/`:

```bash
./deploy.sh dogeos
```

This sends a deployment transaction using the configured wallet. Record the resulting `EventEmitter` address from the command output or `contracts/deployments/6281971.json`. Each invocation deploys a new instance and overwrites the recorded address, so use the address from your own run.

Follow the [Smart Contract Event guide](smart-contract-events.md) to register this address and ABI and create the quest **before** triggering a test event.

Return to the repository root:

```bash
cd ..
```

## B. Prepare the External Rule example

Skip this section if you only want to test Smart Contract Event.

Follow the [External Rule guide](external-rules.md) to generate a staging partner API key and create an `external_rule` quest. You will need its UUID for the server environment below. No contract deployment is required.

## C. Configure and run the web app

From the repository root:

```bash
cd web
cp .env.example .env.local
npm ci --legacy-peer-deps
```

The current lockfile needs legacy peer-dependency resolution. Plain `npm ci` can fail while resolving the SDK's transitive React/Expo dependencies; the flag above installs the committed dependency set without updating it.

Edit `web/.env.local` using these settings:

| Variable | Needed for | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_EVENT_EMITTER_ADDRESS` | Smart Contract Event | Address from your deployment. This setting is only needed for the event card; do not use that card when testing only External Rule. |
| `NEXT_PUBLIC_DOGEOS_CLIENT_ID` | Embedded email/social login | Client ID supplied by DogeOS. The template also allows external-wallet mode without it. Confirm the intended wallet setup with your contact. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect connections | Your WalletConnect project ID, if using that connection method. |
| `DOGEOS_API_URL` | External Rule | `https://quest-api-staging.dogeos.com`. |
| `DOGEOS_PARTNER_API_KEY` | External Rule | Your staging partner key, kept server-side. |
| `DOGEOS_EXTERNAL_QUEST_ID` | External Rule | UUID of your staging External Rule quest. |

The remaining public chain settings default to DogeOS testnet; [`.env.example`](../web/.env.example) lists them. All `NEXT_PUBLIC_` values are exposed to the browser. Restart the dev server after changing environment values; rebuild deployed apps when changing public build-time settings.

Start the dApp:

```bash
npm run dev
```

Open <http://localhost:3000>, connect your wallet, and approve the testnet network switch if prompted.

## D. Complete the walkthrough

| Demo card | What it does | Next step |
| --- | --- | --- |
| **Smart Contract Event → Trigger event** | Calls `EventEmitter.trigger()` from your connected wallet. | Wait for the receipt, then check the quest in staging Questing and click Verify if its claim mode requires it. |
| **External Quest → Mark me eligible (partner action)** | Sends the wallet to the demo server route, which forwards eligibility using its private API key. | Open the External Rule quest in staging Questing and click Verify. |

The External Rule card deliberately simulates a completed partner action. Its [server route](../web/app/api/partner-complete-quest/route.ts) is not an example of user authentication or business-rule validation. Implement both before using this pattern with real rewards.

For a production-mode web build, run these commands from `web/` after configuring the environment:

```bash
npm run build
npm start
```

## Common setup issues

| Symptom | Check |
| --- | --- |
| `forge: command not found` | Install Foundry and add its binaries to your PATH. |
| Missing `forge-std/Script.sol` | Run the dependency installation above from `contracts/`. |
| Wrong network or transaction rejected | Confirm testnet chain ID, wallet approval, and enough testnet DOGE for gas. |
| No response from the event card | Set your deployed contract address and confirm the contract exists on the configured network. |
| “Demo partner backend isn't configured” | Set all three private `DOGEOS_*` variables and restart Next.js. |
| “DogeOS rejected the mark-eligible call” | Inspect the local route's `upstreamStatus` and `upstreamBody`; compare with the [API reference](api-reference.md). |

The web demo pins `@dogeos/dogeos-sdk@3.3.0-beta.0`. The installation command above preserves the committed versions. Review a supported production SDK update against the [SDK documentation](https://sdk.dogeos.com/) and test compatibility before launch.
