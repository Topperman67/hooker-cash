use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::ConfigUpdated;
use crate::program::QuantumHooks;
use crate::state::Config;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// Only the upgrade authority may initialize, so nobody can front-run the deploy.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ QuantumError::NotUpgradeAuthority)]
    pub program: Program<'info, QuantumHooks>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ QuantumError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

/// `update_config` and `set_paused`.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ QuantumError::NotAuthority
    )]
    pub config: Account<'info, Config>,
}

#[allow(clippy::too_many_arguments)]
fn validate(
    treasury: &Pubkey,
    keeper: &Pubkey,
    protocol_bps: u16,
    max_burn_lamports: u64,
    min_action_interval: i64,
    keeper_grace: i64,
    claim_delay: i64,
) -> Result<()> {
    require!(protocol_bps <= MAX_PROTOCOL_BPS, QuantumError::ProtocolBpsTooHigh);
    require!(*treasury != Pubkey::default(), QuantumError::InvalidConfig);
    require!(*keeper != Pubkey::default(), QuantumError::InvalidConfig);
    require!(max_burn_lamports > 0, QuantumError::InvalidConfig);
    require!(min_action_interval >= 0, QuantumError::InvalidConfig);
    require!(keeper_grace >= 0, QuantumError::InvalidConfig);
    require!(
        (0..=MAX_CLAIM_DELAY).contains(&claim_delay),
        QuantumError::InvalidConfig
    );
    Ok(())
}

fn emit_config(config: &Config) {
    emit!(ConfigUpdated {
        authority: config.authority,
        treasury: config.treasury,
        keeper: config.keeper,
        protocol_bps: config.protocol_bps,
        max_burn_lamports: config.max_burn_lamports,
        min_action_interval: config.min_action_interval,
        keeper_grace: config.keeper_grace,
        paused: config.paused,
        claim_delay: config.claim_delay,
        version: config.version,
    });
}

fn bump_version(config: &mut Config) -> Result<()> {
    config.version = config
        .version
        .checked_add(1)
        .ok_or(QuantumError::MathOverflow)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn initialize_config(
    ctx: Context<InitializeConfig>,
    treasury: Pubkey,
    keeper: Pubkey,
    protocol_bps: u16,
    max_burn_lamports: u64,
    min_action_interval: i64,
    keeper_grace: i64,
    claim_delay: i64,
) -> Result<()> {
    validate(
        &treasury,
        &keeper,
        protocol_bps,
        max_burn_lamports,
        min_action_interval,
        keeper_grace,
        claim_delay,
    )?;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = treasury;
    config.keeper = keeper;
    config.protocol_bps = protocol_bps;
    config.max_burn_lamports = max_burn_lamports;
    config.min_action_interval = min_action_interval;
    config.keeper_grace = keeper_grace;
    config.paused = false;
    config.bump = ctx.bumps.config;
    config.claim_delay = claim_delay;
    config.version = 0;
    config.reserved = [0u8; 48];
    emit_config(config);
    Ok(())
}

/// Rewrites every field except `paused`, but only if the config is still at `expected_version`:
/// an update prepared before another change (a pause, a keeper rotation) fails with
/// `ConfigChanged` instead of silently undoing it.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_config(
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
    let config = &mut ctx.accounts.config;
    require!(
        config.version == expected_version,
        QuantumError::ConfigChanged
    );
    validate(
        &treasury,
        &keeper,
        protocol_bps,
        max_burn_lamports,
        min_action_interval,
        keeper_grace,
        claim_delay,
    )?;
    require!(new_authority != Pubkey::default(), QuantumError::InvalidConfig);
    config.authority = new_authority;
    config.treasury = treasury;
    config.keeper = keeper;
    config.protocol_bps = protocol_bps;
    config.max_burn_lamports = max_burn_lamports;
    config.min_action_interval = min_action_interval;
    config.keeper_grace = keeper_grace;
    config.claim_delay = claim_delay;
    bump_version(config)?;
    emit_config(config);
    Ok(())
}

/// The only way to pause or unpause. Takes no expected version, so an emergency pause always lands.
pub(crate) fn set_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.paused = paused;
    bump_version(config)?;
    emit_config(config);
    Ok(())
}
