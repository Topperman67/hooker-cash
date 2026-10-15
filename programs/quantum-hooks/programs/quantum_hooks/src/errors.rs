use anchor_lang::prelude::*;

#[error_code]
pub enum QuantumError {
    #[msg("Allocation bps (creator + burn + entangle + fusion) must sum to 10000")]
    InvalidAllocation,
    #[msg("At most 4 Superposition splits are allowed")]
    TooManySplits,
    #[msg("Each split needs 1..=10000 bps and all splits together at most 10000")]
    InvalidSplitBps,
    #[msg("Split wallets must be distinct ordinary wallets: not the default key, the well, the Quantum account, a sysvar or a program")]
    InvalidSplitWallet,
    #[msg("Invalid lock terms: need 0 <= cliff <= duration and 0 < duration <= 4 years")]
    InvalidLockTerms,
    #[msg("Lock terms differ from the ones registered for this coin")]
    LockTermsMismatch,
    #[msg("The mint must be a fresh keypair account with no lamports and no data")]
    MintNotFresh,
    #[msg("Quant Pad is paused")]
    Paused,
    #[msg("protocol_bps exceeds the 1000 bps hard cap")]
    ProtocolBpsTooHigh,
    #[msg("Invalid config value")]
    InvalidConfig,
    #[msg("Only the program upgrade authority can initialize the config")]
    NotUpgradeAuthority,
    #[msg("Signer is not the config authority")]
    NotAuthority,
    #[msg("Signer is not this coin's launcher")]
    NotLauncher,
    #[msg("Dev tokens are already locked for this coin")]
    AlreadyLocked,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Nothing has vested beyond what was already released")]
    NothingToRelease,
    #[msg("Less than 0.001 SOL is available to pulse")]
    NothingToPulse,
    #[msg("Remaining accounts must be the stored Superposition wallets, writable, in order")]
    SplitAccountsMismatch,
    #[msg("Only the keeper may act until the keeper grace period has passed")]
    KeeperOnly,
    #[msg("The minimum interval between actions has not elapsed")]
    TooSoon,
    #[msg("Spend exceeds the module reserve or the per-action cap")]
    SpendTooHigh,
    #[msg("The CPI spent more lamports than authorised")]
    Overspent,
    #[msg("Venue accounts must be this coin's Meteora pool and its program's accounts")]
    NotCanonicalPool,
    #[msg("The buy delivered no tokens to the well")]
    NothingBought,
    #[msg("Fusion added a different amount of liquidity than requested")]
    LiquidityMismatch,
    #[msg("Entanglement leaf count must be 1..=16384")]
    InvalidLeafCount,
    #[msg("Epoch total exceeds the Entanglement reserve")]
    InsufficientEntangleReserve,
    #[msg("This Entanglement epoch has expired")]
    EpochExpired,
    #[msg("This Entanglement epoch has not expired yet")]
    EpochNotExpired,
    #[msg("Leaf index out of range")]
    LeafOutOfRange,
    #[msg("This leaf was already claimed")]
    AlreadyClaimed,
    #[msg("Invalid merkle proof")]
    InvalidProof,
    #[msg("Merkle proof is too long")]
    ProofTooLong,
    #[msg("Claim would exceed the epoch total")]
    ClaimExceedsTotal,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Well balance is below its rent minimum plus reserved ledgers")]
    WellInvariant,
    // Appended (codes above are stable).
    #[msg("The config changed since this update was prepared (expected_version does not match)")]
    ConfigChanged,
    #[msg("Claims for this Entanglement epoch are not open yet")]
    ClaimNotOpen,
    #[msg("This Entanglement epoch can no longer be cancelled: its claims have opened")]
    CancelWindowClosed,
    #[msg("The minimum interval between Entanglement epochs has not elapsed")]
    EpochTooSoon,
    #[msg("A public burn or fusion must be a top-level instruction and may share its transaction only with compute-budget, system, token, associated-token and Quantum Hooks instructions")]
    PublicTransactionNotAllowed,
    #[msg("This DBC config is not one of Quant Pad's launch configs")]
    LaunchConfigNotAllowed,
    #[msg("At most 4 distinct, non-default launch configs")]
    InvalidLaunchConfigs,
    #[msg("The well is not this coin's DBC pool creator")]
    NotBound,
    #[msg("The venue cannot trade right now (curve complete but not migrated, or pool disabled)")]
    VenueUnavailable,
    #[msg("Not the DAMM v2 pool DBC migrated this coin into")]
    NotCanonicalDammPool,
    #[msg("The DAMM v2 position is not the well's")]
    PositionNotWells,
    #[msg("A Meteora account has an unexpected owner, discriminator or size")]
    InvalidVenueAccount,
    #[msg("The coin has not migrated to DAMM v2 yet")]
    NotMigrated,
}
