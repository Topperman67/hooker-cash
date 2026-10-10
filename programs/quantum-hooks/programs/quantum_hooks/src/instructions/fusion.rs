//! Fusion: after graduation the well buys base on the canonical PumpSwap pool and deposits both
//! sides as liquidity. The LP tokens stay in the well's LP ATA forever (no withdraw path).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::Fused;
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
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = well,
        associated_token::token_program = token_program
    )]
    pub well_token_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the well's WSOL ATA (address checked).
    #[account(mut, address = well_wsol_address(&well.key()))]
    pub well_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: the WSOL mint.
    #[account(address = NATIVE_MINT)]
    pub wsol_mint: UncheckedAccount<'info>,
    /// CHECK: the coin's canonical PumpSwap pool (address derived from the mint).
    #[account(address = canonical_pool(&mint.key()) @ QuantumError::NotCanonicalPool)]
    pub pool: UncheckedAccount<'info>,
    #[account(
        address = lp_mint_address(&pool.key()) @ QuantumError::NotCanonicalPool,
        mint::token_program = token_program
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = lp_mint,
        associated_token::authority = well,
        associated_token::token_program = token_program
    )]
    pub well_lp_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: PumpSwap.
    #[account(executable, address = PUMP_AMM_PROGRAM_ID @ QuantumError::InvalidTargetProgram)]
    pub target_program: UncheckedAccount<'info>,
    // remaining_accounts: buy accounts [0, buy_account_count), then deposit accounts.
}

pub(crate) fn fusion<'info>(
    mut ctx: Context<'_, '_, 'info, 'info, Fusion<'info>>,
    spend: u64,
    buy_data: Vec<u8>,
    buy_account_count: u8,
    deposit_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent = Rent::get()?;
    let accounts = &mut ctx.accounts;
    check_action_gate(
        &accounts.config,
        &accounts.caller.key(),
        accounts.quantum.last_fusion_at,
        now,
    )?;
    require!(spend > 0, QuantumError::ZeroAmount);
    require!(
        spend <= accounts.quantum.fusion_reserve && spend <= accounts.config.max_burn_lamports,
        QuantumError::SpendTooHigh
    );
    check_discriminator(&buy_data, &PUMP_AMM_BUY_DISCRIMINATORS)?;
    check_discriminator(&deposit_data, &[PUMP_AMM_DEPOSIT_DISCRIMINATOR])?;

    let split = buy_account_count as usize;
    require!(
        split > 0 && split < ctx.remaining_accounts.len(),
        QuantumError::InvalidBuyAccountCount
    );
    let (buy_accounts, deposit_accounts) = ctx.remaining_accounts.split_at(split);
    let pool = accounts.pool.key();
    require!(
        *buy_accounts[0].key == pool && *deposit_accounts[0].key == pool,
        QuantumError::NotCanonicalPool
    );

    let mint = accounts.mint.key();
    let well_bump = [accounts.quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    let signer = &[well_seeds];
    let well = accounts.well.to_account_info();
    let wsol_ata = accounts.well_wsol_ata.to_account_info();
    let quote_token_program = accounts.quote_token_program.to_account_info();
    let target = accounts.target_program.to_account_info();

    let lamports_before = well_total(&well, &wsol_ata)?;
    let tokens_before = accounts.well_token_ata.amount;
    let lp_before = accounts.well_lp_ata.amount;

    wrap_from_well(
        &well,
        &wsol_ata,
        &accounts.wsol_mint.to_account_info(),
        &quote_token_program,
        &accounts.associated_token_program.to_account_info(),
        &accounts.system_program.to_account_info(),
        spend,
        signer,
    )?;

    invoke_as_well(&target, buy_accounts, buy_data, &well.key(), &mint, signer)?;
    accounts.well_token_ata.reload()?;
    require!(
        accounts.well_token_ata.amount > tokens_before,
        QuantumError::NothingBought
    );

    invoke_as_well(
        &target,
        deposit_accounts,
        deposit_data,
        &well.key(),
        &mint,
        signer,
    )?;
    accounts.well_lp_ata.reload()?;
    let lp_received = accounts.well_lp_ata.amount.saturating_sub(lp_before);
    require!(lp_received > 0, QuantumError::NoLiquidityAdded);

    // Base the deposit did not take is burned; WSOL it did not take is unwrapped.
    accounts.well_token_ata.reload()?;
    let leftover = accounts.well_token_ata.amount;
    if leftover > 0 {
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
            leftover,
        )?;
    }
    unwrap_to_well(&well, &wsol_ata, &quote_token_program, signer)?;

    let spent = lamports_before.saturating_sub(well.lamports());
    require!(spent <= spend, QuantumError::Overspent);

    let quantum = &mut accounts.quantum;
    quantum.fusion_reserve = sub(quantum.fusion_reserve, spent)?;
    quantum.total_fused_sol = add(quantum.total_fused_sol, spent)?;
    quantum.total_burned_tokens = add(quantum.total_burned_tokens, leftover)?;
    quantum.last_fusion_at = now;
    assert_well_invariant(&well, quantum, &rent)?;

    emit!(Fused {
        mint,
        caller: accounts.caller.key(),
        spent,
        lp_received,
        tokens_burned: leftover,
    });
    Ok(())
}
