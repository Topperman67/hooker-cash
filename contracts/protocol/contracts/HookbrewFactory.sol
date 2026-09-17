// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BaseHook} from "@openzeppelin/uniswap-hooks/src/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {HookbrewToken} from "./HookbrewToken.sol";
import {HookbrewVesting} from "./HookbrewVesting.sol";

/// @notice Hookbrew's own ERC20-quoted V4 launch venue. Seed positions have no withdrawal path.
/// @dev This is a separate implementation/version; never describe it as the original V10 bytecode.
contract HookbrewFactory is BaseHook, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant Q96 = 1 << 96;
    address public immutable quote;
    address public immutable treasury;
    uint256 public immutable launchFee;
    HookbrewVesting public immutable vesting;
    uint256 public constant MIN_MCAP = 2_000e6;
    uint256 public constant MAX_MCAP = 10_000e6;
    struct Split { address wallet; uint16 bps; uint32 cliff; uint32 duration; }
    struct Guard { uint32 window; uint16 startCapBps; uint16 endCapBps; uint16 interval; }
    struct LaunchParams { string name; string symbol; string metadataURI; bytes32 salt; uint24 fee; uint256 targetMcap; uint256 initialBuy; uint256 minTokensOut; Guard guard; Split[] splits; }
    struct Launch { address creator; bytes32 poolId; uint64 createdAt; uint24 fee; int24 lower; int24 upper; uint128 liquidity; Guard guard; uint64 lastBuy; }
    mapping(address => Launch) public launches;
    mapping(bytes32 => address) public tokenOfPool;
    mapping(address => Split[]) private recipients;
    mapping(address => mapping(address => uint256)) public holdThreshold;
    mapping(address => mapping(address => mapping(address => uint256))) public claimable;
    mapping(address => mapping(address => uint256)) public protocolClaimable;
    event TokenLaunched(address indexed token, address indexed creator, bytes32 indexed poolId, uint24 fee, uint160 sqrtPriceX96, uint256 initialBuy, uint256 tokensBought, string metadataURI);
    event Harvested(address indexed token, uint256 tokenFees, uint256 quoteFees);
    event Claimed(address indexed token, address indexed recipient, uint256 tokenAmount, uint256 quoteAmount);
    constructor(IPoolManager manager, address quote_, address treasury_, uint256 launchFee_) BaseHook(manager) {
        require(quote_ != address(0) && treasury_ != address(0) && quote_.code.length > 0, "invalid configuration");
        require(IERC20Metadata(quote_).decimals() == 6, "quote must use 6 decimals");
        quote = quote_; treasury = treasury_; launchFee = launchFee_;
        vesting = new HookbrewVesting(address(this));
    }
    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) { p.beforeInitialize = true; p.beforeSwap = true; }
    function poolKey(address token) public view returns (PoolKey memory k) {
        require(launches[token].creator != address(0), "unknown token");
        bool token0 = token < quote;
        k = PoolKey(Currency.wrap(token0 ? token : quote), Currency.wrap(token0 ? quote : token), launches[token].fee, TICK_SPACING, IHooks(address(this)));
    }
    function getRecipients(address token) external view returns (Split[] memory) { return recipients[token]; }
    function launchedToken(address token) external view returns (bool) { return launches[token].creator != address(0); }
    function predictToken(string calldata name, string calldata symbol, address creator, bytes32 salt, string calldata uri) external view returns (address) {
        bytes32 s = keccak256(abi.encode(creator, salt));
        bytes32 h = keccak256(abi.encodePacked(type(HookbrewToken).creationCode, abi.encode(name, symbol, creator, TOTAL_SUPPLY, uri)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, h)))));
    }
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, uint256 bought) {
        require(bytes(p.name).length > 0 && bytes(p.name).length <= 32 && bytes(p.symbol).length > 0 && bytes(p.symbol).length <= 12, "invalid identity");
        require(bytes(p.metadataURI).length <= 2048, "metadata too long");
        require(p.fee >= 10000 && p.fee <= 50000 && p.fee % 10000 == 0, "invalid fee");
        require(p.targetMcap >= MIN_MCAP && p.targetMcap <= MAX_MCAP, "valuation out of range");
        require(msg.value == launchFee && p.splits.length <= 10, "invalid fee or splits");
        Guard calldata g = p.guard;
        require(g.window <= 3600 && g.interval <= 60 && g.startCapBps <= g.endCapBps && g.endCapBps <= 5000, "invalid guard");
        require(g.window == 0 ? g.interval == 0 && g.startCapBps == 0 && g.endCapBps == 0 : g.startCapBps > 0, "invalid guard window");
        token = address(new HookbrewToken{salt: keccak256(abi.encode(msg.sender, p.salt))}(p.name, p.symbol, msg.sender, TOTAL_SUPPLY, p.metadataURI));
        Launch storage l = launches[token]; l.creator = msg.sender; l.createdAt = uint64(block.timestamp); l.fee = p.fee; l.guard = g;
        uint256 totalBps;
        if (p.splits.length == 0) { recipients[token].push(Split(msg.sender, 10000, 0, 0)); }
        else for (uint256 i; i < p.splits.length; ++i) {
            Split calldata s = p.splits[i];
            require(s.wallet != address(0) && s.wallet != address(this) && s.wallet != address(vesting) && s.bps > 0 && uint256(s.cliff) + s.duration <= 3650 days, "invalid recipient");
            for(uint256 j; j < i; ++j) require(s.wallet != p.splits[j].wallet, "duplicate recipient");
            totalBps += s.bps; recipients[token].push(s);
        }
        require(p.splits.length == 0 || totalBps == 10000, "split must total 100%");
        PoolKey memory k = poolKey(token);
        bytes32 pid = PoolId.unwrap(k.toId()); l.poolId = pid; tokenOfPool[pid] = token;
        uint160 sqrtPrice = uint160(Math.sqrt(FullMath.mulDiv(p.targetMcap, 1 << 192, TOTAL_SUPPLY)));
        if (token > quote) sqrtPrice = uint160((1 << 192) / uint256(sqrtPrice));
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPrice); tick = tick / TICK_SPACING * TICK_SPACING;
        sqrtPrice = TickMath.getSqrtPriceAtTick(tick);
        poolManager.initialize(k, sqrtPrice);
        l.lower = token < quote ? tick : TickMath.minUsableTick(TICK_SPACING);
        l.upper = token < quote ? TickMath.maxUsableTick(TICK_SPACING) : tick;
        l.liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtPrice, TickMath.getSqrtPriceAtTick(l.lower), TickMath.getSqrtPriceAtTick(l.upper), token < quote ? TOTAL_SUPPLY : 0, token < quote ? 0 : TOTAL_SUPPLY);
        poolManager.unlock(abi.encode(uint8(0), token, uint256(0)));
        if (p.initialBuy > 0) {
            uint256 beforeQuote = IERC20(quote).balanceOf(address(this));
            IERC20(quote).safeTransferFrom(msg.sender, address(this), p.initialBuy);
            require(IERC20(quote).balanceOf(address(this)) - beforeQuote == p.initialBuy, "quote transfer mismatch");
            bought = abi.decode(poolManager.unlock(abi.encode(uint8(1), token, p.initialBuy)), (uint256));
            require(bought >= p.minTokensOut && bought <= TOTAL_SUPPLY / 10, "founder buy outside limits");
            Split[] storage split = recipients[token]; uint256 assigned;
            for (uint256 i; i < split.length; ++i) {
                Split memory s = split[i]; uint256 share = i + 1 == split.length ? bought - assigned : bought * s.bps / 10000;
                assigned += share; holdThreshold[token][s.wallet] = share;
                if (s.cliff != 0 || s.duration != 0) {
                    IERC20(token).safeTransfer(address(vesting), share); vesting.create(token, s.wallet, share, s.cliff, s.duration);
                } else IERC20(token).safeTransfer(s.wallet, share);
            }
        } else require(p.minTokensOut == 0, "no founder buy");
        if (launchFee > 0) { (bool paid,) = treasury.call{value: launchFee}(""); require(paid, "treasury transfer failed"); }
        emit TokenLaunched(token, msg.sender, pid, p.fee, sqrtPrice, p.initialBuy, bought, p.metadataURI);
    }
    function _beforeInitialize(address sender, PoolKey calldata k, uint160) internal view override returns (bytes4) {
        require(sender == address(this) && tokenOfPool[PoolId.unwrap(k.toId())] != address(0), "unregistered pool");
        return this.beforeInitialize.selector;
    }
    function _beforeSwap(address sender, PoolKey calldata k, SwapParams calldata params, bytes calldata) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        address token = tokenOfPool[PoolId.unwrap(k.toId())]; Launch storage l = launches[token];
        require(l.creator != address(0), "unregistered pool");
        uint256 elapsed = block.timestamp - l.createdAt;
        if (sender != address(this) && params.zeroForOne == (quote < token) && elapsed < l.guard.window) {
            require(params.amountSpecified < 0, "exact input required during guard");
            require(l.lastBuy == 0 || block.timestamp >= uint256(l.lastBuy) + l.guard.interval, "buy spacing active");
            // At an upper seed boundary, active pool liquidity is zero until the first buy
            // crosses into the range. Use this immutable seed position for both orderings;
            // unrelated LP additions must not change a launch's buy allowance.
            (uint160 sqrtPrice,,,) = poolManager.getSlot0(k.toId()); uint128 liq = l.liquidity;
            uint256 reserves = quote < token ? FullMath.mulDiv(liq, Q96, sqrtPrice) : FullMath.mulDiv(liq, sqrtPrice, Q96);
            uint256 cap = l.guard.startCapBps + (uint256(l.guard.endCapBps) - l.guard.startCapBps) * elapsed / l.guard.window;
            require(uint256(-params.amountSpecified) <= reserves * cap / 10000, "launch buy cap");
            l.lastBuy = uint64(block.timestamp);
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "only pool manager");
        (uint8 action, address token, uint256 amount) = abi.decode(data, (uint8, address, uint256));
        PoolKey memory k = poolKey(token); Launch memory l = launches[token]; BalanceDelta delta;
        if (action == 1) {
            bool zeroForOne = quote < token;
            delta = poolManager.swap(k, SwapParams(zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
            int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
            require(spent < 0 && uint256(uint128(-spent)) == amount, "partial founder buy");
        } else {
            (delta,) = poolManager.modifyLiquidity(k, ModifyLiquidityParams(l.lower, l.upper, action == 0 ? int256(uint256(l.liquidity)) : int256(0), bytes32(0)), "");
        }
        _settle(k.currency0, delta.amount0()); _settle(k.currency1, delta.amount1());
        if (action == 1) return abi.encode(uint256(uint128(token < quote ? delta.amount0() : delta.amount1())));
        if (action == 2) return abi.encode(uint256(uint128(token < quote ? delta.amount0() : delta.amount1())), uint256(uint128(token < quote ? delta.amount1() : delta.amount0())));
        return "";
    }
    function _settle(Currency currency, int128 delta) private {
        if (delta < 0) { poolManager.sync(currency); IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), uint128(-delta)); poolManager.settle(); }
        else if (delta > 0) poolManager.take(currency, address(this), uint128(delta));
    }
    function harvest(address token) external nonReentrant {
        (uint256 tokenFees, uint256 quoteFees) = abi.decode(poolManager.unlock(abi.encode(uint8(2), token, uint256(0))), (uint256,uint256));
        _credit(token, token, tokenFees); _credit(token, quote, quoteFees);
        emit Harvested(token, tokenFees, quoteFees);
    }
    function _credit(address token, address currency, uint256 amount) private {
        uint256 creatorPart = amount * 7000 / 10000; uint256 credited;
        Split[] storage split = recipients[token];
        for (uint256 i; i < split.length; ++i) { uint256 share = i + 1 == split.length ? creatorPart - credited : creatorPart * split[i].bps / 10000; credited += share; claimable[token][split[i].wallet][currency] += share; }
        protocolClaimable[token][currency] += amount - creatorPart;
    }
    function eligible(address token, address recipient) public view returns (bool) {
        return IERC20(token).balanceOf(recipient) + vesting.lockedBalance(token, recipient) >= holdThreshold[token][recipient];
    }
    function claim(address token, address recipient) external nonReentrant {
        require(eligible(token, recipient), "restore founder allocation to claim");
        uint256 t = claimable[token][recipient][token]; uint256 q = claimable[token][recipient][quote];
        claimable[token][recipient][token] = 0; claimable[token][recipient][quote] = 0;
        if(t > 0) IERC20(token).safeTransfer(recipient,t); if(q > 0) IERC20(quote).safeTransfer(recipient,q);
        emit Claimed(token,recipient,t,q);
    }
    function claimProtocol(address token) external nonReentrant {
        uint256 t=protocolClaimable[token][token]; uint256 q=protocolClaimable[token][quote];
        protocolClaimable[token][token]=0; protocolClaimable[token][quote]=0;
        if(t>0) IERC20(token).safeTransfer(treasury,t); if(q>0) IERC20(quote).safeTransfer(treasury,q);
        emit Claimed(token,treasury,t,q);
    }
}
