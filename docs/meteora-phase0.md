# Meteora switch, Phase 0: findings

Evidence comes from `programs/quantum-hooks/tests/meteora-spike.mjs`. It ran Meteora's real
programs (mainnet dumps) on the local validator through a full coin lifecycle. Raw output is in
`programs/quantum-hooks/tests/meteora-spike.json`, and the run date is in its fixture manifest.
A plain keypair stood in for the well PDA.

## Pinned versions

| Item                              | Value                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| DBC program                       | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, deployed IDL 0.2.1, sha256 `b3f7b765…6c44`         |
| DAMM v2 program                   | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, sha256 `7c479dd7…94e0`                             |
| Upgrade authority (both programs) | `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`                                                    |
| SDKs                              | `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 and `@meteora-ag/cp-amm-sdk` 1.5.1, pinned exactly |
| IDLs                              | `shared/idl/meteora_dbc.json`, `shared/idl/meteora_damm_v2.json`                                  |

**IDL source.** The IDLs come from the SDKs. The IDL accounts Meteora publishes on-chain are stale (0.1.10 and 0.2.0), so `scripts/meteora-idls.mjs` reports the differences and records the deployed program hashes. Re-run it after Meteora's next upgrade.

**Devnet.** Devnet uses the same program IDs, and the Customizable migration config `A8gM…Ctck` exists there too.

## Answers

1. **First-swap minimum fee.** The dev buy gets it (100 bps while the scheduler was at 5,000 bps) in every order tried, including create → `transfer_pool_creator` → buy.
   - **Condition:** the swap must pass the Instructions sysvar as a remaining account. Without it, the dev buy paid the full 5,000 bps.
   - **T2 order stays as planned:** create → transfer → sync → dev buy.
2. **Zero-amount claims succeed.** This holds for DBC `claim_creator_trading_fee` and DAMM `claim_position_fee`, so `harvest` can call every leg unconditionally. `creator_withdraw_surplus` also succeeds with nothing to withdraw, once the curve is complete.
3. **Adding to a permanently locked position works.** `add_liquidity` into the creator's permanently locked position works, and `permanent_lock_position` of the delta then leaves unlocked liquidity at 0.
4. **Offsets.**
   - Field offsets computed from the IDLs match the account bytes exactly for DBC `VirtualPool` and DAMM `Pool`, `Position` and `Config`, including sizes.
   - These structs are bytemuck `Pod`, so `offset = 8 + Σ field sizes`.
   - The full tables are in `meteora-spike.json` under `offsets`. `VirtualPool` nests everything in one `pool_state` struct, starting at byte 8.
5. **Option 6 gives quote-only fees.** It produces a DAMM v2 pool with `collect_fee_mode = 1`, which is quote token B only. Token A is the coin.
6. **Migration lands the LP with the well.**
   - The well (as `pool.creator`) receives exactly one position NFT, holding 100% of the LP permanently locked.
   - The DAMM pool's `creator` field is DBC's `pool_authority`, and the DAMM config's `pool_creator_authority` is DBC's `pool_authority`. These are the facts `sync` relies on.
7. **Creator migration fee.** `withdraw_migration_fee(1)` paid the creator the configured migration fee: 2% of the 5 SOL test threshold, about 0.1 SOL.
8. **Transfer window.** `transfer_pool_creator` is refused between curve completion and migration (error 6022). It is irrelevant to us, because the transfer happens in T2.
9. **Migration status values.** With no vesting, `migration_progress` jumps to 2 at completion and 3 after migration. `finish_curve_timestamp` is set at completion.
10. **Migration needs rent to be fronted.** It fails with "insufficient funds" unless DBC's and DAMM's `pool_authority` accounts exist with lamports. On mainnet they do, and the fixtures now clone them.
11. **Leftover tokens** go to the config's `leftover_receiver` only. The creator side gets trading fees, surplus, the migration fee and LP fees.

## Sizes

| Transaction                                                                       | Size        | Compute       |
| --------------------------------------------------------------------------------- | ----------- | ------------- |
| T2 without a lookup table (worst-case 32-byte name, 10-byte symbol, 200-byte URI) | 1,206 B     | about 215k CU |
| Migration                                                                         | 1,139 B     | 167k CU       |
| DBC swap                                                                          | about 740 B |               |
| DAMM swap                                                                         | 681 B       |               |

T2 is create + transfer + wrap + dev buy + unwrap. QH `sync` and the platform fee push it past 1,232 B, so T2 needs the lookup table, as planned.

## Plan changes

- **Instructions sysvar on T2's dev buy.** The client must pass it. The on-chain `sync` already reads that sysvar for birth binding.
- **Clone the pool authorities in the test fixtures.** Both pool-authority accounts are now included.
- **`declare_program!`.** Whether it compiles under Anchor 0.31.1 is checked at the start of Phase 1. The fallback is hand-built instructions from the IDL.
