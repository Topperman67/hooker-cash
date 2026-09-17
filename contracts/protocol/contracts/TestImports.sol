// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestQuote is ERC20 { constructor() ERC20("Test USDC", "USDC") {} function decimals() public pure override returns(uint8){return 6;} function mint(address to,uint256 amount) external{_mint(to,amount);} }
