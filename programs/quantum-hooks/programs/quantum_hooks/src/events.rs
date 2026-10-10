use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub keeper: Pubkey,
    pub protocol_bps: u16,
    pub max_burn_lamports: u64,
    pub min_action_interval: i64,
    pub keeper_grace: i64,
    pub paused: bool,
}

#[event]
pub struct Registered {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub well: Pubkey,
    pub creator_bps: u16,
    pub burn_bps: u16,
    pub entangle_bps: u16,
    pub fusion_bps: u16,
    pub split_count: u8,
    pub lock_cliff_secs: i64,
    pub lock_duration_secs: i64,
    pub well_funded: u64,
}

#[event]
pub struct Locked {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub amount: u64,
    pub lock_start: i64,
    pub lock_cliff: i64,
    pub lock_end: i64,
}

#[event]
pub struct Released {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub amount: u64,
    pub released_total: u64,
}

#[event]
pub struct Pulsed {
    pub mint: Pubkey,
    /// WSOL (creator fees) unwrapped from the well's WSOL account before allocation, without the
    /// account's rent (see `rent_refunded`).
    pub unwrapped: u64,
    /// Unallocated lamports this pulse distributed (`available`).
    pub collected: u64,
    pub protocol: u64,
    pub launcher_paid: u64,
    pub splits_paid: u64,
    pub burn_added: u64,
    pub entangle_added: u64,
    pub fusion_added: u64,
    /// Payments skipped because the recipient could not hold them (would stay below its rent
    /// minimum, or is executable). They stay in the well and are re-pulsed later.
    pub deferred: u64,
    /// Rent of the closed WSOL account, returned to the pulse's `rent_payer` (not fees).
    pub rent_refunded: u64,
}

#[event]
pub struct Burned {
    pub mint: Pubkey,
    pub caller: Pubkey,
    /// 0 = bonding curve (pump.fun), 1 = PumpSwap pool.
    pub venue: u8,
    pub spent: u64,
    pub tokens_burned: u64,
}

#[event]
pub struct EpochPosted {
    pub mint: Pubkey,
    pub index: u32,
    pub root: [u8; 32],
    pub total: u64,
    pub leaf_count: u32,
    pub expires_at: i64,
}

#[event]
pub struct Claimed {
    pub mint: Pubkey,
    pub index: u32,
    pub leaf_index: u32,
    pub claimant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EpochClosed {
    pub mint: Pubkey,
    pub index: u32,
    pub unclaimed: u64,
    pub payer: Pubkey,
}

#[event]
pub struct Fused {
    pub mint: Pubkey,
    pub caller: Pubkey,
    pub spent: u64,
    pub lp_received: u64,
    pub tokens_burned: u64,
}
