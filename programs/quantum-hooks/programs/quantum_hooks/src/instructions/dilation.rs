//! Time Dilation: the launcher's dev-buy tokens locked with a cliff and linear vesting.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::{Locked, Released};
use crate::instructions::register::validate_lock_terms;
use crate::state::Quantum;

#[derive(Accounts)]
pub struct Lock<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(
        mut,
        seeds = [QUANTUM_SEED, mint.key().as_ref()],
        bump = quantum.bump,
        has_one = launcher @ QuantumError::NotLauncher,
        has_one = mint
    )]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = launcher,
        associated_token::token_program = token_program
    )]
    pub launcher_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = launcher,
        associated_token::mint = mint,
        associated_token::authority = quantum,
        associated_token::token_program = token_program
    )]
    pub lock_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Release<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(
        mut,
        seeds = [QUANTUM_SEED, mint.key().as_ref()],
        bump = quantum.bump,
        has_one = launcher @ QuantumError::NotLauncher,
        has_one = mint
    )]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = launcher,
        associated_token::mint = mint,
        associated_token::authority = launcher,
        associated_token::token_program = token_program
    )]
    pub launcher_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = quantum,
        associated_token::token_program = token_program
    )]
    pub lock_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub(crate) fn lock(ctx: Context<Lock>, amount: u64, cliff_secs: i64, duration_secs: i64) -> Result<()> {
    require!(amount > 0, QuantumError::ZeroAmount);
    validate_lock_terms(cliff_secs, duration_secs)?;
    let quantum = &mut ctx.accounts.quantum;
    require!(quantum.locked_amount == 0, QuantumError::AlreadyLocked);
    if quantum.planned_duration_secs > 0 {
        require!(
            quantum.planned_cliff_secs == cliff_secs
                && quantum.planned_duration_secs == duration_secs,
            QuantumError::LockTermsMismatch
        );
    }

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.launcher_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.lock_ata.to_account_info(),
                authority: ctx.accounts.launcher.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let now = Clock::get()?.unix_timestamp;
    quantum.locked_amount = amount;
    quantum.released_amount = 0;
    quantum.lock_start = now;
    quantum.lock_cliff = now
        .checked_add(cliff_secs)
        .ok_or(QuantumError::MathOverflow)?;
    quantum.lock_end = now
        .checked_add(duration_secs)
        .ok_or(QuantumError::MathOverflow)?;

    emit!(Locked {
        mint: quantum.mint,
        launcher: quantum.launcher,
        amount,
        lock_start: quantum.lock_start,
        lock_cliff: quantum.lock_cliff,
        lock_end: quantum.lock_end,
    });
    Ok(())
}

/// `locked × min(1, (now − start) / (end − start))`, zero before the cliff.
pub fn vested_amount(quantum: &Quantum, now: i64) -> Result<u64> {
    if quantum.locked_amount == 0 || now < quantum.lock_cliff {
        return Ok(0);
    }
    if now >= quantum.lock_end {
        return Ok(quantum.locked_amount);
    }
    let elapsed = now.saturating_sub(quantum.lock_start).max(0) as u128;
    let duration = quantum
        .lock_end
        .checked_sub(quantum.lock_start)
        .ok_or(QuantumError::MathOverflow)?;
    if duration <= 0 {
        return Ok(quantum.locked_amount);
    }
    let vested = (quantum.locked_amount as u128)
        .checked_mul(elapsed)
        .ok_or(QuantumError::MathOverflow)?
        / duration as u128;
    u64::try_from(vested.min(quantum.locked_amount as u128))
        .map_err(|_| error!(QuantumError::MathOverflow))
}

pub(crate) fn release(ctx: Context<Release>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let quantum = &ctx.accounts.quantum;
    let vested = vested_amount(quantum, now)?;
    let amount = vested.saturating_sub(quantum.released_amount);
    require!(amount > 0, QuantumError::NothingToRelease);

    let mint_key = quantum.mint;
    let bump = [quantum.bump];
    let seeds: &[&[u8]] = &[QUANTUM_SEED, mint_key.as_ref(), &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.lock_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.launcher_token.to_account_info(),
                authority: ctx.accounts.quantum.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    let quantum = &mut ctx.accounts.quantum;
    quantum.released_amount = quantum
        .released_amount
        .checked_add(amount)
        .ok_or(QuantumError::MathOverflow)?;
    emit!(Released {
        mint: quantum.mint,
        launcher: quantum.launcher,
        amount,
        released_total: quantum.released_amount,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quantum(locked: u64, start: i64, cliff: i64, end: i64) -> Quantum {
        let mut q: Quantum = unsafe { core::mem::zeroed() };
        q.locked_amount = locked;
        q.lock_start = start;
        q.lock_cliff = cliff;
        q.lock_end = end;
        q
    }

    #[test]
    fn vesting_is_zero_before_cliff_then_linear_then_full() {
        let q = quantum(1_000_000, 1000, 1100, 2000);
        assert_eq!(vested_amount(&q, 999).unwrap(), 0);
        assert_eq!(vested_amount(&q, 1099).unwrap(), 0);
        assert_eq!(vested_amount(&q, 1100).unwrap(), 100_000);
        assert_eq!(vested_amount(&q, 1500).unwrap(), 500_000);
        assert_eq!(vested_amount(&q, 2000).unwrap(), 1_000_000);
        assert_eq!(vested_amount(&q, i64::MAX).unwrap(), 1_000_000);
        // Large amounts do not overflow (u128 intermediate).
        let big = quantum(u64::MAX, 0, 0, 4 * 365 * 86_400);
        assert_eq!(vested_amount(&big, 2 * 365 * 86_400).unwrap(), u64::MAX / 2);
    }
}
