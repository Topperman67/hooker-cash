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
    pub claim_delay: i64,
    /// The config version after this change.
    pub version: u64,
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
    /// Unallocated lamports this pulse distributed (`available`; 0 when below the 0.001 SOL floor
    /// and the pulse only paid owed amounts).
    pub collected: u64,
    /// Paid to the treasury, launcher and splits by this pulse, including amounts owed from
    /// earlier pulses (`owed_paid` of the total).
    pub protocol: u64,
    pub launcher_paid: u64,
    pub splits_paid: u64,
    pub burn_added: u64,
    pub entangle_added: u64,
    pub fusion_added: u64,
    /// Shares this pulse could not pay: the recipient would stay below its rent-exempt minimum
    /// (recorded as owed to it and paid first once it can receive), or a split is a key that can
    /// never be paid (reserved or executable; stays in the well unledgered and is re-pulsed).
    pub deferred: u64,
    /// Owed amounts from earlier pulses paid by this one.
    pub owed_paid: u64,
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
    /// Claims open here (`created_at + config.claim_delay`); until then the authority may cancel.
    pub claim_start: i64,
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

/// The authority cancelled an epoch before its claims opened: `returned` went back to the
/// Entanglement reserve and the account's rent to `rent_to` (`config.keeper`).
#[event]
pub struct EpochCancelled {
    pub mint: Pubkey,
    pub index: u32,
    pub returned: u64,
    pub rent_to: Pubkey,
}

#[event]
pub struct Fused {
    pub mint: Pubkey,
    pub caller: Pubkey,
    pub spent: u64,
    pub lp_received: u64,
    pub tokens_burned: u64,
}
