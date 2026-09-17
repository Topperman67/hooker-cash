// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
interface IHookbrewVenue { function poolKey(address token) external view returns (PoolKey memory); function quote() external view returns (address); function poolManager() external view returns (IPoolManager); }

/// @notice Exact-input ERC20 swaps confined to this Hookbrew venue. No arbitrary-call executor.
contract HookbrewRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    IHookbrewVenue public immutable factory;
    IPoolManager public immutable poolManager;
    event Trade(address indexed token, address indexed trader, bool buy, uint256 amountIn, uint256 amountOut, uint160 sqrtPriceX96);
    constructor(IHookbrewVenue factory_) { factory=factory_; poolManager=factory_.poolManager(); }
    function swap(address token, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant returns(uint256 out) {
        require(block.timestamp <= deadline && amountIn > 0 && amountIn <= uint256(uint128(type(int128).max)), "invalid trade");
        PoolKey memory key=factory.poolKey(token);
        address input=buy?factory.quote():token;
        uint256 beforeBalance=IERC20(input).balanceOf(address(this));
        IERC20(input).safeTransferFrom(msg.sender,address(this),amountIn);
        require(IERC20(input).balanceOf(address(this))-beforeBalance==amountIn,"transfer mismatch");
        out=abi.decode(poolManager.unlock(abi.encode(key,input,msg.sender,amountIn,minOut)),(uint256));
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(key.toId());
        emit Trade(token,msg.sender,buy,amountIn,out,sqrtPrice);
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender==address(poolManager),"only pool manager");
        (PoolKey memory key,address input,address recipient,uint256 amount,uint256 minOut)=abi.decode(data,(PoolKey,address,address,uint256,uint256));
        bool zeroForOne=Currency.unwrap(key.currency0)==input;
        BalanceDelta d=poolManager.swap(key,SwapParams(zeroForOne,-int256(amount),zeroForOne?TickMath.MIN_SQRT_PRICE+1:TickMath.MAX_SQRT_PRICE-1),"");
        int128 inDelta=zeroForOne?d.amount0():d.amount1(); int128 outDelta=zeroForOne?d.amount1():d.amount0();
        require(inDelta<0 && uint256(uint128(-inDelta))==amount && outDelta>0 && uint256(uint128(outDelta))>=minOut,"price moved beyond limit");
        poolManager.sync(Currency.wrap(input)); IERC20(input).safeTransfer(address(poolManager),amount); poolManager.settle();
        poolManager.take(zeroForOne?key.currency1:key.currency0,recipient,uint128(outDelta));
        return abi.encode(uint256(uint128(outDelta)));
    }
}
