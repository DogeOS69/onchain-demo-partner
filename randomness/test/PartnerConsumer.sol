// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IAnyrand} from "../vendor/anyrand/contracts/interfaces/IAnyrand.sol";
interface IDemo { function requestRoll(bool) external payable returns (uint256); }
contract PartnerConsumer {
    IAnyrand public immutable coordinator;
    bool public fail;
    uint256 public deliveries;
    constructor(address c, bool f) { coordinator = IAnyrand(c); fail = f; }
    function request(uint256 deadline, uint256 limit) external payable returns (uint256) {
        return coordinator.requestRandomness{value: msg.value}(deadline, limit);
    }
    function receiveRandomness(uint256, uint256) external {
        require(msg.sender == address(coordinator), "coordinator only");
        require(!fail, "callback failure");
        deliveries++;
    }
}
contract RefundReentry {
    IDemo public demo;
    bool public attempted;
    bool public reentered;
    function request(address d) external payable { demo = IDemo(d); demo.requestRoll{value: msg.value}(true); }
    receive() external payable {
        attempted = true;
        (reentered,) = address(demo).call{value: msg.value}(abi.encodeCall(IDemo.requestRoll, (true)));
    }
}
