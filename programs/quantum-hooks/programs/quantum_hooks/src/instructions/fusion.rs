//! Fusion: after migration the well buys some of its coin on the DAMM v2 pool `sync` recorded,
//! adds both sides to its own position there (the creator position DBC handed it at migration)
//! and permanently locks exactly the liquidity it added. Locked liquidity keeps earning LP fees,
//! which `harvest` claims. Whatever the deposit does not take is burned (coin) or unwrapped (SOL).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Fused;
use crate::meteora::*;
use crate::state::{Config, Quantum};
use crate::utils::*;

#[derive(Accounts)]
pub struct Fusion<'info> {
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
    /// CHECK: the well's WSOL ATA (address checked).
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

    /// CHECK: Meteora DAMM v2.
    #[account(executable, address = DAMM_V2_PROGRAM_ID @ QuantumError::NotCanonicalDammPool)]
    pub damm_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's pool authority.
    #[account(address = DAMM_POOL_AUTHORITY @ QuantumError::NotCanonicalDammPool)]
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority.
    #[account(address = DAMM_EVENT_AUTHORITY @ QuantumError::NotCanonicalDammPool)]
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: the pool `sync` recorded.
    #[account(mut, address = quantum.damm_pool @ QuantumError::NotMigrated)]
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: the well's position `sync` recorded.
    #[account(mut, address = quantum.damm_position @ QuantumError::PositionNotWells)]
    pub damm_position: UncheckedAccount<'info>,
    /// CHECK: the account holding that position's NFT, as recorded.
    #[account(address = quantum.damm_nft_account @ QuantumError::PositionNotWells)]
    pub damm_nft_account: UncheckedAccount<'info>,
    /// CHECK: checked against the pool in the handler.
    #[account(mut)]
    pub damm_vault_a: UncheckedAccount<'info>,
    /// CHECK: checked against the pool in the handler.
    #[account(mut)]
    pub damm_vault_b: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn fusion(
    mut ctx: Context<Fusion>,
    spend: u64,
    swap_in: u64,
    min_base_out: u64,
    liquidity_delta: u128,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;
    let accounts = &ctx.accounts;
    require!(
        accounts.quantum.damm_pool != Pubkey::default(),
        QuantumError::NotMigrated
    );
    let is_keeper = accounts.caller.key() == accounts.config.keeper;
    // Anyone may fuse only a full keeper grace after migration (or the last fusion).
    let last_fusion_at = accounts.quantum.last_fusion_at;
    let grace_from = last_fusion_at.max(accounts.quantum.migrated_at);
    check_action_gate(&accounts.config, is_keeper, last_fusion_at, grace_from, now)?;
    check_spend(&accounts.config, is_keeper, spend, accounts.quantum.fusion_reserve)?;
    if !is_keeper {
        check_public_transaction(&accounts.instructions_sysvar.to_account_info())?;
    }
    require!(swap_in > 0 && swap_in < spend && liquidity_delta > 0, QuantumError::ZeroAmount);

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
    let program = accounts.damm_program.to_account_info();
    let pool_authority = accounts.damm_pool_authority.to_account_info();
    let event_authority = accounts.damm_event_authority.to_account_info();
    let pool = accounts.damm_pool.to_account_info();
    let position = accounts.damm_position.to_account_info();
    let nft = accounts.damm_nft_account.to_account_info();
    let vault_a = accounts.damm_vault_a.to_account_info();
    let vault_b = accounts.damm_vault_b.to_account_info();

    let state = read_damm_pool(&pool)?;
    require!(
        state.token_a_vault == *vault_a.key && state.token_b_vault == *vault_b.key,
        QuantumError::NotCanonicalDammPool
    );
    require!(state.pool_status == 0, QuantumError::VenueUnavailable);
    let locked_before = read_damm_position(&position)?.permanent_locked_liquidity;

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
    let damm = Damm {
        program: &program,
        pool_authority: &pool_authority,
        event_authority: &event_authority,
        pool: &pool,
        vault_a: &vault_a,
        vault_b: &vault_b,
        mint_a: &mint_info,
        mint_b: &wsol_mint,
        token_program: &token_program,
    };
    damm.buy(&well, &wsol_ata, &base_ata, swap_in, min_base_out, signer)?;

    let accounts = &mut ctx.accounts;
    accounts.well_token_ata.reload()?;
    let base_held = accounts.well_token_ata.amount;
    require!(base_held > tokens_before, QuantumError::NothingBought);
    // The deposit may take at most what the well holds on each side.
    let wsol_held = token::accessor::amount(&wsol_ata)?;
    damm.add_liquidity(&position, &nft, &well, &base_ata, &wsol_ata, liquidity_delta, base_held, wsol_held, signer)?;
    damm.permanent_lock(&position, &nft, &well, liquidity_delta, signer)?;
    let after = read_damm_position(&position)?;
    require!(
        after.permanent_locked_liquidity == locked_before.saturating_add(liquidity_delta)
            && after.unlocked_liquidity == 0,
        QuantumError::LiquidityMismatch
    );

    accounts.well_token_ata.reload()?;
    let leftover = accounts.well_token_ata.amount;
    if leftover > 0 {
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
            leftover,
        )?;
    }
    unwrap_to_well(&well, &wsol_ata, &token_program, signer)?;

    let spent = lamports_before.saturating_sub(well.lamports());
    require!(spent <= spend, QuantumError::Overspent);

    let quantum = &mut accounts.quantum;
    quantum.fusion_reserve = sub(quantum.fusion_reserve, spent)?;
    quantum.total_fused_sol = add(quantum.total_fused_sol, spent)?;
    quantum.total_fused_liquidity = quantum
        .total_fused_liquidity
        .checked_add(liquidity_delta)
        .ok_or(QuantumError::MathOverflow)?;
    quantum.total_burned_tokens = add(quantum.total_burned_tokens, leftover)?;
    quantum.last_fusion_at = now;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Fused {
        mint,
        caller: accounts.caller.key(),
        spent,
        liquidity_added: liquidity_delta,
        tokens_burned: leftover,
    });
    Ok(())
}
