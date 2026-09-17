// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed initial supply, no transfer tax. Rewards belong to holders at distribution time.
contract HookbrewRewardToken is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e36;
    address public immutable creator;
    address public immutable factory;
    IERC20 public immutable rewardAsset;
    string public metadataURI;
    mapping(address => bool) public excluded;
    mapping(address => uint256) private paid;
    mapping(address => uint256) private credit;
    uint256 public eligibleSupply;
    uint256 public rewardPerToken;
    uint256 public queuedRewards;
    event RewardsAdded(uint256 amount);
    event RewardsClaimed(address indexed holder, uint256 amount);
    constructor(string memory name_, string memory symbol_, address creator_, uint256 supply, string memory uri, address quote, address manager, address vesting, address factory_) ERC20(name_, symbol_) {
        factory = factory_; creator = creator_; metadataURI = uri; rewardAsset = IERC20(quote);
        excluded[address(0)] = true; excluded[factory_] = true; excluded[manager] = true; excluded[vesting] = true;
        _mint(factory_, supply);
    }
    function _accrue(address who) private {
        if (!excluded[who]) credit[who] += balanceOf(who) * (rewardPerToken - paid[who]) / SCALE;
        paid[who] = rewardPerToken;
    }
    function _update(address from, address to, uint256 value) internal override {
        _accrue(from); if (to != from) _accrue(to);
        if (!excluded[from]) eligibleSupply -= value;
        if (!excluded[to]) eligibleSupply += value;
        super._update(from, to, value);
    }
    function burn(uint256 amount) external { require(msg.sender == factory, "only hook"); _burn(msg.sender, amount); }
    function distribute(uint256 amount) external nonReentrant {
        require(msg.sender == factory, "only hook");
        if (amount != 0) rewardAsset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 available = queuedRewards + amount;
        if (eligibleSupply == 0) queuedRewards = available;
        else { rewardPerToken += available * SCALE / eligibleSupply; queuedRewards = 0; }
        emit RewardsAdded(amount);
    }
    function pendingReward(address who) public view returns (uint256) {
        return credit[who] + (excluded[who] ? 0 : balanceOf(who) * (rewardPerToken - paid[who]) / SCALE);
    }
    function claimRewards(address holder) external nonReentrant {
        _accrue(holder); uint256 due = credit[holder]; credit[holder] = 0;
        if (due != 0) rewardAsset.safeTransfer(holder, due);
        emit RewardsClaimed(holder, due);
    }
}
