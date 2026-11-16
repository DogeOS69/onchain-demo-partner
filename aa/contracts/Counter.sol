// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Counter {
    mapping(address => uint256) public counts;
    event Incremented(address indexed account, uint256 count);
    function increment() external {
        emit Incremented(msg.sender, ++counts[msg.sender]);
    }
}
