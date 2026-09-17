// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Immutable funded schedules; permissionless release always pays the named beneficiary.
contract HookbrewVesting is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable factory;
    struct Vest { uint256 total; uint256 released; uint64 start; uint32 cliff; uint32 duration; }
    mapping(address => mapping(address => Vest)) public vests;
    event VestCreated(address indexed token, address indexed beneficiary, uint256 total, uint32 cliff, uint32 duration);
    event Released(address indexed token, address indexed beneficiary, uint256 amount);
    constructor(address factory_) { factory = factory_; }
    function create(address token, address beneficiary, uint256 amount, uint32 cliff, uint32 duration) external {
        require(msg.sender == factory && beneficiary != address(0) && vests[token][beneficiary].total == 0, "invalid vest");
        vests[token][beneficiary] = Vest(amount, 0, uint64(block.timestamp), cliff, duration);
        emit VestCreated(token, beneficiary, amount, cliff, duration);
    }
    function lockedBalance(address token, address beneficiary) external view returns (uint256) {
        Vest memory v = vests[token][beneficiary];
        return v.total - v.released;
    }
    function claimable(address token, address beneficiary) public view returns (uint256) {
        Vest memory v = vests[token][beneficiary];
        uint256 begins = uint256(v.start) + v.cliff;
        if (block.timestamp < begins) return 0;
        uint256 vested = v.duration == 0 || block.timestamp >= begins + v.duration ? v.total : v.total * (block.timestamp - begins) / v.duration;
        return vested - v.released;
    }
    function release(address token, address beneficiary) external nonReentrant {
        uint256 amount = claimable(token, beneficiary);
        require(amount > 0, "nothing vested");
        vests[token][beneficiary].released += amount;
        IERC20(token).safeTransfer(beneficiary, amount);
        emit Released(token, beneficiary, amount);
    }
}
