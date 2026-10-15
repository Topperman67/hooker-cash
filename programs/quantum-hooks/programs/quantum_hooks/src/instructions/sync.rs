//! `sync`: records what this program needs to know about the coin's Meteora venue. Permissionless
//! and read-only towards Meteora; every field it writes is a fact read from Meteora's accounts.
//!
//! - binding: the well became the DBC pool's creator (`bound_at`), and whether that happened
//!   before the pool's first trade (`birth_bound`: the launcher never held a creator fee);
//! - graduation: the curve filled (`graduated_at` = DBC `finish_curve_timestamp`);
//! - migration: the DAMM v2 pool the curve migrated into, the well's position in it and the account
//!   holding that position's NFT. DAMM's own `creator` and position-owner fields can be written by
//!   anyone who creates a pool, so none of them is trusted. Instead: (1) DBC says the pool migrated;
//!   (2) the DAMM config's `pool_creator_authority` is DBC's pool authority, which only DBC can sign
//!   for, so only a DBC migration can create pools under it; (3) the pool address is that config's
//!   PDA for (coin, WSOL); (4) the position is in that pool; (5) its NFT sits in an account owned
//!   by the well (DBC hands the creator's position NFT to `pool.creator`, the well, at migration).
use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Synced;
use crate::meteora::*;
use crate::state::Quantum;
use crate::utils::NATIVE_MINT;

#[derive(Accounts)]
pub struct SyncVenue<'info> {
    #[account(mut, seeds = [QUANTUM_SEED, quantum.mint.as_ref()], bump = quantum.bump)]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(seeds = [WELL_SEED, quantum.mint.as_ref()], bump = quantum.well_bump)]
    pub well: SystemAccount<'info>,
    /// CHECK: the coin's DBC virtual pool (address stored at `register`); read only.
    #[account(address = quantum.dbc_pool @ QuantumError::NotCanonicalPool)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: optional, all four or none: the DAMM v2 config, pool, position and position NFT
    /// account to record once the coin has migrated (verified in the handler).
    pub damm_config: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_config`.
    pub damm_pool: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_config`.
    pub damm_position: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_config`.
    pub damm_nft_account: Option<UncheckedAccount<'info>>,
}

/// The five checks that make a DAMM v2 pool and position the coin's own (see the module docs).
pub fn verify_damm(
    mint: &Pubkey,
    well: &Pubkey,
    dbc: &DbcPool,
    config: &AccountInfo,
    pool: &AccountInfo,
    position: &AccountInfo,
    nft_account: &AccountInfo,
) -> Result<u8> {
    require!(
        dbc.migration_progress == PROGRESS_CREATED_POOL && dbc.is_migrated,
        QuantumError::NotMigrated
    );
    require!(
        read_damm_config_pool_creator_authority(config)? == DBC_POOL_AUTHORITY,
        QuantumError::NotCanonicalDammPool
    );
    require!(
        *pool.key == damm_pool_address(config.key, mint, &NATIVE_MINT),
        QuantumError::NotCanonicalDammPool
    );
    let state = read_damm_pool(pool)?;
    require!(
        state.token_a_mint == *mint && state.token_b_mint == NATIVE_MINT,
        QuantumError::NotCanonicalDammPool
    );
    let pos = read_damm_position(position)?;
    require!(pos.pool == *pool.key, QuantumError::PositionNotWells);
    let (nft_mint, owner, amount) = read_nft_account(nft_account)?;
    require!(
        nft_mint == pos.nft_mint && owner == *well && amount == 1,
        QuantumError::PositionNotWells
    );
    Ok(state.collect_fee_mode)
}

pub(crate) fn sync(ctx: Context<SyncVenue>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let dbc = read_dbc_pool(&accounts.dbc_pool.to_account_info())?;
    let quantum = &accounts.quantum;
    require!(
        dbc.config == quantum.dbc_config && dbc.base_mint == quantum.mint,
        QuantumError::NotCanonicalPool
    );
    let well = accounts.well.key();
    let mint = quantum.mint;

    let mut changed = false;
    let mut collect_fee_mode = 0u8;
    let mut damm: Option<(Pubkey, Pubkey, Pubkey)> = None;
    if quantum.bound_at == 0 {
        // Binding is read from the pool: until the well is the creator there is nothing to record.
        require!(dbc.creator == well, QuantumError::NotBound);
    }
    if quantum.damm_pool == Pubkey::default() {
        match (
            &accounts.damm_config,
            &accounts.damm_pool,
            &accounts.damm_position,
            &accounts.damm_nft_account,
        ) {
            (Some(config), Some(pool), Some(position), Some(nft)) => {
                collect_fee_mode = verify_damm(
                    &mint,
                    &well,
                    &dbc,
                    &config.to_account_info(),
                    &pool.to_account_info(),
                    &position.to_account_info(),
                    &nft.to_account_info(),
                )?;
                damm = Some((pool.key(), position.key(), nft.key()));
            }
            (None, None, None, None) => {}
            _ => return err!(QuantumError::NotCanonicalDammPool),
        }
    }

    let quantum = &mut ctx.accounts.quantum;
    if quantum.bound_at == 0 {
        quantum.bound_at = now;
        // No trade has happened yet, so no creator fee accrued to anyone but the well.
        quantum.birth_bound = !dbc.has_swap;
        changed = true;
    }
    if quantum.graduated_at == 0 && dbc.finish_curve_timestamp > 0 {
        quantum.graduated_at = dbc.finish_curve_timestamp as i64;
        changed = true;
    }
    if let Some((pool, position, nft)) = damm {
        quantum.damm_pool = pool;
        quantum.damm_position = position;
        quantum.damm_nft_account = nft;
        quantum.migrated_at = now;
        changed = true;
    }
    if changed {
        emit!(Synced {
            mint,
            bound_at: quantum.bound_at,
            birth_bound: quantum.birth_bound,
            graduated_at: quantum.graduated_at,
            damm_pool: quantum.damm_pool,
            damm_position: quantum.damm_position,
            collect_fee_mode,
        });
    }
    Ok(())
}
