// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HookbrewModularFactory} from "./HookbrewModularFactory.sol";
import {HookbrewRouter, IHookbrewVenue} from "./HookbrewRouter.sol";
import {HookbrewRecipe} from "./HookbrewRecipe.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice One wallet transaction builds an immutable recipe, hook, vesting vault and router.
/// @dev CREATE2 package salt is mined so its child hook has the required 0x20c0 address flags.
contract HookbrewHookPackage {
    address public immutable factory;
    address public immutable router;
    bytes32 public immutable recipeHash;
    event HookBuilt(address indexed factory, address indexed router, bytes32 indexed recipeHash);
    constructor(IPoolManager manager, address quote, address treasury, uint256 fee, HookbrewRecipe.Config memory recipe) {
        HookbrewRecipe.validate(recipe);
        factory = address(new HookbrewModularFactory{salt: bytes32(0)}(manager, quote, treasury, fee, recipe));
        router = address(new HookbrewRouter(IHookbrewVenue(factory)));
        recipeHash = keccak256(abi.encode(recipe));
        emit HookBuilt(factory, router, recipeHash);
    }
}
