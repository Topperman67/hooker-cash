// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Diagnostic runtime used ONLY in eth_call state overrides. Never deploy this
// contract or send it funds: it intentionally exposes an unrestricted call.
interface IProbeToken {
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
}

interface IProbeHook {
    function launchedToken(address) external view returns (bool);
}

contract LaunchReadOnlyProbe {
    struct Observation {
        address token;
        uint256 runtimeBytes;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 purchaserBalance;
        uint256 poolManagerBalance;
        uint256 vestingBalance;
        uint256 quoteBefore;
        uint256 quoteAfter;
        uint256 nativeBefore;
        uint256 nativeAfter;
        uint256 remainingAllowance;
        bool registeredWithHook;
    }

    function run(
        address factory, address quote, address hook, address poolManager,
        address vesting, bytes calldata launchData, uint256 fee, uint256 initialBuy
    ) external returns (Observation memory result) {
        result.quoteBefore = IProbeToken(quote).balanceOf(address(this));
        result.nativeBefore = address(this).balance;
        require(IProbeToken(quote).approve(factory, initialBuy), "approval failed");
        (bool ok, bytes memory data) = factory.call{value: fee}(launchData);
        if (!ok) assembly ("memory-safe") { revert(add(data, 32), mload(data)) }
        result.token = abi.decode(data, (address));
        IProbeToken token = IProbeToken(result.token);
        result.runtimeBytes = result.token.code.length;
        result.name = token.name();
        result.symbol = token.symbol();
        result.totalSupply = token.totalSupply();
        result.purchaserBalance = token.balanceOf(address(this));
        result.poolManagerBalance = token.balanceOf(poolManager);
        result.vestingBalance = token.balanceOf(vesting);
        result.quoteAfter = IProbeToken(quote).balanceOf(address(this));
        result.nativeAfter = address(this).balance;
        result.remainingAllowance = IProbeToken(quote).allowance(address(this), factory);
        result.registeredWithHook = IProbeHook(hook).launchedToken(result.token);
    }
}
