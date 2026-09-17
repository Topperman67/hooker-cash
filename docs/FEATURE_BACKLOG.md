# Hookbrew feature-parity backlog

Derived from the [reference-site audit](FEATURE_PARITY_AUDIT.md), 17 September 2026. This is a requirements backlog, not a list of changes implemented during the audit. IDs are stable work items; each row may need multiple implementation tasks.

Priority: **P0** shared dependency; **P1** core launch/discover/trade loop; **P2** programmable mechanics and management; **P3** advanced parity. Lower priority does not remove the requirement from full parity.

Reference evidence: **U** observed public UI/read; **C** delivered client code or docs; **G** transaction/account/authentication gated. Local status: **Missing**, **Partial**, or **Gated**. Gated locally means code exists but cannot be used with the unset production deployment.

## Foundation

| ID  | Priority | Requirement                                                               | Local status / reference evidence        | Acceptance                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F01 | P0       | Versioned chain/deployment manifest and matching current contract sources | Partial / U,C                            | Pin chain, addresses, ABIs, source/build, start blocks, code/authority and fee-recipient evidence                 |
| F02 | P0       | Launch/pool/swap event ingestion and historical backfill                  | Missing / U,C                            | Rebuild listings and histories from the selected deployment; resume without gaps/duplicates                       |
| F03 | P0       | Hook, creator, fee, vesting, scheduler and optional perps entities        | Missing / U,C                            | Entity relationships use chain-qualified IDs and reconcile with contract reads                                    |
| F04 | P0       | Read API, pagination, filtering and batched lookups                       | Missing / U                              | Market/registry/token/profile views use a real shared service                                                     |
| F05 | P0       | Decimal-safe price, market-cap, volume and USD conversion                 | Missing / U,C                            | Quote and USD values have explicit units, timestamps and provenance; unavailable prices stay unavailable          |
| F06 | P0       | Reorgs, retries, cache invalidation, index lag and stale/error states     | Missing beyond basic RPC / inferred need | Replay/recovery produces consistent balances and aggregates; no stale success signals                             |
| F07 | P1       | Media upload, validation, storage and token metadata resolution           | Missing / C                              | Image/social metadata survives launch and appears through a stable validated URI                                  |
| F08 | P1       | Shared transaction lifecycle for every new write                          | Partial for basic launch / U,C,G         | Exact preflight, approval scope, wallet checks, one send, receipt verification and recovery apply to each adapter |

## Market and navigation

| ID  | Priority | Requirement                                                                 | Local status / reference evidence     | Acceptance                                                                                          |
| --- | -------- | --------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| M01 | P1       | Indexed launch feed with identity, creator, quote/fee/hook/venue badges     | Missing / U                           | Newly confirmed launch appears with real metadata and deployment provenance                         |
| M02 | P1       | Prices, market caps, volume, change, age, sparklines and recent activity    | Missing / U                           | Metrics match underlying trades and declared windows                                                |
| M03 | P1       | Tile/list views, sorting, filters and pagination                            | Missing / U                           | Both views apply the same query and preserve predictable ordering                                   |
| M04 | P1       | Name/symbol/address search and global autocomplete                          | Partial: address lookup / U           | Search finds indexed launches; arbitrary contract lookup remains distinct                           |
| M05 | P2       | Live activity strip and incremental updates                                 | Missing / U                           | New indexed activity updates once without duplicating rows or resetting user context                |
| M06 | P3       | Token pins/watchlist, persistence and navigation                            | Missing / U,C                         | Pin/unpin and restore real token identities; handle removed/unavailable entries                     |
| M07 | P3       | Quick-buy amounts, explicit enable preference and execution                 | Missing / U,C,G                       | Preferences are editable; selected amount feeds verified trade execution; rejection/revert is clear |
| M08 | P2       | Asset/artist/portfolio/stats/guide/countdown routes and mobile entry points | Missing or redirected / U,C           | Deep links resolve to their actual feature; mobile exposes equivalent actions                       |
| M09 | P3       | Chain and read-node selection with failover                                 | Partial: fixed Arc RPC fallback / U,C | Reads, caches, quotes and writes stay on the selected chain; node choice is explicit                |
| M10 | P1       | Correct existing builder/module/search promises                             | Partial / local source                | Each CTA reaches the named feature; query parameters have defined behavior                          |

## Registry and builder

| ID  | Priority | Requirement                                                                       | Local status / reference evidence | Acceptance                                                                                       |
| --- | -------- | --------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| H01 | P1       | Live hook registry: tier, eligibility, callbacks, address, builder and manifest   | Missing / U                       | Entries derive from registry/contract state; no duplicate-contract count inflation               |
| H02 | P2       | Registry filters, sorts and launch-count/token drilldowns                         | Missing / U                       | Counts reconcile with indexed launches; token modal selects the right hook                       |
| H03 | P1       | Builder workspace with install/remove, fee-flow preview and allocation validation | Missing / U                       | Configuration serializes deterministically and cannot over-allocate the fee cut                  |
| H04 | P2       | Bouncer spacing/window                                                            | Missing / U,G                     | UI units/bounds encode the reviewed throttle module; expiry and sell behavior tested             |
| H05 | P2       | Velvet Rope presets/custom curve and time/buy windows                             | Missing / U,G                     | Reserve-BPS caps and ramps encode correctly; preview agrees with configured behavior             |
| H06 | P2       | Ticker Tape depth and oracle readiness                                            | Missing / U,G                     | Configuration and history readiness match the deployed oracle                                    |
| H07 | P2       | Sugar Daddy permanent support allocation                                          | Missing / U,G                     | Quote-side fee accounting and locked support are verified                                        |
| H08 | P2       | Ashtray burn allocation                                                           | Missing / U,G                     | Burn destination and amount are correct; circulating and total supply are distinguished          |
| H09 | P2       | Money Flip buyback allocation and impact bound                                    | Missing / U,G                     | Quote conversion, impact checks and destination agree with reviewed module behavior              |
| H10 | P2       | Champagne Room liquidity allocation/modes                                         | Missing / U,C,G                   | Only supported modes are offered; custody and accrued liquidity are observable                   |
| H11 | P2       | Make It Rain holder allocation                                                    | Missing / U,G                     | Fee slice and holder-distribution accounting reconcile                                           |
| H12 | P2       | JIT and version-dependent module capabilities                                     | Descriptions only / U,C,G         | Registry/API/preset capabilities agree; unavailable builder cells are not invented               |
| H13 | P1       | Build encoding, salt mining, prediction, reuse, submission and registration       | Missing / U,C,G                   | Predicted/deployed address and callback permissions match; reuse does not send a redundant build |
| H14 | P2       | Source-verification kit and explorer links                                        | Missing / U,C                     | Exact standard JSON/compiler/constructor/version matches the deployed artifact                   |

## Launch and scheduling

| ID  | Priority | Requirement                                                       | Local status / reference evidence              | Acceptance                                                                                       |
| --- | -------- | ----------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| L01 | P1       | Pool → Hook → Token → Payouts → Review wizard                     | Partial / U                                    | Draft survives step navigation; required fields and economics are reviewed before signing        |
| L02 | P1       | Quote admission, fee tiers and initial market-cap policy          | Partial: fixed configured values / U,C         | Fresh on-chain policy supplies permitted quotes/bounds; native and ERC-20 decimals stay distinct |
| L03 | P1       | Curated/custom/built hook selection and builder handoff           | Gated preset select only / U                   | Selected hook is eligible on this deployment; handoff preserves the draft                        |
| L04 | P1       | Name/symbol/image/description/website/X/Telegram metadata         | Partial: name/symbol/description / U           | Byte limits, file handling and metadata encoding agree with contracts                            |
| L05 | P1       | Founder purchase, allowance and allocation cap                    | Missing in UI; prior simulation exists / U,C,G | Exact approval and purchase settle to the correct recipient within policy/slippage constraints   |
| L06 | P2       | Fee/token recipient splits and validation                         | Missing / U,C,G                                | Shares sum correctly; addresses are valid/unique; actual recipient state matches review          |
| L07 | P2       | Global and per-recipient cliff/linear/custom vesting              | Missing / U,C,G                                | Purchased tokens reach vesting; unlock/claim accounting matches each schedule                    |
| L08 | P1       | Activate existing basic launch adapter for selected deployment    | Gated / local code                             | Reviewed configuration, authorized signed launch and indexed receipt complete the real loop      |
| L09 | P3       | Optional vanity suffix and deterministic salt                     | Missing / C,G                                  | Cancellable search predicts the actual token address; ordinary launches remain usable            |
| L10 | P2       | Schedule, escrow, countdown and sharing                           | Missing / U,C,G                                | Valid future schedule records chain state and opens a persistent countdown route                 |
| L11 | P2       | Scheduled launch trigger, cancel/refund and status reconciliation | Missing / C,G                                  | Trigger launches once; cancellation refunds the right account; race/failure states are handled   |

## Token desk and spot execution

| ID  | Priority | Requirement                                                         | Local status / reference evidence   | Acceptance                                                                                   |
| --- | -------- | ------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| T01 | P1       | Token-to-factory/venue/pool/hook resolution                         | Partial: ERC-20 metadata only / U,C | Correct pool key and quote leg are shown; arbitrary ERC-20 is not labeled an indexed launch  |
| T02 | P1       | Token dossier, social/share/creator links and statistics            | Missing / U                         | Identity and metrics reconcile with metadata, supply, pool and quote pricing                 |
| T03 | P1       | Real price history and basic line/candle chart                      | Missing / U                         | Bucket OHLC and time axes derive from real trades; empty intervals/history are explicit      |
| T04 | P3       | Chart interval selection, zoom/pan and drawing/measurement tools    | Missing / U                         | Tools work across responsive layouts without corrupting market data                          |
| T05 | P1       | Paginated trade tape with direction/size/time filters and tx links  | Missing / U                         | Rows decode actual swaps, correct currencies and declared history coverage                   |
| T06 | P2       | Trader P&L and sortable buy/sell/balance views                      | Missing / U                         | Cost basis, transfer treatment and partial-history limitations are defined                   |
| T07 | P2       | Holder balances, ownership percentages and values                   | Missing / U                         | Snapshot block and excluded/system addresses are clear; supply math reconciles               |
| T08 | P1       | Token picker, token import, balances, direction and amount controls | Partial: address lookup / U         | Correct decimals and spendable balances feed quotes                                          |
| T09 | P1       | V4 pool-key resolution, executable quoting and routing              | Missing / U,C,G                     | Exact route and current quote are simulated for the selected deployment                      |
| T10 | P1       | Slippage, minimum received, impact, approval and Permit2 settlement | Missing / U,C,G                     | User-reviewed limits reach exact calldata; allowance/expiry/amount errors are handled        |
| T11 | P1       | Spot submission, receipt verification and data refresh              | Missing / U,C,G                     | Real confirmed trade updates wallet, tape and price; rejection/revert never looks successful |
| T12 | P3       | Chain-specific wrap/unwrap and additional quote routes              | Missing / C,G                       | Enable only currencies/contracts present on the selected chain; no WETH assumptions on Arc   |

## Fees, vesting and liquidity

| ID  | Priority | Requirement                                                        | Local status / reference evidence         | Acceptance                                                                                        |
| --- | -------- | ------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| R01 | P2       | Creator allocation, hold-gate eligibility and recipient accounting | Missing / U,C                             | Balances/eligibility show correct thresholds and reason for unavailable rewards                   |
| R02 | P2       | Permissionless harvest and creator claims in both currencies       | Missing / U,C,G                           | Accruals, harvest and payout reconcile after a verified receipt                                   |
| R03 | P2       | Protocol/treasury claim visibility and execution                   | Missing / C,G                             | Authority/recipient rules are verified; frontend does not assume ownership                        |
| R04 | P2       | Holder reflection totals, batches and distribution                 | Missing / U,C,G                           | Pending/paid/round counts reconcile; partial distribution cannot double-pay                       |
| R05 | P2       | Vesting progress, claimable amounts and token release              | Missing / C,G                             | Cliff/duration/recipient state governs claim UI and actual release                                |
| R06 | P2       | Burn, deepened-liquidity and floor-liquidity module metrics        | Missing / U,C                             | Cumulative measures reconcile to events/state and use accurate supply/custody labels              |
| Q01 | P2       | Pool directory with search, filters and metrics                    | Missing / U                               | Pool/fee/TVL/volume information derives from actual supported venues                              |
| Q02 | P2       | Supported add-liquidity and pool initialization                    | Missing / C,G; reference Arc UI disabled  | Validate currency support, ticks/ranges/amounts, approvals and PositionManager execution          |
| Q03 | P2       | User-position discovery, fee collection and exits                  | Missing / docs; full lifecycle unverified | Establish actual deployment support; distinguish user positions from locked seed/module liquidity |

## Profiles, portfolio and platform statistics

| ID  | Priority | Requirement                                                 | Local status / reference evidence | Acceptance                                                                                              |
| --- | -------- | ----------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| P01 | P2       | Creator and builder leaderboards with search/filter/sort    | Missing / U                       | Rankings reconcile with indexed launches, holdings and measured volume windows                          |
| P02 | P2       | Creator profiles, badges, notable launches and built hooks  | Missing / U,C                     | Route/identity/attribution are correct; badges use stated deterministic rules                           |
| P03 | P2       | Portfolio balances, live values and unpriced-token handling | Missing / U,C,G                   | Native/ERC-20 balances and prices are chain-correct; missing prices do not become zero-value assertions |
| P04 | P2       | Portfolio import/removal and persistence                    | Missing / C,G                     | Valid token tracking changes the portfolio without modifying token ownership                            |
| P05 | P2       | Platform launch/creator/fee-share/volume statistics         | Missing / U                       | Aggregates use explicit windows and deduplicated venue coverage                                         |

## Agents and documentation

| ID  | Priority | Requirement                                                          | Local status / reference evidence        | Acceptance                                                                                                   |
| --- | -------- | -------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A01 | P2       | Hosted MCP initialize/tools/list and versioned schemas               | Missing / U                              | Standards-compatible client can connect and discover the documented tools                                    |
| A02 | P2       | Three discovery/read recipe tools                                    | Missing / U                              | `get_launchpad_info`, `list_launches`, `get_token` return correct chain/version recipes                      |
| A03 | P2       | Four preparation tools                                               | Missing / C,G                            | `prepare_launch`, `prepare_build_hook`, `prepare_trade`, `prepare_collect` produce verified recipe schemas   |
| A04 | P0       | MCP chain/deployment isolation                                       | Missing / observed reference defect      | Chain 5042 cannot receive 4663 addresses/recipes; unsupported chains fail explicitly                         |
| A05 | P2       | Accurate authentication behavior and client setup                    | Missing / observed reference conflict    | If authentication is required, issue/revoke/expiry/setup work; otherwise remove the requirement consistently |
| A06 | P2       | Agent guides, connection snippets, examples and error contracts      | Missing / U,C                            | A new client completes discovery/preparation using docs alone; protocol errors are surfaced correctly        |
| D01 | P1       | User guide and mechanics documentation                               | Partial: project status only / U         | Explain actual launch/trade/fee/module/vesting/custody behavior without stale cross-chain copy               |
| D02 | P1       | Versioned contract directory and source/provenance status            | Partial: engineering evidence only / U,C | Every advertised contract has correct chain/address/version and honest verification status                   |
| D03 | P2       | FAQs, troubleshooting, supported-feature matrix and meaningful Terms | Partial / U,C                            | Documentation matches available actions, permission boundaries and failure states                            |

## Leveraged-market parity

| ID  | Priority | Requirement                                                       | Local status / reference evidence | Acceptance                                                                                  |
| --- | -------- | ----------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| X01 | P3       | TWAP history/readiness and permissionless market activation       | Missing / U,C,G                   | Minimum history/depth and oracle freshness agree with reviewed engine checks                |
| X02 | P3       | Long/short margin, leverage, fees, caps and liquidation estimates | Missing / U,C,G                   | Displayed math matches engine units, current parameters and simulated execution             |
| X03 | P3       | Position open/close/add-margin, funding and health tracking       | Missing / C,G                     | Position state and settlement reconcile across funded test scenarios and receipts           |
| X04 | P3       | Counterparty vault backing, shares and constrained withdrawal     | Missing / U,C,G                   | Deposits/withdrawals and solvency/exposure checks match reviewed contracts                  |
| X05 | P3       | Liquidation/keeper behavior and perps indexing                    | Missing / C; execution unverified | Review actual liquidation support, funding and insolvency boundaries before claiming parity |

## Milestone acceptance gates

1. **Read product:** market → search/filter → asset → chart/tape/holders → creator. Verify with real indexed data and a reproducible backfill; do not substitute production fixtures.
2. **Core write loop:** reviewed launch → verified receipt → indexed listing → executable quote → confirmed trade → refreshed balances/history. Exercise wrong chain, stale quote, declined approval, revert, replacement and reload.
3. **Programmable economics:** build/reuse a hook → launch with its manifest → trade → harvest → recipient/holder/vesting accounting. Validate combinations, bounds and custody separately.
4. **Management:** schedule/trigger/cancel/refund, supported LP lifecycle, portfolio and statistics. Verify each actual deployment path; the reference's disabled Arc LP button is not a passing test.
5. **Agent parity:** independent client discovers the right chain and uses every tool with the documented authentication policy. Test HTTP-success/protocol-error cases and cross-chain rejection.
6. **Advanced markets:** oracle readiness, leverage, position settlement and vault solvency each require contract-level and transaction-level evidence. A rendered perps panel alone does not pass.

All milestones retain the Hookbrew branding and glass interface. The audit adds requirements and evidence only; it enables no transaction and changes no deployment selection.
