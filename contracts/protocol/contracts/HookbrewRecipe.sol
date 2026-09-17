// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
library HookbrewRecipe {
    struct Config {
        uint32 window;
        uint16 interval;
        uint16 startCapBps;
        uint16 endCapBps;
        bool oracle;
        uint16 burnBps;
        uint16 rewardBps;
        uint16 buybackBps;
        uint16 liquidityBps;
    }
    function validate(Config memory c) internal pure {
        require(c.window <= 3600 && c.interval <= 60, "invalid timing");
        require(c.startCapBps <= c.endCapBps && c.endCapBps <= 5000, "invalid caps");
        require((c.startCapBps == 0) == (c.endCapBps == 0), "incomplete caps");
        require(c.window == 0 ? c.interval == 0 && c.startCapBps == 0 : c.interval > 0 || c.startCapBps > 0, "invalid window");
        require(uint256(c.burnBps) + c.rewardBps + c.buybackBps + c.liquidityBps <= 10000, "allocation exceeds 100%");
        require(c.oracle || (c.buybackBps == 0 && c.liquidityBps == 0), "price history required");
    }
}
