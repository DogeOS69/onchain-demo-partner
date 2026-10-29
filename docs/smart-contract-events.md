# Smart Contract Event quests

[Documentation home](../README.md) · [Run the demo](run-demo.md) · [Going live](going-live.md)

Use this integration when a user's action emits an event from your smart contract. DogeOS watches the configured contract and event, associates the event with the user's wallet, and applies the quest's completion and reward rules.

**A partner API key is not required for this flow.** Your backend does not call `mark-eligible` for a `smart_contract_event` quest.

## Before you start

- Get partner access to the [staging CMS](https://thegrandheist-admin.vercel.app/).
- Deploy your contract on the network agreed with DogeOS and have its address and JSON ABI ready. The demo uses DogeOS testnet, chain ID `6281971`; see [Run the demo](run-demo.md).
- Use the same EVM wallet for the contract action and the player account in [staging Questing](https://thegrandheist.vercel.app/).

## 1. Register your contract

In the CMS, open **Contracts → Register contract**.

| Field | What to enter |
| --- | --- |
| Contract address | The deployed `0x…` address on the supported network. |
| Name | An optional label, such as `ACME Contract`; maximum 40 characters. |
| ABI | A JSON array containing the contract's event definitions. Paste the ABI array, not the surrounding build artifact. |

![Register contract dialog with address, name, and JSON ABI fields](assets/register-contract.jpg)

For this repository's [`EventEmitter`](../contracts/src/EventEmitter.sol), the minimal ABI is:

```json
[
  {
    "anonymous": false,
    "inputs": [
      { "indexed": true, "internalType": "address", "name": "user", "type": "address" },
      { "indexed": false, "internalType": "uint256", "name": "count", "type": "uint256" }
    ],
    "name": "Triggered",
    "type": "event"
  }
]
```

You can also use the full ABI from your build output. Check the address and ABI before registering: the current CMS does not offer contract editing or deletion.

After registration, the contract appears in the list and can be selected when creating a quest.

## 2. Create the quest

Open **Quests → New Quest** and select **Smart Contract Event** (`smart_contract_event`) under the onchain category available in your CMS.

| Setting | Demo value or guidance |
| --- | --- |
| Contract | The contract registered in step 1. |
| Event | `Triggered`, selected from the ABI. Its canonical signature is `Triggered(address,uint256)`. |
| Address mapping | The event field identifying the wallet to credit. This demo emits the caller's address in `user`; map the credited wallet to that field. |
| Rewards and frequency | Choose the intended reward and frequency. Use a one-time quest for the first test. |
| Claim mode | Choose the intended automatic or manual claim behavior. The walkthrough below covers manual verification. |
| Availability and publication | Set the active window and make the quest available to your staging tester. |

Register the quest and confirm tracking is configured **before** emitting your test event. Treat detection as forward-only: do not depend on historical events being replayed. If the quest has a future start time, test during its active window.

## 3. Perform the onchain action

In the demo dApp, connect the player's wallet and click **Trigger event**. This calls `trigger()` and emits:

```solidity
event Triggered(address indexed user, uint256 count);
```

Approve the transaction, wait for its receipt, and check that it succeeded on the correct network and contract. Transaction confirmation and DogeOS event detection are separate; a confirmed transaction does not by itself prove that the quest has completed.

## 4. Verify completion in Questing

Open the quest in [staging Questing](https://thegrandheist.vercel.app/).

- With manual verification, click **Verify**. DogeOS checks the detected activity and completes the quest when the requirements are satisfied.
- With automatic reward configuration, check for completion and the configured reward without assuming a Verify click is required.

If verification starts before detection finishes, the UI may remain in **Verifying…** while processing. Detection time varies; this guide does not promise a fixed delay.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The event picker is empty | Select a registered contract whose ABI contains the event. |
| The event name is rejected as ambiguous | The current integration does not support overloaded event names. Use an unambiguous event name. |
| The transaction succeeded, but the quest did not complete | Confirm the network, contract address, event, wallet mapping, quest availability, and that the event was emitted after tracking was configured. |
| A different wallet received credit | Compare the event's wallet field with the EVM wallet used by the player account. |
| Verification stays pending | Check the transaction's logs and allow detection to finish. Send your DogeOS contact the quest ID, transaction hash, network, contract address, and timestamp if it persists. |

Once the staging flow works, follow [Going live](going-live.md).
