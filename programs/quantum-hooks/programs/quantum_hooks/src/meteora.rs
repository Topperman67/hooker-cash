//! Meteora's Dynamic Bonding Curve (DBC, launches) and DAMM v2 (the pool a finished curve migrates
//! into): program ids, the account fields this program reads, and the instructions it invokes.
//!
//! Meteora's program source is under a non-commercial licence, so nothing here comes from it:
//! instructions are built by hand from the published IDLs (`shared/idl/meteora_*.json`, pinned to
//! the deployed programs by `scripts/meteora-idls.mjs`), and accounts are read at fixed offsets.
//! Those structs are bytemuck `Pod` (no implicit padding), so an offset is 8 + the sizes of the
//! fields before it; `tests/meteora-spike.mjs` checked every one against live account bytes. Each
//! reader checks owner, discriminator and length first and fails closed if Meteora ever changes a
//! layout.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::pubkey;

use crate::errors::QuantumError;

pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// `["pool_authority"]` under each program (checked by the unit tests).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

/// `["__event_authority"]` under each program (Anchor event CPI; checked by the unit tests).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

/// Both programs order a pool's two mints larger key first (byte-wise).
fn ordered<'a>(a: &'a Pubkey, b: &'a Pubkey) -> (&'a Pubkey, &'a Pubkey) {
    if a.to_bytes() > b.to_bytes() {
        (a, b)
    } else {
        (b, a)
    }
}

/// The DBC virtual pool for `base_mint` under `config`, quoted in `quote_mint`.
pub fn dbc_pool_address(config: &Pubkey, base_mint: &Pubkey, quote_mint: &Pubkey) -> Pubkey {
    let (first, second) = ordered(base_mint, quote_mint);
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), first.as_ref(), second.as_ref()],
        &DBC_PROGRAM_ID,
    )
    .0
}

/// The DAMM v2 pool for the two mints under a DAMM `config`.
pub fn damm_pool_address(config: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey) -> Pubkey {
    let (first, second) = ordered(mint_a, mint_b);
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), first.as_ref(), second.as_ref()],
        &DAMM_V2_PROGRAM_ID,
    )
    .0
}

// ---- account discriminators (IDL `accounts[].discriminator`) ---------------------------------

pub const DBC_POOL_CONFIG_DISC: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const DBC_VIRTUAL_POOL_DISC: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
pub const DAMM_POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
pub const DAMM_POSITION_DISC: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
pub const DAMM_CONFIG_DISC: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];

// ---- instruction discriminators (IDL `instructions[].discriminator`) -------------------------

pub const IX_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136]; // same name on both programs
pub const IX_CLAIM_CREATOR_TRADING_FEE: [u8; 8] = [82, 220, 250, 189, 3, 85, 107, 45];
pub const IX_CREATOR_WITHDRAW_SURPLUS: [u8; 8] = [165, 3, 137, 7, 28, 134, 76, 80];
pub const IX_WITHDRAW_MIGRATION_FEE: [u8; 8] = [237, 142, 45, 23, 129, 6, 222, 162];
pub const IX_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
pub const IX_ADD_LIQUIDITY: [u8; 8] = [181, 157, 89, 67, 143, 182, 52, 72];
pub const IX_PERMANENT_LOCK_POSITION: [u8; 8] = [165, 176, 125, 6, 231, 171, 186, 213];

/// DBC `swap_mode` / DAMM `swap_mode`.
pub const SWAP_EXACT_IN: u8 = 0;
pub const SWAP_PARTIAL_FILL: u8 = 1;
/// `withdraw_migration_fee` flag for the creator's share, and its bit in
/// `migration_fee_withdraw_status` (DBC `CREATOR_MIGRATION_FEE_MASK`).
pub const MIGRATION_FEE_CREATOR_FLAG: u8 = 1;
pub const CREATOR_MIGRATION_FEE_MASK: u8 = 0b010;

/// DBC `migration_progress`.
pub const PROGRESS_PRE_BONDING_CURVE: u8 = 0;
pub const PROGRESS_CREATED_POOL: u8 = 3;
/// DAMM v2 `collect_fee_mode` 1: fees in token B (the quote) only.
pub const DAMM_COLLECT_FEE_ONLY_B: u8 = 1;

// ---- account readers --------------------------------------------------------------------------

/// The first `len` bytes of a Meteora account, after checking its owner, discriminator and size.
fn data_of(info: &AccountInfo, owner: &Pubkey, disc: &[u8; 8], len: usize) -> Result<Vec<u8>> {
    require!(info.owner == owner, QuantumError::InvalidVenueAccount);
    let data = info.try_borrow_data()?;
    require!(data.len() >= len && data[..8] == disc[..], QuantumError::InvalidVenueAccount);
    Ok(data[..len].to_vec())
}

fn pubkey_at(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}
fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}
fn u128_at(d: &[u8], at: usize) -> u128 {
    u128::from_le_bytes(d[at..at + 16].try_into().unwrap())
}

/// DBC `VirtualPool` (424 bytes; every field sits in one `PoolState` starting at byte 8).
pub mod virtual_pool {
    pub const CONFIG: usize = 72;
    pub const CREATOR: usize = 104;
    pub const BASE_MINT: usize = 136;
    pub const BASE_VAULT: usize = 168;
    pub const QUOTE_VAULT: usize = 200;
    pub const QUOTE_RESERVE: usize = 240;
    pub const IS_MIGRATED: usize = 305;
    pub const MIGRATION_PROGRESS: usize = 308;
    pub const IS_CREATOR_WITHDRAW_SURPLUS: usize = 310;
    pub const MIGRATION_FEE_WITHDRAW_STATUS: usize = 311;
    pub const FINISH_CURVE_TIMESTAMP: usize = 344;
    pub const CREATOR_BASE_FEE: usize = 352;
    pub const CREATOR_QUOTE_FEE: usize = 360;
    pub const HAS_SWAP: usize = 370;
    pub const LEN: usize = 424;
}

pub struct DbcPool {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub quote_reserve: u64,
    pub is_migrated: bool,
    pub migration_progress: u8,
    pub creator_withdrew_surplus: bool,
    pub migration_fee_withdraw_status: u8,
    pub finish_curve_timestamp: u64,
    pub creator_base_fee: u64,
    pub creator_quote_fee: u64,
    pub has_swap: bool,
}

pub fn read_dbc_pool(info: &AccountInfo) -> Result<DbcPool> {
    use virtual_pool::*;
    let d = data_of(info, &DBC_PROGRAM_ID, &DBC_VIRTUAL_POOL_DISC, LEN)?;
    Ok(DbcPool {
        config: pubkey_at(&d, CONFIG),
        creator: pubkey_at(&d, CREATOR),
        base_mint: pubkey_at(&d, BASE_MINT),
        base_vault: pubkey_at(&d, BASE_VAULT),
        quote_vault: pubkey_at(&d, QUOTE_VAULT),
        quote_reserve: u64_at(&d, QUOTE_RESERVE),
        is_migrated: d[IS_MIGRATED] != 0,
        migration_progress: d[MIGRATION_PROGRESS],
        creator_withdrew_surplus: d[IS_CREATOR_WITHDRAW_SURPLUS] != 0,
        migration_fee_withdraw_status: d[MIGRATION_FEE_WITHDRAW_STATUS],
        finish_curve_timestamp: u64_at(&d, FINISH_CURVE_TIMESTAMP),
        creator_base_fee: u64_at(&d, CREATOR_BASE_FEE),
        creator_quote_fee: u64_at(&d, CREATOR_QUOTE_FEE),
        has_swap: d[HAS_SWAP] != 0,
    })
}

/// A DBC `PoolConfig` account (only its identity is checked).
pub fn is_dbc_config(info: &AccountInfo) -> bool {
    info.owner == &DBC_PROGRAM_ID
        && info
            .try_borrow_data()
            .map(|d| d.len() >= 8 && d[..8] == DBC_POOL_CONFIG_DISC)
            .unwrap_or(false)
}

/// DAMM v2 `Pool` (1 112 bytes).
pub mod damm_pool {
    pub const TOKEN_A_MINT: usize = 168;
    pub const TOKEN_B_MINT: usize = 200;
    pub const TOKEN_A_VAULT: usize = 232;
    pub const TOKEN_B_VAULT: usize = 264;
    pub const POOL_STATUS: usize = 481;
    pub const COLLECT_FEE_MODE: usize = 484;
    pub const LEN: usize = 1112;
}

pub struct DammPool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub pool_status: u8,
    pub collect_fee_mode: u8,
}

pub fn read_damm_pool(info: &AccountInfo) -> Result<DammPool> {
    use damm_pool::*;
    let d = data_of(info, &DAMM_V2_PROGRAM_ID, &DAMM_POOL_DISC, LEN)?;
    Ok(DammPool {
        token_a_mint: pubkey_at(&d, TOKEN_A_MINT),
        token_b_mint: pubkey_at(&d, TOKEN_B_MINT),
        token_a_vault: pubkey_at(&d, TOKEN_A_VAULT),
        token_b_vault: pubkey_at(&d, TOKEN_B_VAULT),
        pool_status: d[POOL_STATUS],
        collect_fee_mode: d[COLLECT_FEE_MODE],
    })
}

/// DAMM v2 `Position` (408 bytes).
pub mod position {
    pub const POOL: usize = 8;
    pub const NFT_MINT: usize = 40;
    pub const UNLOCKED_LIQUIDITY: usize = 152;
    pub const PERMANENT_LOCKED_LIQUIDITY: usize = 184;
    pub const LEN: usize = 408;
}

pub struct DammPosition {
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub unlocked_liquidity: u128,
    pub permanent_locked_liquidity: u128,
}

pub fn read_damm_position(info: &AccountInfo) -> Result<DammPosition> {
    use position::*;
    let d = data_of(info, &DAMM_V2_PROGRAM_ID, &DAMM_POSITION_DISC, LEN)?;
    Ok(DammPosition {
        pool: pubkey_at(&d, POOL),
        nft_mint: pubkey_at(&d, NFT_MINT),
        unlocked_liquidity: u128_at(&d, UNLOCKED_LIQUIDITY),
        permanent_locked_liquidity: u128_at(&d, PERMANENT_LOCKED_LIQUIDITY),
    })
}

/// DAMM v2 `Config`: who may create pools under it.
pub const DAMM_CONFIG_POOL_CREATOR_AUTHORITY: usize = 40;
pub const DAMM_CONFIG_LEN: usize = 328;

pub fn read_damm_config_pool_creator_authority(info: &AccountInfo) -> Result<Pubkey> {
    let d = data_of(info, &DAMM_V2_PROGRAM_ID, &DAMM_CONFIG_DISC, DAMM_CONFIG_LEN)?;
    Ok(pubkey_at(&d, DAMM_CONFIG_POOL_CREATOR_AUTHORITY))
}

/// A DAMM v2 position NFT account: (mint, owner, amount) of a Token-2022 token account.
pub fn read_nft_account(info: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require!(
        info.owner == &anchor_spl::token_2022::ID,
        QuantumError::InvalidVenueAccount
    );
    let d = info.try_borrow_data()?;
    require!(d.len() >= 72, QuantumError::InvalidVenueAccount);
    Ok((pubkey_at(&d, 0), pubkey_at(&d, 32), u64_at(&d, 64)))
}

// ---- invoking -----------------------------------------------------------------------------------

fn w(info: &AccountInfo) -> AccountMeta {
    AccountMeta::new(*info.key, false)
}
fn r(info: &AccountInfo) -> AccountMeta {
    AccountMeta::new_readonly(*info.key, false)
}
fn s(info: &AccountInfo) -> AccountMeta {
    AccountMeta::new_readonly(*info.key, true)
}

fn call<'info>(
    program: &AccountInfo<'info>,
    metas: Vec<AccountMeta>,
    data: Vec<u8>,
    infos: &[AccountInfo<'info>],
    signer: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: *program.key,
        accounts: metas,
        data,
    };
    let mut all = infos.to_vec();
    all.push(program.clone());
    invoke_signed(&ix, &all, signer)?;
    Ok(())
}

fn data(disc: [u8; 8], args: &[&[u8]]) -> Vec<u8> {
    let mut out = disc.to_vec();
    for a in args {
        out.extend_from_slice(a);
    }
    out
}

/// The venue-side accounts shared by every DBC call.
pub struct Dbc<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub pool_authority: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub config: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub base_vault: &'a AccountInfo<'info>,
    pub quote_vault: &'a AccountInfo<'info>,
    pub base_mint: &'a AccountInfo<'info>,
    pub quote_mint: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Dbc<'a, 'info> {
    /// `swap2` buying base with quote: `input` is a quote token account, `output` a base one.
    pub fn buy(
        &self,
        payer: &AccountInfo<'info>,
        input: &AccountInfo<'info>,
        output: &AccountInfo<'info>,
        amount_in: u64,
        min_out: u64,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            r(self.pool_authority),
            r(self.config),
            w(self.pool),
            w(input),
            w(output),
            w(self.base_vault),
            w(self.quote_vault),
            r(self.base_mint),
            r(self.quote_mint),
            s(payer),
            r(self.token_program),
            r(self.token_program),
            r(self.program), // referral_token_account: None
            r(self.event_authority),
            r(self.program),
        ];
        let params = data(
            IX_SWAP2,
            &[&amount_in.to_le_bytes(), &min_out.to_le_bytes(), &[SWAP_PARTIAL_FILL]],
        );
        call(
            self.program,
            metas,
            params,
            &[
                self.pool_authority.clone(),
                self.config.clone(),
                self.pool.clone(),
                input.clone(),
                output.clone(),
                self.base_vault.clone(),
                self.quote_vault.clone(),
                self.base_mint.clone(),
                self.quote_mint.clone(),
                payer.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }

    /// `claim_creator_trading_fee(u64::MAX, u64::MAX)`.
    pub fn claim_creator_trading_fee(
        &self,
        creator: &AccountInfo<'info>,
        base_dest: &AccountInfo<'info>,
        quote_dest: &AccountInfo<'info>,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            r(self.pool_authority),
            w(self.pool),
            w(base_dest),
            w(quote_dest),
            w(self.base_vault),
            w(self.quote_vault),
            r(self.base_mint),
            r(self.quote_mint),
            s(creator),
            r(self.token_program),
            r(self.token_program),
            r(self.event_authority),
            r(self.program),
        ];
        let params = data(
            IX_CLAIM_CREATOR_TRADING_FEE,
            &[&u64::MAX.to_le_bytes(), &u64::MAX.to_le_bytes()],
        );
        call(
            self.program,
            metas,
            params,
            &[
                self.pool_authority.clone(),
                self.pool.clone(),
                base_dest.clone(),
                quote_dest.clone(),
                self.base_vault.clone(),
                self.quote_vault.clone(),
                self.base_mint.clone(),
                self.quote_mint.clone(),
                creator.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }

    /// `creator_withdraw_surplus` (curve complete, not withdrawn yet) or
    /// `withdraw_migration_fee(1)` (migrated, creator bit clear): both pay quote to `quote_dest`.
    pub fn creator_quote_withdrawal(
        &self,
        migration_fee: bool,
        creator: &AccountInfo<'info>,
        quote_dest: &AccountInfo<'info>,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            r(self.pool_authority),
            r(self.config),
            w(self.pool),
            w(quote_dest),
            w(self.quote_vault),
            r(self.quote_mint),
            s(creator),
            r(self.token_program),
            r(self.event_authority),
            r(self.program),
        ];
        let params = if migration_fee {
            data(IX_WITHDRAW_MIGRATION_FEE, &[&[MIGRATION_FEE_CREATOR_FLAG]])
        } else {
            data(IX_CREATOR_WITHDRAW_SURPLUS, &[])
        };
        call(
            self.program,
            metas,
            params,
            &[
                self.pool_authority.clone(),
                self.config.clone(),
                self.pool.clone(),
                quote_dest.clone(),
                self.quote_vault.clone(),
                self.quote_mint.clone(),
                creator.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }
}

/// The venue-side accounts shared by every DAMM v2 call. Token A is the coin, B the quote.
pub struct Damm<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub pool_authority: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub vault_a: &'a AccountInfo<'info>,
    pub vault_b: &'a AccountInfo<'info>,
    pub mint_a: &'a AccountInfo<'info>,
    pub mint_b: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> Damm<'a, 'info> {
    /// `swap2` exact-in, B (quote) → A (coin).
    pub fn buy(
        &self,
        payer: &AccountInfo<'info>,
        input: &AccountInfo<'info>,
        output: &AccountInfo<'info>,
        amount_in: u64,
        min_out: u64,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            r(self.pool_authority),
            w(self.pool),
            w(input),
            w(output),
            w(self.vault_a),
            w(self.vault_b),
            r(self.mint_a),
            r(self.mint_b),
            s(payer),
            r(self.token_program),
            r(self.token_program),
            r(self.program), // referral_token_account: None
            r(self.event_authority),
            r(self.program),
        ];
        let params = data(
            IX_SWAP2,
            &[&amount_in.to_le_bytes(), &min_out.to_le_bytes(), &[SWAP_EXACT_IN]],
        );
        call(
            self.program,
            metas,
            params,
            &[
                self.pool_authority.clone(),
                self.pool.clone(),
                input.clone(),
                output.clone(),
                self.vault_a.clone(),
                self.vault_b.clone(),
                self.mint_a.clone(),
                self.mint_b.clone(),
                payer.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }

    /// `claim_position_fee` into `dest_a` / `dest_b`.
    #[allow(clippy::too_many_arguments)]
    pub fn claim_position_fee(
        &self,
        position: &AccountInfo<'info>,
        nft_account: &AccountInfo<'info>,
        owner: &AccountInfo<'info>,
        dest_a: &AccountInfo<'info>,
        dest_b: &AccountInfo<'info>,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            r(self.pool_authority),
            r(self.pool),
            w(position),
            w(dest_a),
            w(dest_b),
            w(self.vault_a),
            w(self.vault_b),
            r(self.mint_a),
            r(self.mint_b),
            r(nft_account),
            s(owner),
            r(self.token_program),
            r(self.token_program),
            r(self.event_authority),
            r(self.program),
        ];
        call(
            self.program,
            metas,
            IX_CLAIM_POSITION_FEE.to_vec(),
            &[
                self.pool_authority.clone(),
                self.pool.clone(),
                position.clone(),
                dest_a.clone(),
                dest_b.clone(),
                self.vault_a.clone(),
                self.vault_b.clone(),
                self.mint_a.clone(),
                self.mint_b.clone(),
                nft_account.clone(),
                owner.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }

    /// `add_liquidity` into the well's position, paying from `from_a` / `from_b` (thresholds are
    /// the most it may take of each).
    #[allow(clippy::too_many_arguments)]
    pub fn add_liquidity(
        &self,
        position: &AccountInfo<'info>,
        nft_account: &AccountInfo<'info>,
        owner: &AccountInfo<'info>,
        from_a: &AccountInfo<'info>,
        from_b: &AccountInfo<'info>,
        liquidity_delta: u128,
        max_a: u64,
        max_b: u64,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            w(self.pool),
            w(position),
            w(from_a),
            w(from_b),
            w(self.vault_a),
            w(self.vault_b),
            r(self.mint_a),
            r(self.mint_b),
            r(nft_account),
            s(owner),
            r(self.token_program),
            r(self.token_program),
            r(self.event_authority),
            r(self.program),
        ];
        let params = data(
            IX_ADD_LIQUIDITY,
            &[&liquidity_delta.to_le_bytes(), &max_a.to_le_bytes(), &max_b.to_le_bytes()],
        );
        call(
            self.program,
            metas,
            params,
            &[
                self.pool.clone(),
                position.clone(),
                from_a.clone(),
                from_b.clone(),
                self.vault_a.clone(),
                self.vault_b.clone(),
                self.mint_a.clone(),
                self.mint_b.clone(),
                nft_account.clone(),
                owner.clone(),
                self.token_program.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }

    /// `permanent_lock_position(liquidity)`.
    pub fn permanent_lock(
        &self,
        position: &AccountInfo<'info>,
        nft_account: &AccountInfo<'info>,
        owner: &AccountInfo<'info>,
        liquidity: u128,
        signer: &[&[&[u8]]],
    ) -> Result<()> {
        let metas = vec![
            w(self.pool),
            w(position),
            r(nft_account),
            s(owner),
            r(self.event_authority),
            r(self.program),
        ];
        call(
            self.program,
            metas,
            data(IX_PERMANENT_LOCK_POSITION, &[&liquidity.to_le_bytes()]),
            &[
                self.pool.clone(),
                position.clone(),
                nft_account.clone(),
                owner.clone(),
                self.event_authority.clone(),
            ],
            signer,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::hash::hash;

    fn sighash(namespace: &str, name: &str) -> [u8; 8] {
        let h = hash(format!("{namespace}:{name}").as_bytes()).to_bytes();
        h[..8].try_into().unwrap()
    }

    #[test]
    fn discriminators_match_names() {
        assert_eq!(IX_SWAP2, sighash("global", "swap2"));
        assert_eq!(IX_CLAIM_CREATOR_TRADING_FEE, sighash("global", "claim_creator_trading_fee"));
        assert_eq!(IX_CREATOR_WITHDRAW_SURPLUS, sighash("global", "creator_withdraw_surplus"));
        assert_eq!(IX_WITHDRAW_MIGRATION_FEE, sighash("global", "withdraw_migration_fee"));
        assert_eq!(IX_CLAIM_POSITION_FEE, sighash("global", "claim_position_fee"));
        assert_eq!(IX_ADD_LIQUIDITY, sighash("global", "add_liquidity"));
        assert_eq!(IX_PERMANENT_LOCK_POSITION, sighash("global", "permanent_lock_position"));
        assert_eq!(DBC_POOL_CONFIG_DISC, sighash("account", "PoolConfig"));
        assert_eq!(DBC_VIRTUAL_POOL_DISC, sighash("account", "VirtualPool"));
        assert_eq!(DAMM_POOL_DISC, sighash("account", "Pool"));
        assert_eq!(DAMM_POSITION_DISC, sighash("account", "Position"));
        assert_eq!(DAMM_CONFIG_DISC, sighash("account", "Config"));
    }

    #[test]
    fn authorities_are_the_programs_pdas() {
        let pda = |seed: &[u8], p: &Pubkey| Pubkey::find_program_address(&[seed], p).0;
        assert_eq!(DBC_POOL_AUTHORITY, pda(b"pool_authority", &DBC_PROGRAM_ID));
        assert_eq!(DAMM_POOL_AUTHORITY, pda(b"pool_authority", &DAMM_V2_PROGRAM_ID));
        assert_eq!(DBC_EVENT_AUTHORITY, pda(b"__event_authority", &DBC_PROGRAM_ID));
        assert_eq!(DAMM_EVENT_AUTHORITY, pda(b"__event_authority", &DAMM_V2_PROGRAM_ID));
    }

    #[test]
    fn the_idl_files_agree() {
        // The pinned IDLs in shared/idl carry the same discriminators.
        let dbc = include_str!("../../../../../shared/idl/meteora_dbc.json");
        let damm = include_str!("../../../../../shared/idl/meteora_damm_v2.json");
        let has = |idl: &str, d: [u8; 8]| {
            let list = d.iter().map(|b| b.to_string()).collect::<Vec<_>>().join(",\n        ");
            idl.contains(&format!("[\n        {list}\n      ]"))
        };
        for d in [IX_SWAP2, IX_CLAIM_CREATOR_TRADING_FEE, IX_CREATOR_WITHDRAW_SURPLUS, IX_WITHDRAW_MIGRATION_FEE] {
            assert!(has(dbc, d), "{d:?} not in the DBC IDL");
        }
        for d in [IX_SWAP2, IX_CLAIM_POSITION_FEE, IX_ADD_LIQUIDITY, IX_PERMANENT_LOCK_POSITION] {
            assert!(has(damm, d), "{d:?} not in the DAMM v2 IDL");
        }
    }

    #[test]
    fn pool_seeds_put_the_larger_mint_first() {
        let lo = Pubkey::new_from_array([1; 32]);
        let hi = Pubkey::new_from_array([2; 32]);
        let cfg = Pubkey::new_unique();
        assert_eq!(dbc_pool_address(&cfg, &lo, &hi), dbc_pool_address(&cfg, &hi, &lo));
        let expected = Pubkey::find_program_address(&[b"pool", cfg.as_ref(), hi.as_ref(), lo.as_ref()], &DBC_PROGRAM_ID).0;
        assert_eq!(dbc_pool_address(&cfg, &lo, &hi), expected);
    }
}
