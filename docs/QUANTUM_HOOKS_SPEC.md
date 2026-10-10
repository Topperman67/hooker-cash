# Quantum Hooks — on-chain specification

Quant Pad launches coins through pump.fun on Solana. pump.fun mints cannot carry Token-2022
transfer hooks and trades cannot be intercepted, so **Quantum Hooks are powered by the coin's
creator-fee stream**. At launch the coin's pump.fun `creator` is set to a per-mint PDA of the
`quantum_hooks` program (the **well**). Creator fees from the bonding curve (and from the canonical
PumpSwap pool after graduation) accumulate in the well and are routed by immutable, per-coin rules.

Program: Anchor **0.31.1**, Rust, program name `quantum_hooks`. Mint decimals are 6 and pump.fun
`create_v2` mints are Token-2022; all token CPIs use the token interface and `transfer_checked`.

## Modules

| Module            | Effect                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Creator share** | Share of each pulse paid to the launcher (optionally split, see Superposition).                                      |
| **Superposition** | Up to 4 extra wallets receive fixed shares of the creator slice.                                                     |
| **Quantum Burn**  | Reserve that buys the coin (curve or PumpSwap) from the well and burns every token.                                  |
| **Entanglement**  | Reserve distributed to holders by merkle epochs posted by the keeper.                                                |
| **Fusion**        | Reserve that, after graduation, adds liquidity to the canonical PumpSwap pool; LP locked forever (no withdraw path). |
| **Time Dilation** | Locks the launcher's dev-buy tokens with a cliff and linear vesting.                                                 |

Allocation bps (`creator_bps + burn_bps + entangle_bps + fusion_bps`) must equal 10 000 and are
**immutable after registration**. A protocol cut (`config.protocol_bps`, hard cap 1 000) is taken
from each pulse before allocation and paid to `config.treasury`.

## Accounts and PDAs

| Account        | Seeds                                                           | Owner          | Notes                                                                                                                                                      |
| -------------- | --------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config`       | `["qp-config"]`                                                 | program        | `authority`, `treasury`, `keeper`, `protocol_bps: u16`, `max_burn_lamports: u64`, `min_action_interval: i64`, `keeper_grace: i64`, `paused: bool`, `bump`. |
| `Quantum`      | `["quantum", mint]`                                             | program        | Per-coin state (below). Authority of the Time Dilation lock ATA.                                                                                           |
| well           | `["well", mint]`                                                | System, 0 data | pump.fun `creator`. Holds all fee SOL. Signs buy/deposit CPIs. Funded with the rent-exempt minimum at registration.                                        |
| `Epoch`        | `["epoch", mint, index: u32 LE]`                                | program        | Entanglement epoch: `root [u8;32]`, `total`, `claimed`, `leaf_count: u32`, `created_at`, `expires_at`, `payer`, `bitmap: Vec<u8>` (ceil(leaf_count/8)).    |
| lock ATA       | ATA(`Quantum`, mint, Token-2022)                                | Token-2022     | Time Dilation escrow.                                                                                                                                      |
| well token ATA | ATA(well, mint, Token-2022)                                     | Token-2022     | Transient: bought tokens land here and are burned in the same instruction.                                                                                 |
| well WSOL ATA  | ATA(well, WSOL, SPL Token)                                      | SPL Token      | Post-graduation creator fees arrive as WSOL here; pulse closes it into the well.                                                                           |
| well LP ATA    | ATA(well, pool LP mint, Token-2022 or SPL as the pool requires) | —              | Fusion LP; never withdrawn.                                                                                                                                |

`Quantum` fields:

```
mint, launcher: Pubkey
bump, well_bump: u8
created_at: i64
creator_bps, burn_bps, entangle_bps, fusion_bps: u16
split_count: u8, splits: [Split { wallet: Pubkey, bps: u16 }; 4]   // bps of the creator slice, sum ≤ 10 000
burn_reserve, entangle_reserve, entangle_owed, fusion_reserve: u64 // lamport ledgers held in the well
total_collected, total_protocol, total_creator_paid: u64
total_burn_sol, total_burned_tokens, total_claimed, total_fused_sol: u64
epoch_count: u32
locked_amount, released_amount: u64
lock_start, lock_cliff, lock_end: i64
last_burn_at, last_fusion_at: i64
_reserved: [u8; 64]
```

Invariant: `well.lamports ≥ rent_min + burn_reserve + entangle_reserve + entangle_owed + fusion_reserve`.

## Instructions

1. **`initialize_config(treasury, keeper, protocol_bps, max_burn_lamports, min_action_interval, keeper_grace)`** — signer becomes `authority`. Once.
2. **`update_config(...)`** — authority only. Same fields plus `paused` and `new_authority`. `protocol_bps ≤ 1000`.
3. **`register(params)`** — accounts: `launcher` (signer, mut), `mint` (**signer**, must have 0 lamports and 0 data: a fresh mint keypair), `config`, `quantum` (init), `well` (mut, PDA), `system_program`. Validates bps sum = 10 000, `split_count ≤ 4`, split bps sum ≤ 10 000, no default/duplicate split wallets, lock parameters (`cliff ≤ duration`, `duration ≤ 4 years`). Funds the well to the rent-exempt minimum from the launcher. Rejects when `config.paused`.
   A create_v2 + dev-buy transaction alone is ~1 224/1 232 bytes even with a lookup table, so a launch is **three transactions** signed together and sent in order: (A) `register` (launcher + mint keypair sign; the coin does not exist yet, so nothing can be sniped), (B) pump.fun `create_v2` with `creator = well` plus the optional dev buy, (C) the optional `lock`. `register` does not introspect the transaction for `create_v2`: requiring the fresh mint keypair's signature is what binds the config to whoever creates the coin, so nobody can register hooks for someone else's mint. If (B) never lands, the launcher can retry it with the same mint keypair. Clients should still check `bonding_curve.creator == well` before presenting a coin as Quantum. `params.lock` (optional `{cliff_secs, duration_secs}`) commits the Time Dilation terms; `lock` must then use exactly those terms. `last_burn_at` and `last_fusion_at` start at `created_at`, so the keeper grace counts from launch.
4. **`lock(amount, cliff_secs, duration_secs)`** — launcher only, once (`locked_amount == 0`). Transfers `amount` tokens from the launcher's Token-2022 ATA into the lock ATA (created idempotently). Sets `lock_start = now`, `lock_cliff = now + cliff`, `lock_end = now + duration`. Runs after the pump.fun dev buy, in its own transaction (C).
5. **`release()`** — launcher only. Vested = `locked × min(1, (now − start)/(end − start))`, zero before the cliff. Transfers `vested − released`.
6. **`pulse()`** — permissionless. Optional account: well WSOL ATA; if present and initialized it is closed into the well first (native close moves all lamports). Then
   `available = well.lamports − rent_min − (burn_reserve + entangle_reserve + entangle_owed + fusion_reserve)`.
   Errors with `NothingToPulse` below 1 000 000 lamports. `protocol = available × protocol_bps / 10 000` → treasury. `net = available − protocol`. Burn, entangle and fusion reserves increase by their bps of `net`; the creator slice is the remainder (absorbs rounding). Each split receives its bps of the creator slice; the launcher receives the rest. All transfers are system transfers signed by the well. Split wallets are passed in `remaining_accounts` in stored order and must match.
   The keeper transaction places pump.fun `sweep_creator_fee` + `collect_creator_fee` (curve) or PumpSwap `sweep_creator_fee` + `collect_coin_creator_fee` (pool, paying WSOL into the well WSOL ATA) **before** `pulse` in the same transaction; the program itself does not CPI into collection.
7. **`quantum_burn(spend: u64, cpi_data: Vec<u8>)`** — keeper only, or anyone when `now > last_burn_at + keeper_grace`. Also requires `now ≥ last_burn_at + min_action_interval` and `spend ≤ min(burn_reserve, max_burn_lamports)`. Accounts: `quantum`, `config`, `well`, `mint`, `well_token_ata` (init_if_needed), `token_program` (Token-2022), `target_program`, plus `remaining_accounts` for the buy CPI.
   - `target_program` must be pump (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) or PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`).
   - The first 8 bytes of `cpi_data` must be a buy discriminator of that program (computed as `sha256("global:<name>")[..8]` and checked against the IDL in `@pump-fun/pump-sdk`). Allowed pump names: `buy`, `buy_exact_sol_in`, `buy_v2`, `buy_exact_quote_in_v2`, `buy_v3`, `buy_exact_quote_in_v3`. Allowed PumpSwap names: `buy`, `buy_exact_quote_in`, `buy_v2`, `buy_exact_quote_in_v2` (only those that exist in the IDL).
   - `quantum.mint` must appear in the CPI accounts; the well is the only signer PDA passed.
   - PumpSwap route: the program wraps `spend` into the well WSOL ATA (system transfer + `sync_native`), invokes, then closes the WSOL ATA back into the well.
   - `spent = well_before − well_after` (lamports, after unwrapping) must be ≤ `spend`. All tokens in the well token ATA are then burned (Token-2022 `burn`, well signs). `burn_reserve −= spent`, totals updated, `last_burn_at = now`.
8. **`post_entanglement(root, total, leaf_count)`** — keeper only. `total ≤ entangle_reserve`, `1 ≤ leaf_count ≤ 16 384`. Creates `Epoch[epoch_count]`, moves `total` from `entangle_reserve` to `entangle_owed`, `expires_at = now + 30 days`, `epoch_count += 1`.
9. **`claim_entanglement(index, leaf_index, amount, proof)`** — claimant signs. Leaf = `sha256(0x00 ‖ leaf_index u32 LE ‖ claimant ‖ amount u64 LE)`; inner nodes = `sha256(0x01 ‖ min(a,b) ‖ max(a,b))` (sorted pairs). Checks bitmap, sets bit, transfers `amount` from the well. Rejected after expiry.
10. **`close_epoch(index)`** — anyone after `expires_at`. Unclaimed (`total − claimed`) returns from `entangle_owed` to `entangle_reserve`; rent returns to `epoch.payer`.
11. **`fusion(spend: u64, buy_data: Vec<u8>, buy_account_count: u8, deposit_data: Vec<u8>)`** — same gating as burn (shares `min_action_interval` via `last_fusion_at`). PumpSwap only. First CPI buys base with part of the wrapped SOL (`buy_*` discriminator), second CPI is PumpSwap `deposit` (discriminator check) with the well as user; remaining_accounts are split at `buy_account_count`. LP tokens stay in the well LP ATA forever. Leftover base tokens are burned; leftover WSOL is unwrapped. `fusion_reserve −= spent`.

All state-changing instructions emit Anchor events (`Registered`, `Locked`, `Released`, `Pulsed`, `Burned`, `EpochPosted`, `Claimed`, `EpochClosed`, `Fused`) with the mint and amounts.

## Trust model (documented to users)

- pump.fun's admins can reassign a coin's creator (`admin_cto`, `set_creator`), which would redirect future fees away from the well. Quant Pad cannot prevent this.
- The keeper posts Entanglement roots and normally runs burns/fusion; anyone can run them after `keeper_grace`. The keeper cannot withdraw SOL except through these rules.
- pump.fun programs are upgradeable and change frequently; the discriminator allow-list must be kept current.
- This program needs an independent audit before holding meaningful value on mainnet.
- Quantum Burn and Fusion swaps can be sandwiched: whoever runs them (the keeper, or anyone after `keeper_grace`) chooses the slippage inside the CPI data. `max_burn_lamports` and `min_action_interval` bound the exposure per action.

## Implementation notes (program `FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK`)

Where the implementation deviates from or tightens the text above, and why:

- **`initialize_config`** must be signed by the program's upgrade authority (checked against the `ProgramData` account), so the config cannot be front-run between deploy and init.
- **`paused`** blocks `register`, `quantum_burn` and `fusion` (the paths that CPI into pump.fun). Pulses, claims, epoch closes and releases keep working so nobody's funds are frozen.
- **`Quantum`** carries `planned_cliff_secs` / `planned_duration_secs` (taken from `_reserved`, now `reserved: [u8; 48]`) so the lock terms validated at registration are binding on `lock`. `last_burn_at` / `last_fusion_at` start at `created_at`.
- **`pulse`** pays nothing that the recipient cannot hold: a payment that would leave a treasury, split or launcher account below its rent-exempt minimum (or an executable account) is skipped, stays in the well unledgered and is re-pulsed later (`Pulsed.deferred`). Without this, one drained 0-lamport split wallet could block every pulse. Re-pulsed amounts pay the protocol cut again.
- **`quantum_burn`**: the well WSOL ATA, WSOL mint and SPL Token program are optional accounts, required only for the PumpSwap route (keeps the curve-route transaction small; a curve-route CPI may not touch the well's WSOL ATA then). Besides the spec checks the program requires that (a) a PumpSwap CPI's first account is the coin's canonical pool (`["pool", 0u16, pool_authority(mint), mint, WSOL]`), so the well cannot be made to buy from an attacker's pool, and (b) the well token ATA actually received tokens (otherwise a CPI could route the bought tokens elsewhere). `spent` counts the well WSOL ATA's lamports before and after, so creator fees sitting there are never mistaken for burn spend.
- **`fusion`** takes the canonical pool, its LP mint (`["pool_lp_mint", pool]`) and the well LP ATA (created if needed) as named accounts; both CPIs must target that pool, and the well LP ATA must receive LP tokens.
- **`post_entanglement`** also rejects `total == 0`; proofs longer than 24 nodes are rejected.
- Test builds use the `short-expiry` feature (epochs expire after 20 s) so `close_epoch` can be tested on a local validator; production builds keep 30 days.
