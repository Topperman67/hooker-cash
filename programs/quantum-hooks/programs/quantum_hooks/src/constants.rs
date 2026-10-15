use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"qp-config";
pub const QUANTUM_SEED: &[u8] = b"quantum";
pub const WELL_SEED: &[u8] = b"well";
pub const EPOCH_SEED: &[u8] = b"epoch";

pub const BPS_DENOMINATOR: u64 = 10_000;
/// Hard cap on `config.protocol_bps` (10%).
pub const MAX_PROTOCOL_BPS: u16 = 1_000;
/// Superposition wallets per coin.
pub const MAX_SPLITS: usize = 4;
/// `pulse` refuses to run for less than 0.001 SOL.
pub const MIN_PULSE_LAMPORTS: u64 = 1_000_000;
/// DBC configs a coin may launch under (`config.launch_configs`).
pub const MAX_LAUNCH_CONFIGS: usize = 4;
/// Entanglement epochs hold at most this many leaves (bitmap of 2 KiB).
pub const MAX_LEAVES: u32 = 16_384;
/// A sorted-pair tree of 16 384 leaves is 14 levels deep; anything longer is junk.
pub const MAX_PROOF_LEN: usize = 24;
/// Time Dilation locks last at most four years.
pub const MAX_LOCK_DURATION: i64 = 4 * 365 * 86_400;

/// Entanglement epochs expire 30 days after they are posted, and a coin gets at most one epoch
/// every 20 hours. The `short-expiry` feature shortens both (20 s and 15 s) only so the local
/// end-to-end tests can exercise `close_epoch` and the cadence without a clock warp; never deploy it.
#[cfg(not(feature = "short-expiry"))]
pub const EPOCH_TTL: i64 = 30 * 86_400;
#[cfg(feature = "short-expiry")]
pub const EPOCH_TTL: i64 = 20;
#[cfg(not(feature = "short-expiry"))]
pub const MIN_EPOCH_INTERVAL: i64 = 20 * 3_600;
#[cfg(feature = "short-expiry")]
pub const MIN_EPOCH_INTERVAL: i64 = 15;

/// `config.claim_delay` (seconds between posting an epoch and its first claim: the authority's
/// window to cancel it) is at most 7 days. Clients default to 6 hours.
pub const MAX_CLAIM_DELAY: i64 = 7 * 86_400;

/// A burn or fusion run by anyone but the keeper (after `keeper_grace`) may spend at most
/// `max_burn_lamports / PUBLIC_SPEND_DIVISOR`.
pub const PUBLIC_SPEND_DIVISOR: u64 = 10;

/// Programs (besides this one) whose top-level instructions may share a transaction with a public
/// (non-keeper) burn or fusion: none of them can trade. Everything else (Meteora's DBC and DAMM v2,
/// routers, the caller's own program) is refused, so a public run cannot be sandwiched inside its
/// own transaction.
pub const PUBLIC_COMPANION_PROGRAMS: [Pubkey; 5] = [
    anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("11111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    anchor_lang::solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

/// Keys the runtime never lets a transaction write-lock: Agave's `ReservedAccountKeys` (builtin and
/// loader programs and sysvars, including the ones reserved behind feature gates) plus secp256r1.
/// A split wallet at one of these addresses could never be passed writable to `pulse`, so
/// `register` rejects them (`shared/quantum.mjs` keeps the same list, checked by the unit tests).
pub const RESERVED_ACCOUNT_KEYS: [Pubkey; 31] = [
    // Builtin and loader programs.
    anchor_lang::solana_program::pubkey!("11111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("AddressLookupTab1e1111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("BPFLoader1111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("BPFLoader2111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111"),
    anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Config1111111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Feature111111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("KeccakSecp256k11111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("LoaderV411111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("NativeLoader1111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Secp256r1SigVerify1111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Stake11111111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("StakeConfig11111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Vote111111111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("ZkE1Gama1Proof11111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("ZkTokenProof1111111111111111111111111111111"),
    // Sysvars and the sysvar owner.
    anchor_lang::solana_program::pubkey!("Sysvar1111111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("Sysvar1nstructions1111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarC1ock11111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarEpochRewards1111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarEpochSchedu1e111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarFees111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarLastRestartS1ot1111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarRecentB1ockHashes11111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarRent111111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarRewards111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarS1otHashes111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarS1otHistory11111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("SysvarStakeHistory1111111111111111111111111"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meteora::{DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID};

    #[test]
    #[allow(deprecated)]
    fn reserved_keys_cover_the_sdk_ids() {
        use anchor_lang::solana_program as sp;
        let known = [
            sp::system_program::ID,
            sp::address_lookup_table::program::ID,
            sp::bpf_loader_deprecated::ID,
            sp::bpf_loader::ID,
            sp::bpf_loader_upgradeable::ID,
            sp::config::program::ID,
            sp::ed25519_program::ID,
            sp::feature::ID,
            sp::secp256k1_program::ID,
            sp::loader_v4::ID,
            sp::stake::program::ID,
            sp::stake::config::ID,
            sp::vote::program::ID,
            sp::sysvar::ID,
        ];
        for key in known.iter().chain(sp::sysvar::ALL_IDS.iter()) {
            assert!(RESERVED_ACCOUNT_KEYS.contains(key), "{key} missing");
        }
        for (i, key) in RESERVED_ACCOUNT_KEYS.iter().enumerate() {
            assert!(!RESERVED_ACCOUNT_KEYS[..i].contains(key), "{key} listed twice");
        }
        assert!(!RESERVED_ACCOUNT_KEYS.contains(&DBC_PROGRAM_ID));
    }

    #[test]
    #[allow(deprecated)]
    fn public_companions_are_the_non_trading_programs() {
        use anchor_lang::solana_program as sp;
        assert_eq!(
            PUBLIC_COMPANION_PROGRAMS[0].to_string(),
            "ComputeBudget111111111111111111111111111111"
        );
        assert_eq!(PUBLIC_COMPANION_PROGRAMS[1], sp::system_program::ID);
        assert_eq!(PUBLIC_COMPANION_PROGRAMS[2], anchor_spl::associated_token::ID);
        assert_eq!(PUBLIC_COMPANION_PROGRAMS[3], anchor_spl::token::ID);
        assert_eq!(PUBLIC_COMPANION_PROGRAMS[4], anchor_spl::token_2022::ID);
        for trader in [DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID] {
            assert!(!PUBLIC_COMPANION_PROGRAMS.contains(&trader));
        }
    }
}
