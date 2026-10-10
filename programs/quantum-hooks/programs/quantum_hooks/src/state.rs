use anchor_lang::prelude::*;

use crate::errors::QuantumError;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub keeper: Pubkey,
    pub protocol_bps: u16,
    pub max_burn_lamports: u64,
    pub min_action_interval: i64,
    pub keeper_grace: i64,
    pub paused: bool,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Split {
    pub wallet: Pubkey,
    /// Share of the creator slice in bps.
    pub bps: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Quantum {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub bump: u8,
    pub well_bump: u8,
    pub created_at: i64,
    pub creator_bps: u16,
    pub burn_bps: u16,
    pub entangle_bps: u16,
    pub fusion_bps: u16,
    pub split_count: u8,
    pub splits: [Split; 4], // MAX_SPLITS (a literal keeps the IDL simple)
    // Lamport ledgers held in the well.
    pub burn_reserve: u64,
    pub entangle_reserve: u64,
    pub entangle_owed: u64,
    pub fusion_reserve: u64,
    pub total_collected: u64,
    pub total_protocol: u64,
    pub total_creator_paid: u64,
    pub total_burn_sol: u64,
    pub total_burned_tokens: u64,
    pub total_claimed: u64,
    pub total_fused_sol: u64,
    pub epoch_count: u32,
    // Time Dilation.
    pub locked_amount: u64,
    pub released_amount: u64,
    pub lock_start: i64,
    pub lock_cliff: i64,
    pub lock_end: i64,
    pub last_burn_at: i64,
    pub last_fusion_at: i64,
    /// Lock terms committed at registration (0/0 = none planned). `lock` must use them.
    pub planned_cliff_secs: i64,
    pub planned_duration_secs: i64,
    pub reserved: [u8; 48],
}

impl Quantum {
    /// Lamports in the well that belong to a module or to Entanglement claimants.
    pub fn reserved_lamports(&self) -> Result<u64> {
        self.burn_reserve
            .checked_add(self.entangle_reserve)
            .and_then(|v| v.checked_add(self.entangle_owed))
            .and_then(|v| v.checked_add(self.fusion_reserve))
            .ok_or_else(|| error!(QuantumError::MathOverflow))
    }
}

#[account]
pub struct Epoch {
    pub mint: Pubkey,
    pub index: u32,
    pub root: [u8; 32],
    pub total: u64,
    pub claimed: u64,
    pub leaf_count: u32,
    pub created_at: i64,
    pub expires_at: i64,
    pub payer: Pubkey,
    pub bump: u8,
    /// One bit per leaf, `ceil(leaf_count / 8)` bytes.
    pub bitmap: Vec<u8>,
}

impl Epoch {
    pub const FIXED_LEN: usize = 8 + 32 + 4 + 32 + 8 + 8 + 4 + 8 + 8 + 32 + 1 + 4;

    pub fn bitmap_len(leaf_count: u32) -> usize {
        (leaf_count as usize).div_ceil(8)
    }

    pub fn space(leaf_count: u32) -> usize {
        Self::FIXED_LEN + Self::bitmap_len(leaf_count)
    }

    pub fn is_claimed(&self, leaf_index: u32) -> bool {
        let byte = (leaf_index / 8) as usize;
        let bit = 1u8 << (leaf_index % 8);
        self.bitmap[byte] & bit != 0
    }

    pub fn set_claimed(&mut self, leaf_index: u32) {
        let byte = (leaf_index / 8) as usize;
        let bit = 1u8 << (leaf_index % 8);
        self.bitmap[byte] |= bit;
    }
}
