//! Entanglement: SOL distributed to holders through merkle epochs posted by the keeper.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;

use crate::constants::*;
use crate::errors::QuantumError;
use crate::events::{Claimed, EpochClosed, EpochPosted};
use crate::state::{Config, Epoch, Quantum};
use crate::utils::*;

#[derive(Accounts)]
#[instruction(root: [u8; 32], total: u64, leaf_count: u32)]
pub struct PostEntanglement<'info> {
    #[account(mut, address = config.keeper @ QuantumError::KeeperOnly)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [QUANTUM_SEED, quantum.mint.as_ref()], bump = quantum.bump)]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(
        init,
        payer = keeper,
        // Clamped so a bogus leaf count cannot size the account; validated in the handler.
        space = Epoch::space(leaf_count.clamp(1, MAX_LEAVES)),
        seeds = [EPOCH_SEED, quantum.mint.as_ref(), &quantum.epoch_count.to_le_bytes()],
        bump
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct ClaimEntanglement<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [QUANTUM_SEED, quantum.mint.as_ref()], bump = quantum.bump)]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(mut, seeds = [WELL_SEED, quantum.mint.as_ref()], bump = quantum.well_bump)]
    pub well: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, quantum.mint.as_ref(), &index.to_le_bytes()],
        bump = epoch.bump
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct CloseEpoch<'info> {
    #[account(mut, seeds = [QUANTUM_SEED, quantum.mint.as_ref()], bump = quantum.bump)]
    pub quantum: Box<Account<'info, Quantum>>,
    #[account(
        mut,
        seeds = [EPOCH_SEED, quantum.mint.as_ref(), &index.to_le_bytes()],
        bump = epoch.bump,
        close = payer
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: must be the account that paid the epoch's rent; receives it back.
    #[account(mut, address = epoch.payer @ QuantumError::InvalidConfig)]
    pub payer: UncheckedAccount<'info>,
}

pub(crate) fn post_entanglement(
    ctx: Context<PostEntanglement>,
    root: [u8; 32],
    total: u64,
    leaf_count: u32,
) -> Result<()> {
    require!(
        (1..=MAX_LEAVES).contains(&leaf_count),
        QuantumError::InvalidLeafCount
    );
    require!(total > 0, QuantumError::ZeroAmount);
    let now = Clock::get()?.unix_timestamp;
    let quantum = &mut ctx.accounts.quantum;
    require!(
        total <= quantum.entangle_reserve,
        QuantumError::InsufficientEntangleReserve
    );

    let index = quantum.epoch_count;
    let expires_at = now.checked_add(EPOCH_TTL).ok_or(QuantumError::MathOverflow)?;
    let epoch = &mut ctx.accounts.epoch;
    epoch.mint = quantum.mint;
    epoch.index = index;
    epoch.root = root;
    epoch.total = total;
    epoch.claimed = 0;
    epoch.leaf_count = leaf_count;
    epoch.created_at = now;
    epoch.expires_at = expires_at;
    epoch.payer = ctx.accounts.keeper.key();
    epoch.bump = ctx.bumps.epoch;
    epoch.bitmap = vec![0u8; Epoch::bitmap_len(leaf_count)];

    quantum.entangle_reserve = sub(quantum.entangle_reserve, total)?;
    quantum.entangle_owed = add(quantum.entangle_owed, total)?;
    quantum.epoch_count = index.checked_add(1).ok_or(QuantumError::MathOverflow)?;

    emit!(EpochPosted {
        mint: quantum.mint,
        index,
        root,
        total,
        leaf_count,
        expires_at,
    });
    Ok(())
}

/// Leaf = sha256(0x00 ‖ leaf_index u32 LE ‖ claimant ‖ amount u64 LE).
pub fn leaf_hash(leaf_index: u32, claimant: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        &[0u8],
        &leaf_index.to_le_bytes(),
        claimant.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

/// Inner node = sha256(0x01 ‖ min(a, b) ‖ max(a, b)).
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[1u8], lo, hi]).to_bytes()
}

pub(crate) fn claim_entanglement(
    ctx: Context<ClaimEntanglement>,
    _index: u32,
    leaf_index: u32,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    require!(amount > 0, QuantumError::ZeroAmount);
    require!(proof.len() <= MAX_PROOF_LEN, QuantumError::ProofTooLong);
    let now = Clock::get()?.unix_timestamp;
    let epoch = &mut ctx.accounts.epoch;
    require!(now < epoch.expires_at, QuantumError::EpochExpired);
    require!(leaf_index < epoch.leaf_count, QuantumError::LeafOutOfRange);
    require!(!epoch.is_claimed(leaf_index), QuantumError::AlreadyClaimed);

    let claimant = ctx.accounts.claimant.key();
    let mut node = leaf_hash(leaf_index, &claimant, amount);
    for sibling in proof.iter() {
        node = node_hash(&node, sibling);
    }
    require!(node == epoch.root, QuantumError::InvalidProof);

    let claimed = add(epoch.claimed, amount)?;
    require!(claimed <= epoch.total, QuantumError::ClaimExceedsTotal);
    epoch.claimed = claimed;
    epoch.set_claimed(leaf_index);
    let index = epoch.index;

    let quantum = &mut ctx.accounts.quantum;
    quantum.entangle_owed = sub(quantum.entangle_owed, amount)?;
    quantum.total_claimed = add(quantum.total_claimed, amount)?;

    let mint = quantum.mint;
    let well_bump = [quantum.well_bump];
    let well_seeds: &[&[u8]] = &[WELL_SEED, mint.as_ref(), &well_bump];
    pay_from_well(
        &ctx.accounts.well.to_account_info(),
        &ctx.accounts.claimant.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        amount,
        &[well_seeds],
    )?;
    assert_well_invariant(
        &ctx.accounts.well.to_account_info(),
        &ctx.accounts.quantum,
        &Rent::get()?,
    )?;

    emit!(Claimed {
        mint,
        index,
        leaf_index,
        claimant,
        amount,
    });
    Ok(())
}

pub(crate) fn close_epoch(ctx: Context<CloseEpoch>, index: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let epoch = &ctx.accounts.epoch;
    require!(now >= epoch.expires_at, QuantumError::EpochNotExpired);
    let unclaimed = sub(epoch.total, epoch.claimed)?;
    let payer = epoch.payer;

    let quantum = &mut ctx.accounts.quantum;
    quantum.entangle_owed = sub(quantum.entangle_owed, unclaimed)?;
    quantum.entangle_reserve = add(quantum.entangle_reserve, unclaimed)?;

    emit!(EpochClosed {
        mint: quantum.mint,
        index,
        unclaimed,
        payer,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    // Vectors produced by shared/merkle.mjs (leafHash / nodeHash).
    #[test]
    fn hashing_matches_the_js_client() {
        let wallet = Pubkey::new_from_array(core::array::from_fn(|i| i as u8 + 1));
        let leaf = leaf_hash(3, &wallet, 1000);
        assert_eq!(
            hex(&leaf),
            "a733f199d71d1ae91138504e15da252ef1ed562beb26528646eb4059e0090c8c"
        );
        let other = leaf_hash(4, &wallet, 7);
        assert_eq!(
            hex(&node_hash(&leaf, &other)),
            "a626733d68095e27526abf2b4ebec8849f9c7a08995e99287b42ead8e2ae62b3"
        );
        assert_eq!(node_hash(&leaf, &other), node_hash(&other, &leaf));
    }
}
