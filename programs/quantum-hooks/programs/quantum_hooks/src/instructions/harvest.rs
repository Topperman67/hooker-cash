//! `harvest`: the well, as the coin's DBC pool creator and the owner of its DAMM v2 position,
//! claims everything the creator side has earned into its own accounts. Permissionless and not
//! blocked by a pause: it only moves value into the well, where `pulse` allocates it.
//!
//! Legs (bitmask; a leg with nothing to do is skipped, so a harvest that lands first never makes a
//! later one fail):
//! - 1: DBC creator trading fee (zero claims succeed, so it always runs);
//! - 2: DBC creator surplus (once the curve is complete, until withdrawn);
//! - 4: DBC creator migration fee (after migration, until withdrawn);
//! - 8: DAMM v2 LP fee of the well's position (after migration).
//!
//! Fees arrive as WSOL in the well's WSOL account, which this instruction creates (`caller` pays
//! the rent), closes into the well afterwards, and whose rent it refunds to `caller`, so only fees
//! remain. A config that ever pays fees in the coin itself would deliver base tokens: those are
//! burned.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Harvested;
use crate::meteora::*;
use crate::state::Quantum;
use crate::utils::*;

pub const LEG_TRADING_FEE: u8 = 1;
pub const LEG_SURPLUS: u8 = 2;
pub const LEG_MIGRATION_FEE: u8 = 4;
pub const LEG_LP_FEE: u8 = 8;

#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
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
    /// CHECK: the well's WSOL ATA (address checked); created and closed here.
    #[account(mut, address = well_wsol_address(&well.key()))]
    pub well_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: the WSOL mint.
    #[account(address = NATIVE_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: Meteora DBC.
    #[account(executable, address = DBC_PROGRAM_ID @ QuantumError::NotCanonicalPool)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ QuantumError::NotCanonicalPool)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority.
    #[account(address = DBC_EVENT_AUTHORITY @ QuantumError::NotCanonicalPool)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the coin's DBC config (stored at `register`).
    #[account(address = quantum.dbc_config @ QuantumError::NotCanonicalPool)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the coin's DBC virtual pool (stored at `register`).
    #[account(mut, address = quantum.dbc_pool @ QuantumError::NotCanonicalPool)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: the pool's base vault (checked against the pool in the handler).
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault (checked against the pool in the handler).
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,

    /// CHECK: optional (leg 8), all or none: Meteora DAMM v2 and the coin's recorded pool,
    /// position and NFT account (addresses stored by `sync`), plus the pool's vaults.
    #[account(executable, address = DAMM_V2_PROGRAM_ID @ QuantumError::NotCanonicalDammPool)]
    pub damm_program: Option<UncheckedAccount<'info>>,
    /// CHECK: DAMM v2's pool authority.
    #[account(address = DAMM_POOL_AUTHORITY @ QuantumError::NotCanonicalDammPool)]
    pub damm_pool_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: DAMM v2's event authority.
    #[account(address = DAMM_EVENT_AUTHORITY @ QuantumError::NotCanonicalDammPool)]
    pub damm_event_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_program`.
    #[account(address = quantum.damm_pool @ QuantumError::NotCanonicalDammPool)]
    pub damm_pool: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_program`.
    #[account(mut, address = quantum.damm_position @ QuantumError::PositionNotWells)]
    pub damm_position: Option<UncheckedAccount<'info>>,
    /// CHECK: see `damm_program`.
    #[account(address = quantum.damm_nft_account @ QuantumError::PositionNotWells)]
    pub damm_nft_account: Option<UncheckedAccount<'info>>,
    /// CHECK: checked against the pool in the handler.
    #[account(mut)]
    pub damm_vault_a: Option<UncheckedAccount<'info>>,
    /// CHECK: checked against the pool in the handler.
    #[account(mut)]
    pub damm_vault_b: Option<UncheckedAccount<'info>>,
}

pub(crate) fn harvest(mut ctx: Context<Harvest>, legs: u8) -> Result<()> {
    let rent = Rent::get()?;
    let accounts = &ctx.accounts;
    let mint = accounts.mint.key();
    let well_bump = [accounts.quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    let signer = &[well_seeds];
    let well = accounts.well.to_account_info();
    let caller = accounts.caller.to_account_info();
    let wsol_ata = accounts.well_wsol_ata.to_account_info();
    let base_ata = accounts.well_token_ata.to_account_info();
    let token_program = accounts.token_program.to_account_info();
    let system_program = accounts.system_program.to_account_info();

    let pool_info = accounts.dbc_pool.to_account_info();
    let pool = read_dbc_pool(&pool_info)?;
    require!(
        pool.base_vault == accounts.dbc_base_vault.key()
            && pool.quote_vault == accounts.dbc_quote_vault.key(),
        QuantumError::NotCanonicalPool
    );
    require!(pool.creator == well.key(), QuantumError::NotBound);

    if !is_token_account(&wsol_ata) {
        associated_token::create_idempotent(CpiContext::new(
            accounts.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: caller.clone(),
                associated_token: wsol_ata.clone(),
                authority: well.clone(),
                mint: accounts.wsol_mint.to_account_info(),
                system_program: system_program.clone(),
                token_program: token_program.clone(),
            },
        ))?;
    }

    let dbc_program = accounts.dbc_program.to_account_info();
    let dbc_pool_authority = accounts.dbc_pool_authority.to_account_info();
    let dbc_event_authority = accounts.dbc_event_authority.to_account_info();
    let dbc_config = accounts.dbc_config.to_account_info();
    let dbc_base_vault = accounts.dbc_base_vault.to_account_info();
    let dbc_quote_vault = accounts.dbc_quote_vault.to_account_info();
    let mint_info = accounts.mint.to_account_info();
    let wsol_mint = accounts.wsol_mint.to_account_info();
    let dbc = Dbc {
        program: &dbc_program,
        pool_authority: &dbc_pool_authority,
        event_authority: &dbc_event_authority,
        config: &dbc_config,
        pool: &pool_info,
        base_vault: &dbc_base_vault,
        quote_vault: &dbc_quote_vault,
        base_mint: &mint_info,
        quote_mint: &wsol_mint,
        token_program: &token_program,
    };

    let mut ran = 0u8;
    if legs & LEG_TRADING_FEE != 0 {
        dbc.claim_creator_trading_fee(&well, &base_ata, &wsol_ata, signer)?;
        ran |= LEG_TRADING_FEE;
    }
    if legs & LEG_SURPLUS != 0 && pool.finish_curve_timestamp > 0 && !pool.creator_withdrew_surplus {
        dbc.creator_quote_withdrawal(false, &well, &wsol_ata, signer)?;
        ran |= LEG_SURPLUS;
    }
    if legs & LEG_MIGRATION_FEE != 0
        && pool.migration_progress == PROGRESS_CREATED_POOL
        && pool.migration_fee_withdraw_status & CREATOR_MIGRATION_FEE_MASK == 0
    {
        dbc.creator_quote_withdrawal(true, &well, &wsol_ata, signer)?;
        ran |= LEG_MIGRATION_FEE;
    }
    if legs & LEG_LP_FEE != 0 {
        let (program, pool_authority, event_authority, damm_pool, position, nft, vault_a, vault_b) = match (
            &accounts.damm_program,
            &accounts.damm_pool_authority,
            &accounts.damm_event_authority,
            &accounts.damm_pool,
            &accounts.damm_position,
            &accounts.damm_nft_account,
            &accounts.damm_vault_a,
            &accounts.damm_vault_b,
        ) {
            (Some(a), Some(b), Some(c), Some(d), Some(e), Some(f), Some(g), Some(h)) => (
                a.to_account_info(),
                b.to_account_info(),
                c.to_account_info(),
                d.to_account_info(),
                e.to_account_info(),
                f.to_account_info(),
                g.to_account_info(),
                h.to_account_info(),
            ),
            _ => return err!(QuantumError::NotMigrated),
        };
        require!(
            accounts.quantum.damm_pool != Pubkey::default(),
            QuantumError::NotMigrated
        );
        let state = read_damm_pool(&damm_pool)?;
        require!(
            state.token_a_vault == *vault_a.key && state.token_b_vault == *vault_b.key,
            QuantumError::NotCanonicalDammPool
        );
        let damm = Damm {
            program: &program,
            pool_authority: &pool_authority,
            event_authority: &event_authority,
            pool: &damm_pool,
            vault_a: &vault_a,
            vault_b: &vault_b,
            mint_a: &mint_info,
            mint_b: &wsol_mint,
            token_program: &token_program,
        };
        damm.claim_position_fee(&position, &nft, &well, &base_ata, &wsol_ata, signer)?;
        ran |= LEG_LP_FEE;
    }

    // Base tokens only arrive if a fee mode pays in the coin: burn them (the hooks hold SOL only).
    let accounts = &mut ctx.accounts;
    accounts.well_token_ata.reload()?;
    let tokens_burned = accounts.well_token_ata.amount;
    if tokens_burned > 0 {
        token::burn(
            CpiContext::new_with_signer(
                token_program.clone(),
                Burn {
                    mint: accounts.mint.to_account_info(),
                    from: base_ata.clone(),
                    authority: well.clone(),
                },
                signer,
            ),
            tokens_burned,
        )?;
    }

    let closed = unwrap_to_well(&well, &wsol_ata, &token_program, signer)?;
    let (rent_refunded, claimed) = split_closed_ata(closed, rent.minimum_balance(TOKEN_ACCOUNT_LEN));
    pay_from_well(&well, &caller, &system_program, rent_refunded, signer)?;

    let quantum = &mut accounts.quantum;
    quantum.total_harvested = add(quantum.total_harvested, claimed)?;
    quantum.total_burned_tokens = add(quantum.total_burned_tokens, tokens_burned)?;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Harvested {
        mint,
        caller: caller.key(),
        legs: ran,
        claimed,
        tokens_burned,
        rent_refunded,
    });
    Ok(())
}
