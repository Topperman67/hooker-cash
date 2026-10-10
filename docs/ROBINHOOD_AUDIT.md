# Robinhood migration verification

Verified September 19, 2026 UTC (September 18 in New York). The application migration passes the checks below, and the audit fixes are published at https://hookbrew.tech. **The on-chain venue is not activated.** The live status response still contains `deployment: null`; wallet deployment, source publication and a signed mainnet smoke test remain incomplete.

## Findings corrected during this audit

1. **Deployment estimates could become stale before signing.** Standard setup and custom-hook builds now refresh RPC chain, gas estimate, gas price and wallet balance before requesting a signature. Saved gas limits cannot constrain a fresh estimate. A browser test lowers the reported balance after review and verifies that neither factory nor router deployment requests a wallet signature until funds are sufficient.
2. **Browser confirmation did not independently check canonical block hashes.** Confirmation now checks the receipt against the current block hash and requires two L2 confirmations before accepting success or clearing pending state. A changed receipt remains available for confirmation recovery. Resuming factory setup performs the same check.
3. **Stored configuration checks were incomplete.** Both server registries, frontend transaction verification and source-publication tooling now require the complete ETH configuration, including symbol, decimals, native flag, exact launch fee and all valuation limits. Invalid or old records are rejected.
4. **The opening-price test allowed too much rounding.** Its bound now uses the actual contract tick spacing of 60 rather than 200. Both factories pass at 0.5, 1 and 5 ETH.

The custom-hook browser test initially exceeded its five-second expectation while the new gas re-estimation was still running. Its wait now accommodates that operation. The targeted rerun and subsequent full suite both passed; the final result is a single clean run of all 38 tests.

## Verification evidence

| Area                                    | Result                                                                                                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts against real local Uniswap V4 | 26 passed; the optional fork case is run separately                                                                                                                                |
| Mainnet fork                            | 1 passed; standard and modular launch, quote, buy, sell and claims use Robinhood's actual PoolManager, Quoter, StateView and CREATE2 deployer; every write stays on the local fork |
| Unit and persistence tests              | 42 passed, zero skipped; real Redis uses an isolated random test namespace                                                                                                         |
| Browser suite                           | 38 passed in one run, approximately 3.8 minutes                                                                                                                                    |
| Compiler reproducibility                | Forced compilation of 86 Solidity files; all ten exported release files match the recorded SHA-256 hashes byte-for-byte                                                            |
| Contract sizes                          | All below the 24,576-byte runtime limit; largest is the modular factory at 22,554 bytes                                                                                            |
| Formatting and production build         | Passed                                                                                                                                                                             |
| Production dependencies                 | Zero reported vulnerabilities                                                                                                                                                      |
| Contract development tooling            | 14 low-severity dependency entries; zero moderate, high or critical entries                                                                                                        |
| Live website                            | Latest bundle and all nine public release artifacts verified; status, hook registry and market endpoints return successfully; no browser errors observed on setup                  |
| Headers and packaging                   | Local and Vercel CSP match the live response; Robinhood RPC is allowed; shared configuration is included in function packaging                                                     |
| CI action pins                          | Checkout, setup-node and upload-artifact commit hashes match their upstream release tags                                                                                           |

The contract tests cover native settlement, exact transaction value, approval-free buys, token sells, deadlines, slippage, vesting, the founder cap, fees, permanent seed liquidity, all seven hook modules, rejected ETH recipients, reentrancy and accounting isolation. The browser tests cover actual wallet-driven setup, launch and custom build, switching chains, sell approvals, MAX, wallet rejection, cancellation/replacement, reload recovery, Arc state rejection, mobile layout and production CSP.

The compiler emits the upstream Uniswap transient-storage advisory. The production build also reports a large JavaScript chunk; Vercel reports that the configured function memory value is ignored under Active CPU billing. These are recorded build notices, not passing-test substitutes. This verification is not an independent smart-contract security audit.

## Published application

- Domain: https://hookbrew.tech
- Deployment: `dpl_A5QFgEytA9FbGNXEfqPQjTKABWkY`
- Build URL: https://hooker-cash-8ew8tmms8-kyles-projects-692df208.vercel.app
- Native quote: ETH, zero address, 18 decimals, chain 4663.
- Launch fee: `100000000000000` wei (0.0001 ETH).
- Opening target: 0.5–5 ETH, default 1 ETH. Tick rounding is bounded separately from the requested target.
- Treasury: `0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4`.
- Persistence: healthy Redis; fresh `hookbrew:4663:v2` namespace.
- Deployment registry, custom-hook registry and indexed markets are currently empty.

## Remaining before declaring the venue live

1. Configure a dedicated Robinhood mainnet **archive RPC** through the server-only `HOOKBREW_RPC_URL`. Production currently uses the official public endpoint. [Robinhood explicitly describes that endpoint as rate-limited and unsuitable for production, and calls for archive access for historical reads and indexing](https://docs.robinhood.com/chain/connecting/). No provider credential was available to complete this step.
2. Use the funded wallet to sign factory and router deployment in `/setup`, then use the configured treasury wallet to authorize activation. These signatures have not occurred. Export actual addresses, receipts, compiler settings and indexing start block after activation.
3. Publish sources on Robinhood Blockscout with a configured `BLOCKSCOUT_API_KEY`, or submit the exported standard JSON sources through the explorer UI. The publication command correctly refuses to proceed when there is no activated deployment. No live source publication is claimed.
4. Complete the mainnet wallet-signed launch, buy, sell, harvest and claim smoke test; check indexed data, metadata and explorer links. Local and fork tests do not replace this final step.

Operating instructions are in [ROBINHOOD_MIGRATION.md](ROBINHOOD_MIGRATION.md). Official infrastructure addresses were cross-checked against [Uniswap's Robinhood deployment table](https://developers.uniswap.org/docs/protocols/v4/deployments) and read-only RPC calls on chain 4663. Two L2 confirmations remain the interaction threshold, not Ethereum finality.
