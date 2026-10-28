// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {EventEmitter} from "../src/EventEmitter.sol";

/// @notice One-shot deploy of the demo EventEmitter contract.
///
///         Usage:
///           forge script script/Deploy.s.sol \
///             --rpc-url $DOGEOS_RPC_URL \
///             --private-key $DEPLOYER_PRIVATE_KEY \
///             --broadcast
///
///         Writes the address to stdout in a `KEY=value` line so the bash
///         wrapper can grep it out and update deployments/<chainId>.json.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        EventEmitter emitter = new EventEmitter();

        vm.stopBroadcast();

        console2.log("CHAIN_ID=", block.chainid);
        console2.log("DEPLOYER=", deployer);
        console2.log("EVENT_EMITTER_ADDRESS=", address(emitter));
    }
}
