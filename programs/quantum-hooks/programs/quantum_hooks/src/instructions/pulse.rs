use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Pulsed;
use crate::state::{Config, Quantum};
use crate::utils::*;

/// Allocates the lamports `harvest` (or anyone) put in the well: protocol cut, module reserves,
/// splits and the launcher, with an owed ledger for recipients that cannot hold their share yet.
/// Permissionless and not blocked by a pause.
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
    pub system_program: Program<'info, System>,
    // remaining_accounts: the Superposition wallets, writable, in stored order.
}

/// What happened to one recipient's due amount (`owed + share`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Settled {
    /// Lamports transferred now (the whole due amount, or nothing).
    pub paid: u64,
    /// What the recipient is owed afterwards.
    pub owed: u64,
    /// Part of `paid` that was owed from earlier pulses.
    pub owed_paid: u64,
    /// Part of `owed` this pulse added.
    pub newly_owed: u64,
}

/// Pure part of `settle`: pay the whole due amount when the recipient can hold it, otherwise owe
/// this pulse's share as well. Never pays part: if the total would leave the recipient below its
/// rent minimum, so would any part of it.
pub fn settlement(owed: u64, share: u64, can_hold: impl Fn(u64) -> bool) -> Result<Settled> {
    let due = add(owed, share)?;
    if due == 0 {
        return Ok(Settled::default());
    }
    Ok(if can_hold(due) {
        Settled {
            paid: due,
            owed: 0,
            owed_paid: owed,
            newly_owed: 0,
        }
    } else {
        Settled {
            paid: 0,
            owed: due,
            owed_paid: 0,
            newly_owed: share,
        }
    })
}

fn settle<'info>(
    well: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    rent: &Rent,
    owed: u64,
    share: u64,
) -> Result<Settled> {
    let settled = settlement(owed, share, |due| can_receive(to, due, rent))?;
    pay_from_well(well, to, system_program, settled.paid, signer)?;
    Ok(settled)
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

    // Superposition wallets must match the stored list exactly.
    let split_count = accounts.quantum.split_count as usize;
    let splits = accounts.quantum.splits;
    require!(
        ctx.remaining_accounts.len() == split_count,
        QuantumError::SplitAccountsMismatch
    );
    for (i, account) in ctx.remaining_accounts.iter().enumerate() {
        require!(
            split_account_ok(
                account.key,
                &splits[i].wallet,
                account.is_writable,
                account.executable
            ),
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
    // Below the floor nothing new is allocated (the dust waits for more fees), but amounts owed
    // from earlier pulses are still paid once their recipients can hold them.
    let allocated = if available >= MIN_PULSE_LAMPORTS {
        available
    } else {
        0
    };
    require!(
        allocated > 0 || quantum.owed_lamports()? > 0,
        QuantumError::NothingToPulse
    );

    let protocol = bps_of(allocated, accounts.config.protocol_bps)?;
    let net = sub(allocated, protocol)?;
    let burn_added = bps_of(net, quantum.burn_bps)?;
    let entangle_added = bps_of(net, quantum.entangle_bps)?;
    let fusion_added = bps_of(net, quantum.fusion_bps)?;
    // The creator slice absorbs rounding.
    let creator_slice = sub(net, add(add(burn_added, entangle_added)?, fusion_added)?)?;

    // A share the recipient cannot hold yet is owed to it (reserved in the well, paid first next
    // time), never allocated again, so nobody can shrink a recipient's share by pulsing while
    // its wallet is empty.
    let mut deferred = 0u64;
    let mut owed_paid = 0u64;
    let treasury = accounts.treasury.to_account_info();
    let settled = settle(
        &well,
        &treasury,
        &system_program,
        signer,
        &rent,
        quantum.protocol_owed,
        protocol,
    )?;
    quantum.protocol_owed = settled.owed;
    let protocol_paid = settled.paid;
    deferred = add(deferred, settled.newly_owed)?;
    owed_paid = add(owed_paid, settled.owed_paid)?;

    let mut splits_paid = 0u64;
    let mut split_total = 0u64;
    let mut resplit = 0u64;
    for (i, account) in ctx.remaining_accounts.iter().enumerate() {
        let share = bps_of(creator_slice, splits[i].bps)?;
        split_total = add(split_total, share)?;
        if !account.is_writable || account.executable {
            // A reserved key or a program (accepted read-only, see `split_account_ok`) can never
            // be paid: owing it would lock the share forever, so it stays in the well unledgered
            // and the next pulse allocates it again. `register` refuses such wallets.
            resplit = add(resplit, share)?;
            continue;
        }
        let settled = settle(
            &well,
            account,
            &system_program,
            signer,
            &rent,
            quantum.split_owed[i],
            share,
        )?;
        quantum.split_owed[i] = settled.owed;
        splits_paid = add(splits_paid, settled.paid)?;
        deferred = add(deferred, settled.newly_owed)?;
        owed_paid = add(owed_paid, settled.owed_paid)?;
    }
    deferred = add(deferred, resplit)?;

    let launcher_share = sub(creator_slice, split_total)?;
    let launcher = accounts.launcher.to_account_info();
    let settled = settle(
        &well,
        &launcher,
        &system_program,
        signer,
        &rent,
        quantum.launcher_owed,
        launcher_share,
    )?;
    quantum.launcher_owed = settled.owed;
    let launcher_paid = settled.paid;
    deferred = add(deferred, settled.newly_owed)?;
    owed_paid = add(owed_paid, settled.owed_paid)?;

    require!(
        allocated > 0 || owed_paid > 0,
        QuantumError::NothingToPulse
    );

    quantum.burn_reserve = add(quantum.burn_reserve, burn_added)?;
    quantum.entangle_reserve = add(quantum.entangle_reserve, entangle_added)?;
    quantum.fusion_reserve = add(quantum.fusion_reserve, fusion_added)?;
    quantum.total_collected = add(quantum.total_collected, sub(allocated, resplit)?)?;
    quantum.total_protocol = add(quantum.total_protocol, protocol_paid)?;
    quantum.total_creator_paid = add(
        quantum.total_creator_paid,
        add(launcher_paid, splits_paid)?,
    )?;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Pulsed {
        mint,
        collected: allocated,
        protocol: protocol_paid,
        launcher_paid,
        splits_paid,
        burn_added,
        entangle_added,
        fusion_added,
        deferred,
        owed_paid,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recipient_that_cannot_hold_its_share_is_owed_it_in_full() {
        let rent_min = 890_880u64;
        // An empty split wallet: its share is owed, not re-split.
        let empty = |due: u64| due >= rent_min;
        let first = settlement(0, 475_000, empty).unwrap();
        assert_eq!(
            first,
            Settled {
                paid: 0,
                owed: 475_000,
                owed_paid: 0,
                newly_owed: 475_000
            }
        );
        // Small pulses keep adding to the debt instead of eroding it.
        let second = settlement(first.owed, 300_000, empty).unwrap();
        assert_eq!(second.paid, 0);
        assert_eq!(second.owed, 775_000);
        // Once the total covers the rent minimum the whole debt is paid at once.
        let third = settlement(second.owed, 200_000, empty).unwrap();
        assert_eq!(
            third,
            Settled {
                paid: 975_000,
                owed: 0,
                owed_paid: 775_000,
                newly_owed: 0
            }
        );
        // A funded wallet is paid immediately; nothing due is a no-op.
        assert_eq!(settlement(0, 5, |_| true).unwrap().paid, 5);
        assert_eq!(settlement(0, 0, |_| false).unwrap(), Settled::default());
        assert!(settlement(u64::MAX, 1, |_| true).is_err());
    }
}
