// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAnyrand} from "../vendor/anyrand/contracts/interfaces/IAnyrand.sol";
import {IDrandBeacon} from "../vendor/anyrand/contracts/interfaces/IDrandBeacon.sol";

interface ICoordinator is IAnyrand {
    function currentBeaconPubKeyHash() external view returns (bytes32);
}

/// @notice Testnet dice demonstration. No stakes, prizes, or player-selected rounds.
contract RandomnessDemo {
    ICoordinator public immutable anyrand;
    bytes32 public immutable pubKeyHash;
    uint256 public immutable genesis;
    uint256 public immutable period;
    uint256 public constant DELAY_SECONDS = 90;
    uint256 public constant CALLBACK_GAS_LIMIT = 150_000;

    struct Roll {
        address player;
        uint64 requestedAt;
        uint64 requestBlock;
        uint64 round;
        bool automatic;
        bool fulfilled;
        uint8 face;
        uint256 word;
    }
    mapping(uint256 => Roll) private rolls;
    uint256[] public requestIds;

    error OnlyCoordinator();
    error UnknownOrFulfilledRequest();
    error IncorrectFee(uint256 expected);
    error BeaconChanged();
    event RollRequested(uint256 indexed requestId, address indexed player, bool automatic, uint256 round);
    event RollFulfilled(uint256 indexed requestId, address indexed player, uint256 word, uint8 face);

    constructor(address coordinator, address beacon) {
        anyrand = ICoordinator(coordinator);
        pubKeyHash = IDrandBeacon(beacon).publicKeyHash();
        genesis = IDrandBeacon(beacon).genesisTimestamp();
        period = IDrandBeacon(beacon).period();
        require(anyrand.currentBeaconPubKeyHash() == pubKeyHash, "Beacon mismatch");
    }

    function quote() public view returns (uint256 fee) {
        (fee,) = anyrand.getRequestPrice(CALLBACK_GAS_LIMIT);
    }

    function requestRoll(bool automatic) external payable returns (uint256 id) {
        if (anyrand.currentBeaconPubKeyHash() != pubKeyHash) revert BeaconChanged();
        uint256 fee = quote();
        if (msg.value != fee) revert IncorrectFee(fee);
        uint256 deadline = block.timestamp + DELAY_SECONDS;
        uint256 delta = deadline - genesis;
        uint64 round = uint64(delta / period + (delta % period > 0 ? 1 : 0) + 1);
        id = anyrand.requestRandomness{value: fee}(deadline, CALLBACK_GAS_LIMIT);
        rolls[id] = Roll(msg.sender, uint64(block.timestamp), uint64(block.number), round, automatic, false, 0, 0);
        requestIds.push(id);
        emit RollRequested(id, msg.sender, automatic, round);
    }

    function receiveRandomness(uint256 id, uint256 word) external {
        if (msg.sender != address(anyrand)) revert OnlyCoordinator();
        Roll storage roll = rolls[id];
        if (roll.player == address(0) || roll.fulfilled) revert UnknownOrFulfilledRequest();
        roll.fulfilled = true; // Zero is a valid random word; never use it as a sentinel.
        roll.word = word;
        roll.face = diceFace(word);
        emit RollFulfilled(id, roll.player, word, roll.face);
    }

    /// @notice Rejection sampling removes modulo bias: 2**256 % 6 == 4.
    function diceFace(uint256 word) public pure returns (uint8) {
        uint256 counter;
        while (word < 4) {
            word = uint256(keccak256(abi.encode("CHIKYU_DICE_V1", word, counter++)));
        }
        return uint8(word % 6 + 1);
    }

    function getRoll(uint256 id) external view returns (Roll memory) { return rolls[id]; }
    function rollCount() external view returns (uint256) { return requestIds.length; }

    function recentIds(uint256 limit) external view returns (uint256[] memory ids) {
        if (limit > 30) limit = 30;
        if (limit > requestIds.length) limit = requestIds.length;
        ids = new uint256[](limit);
        for (uint256 i; i < limit; ++i) ids[i] = requestIds[requestIds.length - 1 - i];
    }
}
