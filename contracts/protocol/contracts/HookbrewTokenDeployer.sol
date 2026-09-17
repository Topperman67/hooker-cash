// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HookbrewRewardToken} from "./HookbrewRewardToken.sol";
contract HookbrewTokenDeployer {
    address public immutable factory;
    address public immutable quote;
    address public immutable manager;
    address public immutable vesting;
    constructor(address quote_, address manager_, address vesting_) { factory = msg.sender; quote = quote_; manager = manager_; vesting = vesting_; }
    function deploy(string calldata name, string calldata symbol, address creator, bytes32 salt, string calldata uri) external returns (address) {
        require(msg.sender == factory, "only factory");
        return address(new HookbrewRewardToken{salt: keccak256(abi.encode(creator, salt))}(name, symbol, creator, 1_000_000_000e18, uri, quote, manager, vesting, factory));
    }
    function predict(string calldata name, string calldata symbol, address creator, bytes32 salt, string calldata uri) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(type(HookbrewRewardToken).creationCode, abi.encode(name, symbol, creator, 1_000_000_000e18, uri, quote, manager, vesting, factory)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(creator,salt)), h)))));
    }
}
