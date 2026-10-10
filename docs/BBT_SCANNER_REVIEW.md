# BBT scanner warning review

Reviewed September 19, 2026. Scope: the specific reward-erasure allegation shown in the user's screenshot and the feasibility of retaining Hookbrew contracts through Pons. This is not a complete independent security audit.

## Findings

Token: `0x7c906f147f0441eafc90bd7f1cdc79dae7db7cb1` on Robinhood Chain, chain ID 4663.

Hook/factory: `0x75455A147501BEA638aE1aBfDEBe3d07DeEF20C0`.

The deployed token runtime exactly matches `HookbrewRewardToken.sol`, compiled with Solidity `0.8.26+commit.8a97fa7a`, optimizer enabled with 200 runs, via IR, Cancun. Comparison includes metadata and substitutes the three immutable addresses using the compiler's immutable-reference offsets. Runtime keccak256:

`0x979b09eadc0c7a9d0e18b798dfae940c99061afbf92779f35d0c32e83175e54e`

The allegation that anyone can erase another holder's accrued rewards without paying was not reproduced. `claimRewards(holder)` is permissionless, but sends ETH to `holder`, never to the caller. Clearing credit before the external call implements checks-effects-interactions. A rejected ETH payment reverts the entire transaction, restoring credit. ReentrancyGuard protects claim and distribution entry points.

Zero-value transfers can trigger accrual, but existing whole-wei rewards move into stored credit rather than disappearing. As with the existing accounting design, fractional amounts below one wei can be lost to integer rounding when accrual checkpoints advance. These tests do not prove that every conceivable attack is impossible.

The hook trade-limit warning describes an intentional feature. BBT's recorded recipe uses a 300-second opening guard, caps increasing from 100 to 1,000 basis points, and no buy-spacing interval. The source applies these limits only to early buys and has no path to rearm the launch window. The local fork successfully bought BBT after that window. Keeping this feature may continue to attract a scanner warning.

## Verification evidence

`contracts/protocol/test/bbt-rewards-fork.cjs` tests the actual deployed bytecode and existing V4 pool at fork block **66858255**. It buys BBT and harvests actual pool fees locally; it does not inject reward ledger storage or impersonate the hook.

All three tests passed with exit code 0:

1. A stranger claims for a holder: the holder's ETH balance increases by exactly the full pending reward. Repeating the claim pays nothing further.
2. Repeated unsolicited zero transfers and zero-value `transferFrom` calls preserve the holder's pending reward, which can still be claimed in full.
3. A rejecting recipient preserves both its reward and the token's ETH reserve. After accepting payment, reentry is rejected and payment succeeds once.

Run from the repository root:

```powershell
node scripts/test-bbt-fork.mjs
```

All writes target an in-process Hardhat fork. No mainnet transaction was submitted during this review.

The existing native-boundary suite also passed 9 tests with exit code 0. The modular suite reported 8 passing tests, then the Windows Node 24.13.1 process aborted during shutdown with a libuv `UV_HANDLE_CLOSING` assertion. That suite's run is not recorded as a clean process-level pass.

## Source publication status

Blockscout's BBT contract page showed bytecode and **Verify & publish**, without published Solidity source. Two submissions were attempted through its normal browser form:

- Full standard JSON input: verification endpoint returned HTTP 500.
- BBT plus only its compiler-recorded dependencies: endpoint returned HTTP 429.

The smaller bundle was independently recompiled and its creation bytecode exactly matched the original build before submission. No further requests were made after the rate-limit response. Publication remains incomplete; no scanner rescan or warning removal has been confirmed.

Prepared files are in `artifacts/unsafe-review/`:

- `bbt-solc-input.json`: exact, reduced source input for the Blockscout form.
- `constructor-arguments.txt`: ABI-encoded constructor arguments.
- `bbt-runtime-verification.json`: RPC block, runtime match, compiler, immutable values, deployment record and constructor arguments.
- `solc-input.json`: complete original compiler input.
- `inspect-bbt.mjs`: read-only runtime comparison and bundle preparation.

[BBT on Blockscout](https://robinhoodchain.blockscout.com/address/0x7c906f147f0441eafc90bd7f1cdc79dae7db7cb1?tab=contract).

The scripted alternative is `npm run contracts:verify -- https://hookbrew.tech` with `BLOCKSCOUT_API_KEY` configured. No key was present in the current environment or known local env files. [Blockscout verification documentation](https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api).

## Pons compatibility

Pons's standard V2 deployer explicitly constructs its own token. Its launch flow uses the shared Pons hook. A custom creator-fee recipient can retain some auxiliary fee logic, but it does not substitute Hookbrew's ERC20 or its full hook behavior. [Pons deployer source](https://github.com/ponsdotdev/pons-labs/blob/main/contractsV2/src/v2/PonsV2LaunchDeployer.sol), [Pons V2 documentation](https://docs.ponsfamily.com/v2).

A V4 pool has one selected hook; Hookbrew cannot simply be attached as a second independent hook to a Pons pool. Preserving the full stack would require a specifically supported integration or separate pools. [Uniswap hook documentation](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks).

Recommendation: retain the custom contracts, complete source verification for the token and protocol deployment, and supply the reproducible evidence to the scanner's review process. The scanner website remains unidentified. No contract logic was altered to hide behavior or appease the label, and no claim is made that using another launchpad guarantees a clean rating.
