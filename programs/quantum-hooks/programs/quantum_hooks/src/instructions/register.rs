use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Registered;
use crate::state::{Config, Quantum, Split};
use crate::utils::is_reserved_account_key;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct LockTerms {
    pub cliff_secs: i64,
    pub duration_secs: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterParams {
    pub creator_bps: u16,
    pub burn_bps: u16,
    pub entangle_bps: u16,
    pub fusion_bps: u16,
    pub splits: Vec<Split>,
    /// Time Dilation terms the later `lock` must use; `None` when no lock is planned.
    pub lock: Option<LockTerms>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    /// The fresh mint keypair pump.fun `create_v2` initialises right after this instruction.
    /// Its signature binds the hooks to whoever creates the coin.
    #[account(constraint = mint.lamports() == 0 && mint.data_is_empty() @ QuantumError::MintNotFresh)]
    pub mint: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = launcher,
        space = 8 + Quantum::INIT_SPACE,
        seeds = [QUANTUM_SEED, mint.key().as_ref()],
        bump
    )]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mut, seeds = [WELL_SEED, mint.key().as_ref()], bump)]
    pub well: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn validate_lock_terms(cliff_secs: i64, duration_secs: i64) -> Result<()> {
    require!(
        duration_secs > 0
            && duration_secs <= MAX_LOCK_DURATION
            && cliff_secs >= 0
            && cliff_secs <= duration_secs,
        QuantumError::InvalidLockTerms
    );
    Ok(())
}

/// A Superposition wallet must be able to receive lamports in `pulse`, which needs it writable. The
/// runtime always demotes reserved keys (sysvars, builtin and loader programs) to read-only, and
/// programs (this one, pump.fun, PumpSwap) are executable and can never be paid.
pub fn valid_split_wallet(wallet: &Pubkey, well: &Pubkey, quantum: &Pubkey) -> bool {
    *wallet != Pubkey::default()
        && wallet != well
        && wallet != quantum
        && *wallet != crate::ID
        && *wallet != PUMP_PROGRAM_ID
        && *wallet != PUMP_AMM_PROGRAM_ID
        && !is_reserved_account_key(wallet)
}

pub(crate) fn register(ctx: Context<Register>, params: RegisterParams) -> Result<()> {
    require!(!ctx.accounts.config.paused, QuantumError::Paused);

    let total_bps = params.creator_bps as u32
        + params.burn_bps as u32
        + params.entangle_bps as u32
        + params.fusion_bps as u32;
    require!(total_bps == BPS_DENOMINATOR as u32, QuantumError::InvalidAllocation);

    require!(params.splits.len() <= MAX_SPLITS, QuantumError::TooManySplits);
    let well_key = ctx.accounts.well.key();
    let quantum_key = ctx.accounts.quantum.key();
    let mut split_sum: u32 = 0;
    let mut splits = [Split::default(); MAX_SPLITS];
    for (i, split) in params.splits.iter().enumerate() {
        require!(
            split.bps >= 1 && split.bps as u64 <= BPS_DENOMINATOR,
            QuantumError::InvalidSplitBps
        );
        require!(
            valid_split_wallet(&split.wallet, &well_key, &quantum_key),
            QuantumError::InvalidSplitWallet
        );
        require!(
            !params.splits[..i].iter().any(|s| s.wallet == split.wallet),
            QuantumError::InvalidSplitWallet
        );
        split_sum += split.bps as u32;
        splits[i] = *split;
    }
    require!(split_sum as u64 <= BPS_DENOMINATOR, QuantumError::InvalidSplitBps);

    let (planned_cliff_secs, planned_duration_secs) = match params.lock {
        Some(terms) => {
            validate_lock_terms(terms.cliff_secs, terms.duration_secs)?;
            (terms.cliff_secs, terms.duration_secs)
        }
        None => (0, 0),
    };

    // Fund the well to the rent-exempt minimum so it can receive any amount of fees.
    let rent_min = Rent::get()?.minimum_balance(0);
    let well_funded = rent_min.saturating_sub(ctx.accounts.well.lamports());
    if well_funded > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.launcher.to_account_info(),
                    to: ctx.accounts.well.to_account_info(),
                },
            ),
            well_funded,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;
    let quantum = &mut ctx.accounts.quantum;
    quantum.mint = ctx.accounts.mint.key();
    quantum.launcher = ctx.accounts.launcher.key();
    quantum.bump = ctx.bumps.quantum;
    quantum.well_bump = ctx.bumps.well;
    quantum.created_at = now;
    quantum.creator_bps = params.creator_bps;
    quantum.burn_bps = params.burn_bps;
    quantum.entangle_bps = params.entangle_bps;
    quantum.fusion_bps = params.fusion_bps;
    quantum.split_count = params.splits.len() as u8;
    quantum.splits = splits;
    // The keeper grace and the action interval count from launch, not from the epoch.
    quantum.last_burn_at = now;
    quantum.last_fusion_at = now;
    quantum.planned_cliff_secs = planned_cliff_secs;
    quantum.planned_duration_secs = planned_duration_secs;

    emit!(Registered {
        mint: quantum.mint,
        launcher: quantum.launcher,
        well: well_key,
        creator_bps: quantum.creator_bps,
        burn_bps: quantum.burn_bps,
        entangle_bps: quantum.entangle_bps,
        fusion_bps: quantum.fusion_bps,
        split_count: quantum.split_count,
        lock_cliff_secs: planned_cliff_secs,
        lock_duration_secs: planned_duration_secs,
        well_funded,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program as sp;

    #[test]
    fn split_wallets_reject_keys_that_could_never_be_paid() {
        let (well, quantum) = (Pubkey::new_unique(), Pubkey::new_unique());
        assert!(valid_split_wallet(&Pubkey::new_unique(), &well, &quantum));
        for bad in [
            Pubkey::default(),
            well,
            quantum,
            crate::ID,
            PUMP_PROGRAM_ID,
            PUMP_AMM_PROGRAM_ID,
            sp::sysvar::rent::ID,
            sp::sysvar::clock::ID,
            sp::vote::program::ID,
            sp::stake::program::ID,
            sp::bpf_loader_upgradeable::ID,
            sp::pubkey!("ComputeBudget111111111111111111111111111111"),
            sp::pubkey!("AddressLookupTab1e1111111111111111111111111"),
            sp::pubkey!("NativeLoader1111111111111111111111111111111"),
        ] {
            assert!(!valid_split_wallet(&bad, &well, &quantum), "{bad} accepted");
        }
    }
}
