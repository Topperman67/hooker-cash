use anchor_lang::prelude::*;
use anchor_spl::token::Token;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Pulsed;
use crate::state::{Config, Quantum};
use crate::utils::*;

#[derive(Accounts)]
pub struct Pulse<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [QUANTUM_SEED, quantum.mint.as_ref()], bump = quantum.bump)]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mut, seeds = [WELL_SEED, quantum.mint.as_ref()], bump = quantum.well_bump)]
    pub well: SystemAccount<'info>,
    /// CHECK: must be `config.treasury`; only receives lamports.
    #[account(mut, address = config.treasury @ QuantumError::InvalidConfig)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: must be `quantum.launcher`; only receives lamports.
    #[account(mut, address = quantum.launcher @ QuantumError::NotLauncher)]
    pub launcher: UncheckedAccount<'info>,
    /// CHECK: optional; the well's WSOL ATA. Closed into the well first when it exists.
    #[account(mut, address = well_wsol_address(&well.key()))]
    pub well_wsol_ata: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Program<'info, Token>>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the Superposition wallets, writable, in stored order.
}

pub(crate) fn pulse<'info>(mut ctx: Context<'_, '_, 'info, 'info, Pulse<'info>>) -> Result<()> {
    let accounts = &mut ctx.accounts;
    let mint = accounts.quantum.mint;
    let well_bump = [accounts.quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    let signer = &[well_seeds];
    let well = accounts.well.to_account_info();
    let system_program = accounts.system_program.to_account_info();
    let rent = Rent::get()?;

    // Post-graduation creator fees arrive as WSOL; unwrap them into the well first.
    let mut unwrapped = 0u64;
    if let Some(wsol_ata) = &accounts.well_wsol_ata {
        let wsol_ata = wsol_ata.to_account_info();
        if is_token_account(&wsol_ata) {
            let token_program = accounts
                .token_program
                .as_ref()
                .ok_or(QuantumError::MissingTokenProgram)?
                .to_account_info();
            unwrapped = unwrap_to_well(&well, &wsol_ata, &token_program, signer)?;
        }
    }

    // Superposition wallets must match the stored list exactly.
    let split_count = accounts.quantum.split_count as usize;
    let splits = accounts.quantum.splits;
    require!(
        ctx.remaining_accounts.len() == split_count,
        QuantumError::SplitAccountsMismatch
    );
    for (i, account) in ctx.remaining_accounts.iter().enumerate() {
        require!(
            *account.key == splits[i].wallet && account.is_writable,
            QuantumError::SplitAccountsMismatch
        );
    }

    let quantum = &mut accounts.quantum;
    let rent_min = rent.minimum_balance(0);
    let available = well
        .lamports()
        .checked_sub(rent_min)
        .and_then(|v| v.checked_sub(quantum.reserved_lamports().ok()?))
        .ok_or(QuantumError::WellInvariant)?;
    require!(available >= MIN_PULSE_LAMPORTS, QuantumError::NothingToPulse);

    let protocol = bps_of(available, accounts.config.protocol_bps)?;
    let net = sub(available, protocol)?;
    let burn_added = bps_of(net, quantum.burn_bps)?;
    let entangle_added = bps_of(net, quantum.entangle_bps)?;
    let fusion_added = bps_of(net, quantum.fusion_bps)?;
    // The creator slice absorbs rounding.
    let creator_slice = sub(net, add(add(burn_added, entangle_added)?, fusion_added)?)?;

    let mut deferred = 0u64;
    let mut protocol_paid = 0u64;
    let treasury = accounts.treasury.to_account_info();
    if protocol > 0 {
        if can_receive(&treasury, protocol, &rent) {
            pay_from_well(&well, &treasury, &system_program, protocol, signer)?;
            protocol_paid = protocol;
        } else {
            deferred = add(deferred, protocol)?;
        }
    }

    let mut splits_paid = 0u64;
    let mut split_total = 0u64;
    for (i, account) in ctx.remaining_accounts.iter().enumerate() {
        let share = bps_of(creator_slice, splits[i].bps)?;
        split_total = add(split_total, share)?;
        if share == 0 {
            continue;
        }
        if can_receive(account, share, &rent) {
            pay_from_well(&well, account, &system_program, share, signer)?;
            splits_paid = add(splits_paid, share)?;
        } else {
            deferred = add(deferred, share)?;
        }
    }

    let launcher_share = sub(creator_slice, split_total)?;
    let mut launcher_paid = 0u64;
    let launcher = accounts.launcher.to_account_info();
    if launcher_share > 0 {
        if can_receive(&launcher, launcher_share, &rent) {
            pay_from_well(&well, &launcher, &system_program, launcher_share, signer)?;
            launcher_paid = launcher_share;
        } else {
            deferred = add(deferred, launcher_share)?;
        }
    }

    quantum.burn_reserve = add(quantum.burn_reserve, burn_added)?;
    quantum.entangle_reserve = add(quantum.entangle_reserve, entangle_added)?;
    quantum.fusion_reserve = add(quantum.fusion_reserve, fusion_added)?;
    quantum.total_collected = add(quantum.total_collected, sub(available, deferred)?)?;
    quantum.total_protocol = add(quantum.total_protocol, protocol_paid)?;
    quantum.total_creator_paid = add(
        quantum.total_creator_paid,
        add(launcher_paid, splits_paid)?,
    )?;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Pulsed {
        mint,
        unwrapped,
        collected: available,
        protocol: protocol_paid,
        launcher_paid,
        splits_paid,
        burn_added,
        entangle_added,
        fusion_added,
        deferred,
    });
    Ok(())
}
