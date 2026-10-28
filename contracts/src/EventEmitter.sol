// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title EventEmitter
/// @notice Drives the "Smart Contract Event" on-chain quest demo. Anyone
///         can call `trigger`, which increments a per-user counter and
///         emits `Triggered(address indexed user, uint256 count)`.
///
///         The event signature is `Triggered(address,uint256)` →
///         topic0 = keccak256("Triggered(address,uint256)").
///         `user` is indexed (topic1) so Snag can filter logs by wallet
///         without scanning every event.
contract EventEmitter {
    mapping(address => uint256) public callsBy;

    event Triggered(address indexed user, uint256 count);

    function trigger() external {
        uint256 c = callsBy[msg.sender] + 1;
        callsBy[msg.sender] = c;
        emit Triggered(msg.sender, c);
    }
}
