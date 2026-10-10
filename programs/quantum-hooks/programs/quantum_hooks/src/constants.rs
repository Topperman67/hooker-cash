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

/// Entanglement epochs can be claimed for 30 days. The `short-expiry` feature exists only so the
/// local end-to-end tests can exercise `close_epoch` without a clock warp; never deploy it.
#[cfg(not(feature = "short-expiry"))]
pub const EPOCH_TTL: i64 = 30 * 86_400;
#[cfg(feature = "short-expiry")]
pub const EPOCH_TTL: i64 = 20;

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
        // Sells must never pass the allow-list.
        for sell in ["sell", "sell_v2", "sell_v3"] {
            assert!(!PUMP_BUY_DISCRIMINATORS.contains(&disc(sell)));
            assert!(!PUMP_AMM_BUY_DISCRIMINATORS.contains(&disc(sell)));
        }
    }
}
