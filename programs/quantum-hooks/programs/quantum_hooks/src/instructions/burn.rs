//! Quantum Burn: the well buys its own coin on the curve or the canonical PumpSwap pool and burns
//! every token it receives.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Burned;
use crate::state::{Config, Quantum};
use crate::utils::*;

#[derive(Accounts)]
pub struct QuantumBurn<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [QUANTUM_SEED, mint.key().as_ref()],
        bump = quantum.bump,
        has_one = mint
    )]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mut, seeds = [WELL_SEED, mint.key().as_ref()], bump = quantum.well_bump)]
    pub well: SystemAccount<'info>,
    #[account(mut, mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = well,
        associated_token::token_program = token_program
    )]
    pub well_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the well's WSOL ATA (address checked). Required by the PumpSwap route, which wraps
    /// `spend` into it and closes it back into the well afterwards. The curve route omits it
    /// (and `wsol_mint` / `quote_token_program`) to keep the transaction small.
    #[account(mut, address = well_wsol_address(&well.key()))]
    pub well_wsol_ata: Option<UncheckedAccount<'info>>,
    /// CHECK: the WSOL mint.
    #[account(address = NATIVE_MINT)]
    pub wsol_mint: Option<UncheckedAccount<'info>>,
    /// The coin mint's owner: Token-2022 for `create_v2` coins, SPL Token for coins made with
    /// pump.fun's legacy `create` (bound by the `mint::token_program` constraint).
    pub token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Option<Program<'info, Token>>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the Instructions sysvar (address checked); read when the caller is not the keeper.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: pump.fun or PumpSwap (checked in the handler).
    #[account(executable)]
    pub target_program: UncheckedAccount<'info>,
    // remaining_accounts: the buy instruction's accounts, in order.
}

pub(crate) fn quantum_burn<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, QuantumBurn<'info>>,
    spend: u64,
    cpi_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;
    let accounts = &mut ctx.accounts;
    let is_keeper = accounts.caller.key() == accounts.config.keeper;
    let last_burn_at = accounts.quantum.last_burn_at;
    check_action_gate(&accounts.config, is_keeper, last_burn_at, last_burn_at, now)?;
    check_spend(
        &accounts.config,
        is_keeper,
        spend,
        accounts.quantum.burn_reserve,
    )?;
    if !is_keeper {
        // The public fallback: a smaller cap (above) and no trading around it in its transaction.
        check_public_transaction(&accounts.instructions_sysvar.to_account_info())?;
    }

    let target = accounts.target_program.key();
    let pool_route = if target == PUMP_PROGRAM_ID {
        check_discriminator(&cpi_data, &PUMP_BUY_DISCRIMINATORS)?;
        false
    } else if target == PUMP_AMM_PROGRAM_ID {
        check_discriminator(&cpi_data, &PUMP_AMM_BUY_DISCRIMINATORS)?;
        true
    } else {
        return err!(QuantumError::InvalidTargetProgram);
    };

    let mint = accounts.mint.key();
    if pool_route {
        let pool = ctx
            .remaining_accounts
            .first()
            .ok_or(QuantumError::NotCanonicalPool)?;
        require!(*pool.key == canonical_pool(&mint), QuantumError::NotCanonicalPool);
    }

    let well_bump = [accounts.quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    let signer = &[well_seeds];
    let well = accounts.well.to_account_info();
    // (well WSOL ATA, SPL Token program) when supplied; mandatory for the pool route.
    let wsol = match (&accounts.well_wsol_ata, &accounts.quote_token_program) {
        (Some(ata), Some(program)) => Some((ata.to_account_info(), program.to_account_info())),
        _ => None,
    };
    if pool_route {
        require!(
            wsol.is_some() && accounts.wsol_mint.is_some(),
            QuantumError::MissingTokenProgram
        );
    } else if wsol.is_none() {
        // Lamports the CPI could park in the well's WSOL ATA must be counted, so a CPI that
        // touches it needs the ATA supplied (and unwrapped) as a named account.
        let wsol_ata = well_wsol_address(&well.key());
        require!(
            !ctx.remaining_accounts.iter().any(|a| *a.key == wsol_ata),
            QuantumError::MissingTokenProgram
        );
    }

    let lamports_before = match &wsol {
        Some((ata, _)) => well_total(&well, ata)?,
        None => well.lamports(),
    };
    let tokens_before = accounts.well_token_ata.amount;

    if pool_route {
        let (ata, quote_token_program) = wsol.as_ref().ok_or(QuantumError::MissingTokenProgram)?;
        let wsol_mint = accounts
            .wsol_mint
            .as_ref()
            .ok_or(QuantumError::MissingTokenProgram)?
            .to_account_info();
        wrap_from_well(
            &well,
            ata,
            &wsol_mint,
            quote_token_program,
            &accounts.associated_token_program.to_account_info(),
            &accounts.system_program.to_account_info(),
            spend,
            signer,
        )?;
    }

    invoke_as_well(
        &accounts.target_program.to_account_info(),
        ctx.remaining_accounts,
        cpi_data,
        &well.key(),
        &mint,
        signer,
    )?;

    if let Some((ata, quote_token_program)) = &wsol {
        unwrap_to_well(&well, ata, quote_token_program, signer)?;
    }

    accounts.well_token_ata.reload()?;
    let tokens_after = accounts.well_token_ata.amount;
    let bought = tokens_after.saturating_sub(tokens_before);
    require!(bought > 0, QuantumError::NothingBought);

    token_interface::burn(
        CpiContext::new_with_signer(
            accounts.token_program.to_account_info(),
            Burn {
                mint: accounts.mint.to_account_info(),
                from: accounts.well_token_ata.to_account_info(),
                authority: well.clone(),
            },
            signer,
        ),
        tokens_after,
    )?;

    let lamports_after = well.lamports();
    let spent = lamports_before.saturating_sub(lamports_after);
    require!(spent <= spend, QuantumError::Overspent);

    let quantum = &mut accounts.quantum;
    quantum.burn_reserve = sub(quantum.burn_reserve, spent)?;
    quantum.total_burn_sol = add(quantum.total_burn_sol, spent)?;
    quantum.total_burned_tokens = add(quantum.total_burned_tokens, tokens_after)?;
    quantum.last_burn_at = now;
    // A buy through the canonical pool proves the coin migrated.
    note_graduation(quantum, pool_route, now);
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Burned {
        mint,
        caller: accounts.caller.key(),
        venue: pool_route as u8,
        spent,
        tokens_burned: tokens_after,
    });
    Ok(())
}
