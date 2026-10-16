// Meteora client pieces shared by the browser, the server and the tests: program ids and PDAs,
// account decoders, quotes, and the instructions Quant Pad sends to Meteora's Dynamic Bonding
// Curve (DBC; launches) and DAMM v2 (the pool a full curve migrates into). Instructions are built
// from the pinned IDLs in shared/idl (see scripts/meteora-idls.mjs); quote maths comes from
// Meteora's MIT SDKs. Amounts cross this API as bigint.
import { Buffer } from 'buffer'
import BN from 'bn.js'
import { AnchorProvider, Program } from '@coral-xyz/anchor'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  getTransferHook,
  unpackMint,
} from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  swapQuoteExactIn as dbcSwapQuoteExactIn,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  getMaxFeeNumerator,
  getTotalTradingFeeFromIncludedFeeAmount,
  getUnClaimLpFee,
  swapQuoteExactInput as dammSwapQuoteExactIn,
} from '@meteora-ag/cp-amm-sdk'
import dbcIdl from './idl/meteora_dbc.json' with { type: 'json' }
import dammIdl from './idl/meteora_damm_v2.json' with { type: 'json' }

const pk = (v) => (v instanceof PublicKey ? v : new PublicKey(v))
const bn = (v) => new BN(BigInt(v).toString())
const big = (v) => BigInt(v.toString())
const find = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0]

export const DBC_PROGRAM_ID = new PublicKey(dbcIdl.address)
export const DAMM_V2_PROGRAM_ID = new PublicKey(dammIdl.address)
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const DBC_POOL_AUTHORITY = find([Buffer.from('pool_authority')], DBC_PROGRAM_ID)
export const DAMM_POOL_AUTHORITY = find([Buffer.from('pool_authority')], DAMM_V2_PROGRAM_ID)
export const DBC_EVENT_AUTHORITY = find([Buffer.from('__event_authority')], DBC_PROGRAM_ID)
export const DAMM_EVENT_AUTHORITY = find([Buffer.from('__event_authority')], DAMM_V2_PROGRAM_ID)
/** DAMM v2 configs DBC migrates into, by the DBC config's `migration_fee_option` (6 = custom). */
export const DAMM_MIGRATION_CONFIGS = DAMM_V2_MIGRATION_FEE_ADDRESS.map((k) => pk(k.toBase58()))

/** DBC `migration_progress`. */
export const PROGRESS = Object.freeze({ PRE: 0, POST: 1, LOCKED_VESTING: 2, MIGRATED: 3 })
export const SWAP_MODE = Object.freeze({ EXACT_IN: 0, PARTIAL_FILL: 1, EXACT_OUT: 2 })

// Both programs key a pool by its two mints, the larger (byte-wise) first.
const ordered = (a, b) => (Buffer.compare(a.toBuffer(), b.toBuffer()) > 0 ? [a, b] : [b, a])

export const dbcPoolPda = (config, baseMint) => {
  const [first, second] = ordered(pk(baseMint), NATIVE_MINT)
  return find(
    [Buffer.from('pool'), pk(config).toBuffer(), first.toBuffer(), second.toBuffer()],
    DBC_PROGRAM_ID,
  )
}
export const dbcVaultPda = (pool, mint) =>
  find([Buffer.from('token_vault'), pk(mint).toBuffer(), pk(pool).toBuffer()], DBC_PROGRAM_ID)
export const metadataPda = (mint) =>
  find(
    [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), pk(mint).toBuffer()],
    METAPLEX_PROGRAM_ID,
  )
export const dammPoolPda = (dammConfig, mint) => {
  const [first, second] = ordered(pk(mint), NATIVE_MINT)
  return find(
    [Buffer.from('pool'), pk(dammConfig).toBuffer(), first.toBuffer(), second.toBuffer()],
    DAMM_V2_PROGRAM_ID,
  )
}
export const positionPda = (nftMint) =>
  find([Buffer.from('position'), pk(nftMint).toBuffer()], DAMM_V2_PROGRAM_ID)
export const positionNftAccountPda = (nftMint) =>
  find([Buffer.from('position_nft_account'), pk(nftMint).toBuffer()], DAMM_V2_PROGRAM_ID)

/** The DAMM v2 pool a coin launched under DBC `config` migrates (or migrated) into. */
export const migratedPoolFor = (config, mint) =>
  dammPoolPda(DAMM_MIGRATION_CONFIGS[Number(config.migrationFeeOption)], mint)

const READONLY_WALLET = Object.freeze({
  publicKey: PublicKey.default,
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
})
const provider = (connection) =>
  new AnchorProvider(connection ?? null, READONLY_WALLET, { commitment: 'confirmed' })
export const dbcProgram = (connection) => new Program(dbcIdl, provider(connection))
export const dammProgram = (connection) => new Program(dammIdl, provider(connection))
// The Program's coder: it camel-cases the IDL, so decoded fields match the SDKs' shapes.
export const dbcCoder = dbcProgram(null).coder
export const dammCoder = dammProgram(null).coder

// ---- accounts ---------------------------------------------------------------------------------

const disc = (idl, name) => Buffer.from(idl.accounts.find((a) => a.name === name).discriminator)
const DISC = {
  VirtualPool: disc(dbcIdl, 'VirtualPool'),
  PoolConfig: disc(dbcIdl, 'PoolConfig'),
  // A Token-2022 coin with a transfer hook (such as $QUANTP) trades in a TransferHookPool under a
  // ConfigWithTransferHook: the same pool state and config wrapped with the hook program.
  TransferHookPool: disc(dbcIdl, 'TransferHookPool'),
  ConfigWithTransferHook: disc(dbcIdl, 'ConfigWithTransferHook'),
  Pool: disc(dammIdl, 'Pool'),
  Position: disc(dammIdl, 'Position'),
}
const is = (data, name) =>
  !!data && data.length >= 8 && Buffer.from(data).subarray(0, 8).equals(DISC[name])

/**
 * Raw DBC VirtualPool (the SDK's shape, for quotes) plus a flat bigint summary; null if not one. A
 * TransferHookPool decodes to the same shape with `transferHook: true`: its swaps need
 * swap2_with_transfer_hook, the Token-2022 program for the coin and the hook's extra accounts.
 */
export function decodeDbcPool(data) {
  const transferHook = is(data, 'TransferHookPool')
  if (!transferHook && !is(data, 'VirtualPool')) return null
  const raw = dbcCoder.accounts.decode(
    transferHook ? 'transferHookPool' : 'virtualPool',
    Buffer.from(data),
  )
  const s = raw.poolState
  return {
    raw,
    transferHook,
    poolType: Number(s.poolType),
    config: s.config.toBase58(),
    creator: s.creator.toBase58(),
    baseMint: s.baseMint.toBase58(),
    baseVault: s.baseVault.toBase58(),
    quoteVault: s.quoteVault.toBase58(),
    baseReserve: big(s.baseReserve),
    quoteReserve: big(s.quoteReserve),
    sqrtPrice: big(s.sqrtPrice),
    activationPoint: big(s.activationPoint),
    isMigrated: !!s.isMigrated,
    migrationProgress: Number(s.migrationProgress),
    creatorQuoteFee: big(s.creatorQuoteFee),
    creatorBaseFee: big(s.creatorBaseFee),
    creatorWithdrewSurplus: !!s.isCreatorWithdrawSurplus,
    migrationFeeWithdrawStatus: Number(s.migrationFeeWithdrawStatus),
    finishCurveTimestamp: Number(s.finishCurveTimestamp),
    hasSwap: !!s.hasSwap,
  }
}

/**
 * Raw DBC PoolConfig (the SDK's shape) plus the fields Quant Pad reads; null if not one. A
 * ConfigWithTransferHook gives its inner PoolConfig as `raw`, plus `transferHookProgram`.
 */
export function decodeDbcConfig(data) {
  const withHook = is(data, 'ConfigWithTransferHook')
  if (!withHook && !is(data, 'PoolConfig')) return null
  const decoded = dbcCoder.accounts.decode(
    withHook ? 'configWithTransferHook' : 'poolConfig',
    Buffer.from(data),
  )
  const raw = withHook ? decoded.config : decoded
  return {
    raw,
    transferHookProgram: withHook ? decoded.transferHookProgram.toBase58() : null,
    quoteMint: raw.quoteMint.toBase58(),
    feeClaimer: raw.feeClaimer.toBase58(),
    migrationQuoteThreshold: big(raw.migrationQuoteThreshold),
    migrationFeeOption: Number(raw.migrationFeeOption),
    tokenDecimal: Number(raw.tokenDecimal),
    tokenType: Number(raw.tokenType),
    activationType: Number(raw.activationType),
    collectFeeMode: Number(raw.collectFeeMode),
    creatorTradingFeePercentage: Number(raw.creatorTradingFeePercentage),
    postMigrationTokenSupply: big(raw.postMigrationTokenSupply),
  }
}

export function decodeDammPool(data) {
  if (!is(data, 'Pool')) return null
  const raw = dammCoder.accounts.decode('pool', Buffer.from(data))
  return {
    raw,
    tokenAMint: raw.tokenAMint.toBase58(),
    tokenBMint: raw.tokenBMint.toBase58(),
    tokenAVault: raw.tokenAVault.toBase58(),
    tokenBVault: raw.tokenBVault.toBase58(),
    sqrtPrice: big(raw.sqrtPrice),
    liquidity: big(raw.liquidity),
    poolStatus: Number(raw.poolStatus),
    collectFeeMode: Number(raw.collectFeeMode),
  }
}

export function decodePosition(data) {
  if (!is(data, 'Position')) return null
  const raw = dammCoder.accounts.decode('position', Buffer.from(data))
  return {
    raw,
    pool: raw.pool.toBase58(),
    nftMint: raw.nftMint.toBase58(),
    unlockedLiquidity: big(raw.unlockedLiquidity),
    permanentLockedLiquidity: big(raw.permanentLockedLiquidity),
  }
}

/** Unclaimed LP fees of a position (quote side = B), bigint lamports. */
export function pendingPositionFees(dammPool, position) {
  const { feeTokenA, feeTokenB } = getUnClaimLpFee(dammPool.raw, position.raw)
  return { a: big(feeTokenA), b: big(feeTokenB) }
}

// ---- Token-2022 transfer hooks ------------------------------------------------------------------

const readonlyMeta = (pubkey) => ({ pubkey: pk(pubkey), isSigner: false, isWritable: false })

/**
 * The program a Token-2022 mint calls on every transfer (a PublicKey), or null: an SPL Token mint,
 * a mint without the TransferHook extension, or one whose hook was revoked. DBC revokes a
 * TransferHookPool coin's hook after the curve's last swap, which leaves the extension in place
 * with no program, so the coin trades as plain Token-2022 in its DAMM v2 pool.
 */
export function transferHookProgram(mint, mintInfo) {
  if (!mintInfo?.owner || !pk(mintInfo.owner).equals(TOKEN_2022_PROGRAM_ID)) return null
  const info = { ...mintInfo, owner: TOKEN_2022_PROGRAM_ID, data: Buffer.from(mintInfo.data) }
  const hook = getTransferHook(unpackMint(pk(mint), info, TOKEN_2022_PROGRAM_ID))
  return hook && !hook.programId.equals(PublicKey.default) ? hook.programId : null
}

/**
 * The extra accounts a transfer of `mint` from `source` to `destination`, authorised by `owner`,
 * needs for the mint's transfer hook, in the order Token-2022 takes them after the transfer's own
 * accounts: the extras resolved from the hook's extra-account-metas account, then the hook program
 * and that account. Always read from the chain, never hard-coded: whoever controls the hook can
 * upgrade it and change them. [] when the mint has no active hook. `mintInfo` saves the mint read.
 */
export async function transferHookAccounts(
  connection,
  mint,
  { source, destination, owner, amount = 0n, mintInfo } = {},
) {
  mint = pk(mint)
  const info = mintInfo ?? (await connection.getAccountInfo(mint))
  if (!info) throw new Error('That mint does not exist on Solana.')
  const program = transferHookProgram(mint, info)
  if (!program) return []
  const metas = getExtraAccountMetaAddress(mint, program)
  const metasInfo = await connection.getAccountInfo(metas)
  // A hook without a metas account takes no extras, but Token-2022 still looks for the program
  // (and, in older versions, for the metas address).
  if (!metasInfo) return [readonlyMeta(program), readonlyMeta(metas)]
  const base = [source, mint, destination, owner].map(readonlyMeta)
  const transfer = new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [...base],
    data: Buffer.alloc(0),
  })
  // spl-token's resolver (every seed kind) re-reads the metas account: answer it from this read.
  const reader = {
    getAccountInfo: (key, commitment) =>
      key.equals(metas) ? Promise.resolve(metasInfo) : connection.getAccountInfo(key, commitment),
  }
  await addExtraAccountMetasForExecute(
    reader,
    transfer,
    program,
    base[0].pubkey,
    mint,
    base[2].pubkey,
    base[3].pubkey,
    BigInt(amount),
  )
  return transfer.keys.slice(base.length)
}

/**
 * Where a DBC coin trades now. `kind`: 'curve' (DBC, before the threshold), 'migrating' (curve
 * full, waiting for migration: nothing can trade), 'pool' (DAMM v2), or 'none'.
 */
export async function fetchMeteoraVenue(connection, mint, { dbcConfig, dbcPool } = {}) {
  mint = pk(mint)
  let poolKey = dbcPool ? pk(dbcPool) : dbcConfig ? dbcPoolPda(dbcConfig, mint) : null
  if (!poolKey) throw new Error('fetchMeteoraVenue needs the DBC config or pool')
  const poolInfo = await connection.getAccountInfo(poolKey)
  const pool = decodeDbcPool(poolInfo?.data)
  if (!pool || pool.baseMint !== mint.toBase58()) return { kind: 'none', dbcPool: poolKey }
  const configInfo = await connection.getAccountInfo(pk(pool.config))
  const config = decodeDbcConfig(configInfo?.data)
  const base = { dbcPool: poolKey, pool, config }
  if (pool.migrationProgress === PROGRESS.PRE) return { kind: 'curve', ...base }
  const dammKey = migratedPoolFor(config, mint)
  const dammInfo = pool.isMigrated ? await connection.getAccountInfo(dammKey) : null
  const damm = decodeDammPool(dammInfo?.data)
  if (!damm) return { kind: 'migrating', ...base, dammPool: dammKey }
  return { kind: 'pool', ...base, dammPool: dammKey, damm }
}

// ---- quotes -----------------------------------------------------------------------------------

/** The state of a pool that does not exist yet (its first trade, made in the launch transaction). */
export function freshDbcPool(config) {
  const zero = new BN(0)
  return {
    poolState: {
      sqrtPrice: config.raw.sqrtStartPrice,
      quoteReserve: zero,
      baseReserve: zero,
      activationPoint: zero,
      volatilityTracker: {
        lastUpdateTimestamp: zero,
        padding: [],
        sqrtPriceReference: zero,
        volatilityAccumulator: zero,
        volatilityReference: zero,
      },
    },
  }
}

// Both programs price the coin in SOL as (sqrtPrice / 2^64)^2 raw lamports per raw token.
const spotPrice = (sqrtPrice) => (Number(big(sqrtPrice)) / 2 ** 64) ** 2

/**
 * The pool fee and price impact of an SDK quote `q` (either program's swap result). `fee` is the
 * whole pool fee in bigint raw units of `feeToken`: 'sol', or 'token' when the pool takes it from
 * the coin (a DAMM v2 pool that collects both tokens takes a buy's fee from the coins it pays out).
 * `impact` is how far the trade's price before fees sits from the pool price, as a fraction
 * (0.01 = 1%): what the trade's size costs on top of the fee. Null when it cannot be priced.
 */
export function swapQuoteDetails(q, side, sqrtPrice) {
  const fee = ['tradingFee', 'claimingFee', 'compoundingFee', 'protocolFee', 'referralFee'].reduce(
    (sum, key) => sum + (q[key] ? big(q[key]) : 0n),
    0n,
  )
  const out = big(q.outputAmount)
  const netIn = big(q.excludedFeeInputAmount ?? q.includedFeeInputAmount ?? 0)
  const feeOnInput = big(q.includedFeeInputAmount ?? netIn) > netIn
  const feeToken = fee === 0n || (side === 'buy') === feeOnInput ? 'sol' : 'token'
  const grossOut = feeOnInput ? out : out + fee
  const [tokens, lamports] = side === 'buy' ? [grossOut, netIn] : [netIn, grossOut]
  const spot = spotPrice(sqrtPrice ?? 0)
  const paid = tokens > 0n ? Number(lamports) / Number(tokens) : 0
  const impact =
    spot > 0 && paid > 0 ? Math.max(0, side === 'buy' ? paid / spot - 1 : 1 - paid / spot) : null
  return { fee, feeToken, impact }
}

/**
 * DBC quote, exact SOL in (`buy`) or exact tokens in (sell). `pool` null = the first trade on a
 * new pool (`firstSwap`: DBC charges the minimum fee when the swap shares the create's
 * transaction). Returns bigint { out, minOut, fee } with `feeToken` and `impact`
 * (swapQuoteDetails).
 */
export function dbcQuote({
  pool,
  config,
  side,
  amountIn,
  slippageBps = 0,
  currentPoint,
  firstSwap = false,
}) {
  const state = pool ? pool.raw : freshDbcPool(config)
  const q = dbcSwapQuoteExactIn(
    state,
    config.raw,
    side === 'sell',
    bn(amountIn),
    slippageBps,
    false,
    bn(currentPoint ?? 0),
    firstSwap,
  )
  return {
    ...swapQuoteDetails(q, side, state.poolState.sqrtPrice),
    out: big(q.outputAmount),
    minOut: big(q.minimumAmountOut),
    fee: big(q.tradingFee) + big(q.protocolFee),
  }
}

/**
 * DBC `migration_damm_v2` (permissionless) for a full curve: Meteora creates the coin's DAMM v2
 * pool and hands the creator and partner their LP positions. Returns { instructions, signers }
 * (the two position NFT mints sign).
 */
export async function dbcMigrationInstructions({ connection, payer, dbcPool }) {
  const pool = decodeDbcPool((await connection.getAccountInfo(pk(dbcPool)))?.data)
  if (!pool) throw new Error('Not a DBC pool.')
  const config = decodeDbcConfig((await connection.getAccountInfo(pk(pool.config)))?.data)
  const built = await new DynamicBondingCurveClient(
    connection,
    'confirmed',
  ).migration.migrateToDammV2({
    payer: pk(payer),
    pool: pk(dbcPool),
    dammConfig: DAMM_MIGRATION_CONFIGS[config.migrationFeeOption],
  })
  // The sender sets the compute budget: a second set of budget instructions fails the transaction.
  return {
    instructions: built.transaction.instructions.filter(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
    ),
    signers: [built.firstPositionNftKeypair, built.secondPositionNftKeypair],
  }
}

/**
 * DAMM v2 quote, exact in. Token A is the coin, B is WSOL. Returns bigint { out, minOut } with
 * `fee`, `feeToken` and `impact` (swapQuoteDetails).
 */
export function dammQuote({ damm, side, amountIn, slippageBps = 0, currentPoint, decimals = 6 }) {
  const q = dammSwapQuoteExactIn(
    damm.raw,
    bn(currentPoint ?? 0),
    bn(amountIn),
    slippageBps,
    side === 'sell',
    false,
    decimals,
    9,
  )
  const outputAmount = q.outputAmount ?? q.outAmount
  return {
    ...swapQuoteDetails({ ...q, outputAmount }, side, damm.raw.sqrtPrice),
    out: big(outputAmount),
    minOut: big(q.minimumAmountOut ?? q.minOutAmount),
    nextSqrtPrice: q.nextSqrtPrice ? big(q.nextSqrtPrice) : null,
  }
}

/**
 * The fee a DAMM v2 pool charges a trade at `currentPoint`, in bps: its base fee (on a schedule
 * for some pools) plus any dynamic fee, priced on a 1 SOL buy or the same in tokens for a sell.
 */
export function dammFeeBps(damm, currentPoint, side = 'buy') {
  const s = damm.raw
  const numerator = getTotalTradingFeeFromIncludedFeeAmount(
    s.poolFees,
    bn(currentPoint ?? 0),
    s.activationPoint,
    new BN(1_000_000_000),
    side === 'sell' ? 0 : 1, // AtoB sells the coin (A) for SOL (B)
    getMaxFeeNumerator(s.feeVersion),
    s.poolFees.initSqrtPrice,
    s.sqrtPrice,
  )
  return Number(numerator.toString()) / 100_000 // fee numerators are over 1e9
}

// ---- instructions -----------------------------------------------------------------------------

const ata = (mint, owner, program = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(program))

/** Wraps `lamports` into `owner`'s WSOL ATA (created if needed). */
export function wrapSolInstructions(owner, lamports) {
  owner = pk(owner)
  const wsol = ata(NATIVE_MINT, owner)
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, wsol, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsol, lamports: BigInt(lamports) }),
    createSyncNativeInstruction(wsol),
  ]
}
// Closes `owner`'s WSOL ATA, returning all of it as SOL: WSOL a wallet already held is unwrapped
// by a trade too (nothing is lost; it comes back as native SOL).
export const unwrapSolInstruction = (owner) =>
  createCloseAccountInstruction(ata(NATIVE_MINT, owner), pk(owner), pk(owner))

/** DBC `initialize_virtual_pool_with_spl_token` (Metaplex metadata; mint authority revoked). */
export async function dbcCreatePoolInstruction({
  config,
  mint,
  creator,
  payer,
  name,
  symbol,
  uri,
}) {
  const pool = dbcPoolPda(config, mint)
  return dbcProgram()
    .methods.initializeVirtualPoolWithSplToken({ name, symbol, uri })
    .accountsPartial({
      config: pk(config),
      poolAuthority: DBC_POOL_AUTHORITY,
      creator: pk(creator),
      baseMint: pk(mint),
      quoteMint: NATIVE_MINT,
      pool,
      baseVault: dbcVaultPda(pool, mint),
      quoteVault: dbcVaultPda(pool, NATIVE_MINT),
      mintMetadata: metadataPda(mint),
      metadataProgram: METAPLEX_PROGRAM_ID,
      payer: pk(payer ?? creator),
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority: DBC_EVENT_AUTHORITY,
      program: DBC_PROGRAM_ID,
    })
    .instruction()
}

/** DBC `transfer_pool_creator` (only the current creator can sign). */
export async function dbcTransferCreatorInstruction({ config, mint, creator, newCreator }) {
  return dbcProgram()
    .methods.transferPoolCreator()
    .accountsPartial({
      virtualPool: dbcPoolPda(config, mint),
      config: pk(config),
      creator: pk(creator),
      newCreator: pk(newCreator),
      eventAuthority: DBC_EVENT_AUTHORITY,
      program: DBC_PROGRAM_ID,
    })
    .instruction()
}

/**
 * A DBC trade by `user`: SOL → coin (`buy`, `amountIn` lamports) or coin → SOL (`sell`).
 * `mode` is a SWAP_MODE; for EXACT_OUT `amountIn` is the max input and `minOut` the exact output.
 * `firstSwap` passes the Instructions sysvar so a dev buy in the create's transaction pays DBC's
 * minimum fee. Wraps / unwraps SOL around the swap.
 *
 * A Token-2022 coin passes `tokenBaseProgram` (its token account and the swap use it). A coin in a
 * TransferHookPool also passes `transferHookAccounts` (from transferHookAccounts(), for this
 * trade's direction): the swap is then swap2_with_transfer_hook, which DBC requires for that pool
 * and which hands the accounts on to the hook. Without them it is a plain swap2 on SPL Token
 * accounts, as for Quant Pad's own launches.
 */
export async function dbcSwapInstructions({
  config,
  mint,
  user,
  side,
  amountIn,
  minOut = 0n,
  mode = SWAP_MODE.EXACT_IN,
  firstSwap = false,
  tokenBaseProgram = TOKEN_PROGRAM_ID,
  transferHookAccounts: hookAccounts = null,
}) {
  user = pk(user)
  mint = pk(mint)
  tokenBaseProgram = pk(tokenBaseProgram)
  const pool = dbcPoolPda(config, mint)
  const buy = side === 'buy'
  const wsol = ata(NATIVE_MINT, user)
  const coin = ata(mint, user, tokenBaseProgram)
  const [amount0, amount1] = mode === SWAP_MODE.EXACT_OUT ? [minOut, amountIn] : [amountIn, minOut]
  const params = { amount0: bn(amount0), amount1: bn(amount1), swapMode: mode }
  const hook = hookAccounts?.map((a) => ({
    pubkey: pk(a.pubkey),
    isSigner: !!a.isSigner,
    isWritable: !!a.isWritable,
  }))
  const methods = dbcProgram().methods
  // The hook's accounts follow the optional sysvar, described by one TransferHookBase slice.
  const swap = await (
    hook
      ? methods.swap2WithTransferHook(params, {
          slices: hook.length
            ? [{ accountsType: { transferHookBase: {} }, length: hook.length }]
            : [],
        })
      : methods.swap2(params)
  )
    .accountsPartial({
      poolAuthority: DBC_POOL_AUTHORITY,
      config: pk(config),
      pool,
      inputTokenAccount: buy ? wsol : coin,
      outputTokenAccount: buy ? coin : wsol,
      baseVault: dbcVaultPda(pool, mint),
      quoteVault: dbcVaultPda(pool, NATIVE_MINT),
      baseMint: mint,
      quoteMint: NATIVE_MINT,
      payer: user,
      tokenBaseProgram,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      eventAuthority: DBC_EVENT_AUTHORITY,
      program: DBC_PROGRAM_ID,
    })
    .remainingAccounts([
      ...(firstSwap ? [readonlyMeta(SYSVAR_INSTRUCTIONS_PUBKEY)] : []),
      ...(hook ?? []),
    ])
    .instruction()
  return [
    ...(buy
      ? wrapSolInstructions(user, amountIn)
      : [createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT)]),
    createAssociatedTokenAccountIdempotentInstruction(user, coin, user, mint, tokenBaseProgram),
    swap,
    unwrapSolInstruction(user),
  ]
}

/**
 * A DAMM v2 trade by `user` on the migrated pool (exact in, min out). `tokenAProgram` is the
 * coin's token program (Token-2022 for a coin that graduated from a TransferHookPool, whose hook
 * DBC revoked on the way); WSOL is always SPL Token.
 */
export async function dammSwapInstructions({
  damm,
  dammPool,
  mint,
  user,
  side,
  amountIn,
  minOut = 0n,
  tokenAProgram = TOKEN_PROGRAM_ID,
}) {
  user = pk(user)
  mint = pk(mint)
  tokenAProgram = pk(tokenAProgram)
  const buy = side === 'buy'
  const wsol = ata(NATIVE_MINT, user)
  const coin = ata(mint, user, tokenAProgram)
  const swap = await dammProgram()
    .methods.swap2({ amount0: bn(amountIn), amount1: bn(minOut), swapMode: SWAP_MODE.EXACT_IN })
    .accountsPartial({
      poolAuthority: DAMM_POOL_AUTHORITY,
      pool: pk(dammPool),
      inputTokenAccount: buy ? wsol : coin,
      outputTokenAccount: buy ? coin : wsol,
      tokenAVault: pk(damm.tokenAVault),
      tokenBVault: pk(damm.tokenBVault),
      tokenAMint: pk(damm.tokenAMint),
      tokenBMint: pk(damm.tokenBMint),
      payer: user,
      tokenAProgram,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      eventAuthority: DAMM_EVENT_AUTHORITY,
      program: DAMM_V2_PROGRAM_ID,
    })
    .instruction()
  return [
    ...(buy
      ? wrapSolInstructions(user, amountIn)
      : [createAssociatedTokenAccountIdempotentInstruction(user, wsol, user, NATIVE_MINT)]),
    createAssociatedTokenAccountIdempotentInstruction(user, coin, user, mint, tokenAProgram),
    swap,
    unwrapSolInstruction(user),
  ]
}
