// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RandomnessDemo} from "../contracts/RandomnessDemo.sol";
import {Anyrand} from "../vendor/anyrand/contracts/Anyrand.sol";
import {DrandBeacon} from "../vendor/anyrand/contracts/beacon/DrandBeacon.sol";
import {GasStationScroll} from "../vendor/anyrand/contracts/networks/GasStationScroll.sol";

// Test-only replacements: prove upgrades execute new code without changing state.
contract RandomnessDemoV2 is RandomnessDemo {
    function revision() external pure returns (uint256) { return 2; }
}
contract AnyrandV2 is Anyrand {
    function revision() external pure returns (uint256) { return 2; }
}
contract DrandBeaconV2 is DrandBeacon {
    constructor(uint256[4] memory key, uint256 genesis, uint256 secondsPerRound)
        DrandBeacon(key, genesis, secondsPerRound) {}
    function revision() external pure returns (uint256) { return 2; }
}
contract GasStationScrollV2 is GasStationScroll {
    function revision() external pure returns (uint256) { return 2; }
}
contract MockL1Oracle {
    function getL1Fee(bytes memory) external pure returns (uint256) { return 123456789; }
}
