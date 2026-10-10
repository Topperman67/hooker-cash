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

/// Byte offset of `complete: bool` in pump.fun's `BondingCurve` account (8-byte discriminator,
/// then five u64 reserve / supply fields).
pub const CURVE_COMPLETE_OFFSET: usize = 8 + 5 * 8;

/// `sha256("global:init_user_volume_accumulator")[..8]`, the same on pump.fun and PumpSwap. A
/// public burn or fusion may share its transaction with this (the client adds it when the well's
/// volume accumulator is missing) but with no other pump.fun or PumpSwap instruction.
pub const INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR: [u8; 8] = [94, 6, 202, 115, 255, 96, 232, 183];

/// Programs (besides this one) whose top-level instructions may share a transaction with a public
/// (non-keeper) burn or fusion: none of them can trade. Everything else (pump.fun, PumpSwap, the
/// pump fee program, routers, the caller's own program) is refused, so a public run cannot be
/// sandwiched inside its own transaction.
pub const PUBLIC_COMPANION_PROGRAMS: [Pubkey; 5] = [
    anchor_lang::solana_program::pubkey!("ComputeBudget111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("11111111111111111111111111111111"),
    anchor_lang::solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    anchor_lang::solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    anchor_lang::solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

pub const PUMP_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

/// `sha256("global:<name>")[..8]` for the pump.fun bonding-curve buys `quantum_burn` may invoke.
/// Checked against `@pump-fun/pump-sdk` 4.0.0's IDL by the unit tests and the TS tests.
pub const PUMP_BUY_DISCRIMINATORS: [[u8; 8]; 6] = [
    [102, 6, 61, 18, 1, 218, 235, 234],     // buy
    [56, 252, 116, 8, 158, 223, 205, 95],   // buy_exact_sol_in
    [184, 23, 238, 97, 103, 197, 211, 61],  // buy_v2
    [194, 171, 28, 70, 104, 77, 91, 47],    // buy_exact_quote_in_v2
    [7, 5, 29, 196, 245, 23, 101, 80],      // buy_v3
    [225, 247, 80, 30, 213, 179, 132, 136], // buy_exact_quote_in_v3
];

/// PumpSwap buys `quantum_burn` and `fusion` may invoke.
pub const PUMP_AMM_BUY_DISCRIMINATORS: [[u8; 8]; 4] = [
    [102, 6, 61, 18, 1, 218, 235, 234],    // buy
    [198, 46, 21, 82, 180, 217, 232, 112], // buy_exact_quote_in
    [184, 23, 238, 97, 103, 197, 211, 61], // buy_v2
    [194, 171, 28, 70, 104, 77, 91, 47],   // buy_exact_quote_in_v2
];

/// PumpSwap `deposit`.
pub const PUMP_AMM_DEPOSIT_DISCRIMINATOR: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];

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
    use anchor_lang::solana_program::hash::hash;

    fn disc(name: &str) -> [u8; 8] {
        let digest = hash(format!("global:{name}").as_bytes()).to_bytes();
        let mut out = [0u8; 8];
        out.copy_from_slice(&digest[..8]);
        out
    }

    #[test]
    fn discriminators_match_names() {
        let pump = [
            "buy",
            "buy_exact_sol_in",
            "buy_v2",
            "buy_exact_quote_in_v2",
            "buy_v3",
            "buy_exact_quote_in_v3",
        ];
        for (i, name) in pump.iter().enumerate() {
            assert_eq!(PUMP_BUY_DISCRIMINATORS[i], disc(name), "pump {name}");
        }
        let amm = ["buy", "buy_exact_quote_in", "buy_v2", "buy_exact_quote_in_v2"];
        for (i, name) in amm.iter().enumerate() {
            assert_eq!(PUMP_AMM_BUY_DISCRIMINATORS[i], disc(name), "amm {name}");
        }
        assert_eq!(PUMP_AMM_DEPOSIT_DISCRIMINATOR, disc("deposit"));
        assert_eq!(
            INIT_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR,
            disc("init_user_volume_accumulator")
        );
        // Sells must never pass the allow-list.
        for sell in ["sell", "sell_v2", "sell_v3"] {
            assert!(!PUMP_BUY_DISCRIMINATORS.contains(&disc(sell)));
            assert!(!PUMP_AMM_BUY_DISCRIMINATORS.contains(&disc(sell)));
        }
    }

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
        assert!(!RESERVED_ACCOUNT_KEYS.contains(&PUMP_PROGRAM_ID));
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
        for trader in [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID] {
            assert!(!PUBLIC_COMPANION_PROGRAMS.contains(&trader));
        }
    }
}
