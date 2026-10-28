# DogeOS Onchain Quest Demo

A minimal reference dApp showing how a partner drives two DogeOS quests:

- **Smart Contract Event** — the user calls `trigger()` on an on-chain
  contract; DogeOS detects the event and credits the quest.
- **External Rule** — a partner backend marks the user eligible; the user
  verifies in the DogeOS player app.

Two folders: `contracts/` (the `EventEmitter` contract, Foundry) and `web/`
(the Next.js dApp, using `@dogeos/dogeos-sdk` + wagmi/viem).

## Run it

**1. Deploy the contract**

```bash
cd contracts
cp .env.example .env          # fill DOGEOS_RPC_URL + DEPLOYER_PRIVATE_KEY
./deploy.sh dogeos            # prints the EventEmitter address
```

DogeOS testnet — RPC `https://rpc.testnet.dogeos.com/`, chain id `6281971`,
gas faucet `https://faucet.testnet.dogeos.com`.

**2. Run the web app**

```bash
cd web
cp .env.example .env.local    # each var is documented in the file
npm install
npm run dev                   # http://localhost:3000
```

Minimum env: `NEXT_PUBLIC_EVENT_EMITTER_ADDRESS` (from step 1),
`NEXT_PUBLIC_DOGEOS_CLIENT_ID` (ask your DogeOS contact), and the `DOGEOS_*`
server vars for the External Rule card. Everything else defaults to DogeOS
testnet — see `web/.env.example`.

**3. Create the quests in the DogeOS admin**

- `smart_contract_event` → your EventEmitter address, event
  `Triggered(address,uint256)`.
- `external_rule` → any landing URL.

Sign into the DogeOS player app with the same wallet, then drive both quests
from the demo dApp.

---
MIT. SDK docs: <https://sdk.dogeos.com/>
