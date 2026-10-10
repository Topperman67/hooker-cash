//! Quantum Hooks: per-coin routing of a pump.fun coin's creator-fee stream.
//!
//! At launch the coin's pump.fun `creator` is the coin's well, a system-owned PDA of this
//! program. Fees collected into the well are split by immutable per-coin rules (creator share,
//! Superposition splits, Quantum Burn, Entanglement, Fusion) and the launcher's dev buy can be
//! locked with a cliff and linear vesting (Time Dilation). See docs/QUANTUM_HOOKS_SPEC.md.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;

pub use instructions::*;

declare_id!("FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK");

#[program]
pub mod quantum_hooks {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury: Pubkey,
        keeper: Pubkey,
        protocol_bps: u16,
        max_burn_lamports: u64,
        min_action_interval: i64,
        keeper_grace: i64,
        claim_delay: i64,
    ) -> Result<()> {
        instructions::config::initialize_config(
            ctx,
            treasury,
            keeper,
            protocol_bps,
            max_burn_lamports,
            min_action_interval,
            keeper_grace,
            claim_delay,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        expected_version: u64,
        treasury: Pubkey,
        keeper: Pubkey,
        protocol_bps: u16,
        max_burn_lamports: u64,
        min_action_interval: i64,
        keeper_grace: i64,
        claim_delay: i64,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::config::update_config(
            ctx,
            expected_version,
            treasury,
            keeper,
            protocol_bps,
            max_burn_lamports,
            min_action_interval,
            keeper_grace,
            claim_delay,
            new_authority,
        )
    }

    pub fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        instructions::config::set_paused(ctx, paused)
    }

    pub fn register(ctx: Context<Register>, params: RegisterParams) -> Result<()> {
        instructions::register::register(ctx, params)
    }

    pub fn lock(ctx: Context<Lock>, amount: u64, cliff_secs: i64, duration_secs: i64) -> Result<()> {
        instructions::dilation::lock(ctx, amount, cliff_secs, duration_secs)
    }

    pub fn release(ctx: Context<Release>) -> Result<()> {
        instructions::dilation::release(ctx)
    }

    pub fn pulse<'info>(ctx: Context<'_, '_, 'info, 'info, Pulse<'info>>) -> Result<()> {
        instructions::pulse::pulse(ctx)
    }

    pub fn quantum_burn<'info>(
        ctx: Context<'_, '_, 'info, 'info, QuantumBurn<'info>>,
        spend: u64,
        cpi_data: Vec<u8>,
    ) -> Result<()> {
        instructions::burn::quantum_burn(ctx, spend, cpi_data)
    }

    pub fn post_entanglement(
        ctx: Context<PostEntanglement>,
        root: [u8; 32],
        total: u64,
        leaf_count: u32,
    ) -> Result<()> {
        instructions::entanglement::post_entanglement(ctx, root, total, leaf_count)
    }

    pub fn claim_entanglement(
        ctx: Context<ClaimEntanglement>,
        index: u32,
        leaf_index: u32,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::entanglement::claim_entanglement(ctx, index, leaf_index, amount, proof)
    }

    pub fn close_epoch(ctx: Context<CloseEpoch>, index: u32) -> Result<()> {
        instructions::entanglement::close_epoch(ctx, index)
    }

    pub fn cancel_epoch(ctx: Context<CancelEpoch>, index: u32) -> Result<()> {
        instructions::entanglement::cancel_epoch(ctx, index)
    }

    pub fn fusion<'info>(
        ctx: Context<'_, '_, 'info, 'info, Fusion<'info>>,
        spend: u64,
        buy_data: Vec<u8>,
        buy_account_count: u8,
        deposit_data: Vec<u8>,
    ) -> Result<()> {
        instructions::fusion::fusion(ctx, spend, buy_data, buy_account_count, deposit_data)
    }
}
