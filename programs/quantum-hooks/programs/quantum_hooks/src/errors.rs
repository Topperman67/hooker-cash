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
    #[msg("The SPL Token program is required to unwrap the well's WSOL account")]
    MissingTokenProgram,
    #[msg("Only the keeper may act until the keeper grace period has passed")]
    KeeperOnly,
    #[msg("The minimum interval between actions has not elapsed")]
    TooSoon,
    #[msg("Spend exceeds the module reserve or the per-action cap")]
    SpendTooHigh,
    #[msg("The CPI spent more lamports than authorised")]
    Overspent,
    #[msg("Target program must be pump.fun or PumpSwap")]
    InvalidTargetProgram,
    #[msg("CPI instruction is not on the discriminator allow-list")]
    DisallowedInstruction,
    #[msg("CPI accounts must include the coin's mint")]
    MintNotInCpi,
    #[msg("CPI accounts must include the well")]
    WellNotInCpi,
    #[msg("PumpSwap CPIs must target the coin's canonical pool")]
    NotCanonicalPool,
    #[msg("The buy delivered no tokens to the well")]
    NothingBought,
    #[msg("The deposit minted no LP tokens to the well")]
    NoLiquidityAdded,
    #[msg("Invalid buy account count for fusion")]
    InvalidBuyAccountCount,
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
}
