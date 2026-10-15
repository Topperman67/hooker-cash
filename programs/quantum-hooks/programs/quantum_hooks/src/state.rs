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
    /// Seconds between posting an Entanglement epoch and its first claim: the authority's window
    /// to `cancel_epoch` a bad root (0..=MAX_CLAIM_DELAY).
    pub claim_delay: i64,
    /// Incremented by every config change (`update_config`, `set_paused`, `set_launch_configs`).
    /// `update_config` names the version it was prepared against, so a stale update cannot undo a
    /// later change.
    pub version: u64,
    /// Quant Pad's Meteora DBC configs: `register` only binds hooks to a pool launched under one
    /// of these (DBC configs are immutable, so the address pins every curve and fee setting).
    pub launch_configs: [Pubkey; 4], // MAX_LAUNCH_CONFIGS
    pub launch_config_count: u8,
    pub reserved: [u8; 48],
}

impl Config {
    pub fn allows_launch_config(&self, config: &Pubkey) -> bool {
        self.launch_configs[..self.launch_config_count as usize].contains(config)
    }
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
    /// When the newest Entanglement epoch was posted (0 = never); paces `post_entanglement`.
    pub last_epoch_at: i64,
    /// When the coin's bonding curve filled (DBC `finish_curve_timestamp`, recorded by `sync`;
    /// 0 = not yet).
    pub graduated_at: i64,
    /// Shares `pulse` owes but could not pay yet (the recipient would stay below its rent-exempt
    /// minimum). Held in the well and paid first once the recipient can receive.
    pub split_owed: [u64; 4], // MAX_SPLITS, same order as `splits`
    pub launcher_owed: u64,
    pub protocol_owed: u64,
    // Meteora venue.
    /// The DBC config the coin launches under (allow-listed at `register`) and the virtual pool
    /// that config derives for the mint.
    pub dbc_config: Pubkey,
    pub dbc_pool: Pubkey,
    /// The DAMM v2 pool the curve migrated into, the well's position in it and the account holding
    /// that position's NFT, recorded and verified by `sync` (default until the coin migrates).
    pub damm_pool: Pubkey,
    pub damm_position: Pubkey,
    pub damm_nft_account: Pubkey,
    /// When `sync` first saw the well as the DBC pool's creator (0 = not bound yet).
    pub bound_at: i64,
    /// The well became the creator before the pool's first trade, so the launcher never held a
    /// creator fee (`sync` reads DBC's `has_swap`).
    pub birth_bound: bool,
    /// When `sync` recorded the DAMM v2 pool. The public Fusion grace counts from here.
    pub migrated_at: i64,
    /// Quote lamports `harvest` has claimed into the well (rent refunds excluded).
    pub total_harvested: u64,
    /// DAMM v2 liquidity Fusion has added to the well's position and locked.
    pub total_fused_liquidity: u128,
    pub reserved: [u8; 16],
}

impl Quantum {
    /// Lamports owed to the launcher, the splits and the treasury.
    pub fn owed_lamports(&self) -> Result<u64> {
        self.split_owed
            .iter()
            .try_fold(self.launcher_owed, |acc, v| acc.checked_add(*v))
            .and_then(|v| v.checked_add(self.protocol_owed))
            .ok_or_else(|| error!(QuantumError::MathOverflow))
    }

    /// Lamports in the well that belong to a module, to Entanglement claimants or to a recipient
    /// `pulse` still owes.
    pub fn reserved_lamports(&self) -> Result<u64> {
        self.burn_reserve
            .checked_add(self.entangle_reserve)
            .and_then(|v| v.checked_add(self.entangle_owed))
            .and_then(|v| v.checked_add(self.fusion_reserve))
            .ok_or_else(|| error!(QuantumError::MathOverflow))?
            .checked_add(self.owed_lamports()?)
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
    /// `created_at + config.claim_delay`: claims open here; until then the authority may cancel.
    pub claim_start: i64,
    pub expires_at: i64,
    pub payer: Pubkey,
    pub bump: u8,
    /// One bit per leaf, `ceil(leaf_count / 8)` bytes.
    pub bitmap: Vec<u8>,
}

impl Epoch {
    pub const FIXED_LEN: usize = 8 + 32 + 4 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 32 + 1 + 4;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_match_the_space_the_program_allocates() {
        // init-config.mjs budgets the config rent for 8 + 317 bytes.
        assert_eq!(Config::INIT_SPACE, 317);
        let epoch = Epoch {
            mint: Pubkey::default(),
            index: 0,
            root: [0; 32],
            total: 0,
            claimed: 0,
            leaf_count: 9,
            created_at: 0,
            claim_start: 0,
            expires_at: 0,
            payer: Pubkey::default(),
            bump: 0,
            bitmap: vec![0; Epoch::bitmap_len(9)],
        };
        let mut data = Vec::new();
        epoch.try_serialize(&mut data).unwrap(); // discriminator + fields
        assert_eq!(data.len(), Epoch::space(9));
    }

    #[test]
    fn owed_payments_are_reserved_in_the_well() {
        let mut quantum = Quantum {
            mint: Pubkey::default(),
            launcher: Pubkey::default(),
            bump: 0,
            well_bump: 0,
            created_at: 0,
            creator_bps: 0,
            burn_bps: 0,
            entangle_bps: 0,
            fusion_bps: 0,
            split_count: 0,
            splits: [Split::default(); 4],
            burn_reserve: 1,
            entangle_reserve: 2,
            entangle_owed: 4,
            fusion_reserve: 8,
            total_collected: 0,
            total_protocol: 0,
            total_creator_paid: 0,
            total_burn_sol: 0,
            total_burned_tokens: 0,
            total_claimed: 0,
            total_fused_sol: 0,
            epoch_count: 0,
            locked_amount: 0,
            released_amount: 0,
            lock_start: 0,
            lock_cliff: 0,
            lock_end: 0,
            last_burn_at: 0,
            last_fusion_at: 0,
            planned_cliff_secs: 0,
            planned_duration_secs: 0,
            last_epoch_at: 0,
            graduated_at: 0,
            split_owed: [16, 32, 64, 128],
            launcher_owed: 256,
            protocol_owed: 512,
            dbc_config: Pubkey::default(),
            dbc_pool: Pubkey::default(),
            damm_pool: Pubkey::default(),
            damm_position: Pubkey::default(),
            damm_nft_account: Pubkey::default(),
            bound_at: 0,
            birth_bound: false,
            migrated_at: 0,
            total_harvested: 0,
            total_fused_liquidity: 0,
            reserved: [0; 16],
        };
        assert_eq!(quantum.owed_lamports().unwrap(), 1008);
        assert_eq!(quantum.reserved_lamports().unwrap(), 1023);
        quantum.protocol_owed = u64::MAX;
        assert!(quantum.reserved_lamports().is_err());
    }
}
