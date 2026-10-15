//! Quantum Burn: the well buys its own coin on its Meteora venue and burns every token it holds.
//! Before migration the venue is the coin's DBC pool (a partial-fill buy, so a burn near the
//! threshold fills up to it instead of failing); after migration it is the DAMM v2 pool `sync`
//! recorded. Between the curve filling and migration there is nowhere to buy, and the burn fails.
//! The program builds the swap itself and pins every account that matters, so a burn can only ever
//! buy from the coin's own pool.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Burned;
use crate::meteora::*;
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
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = well,
        associated_token::token_program = token_program
    )]
    pub well_token_ata: Box<Account<'info, TokenAccount>>,
    /// CHECK: the well's WSOL ATA (address checked): `spend` is wrapped into it for the buy and it
    /// is closed back into the well afterwards (the well pays and recovers its rent).
    #[account(mut, address = well_wsol_address(&well.key()))]
    pub well_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: the WSOL mint.
    #[account(address = NATIVE_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the Instructions sysvar (address checked); read when the caller is not the keeper.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// CHECK: DBC before migration, DAMM v2 after (checked against the coin's state).
    #[account(executable)]
    pub venue_program: UncheckedAccount<'info>,
    /// CHECK: that program's pool authority (checked in the handler).
    pub venue_pool_authority: UncheckedAccount<'info>,
    /// CHECK: that program's event authority (checked in the handler).
    pub venue_event_authority: UncheckedAccount<'info>,
    /// CHECK: `quantum.dbc_pool` or `quantum.damm_pool` (checked in the handler).
    #[account(mut)]
    pub venue_pool: UncheckedAccount<'info>,
    /// CHECK: the pool's coin vault (checked against the pool).
    #[account(mut)]
    pub venue_base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's WSOL vault (checked against the pool).
    #[account(mut)]
    pub venue_quote_vault: UncheckedAccount<'info>,
    /// CHECK: `quantum.dbc_config`; required on DBC (address checked in the handler).
    pub dbc_config: Option<UncheckedAccount<'info>>,
}

pub(crate) fn quantum_burn(mut ctx: Context<QuantumBurn>, spend: u64, min_out: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;
    let accounts = &ctx.accounts;
    let is_keeper = accounts.caller.key() == accounts.config.keeper;
    let last_burn_at = accounts.quantum.last_burn_at;
    check_action_gate(&accounts.config, is_keeper, last_burn_at, last_burn_at, now)?;
    check_spend(&accounts.config, is_keeper, spend, accounts.quantum.burn_reserve)?;
    if !is_keeper {
        // The public fallback: a smaller cap (above) and no trading around it in its transaction.
        check_public_transaction(&accounts.instructions_sysvar.to_account_info())?;
    }

    let mint = accounts.mint.key();
    let well_bump = [accounts.quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    let signer = &[well_seeds];
    let well = accounts.well.to_account_info();
    let wsol_ata = accounts.well_wsol_ata.to_account_info();
    let base_ata = accounts.well_token_ata.to_account_info();
    let token_program = accounts.token_program.to_account_info();
    let mint_info = accounts.mint.to_account_info();
    let wsol_mint = accounts.wsol_mint.to_account_info();
    let program = accounts.venue_program.to_account_info();
    let pool_authority = accounts.venue_pool_authority.to_account_info();
    let event_authority = accounts.venue_event_authority.to_account_info();
    let pool = accounts.venue_pool.to_account_info();
    let base_vault = accounts.venue_base_vault.to_account_info();
    let quote_vault = accounts.venue_quote_vault.to_account_info();

    // Which venue, and that every venue account is the coin's own.
    let on_damm = accounts.quantum.damm_pool != Pubkey::default();
    if on_damm {
        require!(
            *program.key == DAMM_V2_PROGRAM_ID
                && *pool_authority.key == DAMM_POOL_AUTHORITY
                && *event_authority.key == DAMM_EVENT_AUTHORITY
                && *pool.key == accounts.quantum.damm_pool,
            QuantumError::NotCanonicalPool
        );
        let state = read_damm_pool(&pool)?;
        require!(
            state.token_a_vault == *base_vault.key && state.token_b_vault == *quote_vault.key,
            QuantumError::NotCanonicalPool
        );
        require!(state.pool_status == 0, QuantumError::VenueUnavailable);
    } else {
        let config = accounts
            .dbc_config
            .as_ref()
            .ok_or(QuantumError::NotCanonicalPool)?;
        require!(
            *program.key == DBC_PROGRAM_ID
                && *pool_authority.key == DBC_POOL_AUTHORITY
                && *event_authority.key == DBC_EVENT_AUTHORITY
                && *pool.key == accounts.quantum.dbc_pool
                && config.key() == accounts.quantum.dbc_config,
            QuantumError::NotCanonicalPool
        );
        let state = read_dbc_pool(&pool)?;
        require!(
            state.base_vault == *base_vault.key && state.quote_vault == *quote_vault.key,
            QuantumError::NotCanonicalPool
        );
        // A full curve waits for migration (and `sync`) before the well can buy again.
        require!(
            state.migration_progress == PROGRESS_PRE_BONDING_CURVE,
            QuantumError::VenueUnavailable
        );
    }

    let lamports_before = well_total(&well, &wsol_ata)?;
    let tokens_before = accounts.well_token_ata.amount;
    wrap_from_well(
        &well,
        &wsol_ata,
        &wsol_mint,
        &token_program,
        &accounts.associated_token_program.to_account_info(),
        &accounts.system_program.to_account_info(),
        spend,
        signer,
    )?;
    if on_damm {
        Damm {
            program: &program,
            pool_authority: &pool_authority,
            event_authority: &event_authority,
            pool: &pool,
            vault_a: &base_vault,
            vault_b: &quote_vault,
            mint_a: &mint_info,
            mint_b: &wsol_mint,
            token_program: &token_program,
        }
        .buy(&well, &wsol_ata, &base_ata, spend, min_out, signer)?;
    } else {
        let config = accounts.dbc_config.as_ref().unwrap().to_account_info();
        Dbc {
            program: &program,
            pool_authority: &pool_authority,
            event_authority: &event_authority,
            config: &config,
            pool: &pool,
            base_vault: &base_vault,
            quote_vault: &quote_vault,
            base_mint: &mint_info,
            quote_mint: &wsol_mint,
            token_program: &token_program,
        }
        .buy(&well, &wsol_ata, &base_ata, spend, min_out, signer)?;
    }
    // Whatever the swap did not take is unwrapped back into the well.
    unwrap_to_well(&well, &wsol_ata, &token_program, signer)?;

    let accounts = &mut ctx.accounts;
    accounts.well_token_ata.reload()?;
    let tokens_after = accounts.well_token_ata.amount;
    require!(tokens_after > tokens_before, QuantumError::NothingBought);
    token::burn(
        CpiContext::new_with_signer(
            token_program.clone(),
            Burn {
                mint: mint_info.clone(),
                from: base_ata.clone(),
                authority: well.clone(),
            },
            signer,
        ),
        tokens_after,
    )?;

    let spent = lamports_before.saturating_sub(well.lamports());
    require!(spent <= spend, QuantumError::Overspent);

    let quantum = &mut accounts.quantum;
    quantum.burn_reserve = sub(quantum.burn_reserve, spent)?;
    quantum.total_burn_sol = add(quantum.total_burn_sol, spent)?;
    quantum.total_burned_tokens = add(quantum.total_burned_tokens, tokens_after)?;
    quantum.last_burn_at = now;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Burned {
        mint,
        caller: accounts.caller.key(),
        venue: on_damm as u8,
        spent,
        tokens_burned: tokens_after,
    });
    Ok(())
}
