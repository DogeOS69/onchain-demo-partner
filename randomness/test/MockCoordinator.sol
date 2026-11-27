// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
interface ICallback { function receiveRandomness(uint256, uint256) external; }
contract MockCoordinator {
    bytes32 public currentBeaconPubKeyHash;
    uint256 public nextId = 1;
    constructor(bytes32 key) { currentBeaconPubKeyHash = key; }
    function getRequestPrice(uint256) external pure returns (uint256, uint256) { return (0, 0); }
    function requestRandomness(uint256, uint256) external payable returns (uint256) { return nextId++; }
    function deliver(address to, uint256 id, uint256 word) external { ICallback(to).receiveRandomness(id, word); }
}
