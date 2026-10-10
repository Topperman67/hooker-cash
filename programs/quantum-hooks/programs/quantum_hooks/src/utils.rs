use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{
    get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT,
};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::system_program;
use anchor_spl::associated_token::{self, get_associated_token_address};
use anchor_spl::token::{self, spl_token};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::state::{Config, Quantum};

pub const NATIVE_MINT: Pubkey = spl_token::native_mint::ID;

pub fn bps_of(amount: u64, bps: u16) -> Result<u64> {
    let value = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(QuantumError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    u64::try_from(value).map_err(|_| error!(QuantumError::MathOverflow))
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(QuantumError::MathOverflow))
}

pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| error!(QuantumError::MathOverflow))
}

pub fn well_wsol_address(well: &Pubkey) -> Pubkey {
    get_associated_token_address(well, &NATIVE_MINT)
}

/// The canonical PumpSwap pool pump.fun migrates `mint` into (index 0, quoted in WSOL).
pub fn canonical_pool(mint: &Pubkey) -> Pubkey {
    let (pool_authority, _) =
        Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID);
    let (pool, _) = Pubkey::find_program_address(
        &[
            b"pool",
            &0u16.to_le_bytes(),
            pool_authority.as_ref(),
            mint.as_ref(),
            NATIVE_MINT.as_ref(),
        ],
        &PUMP_AMM_PROGRAM_ID,
    );
    pool
}

pub fn lp_mint_address(pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &PUMP_AMM_PROGRAM_ID).0
}

/// Whether crediting `amount` lamports leaves `account` able to exist (rent exempt, not executable).
pub fn can_receive(account: &AccountInfo, amount: u64, rent: &Rent) -> bool {
    !account.executable
        && account.lamports().saturating_add(amount) >= rent.minimum_balance(account.data_len())
}

/// A key the runtime always demotes to read-only (see `RESERVED_ACCOUNT_KEYS`).
pub fn is_reserved_account_key(key: &Pubkey) -> bool {
    RESERVED_ACCOUNT_KEYS.contains(key)
}

/// `pulse` takes the stored Superposition wallets in order, writable. A wallet the runtime always
/// demotes to read-only (a reserved sysvar/builtin key, or an executable program the transaction
/// may invoke) is accepted read-only: it can never be paid, so its share is deferred instead of
/// blocking every pulse. An ordinary wallet passed read-only is rejected, so a permissionless
/// caller cannot push a real split's share into deferral.
pub fn split_account_ok(key: &Pubkey, wallet: &Pubkey, is_writable: bool, executable: bool) -> bool {
    key == wallet && (is_writable || executable || is_reserved_account_key(key))
}

/// Size of an SPL Token account (the well's WSOL ATA).
pub const TOKEN_ACCOUNT_LEN: usize = token::TokenAccount::LEN;

/// Splits the lamports of a closed WSOL ATA into (rent refund, fees). The rent goes back to whoever
/// paid to create the ATA; only the wrapped SOL above it is creator fees.
pub fn split_closed_ata(closed: u64, ata_rent: u64) -> (u64, u64) {
    let refund = closed.min(ata_rent);
    (refund, closed - refund)
}

/// System transfer out of the well (a system-owned PDA with no data).
pub fn pay_from_well<'info>(
    well: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            system_program::Transfer {
                from: well.clone(),
                to: to.clone(),
            },
            signer,
        ),
        amount,
    )
}

pub fn assert_well_invariant(well: &AccountInfo, quantum: &Quantum, rent: &Rent) -> Result<()> {
    let needed = add(rent.minimum_balance(0), quantum.reserved_lamports()?)?;
    require!(well.lamports() >= needed, QuantumError::WellInvariant);
    Ok(())
}

/// Keeper gating shared by `quantum_burn` and `fusion`. The keeper may act every
/// `min_action_interval` after `last_at`; anyone else only once `keeper_grace` has passed since
/// `grace_from` (the last action, or for Fusion the later of the last fusion and graduation).
pub fn check_action_gate(
    config: &Config,
    is_keeper: bool,
    last_at: i64,
    grace_from: i64,
    now: i64,
) -> Result<()> {
    require!(!config.paused, QuantumError::Paused);
    if !is_keeper {
        let open_at = grace_from
            .checked_add(config.keeper_grace)
            .ok_or(QuantumError::MathOverflow)?;
        require!(now > open_at, QuantumError::KeeperOnly);
    }
    let next = last_at
        .checked_add(config.min_action_interval)
        .ok_or(QuantumError::MathOverflow)?;
    require!(now >= next, QuantumError::TooSoon);
    Ok(())
}

/// Most a burn or fusion may spend: `max_burn_lamports` for the keeper, a tenth of it for anyone
/// else (a public run picks its own price limits, so it gets less to lose).
pub fn spend_cap(config: &Config, is_keeper: bool) -> u64 {
    if is_keeper {
        config.max_burn_lamports
    } else {
        config.max_burn_lamports / PUBLIC_SPEND_DIVISOR
    }
}

pub fn check_spend(config: &Config, is_keeper: bool, spend: u64, reserve: u64) -> Result<()> {
    require!(spend > 0, QuantumError::ZeroAmount);
    require!(
        spend <= reserve && spend <= spend_cap(config, is_keeper),
        QuantumError::SpendTooHigh
    );
    Ok(())
}

/// A top-level instruction that may share a transaction with a public burn or fusion: this
/// program, compute budget, system, token and associated-token instructions, and pump.fun /
/// PumpSwap only to create a volume accumulator. Nothing that can trade.
pub fn public_companion_ok(program_id: &Pubkey, data: &[u8]) -> bool {
    if *program_id == crate::ID || PUBLIC_COMPANION_PROGRAMS.contains(program_id) {
        return true;
    }
    (*program_id == PUMP_PROGRAM_ID || *program_id == PUMP_AMM_PROGRAM_ID)
        && data.len() >= 8
        && data[..8] == INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR
}

/// For a public (non-keeper) burn or fusion: the instruction must be invoked at the top level (no
/// wrapper program around it) and every other top-level instruction of the transaction must pass
/// `public_companion_ok`, so nobody can buy before it and sell after it in the same transaction.
pub fn check_public_transaction(instructions_sysvar: &AccountInfo) -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        QuantumError::PublicTransactionNotAllowed
    );
    let count = {
        let data = instructions_sysvar.try_borrow_data()?;
        require!(data.len() >= 2, QuantumError::PublicTransactionNotAllowed);
        u16::from_le_bytes([data[0], data[1]]) as usize
    };
    let current = load_current_index_checked(instructions_sysvar)? as usize;
    for index in 0..count {
        if index == current {
            continue; // this instruction, at the top level (checked above)
        }
        let ix = load_instruction_at_checked(index, instructions_sysvar)?;
        require!(
            public_companion_ok(&ix.program_id, &ix.data),
            QuantumError::PublicTransactionNotAllowed
        );
    }
    Ok(())
}

/// The coin's pump.fun bonding curve.
pub fn bonding_curve_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID).0
}

/// Whether `curve` (an account at `bonding_curve_address`) is a completed pump.fun curve.
pub fn curve_complete(curve: &AccountInfo) -> bool {
    curve.owner == &PUMP_PROGRAM_ID
        && curve
            .try_borrow_data()
            .map(|d| d.len() > CURVE_COMPLETE_OFFSET && d[CURVE_COMPLETE_OFFSET] == 1)
            .unwrap_or(false)
}

/// Whether `pool` (an account at `canonical_pool`) exists, i.e. the coin migrated to PumpSwap.
pub fn pool_exists(pool: &AccountInfo) -> bool {
    pool.owner == &PUMP_AMM_PROGRAM_ID && !pool.data_is_empty()
}

/// Records the first time the coin is seen graduated (`graduated_at` stays at that time).
pub fn note_graduation(quantum: &mut Quantum, graduated: bool, now: i64) {
    if graduated && quantum.graduated_at == 0 {
        quantum.graduated_at = now;
    }
}

pub fn check_discriminator(data: &[u8], allowed: &[[u8; 8]]) -> Result<()> {
    require!(data.len() >= 8, QuantumError::DisallowedInstruction);
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&data[..8]);
    require!(allowed.contains(&disc), QuantumError::DisallowedInstruction);
    Ok(())
}

pub fn is_token_account(info: &AccountInfo) -> bool {
    info.owner == &token::ID && !info.data_is_empty()
}

/// Invokes `program` with `accounts` (passed through from remaining accounts) and `data`, with
/// the well as the only PDA signer. Every other signer flag is dropped.
pub fn invoke_as_well<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: Vec<u8>,
    well: &Pubkey,
    mint: &Pubkey,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let mut metas = Vec::with_capacity(accounts.len());
    let mut has_mint = false;
    let mut has_well = false;
    for account in accounts {
        let is_well = account.key == well;
        has_well |= is_well;
        has_mint |= account.key == mint;
        metas.push(AccountMeta {
            pubkey: *account.key,
            is_signer: is_well,
            is_writable: account.is_writable,
        });
    }
    require!(has_mint, QuantumError::MintNotInCpi);
    require!(has_well, QuantumError::WellNotInCpi);
    let instruction = Instruction {
        program_id: *program.key,
        accounts: metas,
        data,
    };
    let mut infos = Vec::with_capacity(accounts.len() + 1);
    infos.extend_from_slice(accounts);
    infos.push(program.clone());
    invoke_signed(&instruction, &infos, signer)?;
    Ok(())
}

/// Funds the well's WSOL ATA with `amount` lamports (creating it, well-paid, when missing) and
/// syncs it.
#[allow(clippy::too_many_arguments)]
pub fn wrap_from_well<'info>(
    well: &AccountInfo<'info>,
    wsol_ata: &AccountInfo<'info>,
    wsol_mint: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if !is_token_account(wsol_ata) {
        associated_token::create_idempotent(CpiContext::new_with_signer(
            associated_token_program.clone(),
            associated_token::Create {
                payer: well.clone(),
                associated_token: wsol_ata.clone(),
                authority: well.clone(),
                mint: wsol_mint.clone(),
                system_program: system_program.clone(),
                token_program: token_program.clone(),
            },
            signer,
        ))?;
    }
    pay_from_well(well, wsol_ata, system_program, amount, signer)?;
    token::sync_native(CpiContext::new(
        token_program.clone(),
        token::SyncNative {
            account: wsol_ata.clone(),
        },
    ))
}

/// Closes the well's WSOL ATA (if it exists) into the well, unwrapping everything it holds.
pub fn unwrap_to_well<'info>(
    well: &AccountInfo<'info>,
    wsol_ata: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<u64> {
    if !is_token_account(wsol_ata) {
        return Ok(0);
    }
    let lamports = wsol_ata.lamports();
    token::close_account(CpiContext::new_with_signer(
        token_program.clone(),
        token::CloseAccount {
            account: wsol_ata.clone(),
            destination: well.clone(),
            authority: well.clone(),
        },
        signer,
    ))?;
    Ok(lamports)
}

/// Lamports the well controls right now: its own balance plus its WSOL ATA, if any.
pub fn well_total(well: &AccountInfo, wsol_ata: &AccountInfo) -> Result<u64> {
    let wsol = if is_token_account(wsol_ata) {
        wsol_ata.lamports()
    } else {
        0
    };
    add(well.lamports(), wsol)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bps_math_floors_and_never_overflows() {
        assert_eq!(bps_of(70_455_311, 500).unwrap(), 3_522_765);
        assert_eq!(bps_of(u64::MAX, 10_000).unwrap(), u64::MAX);
        assert_eq!(bps_of(9_999, 1).unwrap(), 0);
        assert!(sub(1, 2).is_err());
        assert!(add(u64::MAX, 1).is_err());
    }

    #[test]
    fn closed_wsol_ata_refunds_rent_and_counts_only_wsol_as_fees() {
        let rent = Rent::default().minimum_balance(TOKEN_ACCOUNT_LEN);
        assert_eq!(TOKEN_ACCOUNT_LEN, 165);
        assert_eq!(rent, 2_039_280);
        // Measured on a local validator before the fix: 93 874 lamports of fees were pulsed as
        // 2 133 154 because the ATA rent was counted too.
        assert_eq!(split_closed_ata(2_133_154, rent), (rent, 93_874));
        assert_eq!(split_closed_ata(rent, rent), (rent, 0));
        assert_eq!(split_closed_ata(1_000, rent), (1_000, 0));
        assert_eq!(split_closed_ata(0, rent), (0, 0));
    }

    #[test]
    fn split_accounts_must_be_writable_unless_the_runtime_forbids_it() {
        let wallet = Pubkey::new_unique();
        assert!(split_account_ok(&wallet, &wallet, true, false));
        // A real wallet passed read-only would let a pulse caller defer its share.
        assert!(!split_account_ok(&wallet, &wallet, false, false));
        assert!(!split_account_ok(&Pubkey::new_unique(), &wallet, true, false));
        // Reserved keys are always demoted by the runtime; executable accounts can never be paid.
        let rent_sysvar = anchor_lang::solana_program::sysvar::rent::ID;
        assert!(split_account_ok(&rent_sysvar, &rent_sysvar, false, false));
        let vote = anchor_lang::solana_program::vote::program::ID;
        assert!(split_account_ok(&vote, &vote, false, true));
        assert!(split_account_ok(&PUMP_PROGRAM_ID, &PUMP_PROGRAM_ID, false, true));
        assert!(!split_account_ok(&rent_sysvar, &wallet, false, false));
        assert!(is_reserved_account_key(&rent_sysvar));
        assert!(!is_reserved_account_key(&wallet));
    }

    fn config() -> Config {
        Config {
            authority: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            keeper: Pubkey::new_unique(),
            protocol_bps: 0,
            max_burn_lamports: 1_000_000_000,
            min_action_interval: 3_600,
            keeper_grace: 86_400,
            paused: false,
            bump: 255,
            claim_delay: 21_600,
            version: 0,
            reserved: [0; 48],
        }
    }

    #[test]
    fn public_fusion_grace_counts_from_graduation() {
        let config = config();
        let launch = 1_000_000;
        let graduated = launch + 5 * 86_400;
        let grace_from = launch.max(graduated);
        // A coin that graduates days after launch: the public gate stays shut for a full grace
        // after graduation, although the last fusion (= launch) is long past.
        let soon = graduated + 60;
        assert!(check_action_gate(&config, false, launch, launch, soon).is_ok());
        assert!(check_action_gate(&config, false, launch, grace_from, soon).is_err());
        assert!(check_action_gate(&config, true, launch, grace_from, soon).is_ok());
        let later = graduated + 86_401;
        assert!(check_action_gate(&config, false, launch, grace_from, later).is_ok());
        // The keeper still waits min_action_interval after its last action.
        assert!(check_action_gate(&config, true, later - 10, grace_from, later).is_err());
        let mut paused = config;
        paused.paused = true;
        assert!(check_action_gate(&paused, true, launch, launch, later).is_err());
    }

    #[test]
    fn public_runs_spend_a_tenth_of_the_cap() {
        let config = config();
        assert_eq!(spend_cap(&config, true), 1_000_000_000);
        assert_eq!(spend_cap(&config, false), 100_000_000);
        assert!(check_spend(&config, false, 100_000_000, u64::MAX).is_ok());
        assert!(check_spend(&config, false, 100_000_001, u64::MAX).is_err());
        assert!(check_spend(&config, true, 100_000_001, u64::MAX).is_ok());
        assert!(check_spend(&config, true, 5, 4).is_err());
        assert!(check_spend(&config, true, 0, 4).is_err());
    }

    #[test]
    fn public_runs_share_a_transaction_only_with_non_trading_programs() {
        use anchor_lang::solana_program as sp;
        let volume = INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR.to_vec();
        for ok in [crate::ID, PUBLIC_COMPANION_PROGRAMS[0], sp::system_program::ID] {
            assert!(public_companion_ok(&ok, &[]));
        }
        assert!(public_companion_ok(&PUMP_PROGRAM_ID, &volume));
        assert!(public_companion_ok(&PUMP_AMM_PROGRAM_ID, &volume));
        for buy in PUMP_BUY_DISCRIMINATORS {
            assert!(!public_companion_ok(&PUMP_PROGRAM_ID, &buy));
        }
        assert!(!public_companion_ok(&PUMP_AMM_PROGRAM_ID, &PUMP_AMM_DEPOSIT_DISCRIMINATOR));
        assert!(!public_companion_ok(&PUMP_PROGRAM_ID, &volume[..7]));
        let fees = sp::pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
        assert!(!public_companion_ok(&fees, &volume));
        assert!(!public_companion_ok(&Pubkey::new_unique(), &[]));
    }

    #[test]
    fn graduation_is_seen_from_a_complete_curve_or_an_existing_pool() {
        let key = Pubkey::new_unique();
        static PUMP: Pubkey = PUMP_PROGRAM_ID;
        static AMM: Pubkey = PUMP_AMM_PROGRAM_ID;
        let leak = |len: usize, complete: bool| {
            let mut d = vec![0u8; len];
            if complete && len > CURVE_COMPLETE_OFFSET {
                d[CURVE_COMPLETE_OFFSET] = 1;
            }
            (Box::leak(d.into_boxed_slice()), Box::leak(Box::new(1_000_000u64)))
        };
        let (d, l) = leak(150, true);
        assert!(curve_complete(&AccountInfo::new(&key, false, false, l, d, &PUMP, false, 0)));
        let (d, l) = leak(150, false);
        assert!(!curve_complete(&AccountInfo::new(&key, false, false, l, d, &PUMP, false, 0)));
        let (d, l) = leak(150, true);
        assert!(!curve_complete(&AccountInfo::new(&key, false, false, l, d, &AMM, false, 0)));
        let (d, l) = leak(10, true);
        assert!(!curve_complete(&AccountInfo::new(&key, false, false, l, d, &PUMP, false, 0)));
        let (d, l) = leak(300, false);
        assert!(pool_exists(&AccountInfo::new(&key, false, false, l, d, &AMM, false, 0)));
        let (d, l) = leak(0, false);
        assert!(!pool_exists(&AccountInfo::new(&key, false, false, l, d, &AMM, false, 0)));
        let (d, l) = leak(300, false);
        assert!(!pool_exists(&AccountInfo::new(&key, false, false, l, d, &PUMP, false, 0)));
    }
}
