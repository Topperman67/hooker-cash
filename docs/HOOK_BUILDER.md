# Hookbrew modular hooks

Stage 2 provides open/guarded V1 presets, a burn/reward recipe, a seven-module composer, and a persistent community registry. Existing V1 contracts and token pools remain unchanged. This implementation is original Hookbrew code; it does not deploy the reference product's contracts.

## User flow

1. Start at Pool, then continue to Hook.
2. Choose **Build a custom hook**, install modules, and set the opening window and fee allocations.
3. Review the exact recipe, projected allocation of each fee currency, hook address, and network fee.
4. Confirm one wallet transaction. This creates a recipe-specific package, V4 hook/factory, token deployer, vesting vault and trading router. It does not launch or buy a token.
5. The app waits for two confirmations and registers a verified deployment. Continue to Token, Payouts and Review. Launch simulation, exact founder-buy approval, launch and trading use this hook's factory/router.

An existing registered recipe is reused without another deployment transaction. Editing any module invalidates the selected build; an unbuilt recipe cannot pass Stage 2. Rejected signatures do not trigger retries. A submitted hash survives reload, and **Check confirmation** retries verification/registration without sending again. Registration failures leave the receipt recoverable.

## Contract structure

`HookbrewHookPackage` has only immutable factory/router/recipe getters. Its CREATE2 salt is searched canonically from zero. The nested factory's permission bits must equal `0x20c0`: beforeInitialize, beforeSwap and afterSwap, without return-delta permissions. The same build, network infrastructure, treasury and recipe derive the same addresses. No private deployment key or privileged module administrator is required.

`HookbrewModularFactory` is a separately versioned V1-derived venue. It owns permanent seed positions, keeps creator/protocol/module balances separately, and enforces the immutable recipe when launching. It has no withdrawal, upgrade, recipe setter or arbitrary-call executor. `HookbrewTokenDeployer` keeps token creation bytecode outside the factory runtime and accepts only its factory. `HookbrewRewardToken` has a fixed initial supply and only permits the factory to burn tokens the factory itself holds.

The original V1 source and artifacts are preserved. New artifacts use the same pinned Solidity 0.8.26, Cancun, viaIR, optimizer 200 build. Export checks both the 24,576-byte runtime and 49,152-byte initcode limits; unlimited-size local deployment is disabled.

## Modules and accounting

| Module                 | Behavior                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buy spacing            | Pool-wide interval of 1–60 seconds between buys during a 1–3,600 second opening window. Founder purchases and sells are exempt.                                                                                                                                                                  |
| Rising buy cap         | Per-buy cap ramps from the starting percentage to the ending percentage of seed-position virtual quote reserves, at most 50%. Expires with the opening window.                                                                                                                                   |
| Price history          | Cumulative tick observations, a 64-slot ring, at most one historical sample each 60 seconds. Current cumulative tick updates around swaps; internal founder/buyback swaps explicitly update it too.                                                                                              |
| Fee burn               | Burns the configured share of creator-side token fees. Quote fees remain available to creators unless another module uses them.                                                                                                                                                                  |
| Holder rewards         | Allocates the configured share of creator-side USDC fees to holders at harvest. PoolManager, factory and vesting balances are excluded. Accrued rewards stay with the holder after transfers and are claimed separately to that holder. With no eligible supply, funds wait for a later harvest. |
| Buyback & burn         | Queues creator-side USDC. Permissionless execution spends at most 0.5% of virtual quote reserves with a 200-tick price limit relative to the historical average, then burns received tokens. Unspent USDC stays reserved.                                                                        |
| Liquidity reinvestment | Reserves the configured share of both creator-side fee currencies and adds available pairs to the permanent seed position. Unused balances remain reserved. Newly harvested fees are accounted separately from liquidity principal.                                                              |

Module percentages together cannot exceed 100% of the creator's 70% share. Sliders consume unassigned budget first, then reduce other module allocations evenly, stopping at zero and redistributing any remaining reduction. The edited slider keeps its chosen value; integer basis-point arithmetic prevents rounding overflow. Modules reduced to zero stay editable. Removing a module returns its allocation to the available creator budget. Saved, unbuilt over-allocations are repaired on load; confirmed recipes are never rewritten. Protocol allocation is always 30%, computed before modules. The UI separately displays token-fee and USDC-fee routing because not every module spends both currencies. Modules never spend other tokens' reserves, creator claim balances or treasury claims.

Buybacks and liquidity execution require Price history, at least 30 minutes of recorded history, and spot price within 100 ticks (about 1%) of the average. There is no spot-only fallback during warm-up. The average uses the most recent retained observation at least 30 minutes old, so sparse trading can produce a longer window. Harvesting and fee claims do not depend on this price check. Market actions are permissionless calls from the token terminal; there is no promise of automatic keeper execution.

Holder rewards are harvest-time proportional distributions, not time-weighted holdings. Buying immediately before harvest can participate. Tiny rounding dust remains in the reward contract. Guards do not eliminate bots or multiple-wallet participation, and price bands bound but do not eliminate market-manipulation risk. Independent security review has not been completed; passing tests is not an audit or an economic guarantee.

## Registry and indexing

`POST /api/hooks/register` verifies the successful, canonical transaction, two confirmations, exact current package creation bytecode/constructor arguments, the configured CREATE2 proxy, permission bits, package/factory/router addresses and runtime hashes. Callers cannot register arbitrary code or redirect protocol fees. A verified build is permissionlessly reusable, so registration does not request a treasury signature.

Redis registration uses a lease and a fenced atomic write. Filesystem deployments persist one record per recipe. The registry and each factory's event index survive separate API instances and restarts. Market listing and token detail endpoints merge the original venue and custom venues. Each token detail supplies its own deployment for quotes, approvals, swaps, harvesting and claims. Burned supply is refreshed from chain when the custom index advances.

Sync work is bounded: the original venue plus up to three rotating custom venues per sync request. Active pages request sync through the existing mechanism. At a large number of venues, indexing latency rises; a dedicated background indexer is the next scaling step. A built recipe is deployed only when a user confirms its build in a wallet. Development verification uses isolated local V4 deployments, never a real user's funds.

## Sources

- [Uniswap V4 hooks and permissions](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks)
- [Uniswap V4 swap callbacks](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks)
- [OpenZeppelin BaseHook](https://docs.openzeppelin.com/uniswap-hooks/base)
