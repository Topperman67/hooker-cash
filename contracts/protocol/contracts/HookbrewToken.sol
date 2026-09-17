// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed constructor supply. No mint, tax, freeze, blacklist or owner functions.
contract HookbrewToken is ERC20 {
    address public immutable creator;
    address public immutable factory;
    string public metadataURI;
    constructor(string memory name_, string memory symbol_, address creator_, uint256 supply, string memory metadata_) ERC20(name_, symbol_) {
        creator = creator_;
        factory = msg.sender;
        metadataURI = metadata_;
        _mint(msg.sender, supply);
    }
}
