# Hookbrew integration and contract review

Checked 2026-09-17 UTC. **The full launch project is incomplete. This is an integration review and test record, not a security audit or approval to deploy.**

## Requirements and current evidence

| Requirement                                               | Evidence                                                                                                                                                                       | Result                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Put the seven glass designs in the left navigation        | `src/components/Shell.jsx`; byte-identical PNGs moved to `public/brand/navigation`; desktop/mobile browser checks                                                              | Implemented                                                                                  |
| Remove the glass toggle; keep QuickLiquid enabled         | `Glass.jsx` always uses `refractionMode: 'auto'`; no preference state; test sets the obsolete off preference and checks active SVG displacement/backdrop refraction            | Implemented, retaining browser and system accessibility fallbacks                            |
| Remove fabricated production activity and identities      | No production token fixtures, generated chart series, invented prices, balances, swap arithmetic, or pretend receipts; token lookup uses contract strings and neutral initials | Implemented                                                                                  |
| Real wallet connection                                    | EIP-6963/EIP-1193 provider connection, actual accounts/network events, Arc switching and native balance reads                                                                  | Implemented; automated wallet fixtures are test-only; a human wallet has not signed a launch |
| Real blockchain reads                                     | Browser made unmocked Arc reads at blocks 21252611–21252614 and read `hooker.cash` / `HOOKER` at its published address, with 18 decimals and 1,000,000,000 total supply        | Verified read-only                                                                           |
| Identify every selected launch contract and fee recipient | No Hookbrew deployment selected. Original Hooker manifest and code hashes recorded separately                                                                                  | Incomplete                                                                                   |
| Match selected deployed contracts to reviewed source      | Recovered V10 core matches four original Arc presets, including immutable values; remaining current implementation sources absent                                              | Partial; no Hookbrew deployment selected                                                     |
| Real Hookbrew token launch                                | Real transaction builder, wallet-send path and receipt verifier implemented behind unset deployment configuration; no new wallet-signed launch                                 | Incomplete; gated integration ready for deployment-specific validation                       |
| Real swaps, indexed markets, positions and charts         | No configured routing/indexing integration; no fabricated fallback                                                                                                             | Incomplete                                                                                   |

## What the user's GitHub repository contains

The remote `Topperman67/hooker-cash` main branch at `bfbab6a92d9755182cb9d92c772fb8ed06bac521` contains a Vite/React frontend and static data. There are no Solidity sources, launch contract ABIs, deployment manifests, wallet dependencies, RPC integration, indexer, or server contracts in that tree. Its only published branch during this check was `main`.

The previous local interface also included invented token identities and metrics, generated sine/cosine charts, a dead-address wallet simulation, and launch/swap previews. Those have been removed. Replacing these with unavailable states is an interim correction, not completion of the real launch goal.

## Original Hooker Arc deployment: read-only observations

Sources are the original site's published [contract manifest bundle](https://hooker.cash/assets/contracts-D8rUCa7Y.js) and [ABI bundle](https://hooker.cash/assets/abis-OZoku8Of.js). The manifest/ABI literals were extracted without executing remote JavaScript and retained in [hooker-arc-reference.json](evidence/hooker-arc-reference.json). This is evidence, not the app's deployment configuration.

At Arc block **21252386**, through `https://rpc.mainnet.arc.io`:

- All 32 nonzero addresses in the manifest's infrastructure, protocol contracts, module catalogue, and preset hooks had runtime code. The position descriptor was explicitly zero and is not deployed in that manifest.
- The factory's `policy()` and `tokenDeployer()` getters matched the published manifest.
- `launchFee()` returned `1000000000000000000`, or **1 native USDC** at Arc's 18 native decimals. This is a snapshot of the original contract, not a Hookbrew price promise.
- `treasury()` on the factory, policy, and hook builder returned `0x4d292846F109BA1c7B6842F8C8d3E971bc4ab376`.
- `owner()` on the hook registry, module registry, and fee engine returned that same address.
- Other attempted owner/treasury getters reverted or were unavailable. That does not prove absence of administrative powers.
- A bounded scan of the latest 10,001 blocks using the published event signatures found no matching factory launch events. That says nothing about earlier launches, other event versions, or other factories. It does not verify launch execution.

| Role            | Published Arc address                        |
| --------------- | -------------------------------------------- |
| Factory         | `0x2707B4c72cD962fb1a511751f2A0C4e8017B6882` |
| Policy          | `0x67b10E7255deD7753311E8fF318a131783E073F5` |
| Token deployer  | `0x05CB5eFf96a172B8Df04F22801A26C236243147D` |
| Hook builder    | `0xa69699a61BA9ceEdA5B4F44010F9512809A4607D` |
| Hook registry   | `0xA4bE82e5048EEA402D294AA64e2A8DeC03E9990B` |
| Module registry | `0x3Eb6EAbfA8F91727969C44CbcdabB87f20a24cec` |
| Pool manager    | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

Every checked address, runtime length/hash, getter result, block hash, and log-query boundary is in [arc-read-only-check.json](evidence/arc-read-only-check.json). Reproduce with `node scripts/verify-reference-contracts.mjs`. The script only reads public state and throttles requests.

Changing frontend names would leave the original treasury and registry ownership unchanged. A deployment decision is required before adopting these contracts for Hookbrew.

## Recovered current V10 hook source

The original site's verification download publishes [LaunchpadHookCore.standard.json](https://hooker.cash/LaunchpadHookCore.standard.json). Its unchanged 81-source bundle is retained in `contracts/review/` with attribution and a pinned compiler. SHA-256 is `8edd68bfc9e1750fa84c67fdb5907dac085b3cea28d0491eead2457d2a122117`.

At Arc block **21254835**, the source compiled with Solidity **0.8.26+commit.8a97fa7a**, optimizer **200**, **via IR**, **Cancun**, and metadata hash `none` matched the **15,578-byte** runtime template of all four original presets: plain, JIT, reflect 50%, and reflect 50% plus burn 20%. Comparison excludes only compiler-identified immutable locations; a separate check verified every immutable value and repeated occurrence against each recorded configuration. Public preset manifests, module parameter bytes, and dependency getters also matched. See [hook-core-source-check.json](evidence/hook-core-source-check.json).

Two address distinctions matter:

- Each hook's `factory()` is the **seed executor** `0x83b527637f312fDe77aF367Cc5645aBD0eD67bEe`, as described by the recovered base source. That executor's `factory()` and `quotePolicy()` matched the published factory and policy. Equating every field named “factory” to the top-level factory would be incorrect.
- The hooks' immutable `WETH` is `0x000000000000000000000000000000000000dEaD`, while the site's generic manifest labels USDC as `weth`. Their `USDG` value is the actual Arc USDC interface. The sentinel is an observed deployment convention, not evidence of a WETH token on Arc.

### Source-level observations and remaining boundaries

- The core embeds gate/value module addresses, checks array sizes and module code during construction, and rejects per-leg aggregate value weights above 10,000 basis points. These checks do not validate the external modules' implementations.
- Gate dispatch is restricted to the PoolManager; launch registration and seed configuration are restricted to the bound executor. Module execution uses external calls and depends on those module contracts.
- `initializeFactory` can be called only once, but has no caller restriction before initialization. The presets are already initialized. Any new deployment must establish the intended binding atomically; the absent current builder source prevents verifying its deployment sequence from this bundle.
- The current treasury can replace itself through `setTreasury`. The hook system is not wholly ownerless.
- The bundled plain token has a fixed `totalSupply`; transfers to a burn address do not themselves reduce that value. The UI no longer promises that a burn module necessarily decreases ERC-20 reported total supply.
- The bundle does not contain current factory, policy, builder, module, fee-engine, vesting, distributor, or executor implementations. Full source equivalence and authority analysis remain incomplete even though the core matches.

## Actual Arc launch and initial-purchase simulations

All calls below used the original contracts' live state, pinned to the report's block, through public RPC. **No transaction was broadcast, no token was actually deployed, and no funds were spent.** Temporary balance/code overrides exist only inside each `eth_call`; they are isolated diagnostics, not production data or application behavior.

At block **21253974**, `scripts/simulate-reference-launch.mjs` produced all **10 expected outcomes**: four preset launches succeeded; an underpaid fee, oversized name, oversized symbol, zero hook, invalid quote address, and creator cap above the policy limit reverted. A transport error would fail a test rather than count as a revert. See [reference-launch-simulation.json](evidence/reference-launch-simulation.json).

At block **21255186**, `scripts/simulate-launch-initial-buy.mjs` produced all **six expected outcomes**:

- All four preset launches accepted ERC-20 approval plus a **1 USDC initial purchase**, alongside the current **1 native USDC launch fee**. The probe checked token code, exact name/symbol/supply, positive purchased and pooled token balances, consumed allowance, hook registration, and the exact **2 USDC combined debit**. Native 18-decimal and ERC-20 6-decimal balances agreed.
- A separate plain-preset launch with a recipient vesting schedule sent the purchased tokens to the vesting contract, leaving the purchaser with zero liquid tokens.
- A zero creator cap with a nonzero purchase reverted with `creator buy exceeds allocation cap`.

The `creatorAllocation` argument is a **purchase cap in this observed path**, not a free premint allocation. Without a vesting schedule, purchased tokens went directly to the caller; a nonzero cap alone did not create vesting. These distinctions were established by failed initial hypotheses and corrected call cases, not inferred from parameter names.

See [reference-initial-buy-simulation.json](evidence/reference-initial-buy-simulation.json) and [reproduction instructions](../contracts/review/README.md). These checks do not cover later market swaps, vesting release after time passes, fee claims, slippage controls, all custom module combinations, or an actual wallet-signed launch.

## Public Solidity reference: different version

Repository: [gigahooker/hookers-contracts](https://github.com/gigahooker/hookers-contracts), pinned source commit `70a7765fd4fcfc37703c874080c9771ffb774a1f`. It was cloned into the ignored local review directory `artifacts/contract-review/reference-contracts`. The source checkout remained clean after installation and testing.

The public source uses `HookersFactory`, `MechanismRegistry`, `LaunchPolicyV1`, `LiquidityCustody`, `CreatorFeeHookV1`, `BuybackBurnHookV1`, `FeeRecipientRegistry`, and `FeeRouter`. Its documented chain is Robinhood 4663 and its initial quote registry permits native ETH. The current Arc site instead publishes a modular builder V10, a newer factory/policy/token-deployer/vesting/fee-engine arrangement, and ERC-20 USDC quote handling. Their launch ABIs and fee models are different. Passing the older tests does not validate the newer code.

### Executed checks

- Dependency installation with lifecycle scripts disabled. The first install failed with a network reset; retry completed. The lockfile/source checkout remained unchanged.
- Solidity **0.8.26**, optimizer **1000**, **Cancun**, `viaIR: false`, metadata bytecode hash `none` with CBOR enabled, taken from the repository's actual Hardhat config.
- `npx hardhat test`: **115 Solidity files compiled, 108 tests passed**, process exit 0.
- Tests deploy a local real Uniswap V4 PoolManager and mine hook permission addresses. They cover local launches and subsequent trading, exact-input/output buy/sell fees, fee solvency/claims, recipient rotation/takeover, registry authority, custody constraints, native and ERC-20 currency ordering, buyback/burn, and compounding feasibility.
- The Hardhat test network allows unlimited contract size. A separate artifact inspection found all non-test project contracts below 24,576 runtime bytes; the largest is `CreatorFeeHookV1` at 14,764 bytes. See [reference-contract-sizes.json](evidence/reference-contract-sizes.json). This does not validate constructor gas, network deployment, or live wiring.
- The package declares `deploy`, `sizes`, and `slither` scripts whose referenced `scripts/` directory is absent in this public commit. A production deployment cannot be reproduced from those commands as shipped.
- The reference installation reported 51 dependency vulnerabilities (20 low, 14 moderate, 16 high, 1 critical). These are npm dependency findings in the reference toolchain, not findings of exploitable Solidity vulnerabilities. They were not automatically upgraded because that would change the tested reference environment.

### Source-level boundaries observed

- The factory calls policy/quote validation, collects the initial buy, creates the token, registers hook fees before pool initialization, seeds custody, executes the first buy, and records the launch.
- Custody exposes seed/increase paths, checks caller identity and PoolManager callbacks, and has no advertised exit path. Its tests cover unauthorized seed/increase and absence of a value-exit function.
- Fee recipients can rotate their own slots; a separate takeover authority can redirect future fees after settling accrued fees. This authority is a substantive control, even when the hook itself has no owner.
- The mechanism registry and launch policy have owner-controlled configuration. FeeRouter's payout is rotatable by its owner. These controls must be reviewed for the selected deployment; calling the entire system “ownerless” would be inaccurate.
- Buyback/burn has native-quote restrictions in the older source. It cannot simply be substituted for Arc's USDC modules.

This older inspection and test suite are not exhaustive security verification and do not establish equivalence to the current Arc factory. No Slither run, independent audit, full current-source equivalence, or user-signed Hookbrew launch has been established. The separate current-core comparison and Arc simulations above close only their stated scopes.

## Frontend verification

`npm run test:e2e`: **15 tests passed**. `npm run test:unit`: **6 tests passed**. Tests use isolated RPC/wallet fixtures to exercise failures and events; no fixtures ship in `src/`. Coverage now includes the configured launch form, account/fee/code drift, exact calldata, a single wallet request under duplicate clicks, declined signatures, strict receipt matching, reverts, reload recovery without resending, UTF-8 byte limits, and mobile layout. Build, formatting and standard `git diff --check` pass; the build still reports a JavaScript chunk above 500 KB.

A separate browser run against the existing local server used actual Arc RPC responses, read real token metadata, and recorded zero page errors. Screenshots and raw read output are in ignored `artifacts/hookbrew-live-*` files. Launch screenshots use isolated test fixtures and are not evidence of a new on-chain launch.

## Implemented transaction path and historical receipt checks

The production code now supports preparation, live deployment/code/treasury/fee checks, simulation, gas estimation, wallet account/network validation, one explicit `eth_sendTransaction`, and strict receipt/post-launch state validation. It stores submitted intent for read-only recovery after a reload. The initial UI supports a launch without an initial purchase, allocation or split. **`src/config/launchDeployment.js` remains `null`; no original contract addresses were silently selected.** See [launch integration](LAUNCH_INTEGRATION.md).

At block **21256905**, the production preparation function passed live checks against the original Arc factory and produced a successful read-only launch simulation and gas estimate. Diagnostic funding was overridden only for that test; no wallet provider or broadcast was used. See [launch-adapter-check.json](evidence/launch-adapter-check.json). Public RPC rejected `debug_traceCall` as unavailable, so no trace verification is claimed.

A separate historical scan covered 22 consecutive 10,000-block windows from the published deployment block, stopping after finding real matching launch events. It found the original platform-token launch at block **21118603** and two plain-preset launches at blocks **21124427** and **21124453**. This supersedes neither the earlier last-10,001-block observation nor a full event index: it is explicitly a bounded historical sample. See [reference-launch-events.json](evidence/reference-launch-events.json).

The production receipt verifier passed against both plain-preset historical transactions, checking the signed calldata and value, event identity, token code, exact metadata/supply and hook registration at their receipt blocks. Historical intent was reconstructed from the transaction, and its token address came from the event; this does not independently test a pre-signing address prediction. These are third-party historical launches, not user-signed Hookbrew launches. See [reference-receipt-check.json](evidence/reference-receipt-check.json).

## Required next inputs and work

Choose the actual deployment model: the user's own existing deployment, the original Hooker deployment with its existing controls, or separately deployed Hookbrew contracts. Provide the matching source repository/commit and address manifest if an existing Hookbrew deployment is intended.

Then finish matching source and deployed bytecode (including immutables/proxies), verify all cross-contract dependencies and administrative powers, establish permitted quotes/fees/hooks, validate and activate the implemented transaction path for that deployment, and verify a wallet-signed launch outcome. Initial-purchase options, routing, approvals, slippage/deadlines, swaps, liquidity views, indexing, and price history must follow the same real-data standard. The goal is not complete and is blocked on the unresolved deployment decision and missing implementation sources. The remote repository and unset local deployment configuration were rechecked after the transaction integration work; neither supplied those missing inputs.
