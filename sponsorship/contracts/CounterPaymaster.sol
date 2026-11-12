// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.28;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/core/Helpers.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Bounded testnet sponsor for one counter action. No token charge.
/// @dev Quotes bind the account, nonce, creation data, call and fee caps.
///      The owner separately signs the complete ERC-4337 UserOperation.
contract CounterPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    address public immutable quoteSigner;
    address public immutable counter;
    bytes32 public immutable allowedCallHash;
    uint256 public constant MAX_OPERATIONS = 50;
    uint256 public constant MAX_OPERATIONS_PER_ACCOUNT = 3;
    uint256 public constant MAX_COST = 0.002 ether;
    uint256 public constant MAX_GAS = 1_500_000;
    uint256 public constant MAX_FEE_PER_GAS = 500_000_000;
    uint256 public totalOperations;
    mapping(address => uint256) public operationsBy;

    struct Quote {
        uint48 validUntil;
        uint128 maxCost;
        uint128 maxFeePerGas;
        uint128 maxGas;
    }

    error UnsupportedCall();
    error InvalidBudget();
    error SponsorshipLimit();

    constructor(IEntryPoint ep, address signer, address target) BasePaymaster(ep) {
        require(signer != address(0) && target.code.length > 0, "invalid config");
        quoteSigner = signer;
        counter = target;
        allowedCallHash = keccak256(abi.encodeWithSignature(
            "execute(address,uint256,bytes)", target, uint256(0),
            abi.encodeWithSignature("increment()")
        ));
    }

    function quoteHash(PackedUserOperation calldata op, Quote memory quote)
        public view returns (bytes32)
    {
        return keccak256(abi.encode(
            block.chainid, address(entryPoint), address(this),
            op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), quote
        ));
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256 maxCost)
        internal override returns (bytes memory context, uint256 validationData)
    {
        (Quote memory quote, bytes memory signature) =
            abi.decode(op.paymasterAndData[PAYMASTER_DATA_OFFSET:], (Quote, bytes));
        if (keccak256(op.callData) != allowedCallHash) revert UnsupportedCall();
        uint256 gasLimit = op.unpackVerificationGasLimit() + op.unpackCallGasLimit()
            + op.preVerificationGas + op.unpackPaymasterVerificationGasLimit()
            + op.unpackPostOpGasLimit();
        if (quote.validUntil == 0 || quote.maxCost > MAX_COST || maxCost > quote.maxCost
            || quote.maxFeePerGas > MAX_FEE_PER_GAS || op.unpackMaxFeePerGas() > quote.maxFeePerGas
            || op.unpackMaxPriorityFeePerGas() > op.unpackMaxFeePerGas()
            || quote.maxGas > MAX_GAS || gasLimit > quote.maxGas
            || op.unpackPostOpGasLimit() != 0) revert InvalidBudget();

        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(
            MessageHashUtils.toEthSignedMessageHash(quoteHash(op, quote)), signature
        );
        bool signatureFailed = error != ECDSA.RecoverError.NoError || recovered != quoteSigner;
        if (!signatureFailed) {
            if (totalOperations >= MAX_OPERATIONS
                || operationsBy[op.sender] >= MAX_OPERATIONS_PER_ACCOUNT) revert SponsorshipLimit();
            ++totalOperations;
            ++operationsBy[op.sender];
        }
        // An empty context means there is no postOp token debit or callback.
        return ("", _packValidationData(signatureFailed, quote.validUntil, 0));
    }
}
