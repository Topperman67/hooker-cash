// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only recipient; never exported as a production artifact.
contract NativeRecipient {
    bool public rejectPayment;
    bool public reentryBlocked;
    address public target;
    bytes public payload;
    function configure(bool reject_, address target_, bytes calldata payload_) external {
        rejectPayment = reject_; target = target_; payload = payload_;
    }
    receive() external payable {
        require(!rejectPayment, "recipient rejects ETH");
        if (target != address(0)) {
            (bool ok,) = target.call(payload);
            reentryBlocked = !ok;
            require(!ok, "unexpected reentry");
        }
    }
}
