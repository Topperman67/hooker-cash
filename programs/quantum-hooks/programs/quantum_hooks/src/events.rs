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
    /// The DBC virtual pool the coin's hooks are bound to.
    pub dbc_pool: Pubkey,
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
pub struct LaunchConfigsSet {
    pub configs: Vec<Pubkey>,
    /// The config version after this change.
    pub version: u64,
}

/// `sync` recorded something new about the coin's Meteora venue.
#[event]
pub struct Synced {
    pub mint: Pubkey,
    pub bound_at: i64,
    pub birth_bound: bool,
    pub graduated_at: i64,
    pub damm_pool: Pubkey,
    pub damm_position: Pubkey,
    /// DAMM v2 `collect_fee_mode` of the recorded pool (1 = quote only); 0 before migration.
    pub collect_fee_mode: u8,
}

/// `harvest` claimed the creator side's fees into the well.
#[event]
pub struct Harvested {
    pub mint: Pubkey,
    pub caller: Pubkey,
    /// Bitmask of the legs that ran (1 trading fee, 2 surplus, 4 migration fee, 8 LP fee).
    pub legs: u8,
    /// Quote (SOL) claimed into the well, without the WSOL account's rent.
    pub claimed: u64,
    /// Coin tokens received (only if a fee mode ever pays base) and burned.
    pub tokens_burned: u64,
    /// Rent of the WSOL account returned to `caller`.
    pub rent_refunded: u64,
}

#[event]
pub struct Pulsed {
    pub mint: Pubkey,
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
}

#[event]
pub struct Burned {
    pub mint: Pubkey,
    pub caller: Pubkey,
    /// 0 = Meteora DBC bonding curve, 1 = DAMM v2 pool.
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
    /// Liquidity added to the well's DAMM v2 position and permanently locked.
    pub liquidity_added: u128,
    pub tokens_burned: u64,
}
