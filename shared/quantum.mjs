// Quantum Hooks client, shared by the browser bundle (Vite) and the Node keeper. No Node-only
// imports. Amounts cross this API as bigint (lamports / raw token units); timestamps as numbers.
// Coins launch on Meteora's Dynamic Bonding Curve and migrate to DAMM v2 (see ./meteora.mjs).
import { Buffer } from 'buffer'
import BN from 'bn.js'
import { AnchorProvider, BorshCoder, EventParser, Program } from '@coral-xyz/anchor'
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token'
import {
  DAMM_EVENT_AUTHORITY,
  DAMM_MIGRATION_CONFIGS,
  DAMM_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  PROGRESS,
  SWAP_MODE,
  dammQuote,
  dbcCreatePoolInstruction,
  dbcPoolPda,
  dbcQuote,
  dbcSwapInstructions,
  dbcTransferCreatorInstruction,
  decodeDammPool,
  decodeDbcConfig,
  decodeDbcPool,
  decodePosition,
  fetchMeteoraVenue,
  migratedPoolFor,
  pendingPositionFees,
  positionPda,
} from './meteora.mjs'
import idl from './idl/quantum_hooks.json' with { type: 'json' }

export const QUANTUM_IDL = idl
export const QUANTUM_PROGRAM_ID = new PublicKey(idl.address)
export { DBC_PROGRAM_ID, DAMM_V2_PROGRAM_ID }
export { dbcMigrationInstructions } from './meteora.mjs'
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const BPS = 10_000
export const MAX_SPLITS = 4
export const MAX_PROTOCOL_BPS = 1_000
export const MIN_PULSE_LAMPORTS = 1_000_000n
export const MAX_LOCK_DURATION = 4 * 365 * 86_400
// Entanglement: claims open `config.claimDelay` seconds after an epoch is posted (the authority
// can cancel it until then); a coin gets at most one epoch per MIN_EPOCH_INTERVAL seconds.
// Same values as constants.rs (the `short-expiry` test build shortens the interval to 15 s).
export const DEFAULT_CLAIM_DELAY = 21_600
export const MAX_CLAIM_DELAY = 7 * 86_400
export const MIN_EPOCH_INTERVAL = 20 * 3_600
// A burn or fusion run by anyone but the keeper may spend at most max_burn_lamports / 10.
export const PUBLIC_SPEND_DIVISOR = 10n
// Rent-exempt minimum of a 0-byte account (the well).
export const RENT_EXEMPT_EMPTY = 890_880n
// Rent-exempt minimum of a 165-byte SPL Token account (the well's WSOL ATA). `harvest` refunds it
// to its caller when it closes that ATA; it is never creator fees.
export const RENT_EXEMPT_TOKEN_ACCOUNT = 2_039_280n
// `harvest` legs (bitmask): DBC trading fee, DBC surplus, DBC migration fee, DAMM v2 LP fee.
export const HARVEST = Object.freeze({
  TRADING_FEE: 1,
  SURPLUS: 2,
  MIGRATION_FEE: 4,
  LP_FEE: 8,
  ALL: 15,
})

// Keys the runtime never lets a transaction write-lock (sysvars, builtin and loader programs). A
// split at one of them could never be paid, so `register` rejects them. Same list as
// RESERVED_ACCOUNT_KEYS in programs/quantum-hooks/programs/quantum_hooks/src/constants.rs.
export const RESERVED_ACCOUNT_KEYS = Object.freeze([
  '11111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'Feature111111111111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'StakeConfig11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'ZkE1Gama1Proof11111111111111111111111111111',
  'ZkTokenProof1111111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarEpochRewards1111111111111111111111111',
  'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarFees111111111111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
  'SysvarS1otHistory11111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
])
const RESERVED = new Set(RESERVED_ACCOUNT_KEYS)
export const isReservedAccountKey = (key) => RESERVED.has(b58(key))

const coder = new BorshCoder(idl)
const READONLY_WALLET = Object.freeze({
  publicKey: PublicKey.default,
  signTransaction: async (tx) => tx,
  signAllTransactions: async (txs) => txs,
})

const pk = (value) => (value instanceof PublicKey ? value : new PublicKey(value))
const pid = (programId) => (programId ? pk(programId) : QUANTUM_PROGRAM_ID)
const bn = (value) => new BN(BigInt(value).toString())
const big = (value) => BigInt(value.toString())
const num = (value) => Number(value.toString())
const b58 = (value) => pk(value).toBase58()
const u32le = (value) => {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value)
  return out
}
// Anchor's coder output casing differs between versions; read either.
const field = (raw, snake) => {
  if (snake in raw) return raw[snake]
  const camel = snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
  return raw[camel]
}

// ---------------------------------------------------------------------------------------------
// Program and PDAs
// ---------------------------------------------------------------------------------------------

export function quantumProgram(connection, programId) {
  const provider = new AnchorProvider(connection ?? null, READONLY_WALLET, {
    commitment: 'confirmed',
  })
  return new Program({ ...idl, address: pid(programId).toBase58() }, provider)
}

const find = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, pid(programId))[0]

export const configPda = (programId) => find([Buffer.from('qp-config')], programId)
export const quantumPda = (mint, programId) =>
  find([Buffer.from('quantum'), pk(mint).toBuffer()], programId)
export const wellPda = (mint, programId) =>
  find([Buffer.from('well'), pk(mint).toBuffer()], programId)
export const epochPda = (mint, index, programId) =>
  find([Buffer.from('epoch'), pk(mint).toBuffer(), u32le(Number(index))], programId)
// Quant Pad coins are SPL Token mints (the DBC launch config's token type).
export const lockAta = (mint, programId) =>
  getAssociatedTokenAddressSync(pk(mint), quantumPda(mint, programId), true, TOKEN_PROGRAM_ID)
export const wellTokenAta = (mint, programId, tokenProgram = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(pk(mint), wellPda(mint, programId), true, pk(tokenProgram))
export const wellWsolAta = (mint, programId) =>
  getAssociatedTokenAddressSync(NATIVE_MINT, wellPda(mint, programId), true, TOKEN_PROGRAM_ID)
export const programDataPda = (programId) =>
  PublicKey.findProgramAddressSync([pid(programId).toBuffer()], BPF_UPGRADEABLE_LOADER)[0]

// ---------------------------------------------------------------------------------------------
// Account reads
// ---------------------------------------------------------------------------------------------

// The 8-byte Anchor discriminator every Config, Quantum and Epoch account starts with.
const ACCOUNT_DISCRIMINATORS = Object.fromEntries(
  idl.accounts.map((a) => [a.name, Buffer.from(a.discriminator)]),
)

function hasDiscriminator(data, name) {
  if (!data) return false
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const disc = ACCOUNT_DISCRIMINATORS[name]
  return bytes.length >= disc.length && bytes.subarray(0, disc.length).equals(disc)
}

/**
 * Whether `info` (an AccountInfo, or null) is a live Quantum Hooks `name` account ('Config',
 * 'Quantum' or 'Epoch'): owned by the program and starting with that account's discriminator.
 * Anyone can send lamports to any address, so an address holding lamports proves nothing: a
 * closed or cancelled Epoch PDA that someone re-funded is a System-owned account with no data.
 */
export function isQuantumAccount(info, name, programId) {
  if (!info?.data || !info.owner || !(name in ACCOUNT_DISCRIMINATORS)) return false
  let owner
  try {
    owner = b58(info.owner)
  } catch {
    return false
  }
  return owner === pid(programId).toBase58() && hasDiscriminator(info.data, name)
}

// The decoders return null for bytes that are not that account (another account type, or the
// empty data of a re-funded closed PDA), the same as for a missing account, so callers that
// decode raw getMultipleAccountsInfo results treat such an address as absent.

/** Config fields, or null when `data` is not a Config account. */
export function decodeConfig(data) {
  if (!hasDiscriminator(data, 'Config')) return null
  const raw = coder.accounts.decode('Config', Buffer.from(data))
  return {
    authority: b58(field(raw, 'authority')),
    treasury: b58(field(raw, 'treasury')),
    keeper: b58(field(raw, 'keeper')),
    protocolBps: num(field(raw, 'protocol_bps')),
    maxBurnLamports: big(field(raw, 'max_burn_lamports')),
    minActionInterval: num(field(raw, 'min_action_interval')),
    keeperGrace: num(field(raw, 'keeper_grace')),
    paused: !!field(raw, 'paused'),
    bump: num(field(raw, 'bump')),
    claimDelay: num(field(raw, 'claim_delay')),
    // Bumped by every config change; update_config must name the version it was built on.
    version: num(field(raw, 'version')),
    // Meteora DBC configs new coins may launch under.
    launchConfigs: field(raw, 'launch_configs')
      .slice(0, num(field(raw, 'launch_config_count')))
      .map(b58),
  }
}

/** Most a non-keeper burn or fusion may spend (bigint lamports). */
export const publicSpendCap = (config) => BigInt(config.maxBurnLamports) / PUBLIC_SPEND_DIVISOR

/** Quantum fields, or null when `data` is not a Quantum account. */
export function decodeQuantum(data) {
  if (!hasDiscriminator(data, 'Quantum')) return null
  const raw = coder.accounts.decode('Quantum', Buffer.from(data))
  const splitCount = num(field(raw, 'split_count'))
  const u64 = (name) => big(field(raw, name))
  const i64 = (name) => num(field(raw, name))
  const splitOwed = field(raw, 'split_owed').map(big)
  const launcherOwed = u64('launcher_owed')
  const protocolOwed = u64('protocol_owed')
  return {
    mint: b58(field(raw, 'mint')),
    launcher: b58(field(raw, 'launcher')),
    bump: num(field(raw, 'bump')),
    wellBump: num(field(raw, 'well_bump')),
    createdAt: i64('created_at'),
    creatorBps: num(field(raw, 'creator_bps')),
    burnBps: num(field(raw, 'burn_bps')),
    entangleBps: num(field(raw, 'entangle_bps')),
    fusionBps: num(field(raw, 'fusion_bps')),
    splitCount,
    splits: field(raw, 'splits')
      .slice(0, splitCount)
      .map((s) => ({ wallet: b58(s.wallet), bps: num(s.bps) })),
    burnReserve: u64('burn_reserve'),
    entangleReserve: u64('entangle_reserve'),
    entangleOwed: u64('entangle_owed'),
    fusionReserve: u64('fusion_reserve'),
    totalCollected: u64('total_collected'),
    totalProtocol: u64('total_protocol'),
    totalCreatorPaid: u64('total_creator_paid'),
    totalBurnSol: u64('total_burn_sol'),
    totalBurnedTokens: u64('total_burned_tokens'),
    totalClaimed: u64('total_claimed'),
    totalFusedSol: u64('total_fused_sol'),
    epochCount: num(field(raw, 'epoch_count')),
    lockedAmount: u64('locked_amount'),
    releasedAmount: u64('released_amount'),
    lockStart: i64('lock_start'),
    lockCliff: i64('lock_cliff'),
    lockEnd: i64('lock_end'),
    lastBurnAt: i64('last_burn_at'),
    lastFusionAt: i64('last_fusion_at'),
    plannedCliffSecs: i64('planned_cliff_secs'),
    plannedDurationSecs: i64('planned_duration_secs'),
    // Unix seconds of the newest Entanglement epoch (0 = none); the next may be posted at
    // lastEpochAt + MIN_EPOCH_INTERVAL.
    lastEpochAt: i64('last_epoch_at'),
    // When the coin's bonding curve filled (DBC finish_curve_timestamp; 0 = not yet).
    graduatedAt: i64('graduated_at'),
    // Shares a pulse could not pay yet (the recipient would stay below its rent minimum), held in
    // the well and paid first once the recipient can receive. splitOwed follows `splits`.
    splitOwed: splitOwed.slice(0, splitCount),
    launcherOwed,
    protocolOwed,
    owedTotal: splitOwed.reduce((a, b) => a + b, launcherOwed + protocolOwed),
    // Meteora venue (see `sync`): the DBC config and pool from `register`; the DAMM v2 pool, the
    // well's position and its NFT account once the coin has migrated (null before).
    dbcConfig: b58(field(raw, 'dbc_config')),
    dbcPool: b58(field(raw, 'dbc_pool')),
    dammPool: optionalKey(field(raw, 'damm_pool')),
    dammPosition: optionalKey(field(raw, 'damm_position')),
    dammNftAccount: optionalKey(field(raw, 'damm_nft_account')),
    // When `sync` saw the well become the DBC pool's creator (0 = not yet), and whether that was
    // before the first trade (the launcher never held a creator fee).
    boundAt: i64('bound_at'),
    birthBound: !!field(raw, 'birth_bound'),
    migratedAt: i64('migrated_at'),
    totalHarvested: u64('total_harvested'),
    totalFusedLiquidity: big(field(raw, 'total_fused_liquidity')),
  }
}

const optionalKey = (key) => (pk(key).equals(PublicKey.default) ? null : b58(key))

/** Epoch fields, or null when `data` is not an Epoch account. */
export function decodeEpoch(data) {
  if (!hasDiscriminator(data, 'Epoch')) return null
  const raw = coder.accounts.decode('Epoch', Buffer.from(data))
  return {
    mint: b58(field(raw, 'mint')),
    index: num(field(raw, 'index')),
    root: Uint8Array.from(field(raw, 'root')),
    total: big(field(raw, 'total')),
    claimed: big(field(raw, 'claimed')),
    leafCount: num(field(raw, 'leaf_count')),
    createdAt: num(field(raw, 'created_at')),
    // Claims open here (unix seconds); before it `claim_entanglement` fails with ClaimNotOpen and
    // the authority may cancel the epoch.
    claimStart: num(field(raw, 'claim_start')),
    expiresAt: num(field(raw, 'expires_at')),
    payer: b58(field(raw, 'payer')),
    bitmap: Uint8Array.from(field(raw, 'bitmap')),
  }
}

// The fetchers return null unless the address holds a live Quantum Hooks account of that type
// (see isQuantumAccount), so a cancelled or closed epoch reads as gone even after a re-funding.

export async function fetchConfig(connection, programId) {
  const info = await connection.getAccountInfo(configPda(programId))
  return isQuantumAccount(info, 'Config', programId) ? decodeConfig(info.data) : null
}

export async function fetchQuantum(connection, mint, programId) {
  const info = await connection.getAccountInfo(quantumPda(mint, programId))
  if (!isQuantumAccount(info, 'Quantum', programId)) return null
  return { ...decodeQuantum(info.data), well: wellPda(mint, programId).toBase58() }
}

export async function fetchEpoch(connection, mint, index, programId) {
  const info = await connection.getAccountInfo(epochPda(mint, index, programId))
  return isQuantumAccount(info, 'Epoch', programId) ? decodeEpoch(info.data) : null
}

export function isLeafClaimed(epoch, leafIndex) {
  return (epoch.bitmap[leafIndex >> 3] & (1 << (leafIndex & 7))) !== 0
}

/** Whether `epoch`'s claims are open at `nowSecs` (after claimStart, before expiresAt). */
export function isEpochClaimable(epoch, nowSecs) {
  const now = Number(nowSecs)
  return now >= Number(epoch.claimStart ?? 0) && now < Number(epoch.expiresAt)
}

/** Unix seconds from which the next Entanglement epoch of `quantum` may be posted. */
export const nextEpochAt = (quantum) => Number(quantum.lastEpochAt ?? 0) + MIN_EPOCH_INTERVAL

const reservedOf = (q) =>
  q.burnReserve + q.entangleReserve + q.entangleOwed + q.fusionReserve + (q.owedTotal ?? 0n)

// The well's lamports above rent and module ledgers. fetchWellBalance().unallocated and the
// well term of pendingCreatorFees must be this same amount: the keeper subtracts one from the
// other to see creator fees still outside the well.
function wellLedger(wellInfo, quantumInfo, programId) {
  const lamports = BigInt(wellInfo?.lamports ?? 0)
  const reserved = isQuantumAccount(quantumInfo, 'Quantum', programId)
    ? reservedOf(decodeQuantum(quantumInfo.data))
    : 0n
  const free = lamports - RENT_EXEMPT_EMPTY - reserved
  return { lamports, reserved, unallocated: free > 0n ? free : 0n }
}

/** The well's lamports split into rent, module ledgers and what the next pulse would allocate. */
export async function fetchWellBalance(connection, mint, programId) {
  const [wellInfo, quantumInfo] = await connection.getMultipleAccountsInfo([
    wellPda(mint, programId),
    quantumPda(mint, programId),
  ])
  const { lamports, reserved, unallocated } = wellLedger(wellInfo, quantumInfo, programId)
  return { lamports, rentExempt: RENT_EXEMPT_EMPTY, reserved, unallocated }
}

function tokenAmount(address, info, programId) {
  if (!info || !info.owner.equals(programId)) return 0n
  try {
    return unpackAccount(address, info, programId).amount
  } catch {
    return 0n
  }
}

/** Lamports of the well's WSOL ATA that `harvest` counts as fees (everything above its rent). */
export function wsolFeeLamports(wsolInfo) {
  if (!wsolInfo || !wsolInfo.owner.equals(TOKEN_PROGRAM_ID)) return 0n
  const fees = BigInt(wsolInfo.lamports) - RENT_EXEMPT_TOKEN_ACCOUNT
  return fees > 0n ? fees : 0n
}

/**
 * Lamports a harvest + pulse would allocate right now: the DBC creator trading fee (and, once
 * claimable, the creator surplus is not estimated), the unclaimed LP fee of the well's DAMM v2
 * position, WSOL already in the well's WSOL ATA (not its rent), and unallocated lamports in the
 * well.
 */
export async function pendingCreatorFees(connection, mint, programId) {
  mint = pk(mint)
  const well = wellPda(mint, programId)
  const [wellInfo, quantumInfo, wsolInfo] = await connection.getMultipleAccountsInfo([
    well,
    quantumPda(mint, programId),
    wellWsolAta(mint, programId),
  ])
  let total = wsolFeeLamports(wsolInfo) + wellLedger(wellInfo, quantumInfo, programId).unallocated
  if (!isQuantumAccount(quantumInfo, 'Quantum', programId)) return total
  const quantum = decodeQuantum(quantumInfo.data)
  const keys = [pk(quantum.dbcPool)]
  if (quantum.dammPool) keys.push(pk(quantum.dammPool), pk(quantum.dammPosition))
  const [poolInfo, dammInfo, positionInfo] = await connection.getMultipleAccountsInfo(keys)
  const pool = decodeDbcPool(poolInfo?.data)
  if (pool && pool.creator === well.toBase58()) total += pool.creatorQuoteFee
  const damm = decodeDammPool(dammInfo?.data)
  const position = decodePosition(positionInfo?.data)
  if (damm && position) total += pendingPositionFees(damm, position).b
  return total
}

/**
 * The binding clients check: `mint` is registered, its DBC pool exists and pays the well (the well
 * is the pool's creator), and whether that happened before the first trade (`birthBound`, recorded
 * by `sync`). `complete` is true once the curve has filled.
 */
export async function verifyQuantumCoin(connection, mint, programId) {
  mint = pk(mint)
  const quantumInfo = await connection.getAccountInfo(quantumPda(mint, programId))
  if (!isQuantumAccount(quantumInfo, 'Quantum', programId))
    return {
      registered: false,
      poolExists: false,
      creatorIsWell: false,
      complete: false,
      birthBound: false,
    }
  const quantum = decodeQuantum(quantumInfo.data)
  const poolInfo = await connection.getAccountInfo(pk(quantum.dbcPool))
  const pool = decodeDbcPool(poolInfo?.data)
  return {
    registered: true,
    poolExists: !!pool,
    creatorIsWell: !!pool && pool.creator === wellPda(mint, programId).toBase58(),
    complete: !!pool && pool.migrationProgress > PROGRESS.PRE,
    migrated: !!pool?.isMigrated,
    bound: quantum.boundAt > 0,
    birthBound: quantum.birthBound,
  }
}

/** Time Dilation: vested raw tokens at `nowSecs` (zero before the cliff, linear to the end). */
export function vestedAmount(quantum, nowSecs) {
  const locked = BigInt(quantum.lockedAmount ?? 0)
  const now = Number(nowSecs)
  if (locked === 0n || now < Number(quantum.lockCliff)) return 0n
  if (now >= Number(quantum.lockEnd)) return locked
  const duration = BigInt(Number(quantum.lockEnd) - Number(quantum.lockStart))
  if (duration <= 0n) return locked
  const elapsed = BigInt(Math.max(0, now - Number(quantum.lockStart)))
  const vested = (locked * elapsed) / duration
  return vested > locked ? locked : vested
}

/** Releasable now = vested − released. */
export function releasableAmount(quantum, nowSecs) {
  const out = vestedAmount(quantum, nowSecs) - BigInt(quantum.releasedAmount ?? 0)
  return out > 0n ? out : 0n
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

function plain(value) {
  if (value === null || value === undefined) return value
  if (BN.isBN(value)) return big(value)
  // Duck-typed: under Node the SDKs' CommonJS web3.js and this module's ESM copy are different classes.
  if (value instanceof PublicKey || (typeof value.toBase58 === 'function' && value._bn))
    return value.toBase58()
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'number') && value.length === 32
      ? Uint8Array.from(value)
      : value.map(plain)
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value))
      out[k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = plain(v)
    return out
  }
  return value
}

/** Decoded Anchor events this program emitted in a transaction's log messages. */
export function decodeQuantumEvents(logMessages, programId) {
  if (!logMessages?.length) return []
  const parser = new EventParser(pid(programId), coder)
  const out = []
  for (const event of parser.parseLogs(logMessages))
    out.push({ name: event.name, data: plain(event.data) })
  return out
}

// ---------------------------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------------------------

/**
 * Split wallets `register` refuses: sysvars, builtin and loader programs (the runtime never lets
 * them be written, so they could never be paid), this program, Meteora's DBC and DAMM v2, and,
 * when `mint` is known, the coin's well and Quantum account.
 */
function unpayableSplitWallets({ mint, programId } = {}) {
  const out = new Set([
    ...RESERVED_ACCOUNT_KEYS,
    pid(programId).toBase58(),
    DBC_PROGRAM_ID.toBase58(),
    DAMM_V2_PROGRAM_ID.toBase58(),
  ])
  if (mint) {
    out.add(wellPda(mint, programId).toBase58())
    out.add(quantumPda(mint, programId).toBase58())
  }
  return out
}

export function validateHooks(hooks, { mint, programId } = {}) {
  const {
    creatorBps = 0,
    burnBps = 0,
    entangleBps = 0,
    fusionBps = 0,
    splits = [],
    lock = null,
  } = hooks || {}
  const unpayable = unpayableSplitWallets({ mint, programId })
  for (const v of [creatorBps, burnBps, entangleBps, fusionBps])
    if (!Number.isInteger(v) || v < 0 || v > BPS)
      throw new Error('Allocation bps must be integers in 0..10000')
  if (creatorBps + burnBps + entangleBps + fusionBps !== BPS)
    throw new Error('Allocation bps must sum to 10000')
  if (splits.length > MAX_SPLITS) throw new Error(`At most ${MAX_SPLITS} Superposition splits`)
  const seen = new Set()
  let sum = 0
  for (const s of splits) {
    if (!Number.isInteger(s.bps) || s.bps < 1 || s.bps > BPS)
      throw new Error('Split bps must be 1..10000')
    const wallet = b58(s.wallet)
    if (unpayable.has(wallet))
      throw new Error(
        `${wallet} cannot be a split wallet: use an ordinary wallet address, not a system or program address`,
      )
    if (seen.has(wallet)) throw new Error('Split wallets must be unique')
    seen.add(wallet)
    sum += s.bps
  }
  if (sum > BPS) throw new Error('Split bps must sum to at most 10000')
  if (lock) {
    const { bps, cliffSecs, durationSecs } = lock
    if (!Number.isInteger(bps) || bps < 1 || bps > BPS) throw new Error('Lock bps must be 1..10000')
    if (!(Number.isInteger(durationSecs) && durationSecs > 0 && durationSecs <= MAX_LOCK_DURATION))
      throw new Error('Lock duration must be 1 second to 4 years')
    if (!(Number.isInteger(cliffSecs) && cliffSecs >= 0 && cliffSecs <= durationSecs))
      throw new Error('Lock cliff must be between 0 and the duration')
  }
  return { creatorBps, burnBps, entangleBps, fusionBps, splits, lock }
}

/** The DBC launch config (decoded; throws if `address` is not a DBC config). */
export async function fetchLaunchConfig(connection, address) {
  const info = await connection.getAccountInfo(pk(address))
  const config = decodeDbcConfig(info?.data)
  if (!config || !info.owner.equals(DBC_PROGRAM_ID))
    throw new Error(`${b58(address)} is not a Meteora DBC config`)
  return config
}

/**
 * Tokens a dev buy of `solLamports` gets as the new pool's first trade (DBC charges its minimum fee
 * on a buy in the create's transaction), and the most SOL that buy may take.
 */
export function devBuyQuote(config, solLamports, slippagePct = 1) {
  const lamports = BigInt(solLamports)
  const { out } = dbcQuote({ pool: null, config, side: 'buy', amountIn: lamports, firstSwap: true })
  const maxIn = lamports + (lamports * BigInt(Math.round(Number(slippagePct) * 100))) / 10_000n
  return { tokens: out, maxIn }
}

// DBC create (launcher as creator and payer) plus an optional dev buy. The dev buy is an exact-out
// first swap for the quoted tokens, so the amount received is known before signing.
async function meteoraCreateInstructions({
  config,
  configAddress,
  launcher,
  mint,
  name,
  symbol,
  uri,
  devBuy,
}) {
  const create = await dbcCreatePoolInstruction({
    config: configAddress,
    mint,
    creator: launcher,
    payer: launcher,
    name,
    symbol,
    uri,
  })
  if (!devBuy || BigInt(devBuy.solLamports) <= 0n) return { create, buy: [], devBuyTokens: 0n }
  const { tokens, maxIn } = devBuyQuote(config, devBuy.solLamports, devBuy.slippagePct ?? 1)
  if (tokens <= 0n) throw new Error('Dev buy is too small to buy any tokens')
  const buy = await dbcSwapInstructions({
    config: configAddress,
    mint,
    user: launcher,
    side: 'buy',
    amountIn: maxIn,
    minOut: tokens,
    mode: SWAP_MODE.EXACT_OUT,
    firstSwap: true,
  })
  return { create, buy, devBuyTokens: tokens }
}

/**
 * A Quant Pad launch on Meteora. Returned in three stages that must be sent as three
 * transactions, in order:
 *   `register` — launcher + mint keypair sign; binds the hooks to the mint and the DBC config;
 *   `launch`   — DBC create (launcher = creator), transfer_pool_creator → well, `sync` (records
 *                the binding before any trade), then the optional dev buy; launcher + mint sign;
 *                needs the lookup table to fit;
 *   `lock`     — optional; launcher signs.
 * `instructions` is all three concatenated. The caller adds compute-budget instructions.
 */
export async function buildQuantumLaunchInstructions({
  connection,
  launcher,
  mint,
  name,
  symbol,
  uri,
  hooks,
  devBuy = null,
  dbcConfig,
  programId,
}) {
  launcher = pk(launcher)
  mint = pk(mint)
  if (!dbcConfig) throw new Error('dbcConfig (the Meteora launch config) is required')
  const valid = validateHooks(hooks, { mint, programId })
  const program = quantumProgram(connection, programId)
  const well = wellPda(mint, programId)
  const config = await fetchLaunchConfig(connection, dbcConfig)

  const { create, buy, devBuyTokens } = await meteoraCreateInstructions({
    config,
    configAddress: dbcConfig,
    launcher,
    mint,
    name,
    symbol,
    uri,
    devBuy,
  })
  const lockAmount =
    valid.lock && devBuyTokens > 0n ? (devBuyTokens * BigInt(valid.lock.bps)) / BigInt(BPS) : 0n
  const lockTerms = lockAmount > 0n ? valid.lock : null

  const register = await program.methods
    .register({
      creatorBps: valid.creatorBps,
      burnBps: valid.burnBps,
      entangleBps: valid.entangleBps,
      fusionBps: valid.fusionBps,
      splits: valid.splits.map((s) => ({ wallet: pk(s.wallet), bps: s.bps })),
      lock: lockTerms
        ? { cliffSecs: bn(lockTerms.cliffSecs), durationSecs: bn(lockTerms.durationSecs) }
        : null,
    })
    .accountsStrict({
      launcher,
      mint,
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well,
      dbcConfig: pk(dbcConfig),
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  const transfer = await dbcTransferCreatorInstruction({
    config: dbcConfig,
    mint,
    creator: launcher,
    newCreator: well,
  })
  const sync = await buildSyncInstruction({
    connection,
    mint,
    programId,
    dbcPool: dbcPoolPda(dbcConfig, mint),
    damm: null,
  })

  const lock = lockTerms
    ? [
        await buildLockInstruction({
          connection,
          launcher,
          mint,
          amount: lockAmount,
          cliffSecs: lockTerms.cliffSecs,
          durationSecs: lockTerms.durationSecs,
          programId,
        }),
      ]
    : []

  const stages = { register: [register], launch: [create, transfer, sync, ...buy], lock }
  return {
    instructions: [...stages.register, ...stages.launch, ...stages.lock],
    stages,
    devBuyTokens,
    lockAmount,
    dbcPool: dbcPoolPda(dbcConfig, mint),
  }
}

/** A plain Meteora launch (creator = launcher; no Quantum Hooks). */
export async function buildStandardLaunchInstructions({
  connection,
  launcher,
  mint,
  name,
  symbol,
  uri,
  devBuy = null,
  dbcConfig,
}) {
  launcher = pk(launcher)
  mint = pk(mint)
  if (!dbcConfig) throw new Error('dbcConfig (the Meteora launch config) is required')
  const config = await fetchLaunchConfig(connection, dbcConfig)
  const { create, buy, devBuyTokens } = await meteoraCreateInstructions({
    config,
    configAddress: dbcConfig,
    launcher,
    mint,
    name,
    symbol,
    uri,
    devBuy,
  })
  const instructions = [create, ...buy]
  return {
    instructions,
    stages: { register: [], launch: instructions, lock: [] },
    devBuyTokens,
    lockAmount: 0n,
    dbcPool: dbcPoolPda(dbcConfig, mint),
  }
}

// ---------------------------------------------------------------------------------------------
// Keeper actions
// ---------------------------------------------------------------------------------------------

/** The coin mint's token program, read from the mint account's owner. */
export function mintTokenProgram(mintInfo) {
  if (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (mintInfo?.owner?.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error(mintInfo ? 'Mint is not an SPL Token mint' : 'Mint account not found')
}

async function loadQuantum(connection, mint, programId) {
  const quantum = await fetchQuantum(connection, mint, programId)
  if (!quantum) throw new Error(`${b58(mint)} is not a Quantum coin`)
  return quantum
}

/**
 * Where the coin trades now (see meteora.mjs fetchMeteoraVenue): 'curve' (DBC), 'migrating'
 * (curve full, not migrated yet), 'pool' (DAMM v2) or 'none'.
 */
export async function fetchVenue(connection, mint, programId) {
  const quantum = await fetchQuantum(connection, mint, programId)
  return fetchMeteoraVenue(connection, mint, quantum ? { dbcPool: quantum.dbcPool } : {})
}

/**
 * The well's DAMM v2 position after migration: the Token-2022 NFT account the well owns whose
 * position is in `dammPool`. Returns { position, nftAccount, nftMint } or null.
 */
export async function findWellPosition(connection, well, dammPool) {
  const { value } = await connection.getTokenAccountsByOwner(pk(well), {
    programId: TOKEN_2022_PROGRAM_ID,
  })
  for (const { pubkey, account } of value) {
    const parsed = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID)
    if (parsed.amount !== 1n) continue
    const position = positionPda(parsed.mint)
    const decoded = decodePosition((await connection.getAccountInfo(position))?.data)
    if (decoded && decoded.pool === b58(dammPool))
      return { position, nftAccount: pubkey, nftMint: parsed.mint }
  }
  return null
}

/** The migrated pool and the well's position, or null while the coin has not migrated. */
async function findMigration(connection, mint, programId, dbcPool) {
  const venue = await fetchMeteoraVenue(connection, mint, { dbcPool })
  if (venue.kind !== 'pool') return null
  const found = await findWellPosition(connection, wellPda(mint, programId), venue.dammPool)
  if (!found) return null
  return {
    config: DAMM_MIGRATION_CONFIGS[venue.config.migrationFeeOption],
    pool: venue.dammPool,
    position: found.position,
    nftAccount: found.nftAccount,
  }
}

/**
 * `sync` (permissionless): records the well's binding as the DBC pool's creator, the curve's
 * finish time, and, once migrated, the DAMM v2 pool and the well's position (looked up on-chain
 * when `damm` is undefined; pass null to skip). The program verifies everything it records.
 */
export async function buildSyncInstruction({
  connection,
  mint,
  programId,
  dbcPool,
  damm = undefined,
}) {
  mint = pk(mint)
  if (!dbcPool || damm === undefined) {
    const quantum = await loadQuantum(connection, mint, programId)
    dbcPool ??= quantum.dbcPool
    if (damm === undefined)
      damm = quantum.dammPool ? null : await findMigration(connection, mint, programId, dbcPool)
  }
  const dammAccounts = damm
    ? {
        dammConfig: pk(damm.config),
        dammPool: pk(damm.pool),
        dammPosition: pk(damm.position),
        dammNftAccount: pk(damm.nftAccount),
      }
    : { dammConfig: null, dammPool: null, dammPosition: null, dammNftAccount: null }
  return quantumProgram(connection, programId)
    .methods.sync()
    .accountsStrict({
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      dbcPool: pk(dbcPool),
      ...dammAccounts,
    })
    .instruction()
}

/** `harvest(legs)`: the well claims its creator fees into itself. */
export async function buildHarvestInstruction({
  connection,
  caller,
  mint,
  legs = HARVEST.ALL,
  programId,
  quantum,
  pool,
}) {
  caller = pk(caller)
  mint = pk(mint)
  quantum ??= await loadQuantum(connection, mint, programId)
  pool ??= decodeDbcPool((await connection.getAccountInfo(pk(quantum.dbcPool)))?.data)
  if (!pool) throw new Error('The coin has no Meteora DBC pool')
  let damm = {
    dammProgram: null,
    dammPoolAuthority: null,
    dammEventAuthority: null,
    dammPool: null,
    dammPosition: null,
    dammNftAccount: null,
    dammVaultA: null,
    dammVaultB: null,
  }
  if (quantum.dammPool) {
    const state = decodeDammPool((await connection.getAccountInfo(pk(quantum.dammPool)))?.data)
    if (!state) throw new Error('The recorded DAMM v2 pool is missing')
    damm = {
      dammProgram: DAMM_V2_PROGRAM_ID,
      dammPoolAuthority: DAMM_POOL_AUTHORITY,
      dammEventAuthority: DAMM_EVENT_AUTHORITY,
      dammPool: pk(quantum.dammPool),
      dammPosition: pk(quantum.dammPosition),
      dammNftAccount: pk(quantum.dammNftAccount),
      dammVaultA: pk(state.tokenAVault),
      dammVaultB: pk(state.tokenBVault),
    }
  } else legs &= ~HARVEST.LP_FEE
  return quantumProgram(connection, programId)
    .methods.harvest(legs)
    .accountsStrict({
      caller,
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      mint,
      wellTokenAta: wellTokenAta(mint, programId),
      wellWsolAta: wellWsolAta(mint, programId),
      wsolMint: NATIVE_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      dbcProgram: DBC_PROGRAM_ID,
      dbcPoolAuthority: DBC_POOL_AUTHORITY,
      dbcEventAuthority: DBC_EVENT_AUTHORITY,
      dbcConfig: pk(quantum.dbcConfig),
      dbcPool: pk(quantum.dbcPool),
      dbcBaseVault: pk(pool.baseVault),
      dbcQuoteVault: pk(pool.quoteVault),
      ...damm,
    })
    .instruction()
}

/**
 * Harvest + pulse: `sync` first when the binding or a completed migration is not recorded yet,
 * then `harvest` (every leg), then `pulse`. Returns the instructions to send; a caller may split
 * them over transactions in this order.
 */
export async function buildPulseInstructions({ connection, payer, mint, programId }) {
  payer = pk(payer)
  mint = pk(mint)
  let quantum = await loadQuantum(connection, mint, programId)
  const config = await fetchConfig(connection, programId)
  if (!config) throw new Error('Quantum config is not initialized')
  const pool = decodeDbcPool((await connection.getAccountInfo(pk(quantum.dbcPool)))?.data)
  if (!pool) throw new Error('The coin has no Meteora DBC pool')
  const pre = []
  const bound = pool.creator === wellPda(mint, programId).toBase58()
  if (bound) {
    const damm =
      !quantum.dammPool && pool.isMigrated
        ? await findMigration(connection, mint, programId, quantum.dbcPool)
        : null
    if (quantum.boundAt === 0 || damm) {
      pre.push(
        await buildSyncInstruction({ connection, mint, programId, dbcPool: quantum.dbcPool, damm }),
      )
      if (damm)
        quantum = {
          ...quantum,
          dammPool: b58(damm.pool),
          dammPosition: b58(damm.position),
          dammNftAccount: b58(damm.nftAccount),
        }
    }
    pre.push(
      await buildHarvestInstruction({ connection, caller: payer, mint, programId, quantum, pool }),
    )
  }
  const splits = quantum.splits.map((s) => ({
    pubkey: pk(s.wallet),
    isSigner: false,
    isWritable: true,
  }))
  const pulse = await quantumProgram(connection, programId)
    .methods.pulse()
    .accountsStrict({
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      treasury: pk(config.treasury),
      launcher: pk(quantum.launcher),
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(splits)
    .instruction()
  return [...pre, pulse]
}

const slip = (amount, pct) => (amount * BigInt(10_000 - Math.round(Number(pct) * 100))) / 10_000n

async function chainTime(connection) {
  const slot = await connection.getSlot()
  const time = await connection.getBlockTime(slot).catch(() => null)
  return { slot: BigInt(slot), now: BigInt(time ?? Math.floor(Date.now() / 1000)) }
}

/**
 * Quantum Burn: the well buys its coin with `spendLamports` from the burn reserve on its current
 * venue (the DBC curve, or the DAMM v2 pool once migrated and synced) and burns everything it
 * holds. `slippagePct` sets the minimum tokens out. Returns the instructions to send.
 */
export async function buildBurnInstructions({
  connection,
  caller,
  mint,
  spendLamports,
  slippagePct = 3,
  programId,
}) {
  caller = pk(caller)
  mint = pk(mint)
  const spend = BigInt(spendLamports)
  if (spend <= 0n) throw new Error('spendLamports must be positive')
  const quantum = await loadQuantum(connection, mint, programId)
  const { slot, now } = await chainTime(connection)
  let venue
  let minOut
  if (quantum.dammPool) {
    const damm = decodeDammPool((await connection.getAccountInfo(pk(quantum.dammPool)))?.data)
    if (!damm) throw new Error('The recorded DAMM v2 pool is missing')
    minOut = slip(
      dammQuote({ damm, side: 'buy', amountIn: spend, currentPoint: now }).out,
      slippagePct,
    )
    venue = {
      venueProgram: DAMM_V2_PROGRAM_ID,
      venuePoolAuthority: DAMM_POOL_AUTHORITY,
      venueEventAuthority: DAMM_EVENT_AUTHORITY,
      venuePool: pk(quantum.dammPool),
      venueBaseVault: pk(damm.tokenAVault),
      venueQuoteVault: pk(damm.tokenBVault),
      dbcConfig: null,
    }
  } else {
    const [poolInfo, configInfo] = await connection.getMultipleAccountsInfo([
      pk(quantum.dbcPool),
      pk(quantum.dbcConfig),
    ])
    const pool = decodeDbcPool(poolInfo?.data)
    const config = decodeDbcConfig(configInfo?.data)
    if (!pool || !config) throw new Error('The coin has no Meteora DBC pool')
    if (pool.migrationProgress !== PROGRESS.PRE)
      throw new Error('The curve is full: burns resume on DAMM v2 after migration and sync')
    const point = config.activationType === 0 ? slot : now
    minOut = slip(
      dbcQuote({ pool, config, side: 'buy', amountIn: spend, currentPoint: point }).out,
      slippagePct,
    )
    venue = {
      venueProgram: DBC_PROGRAM_ID,
      venuePoolAuthority: DBC_POOL_AUTHORITY,
      venueEventAuthority: DBC_EVENT_AUTHORITY,
      venuePool: pk(quantum.dbcPool),
      venueBaseVault: pk(pool.baseVault),
      venueQuoteVault: pk(pool.quoteVault),
      dbcConfig: pk(quantum.dbcConfig),
    }
  }
  const ix = await quantumProgram(connection, programId)
    .methods.quantumBurn(bn(spend), bn(minOut))
    .accountsStrict({
      caller,
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      mint,
      wellTokenAta: wellTokenAta(mint, programId),
      wellWsolAta: wellWsolAta(mint, programId),
      wsolMint: NATIVE_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      // Read when the caller is not the keeper: a public burn may share its transaction only with
      // compute budget, system, token, ATA and Quantum Hooks instructions, and spends at most
      // max_burn_lamports / 10.
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      ...venue,
    })
    .instruction()
  return [ix]
}

/**
 * Fusion (after migration): ~45% of `spendLamports` buys the coin on the DAMM v2 pool, then both
 * sides are added to the well's own position and that liquidity is permanently locked. Leftovers
 * are burned / unwrapped by the program.
 */
export async function buildFusionInstructions({
  connection,
  caller,
  mint,
  spendLamports,
  slippagePct = 3,
  programId,
}) {
  caller = pk(caller)
  mint = pk(mint)
  const spend = BigInt(spendLamports)
  const quantum = await loadQuantum(connection, mint, programId)
  if (!quantum.dammPool)
    throw new Error('Fusion needs a migrated coin whose DAMM v2 pool is synced')
  const [poolInfo, positionInfo] = await connection.getMultipleAccountsInfo([
    pk(quantum.dammPool),
    pk(quantum.dammPosition),
  ])
  const damm = decodeDammPool(poolInfo?.data)
  if (!damm || !decodePosition(positionInfo?.data))
    throw new Error('The recorded DAMM v2 pool or position is missing')
  const { now } = await chainTime(connection)
  const swapIn = (spend * 45n) / 100n
  const quote = dammQuote({ damm, side: 'buy', amountIn: swapIn, currentPoint: now })
  const minBaseOut = slip(quote.out, slippagePct)
  // Liquidity the bought coin and the remaining SOL can fund at the post-swap price, with margin.
  const liquidityDelta =
    (fullRangeLiquidity(damm, quote.nextSqrtPrice, minBaseOut, spend - swapIn) * 97n) / 100n
  if (liquidityDelta <= 0n) throw new Error('Fusion spend is too small to add liquidity')
  const ix = await quantumProgram(connection, programId)
    .methods.fusion(bn(spend), bn(swapIn), bn(minBaseOut), bn(liquidityDelta))
    .accountsStrict({
      caller,
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      mint,
      wellTokenAta: wellTokenAta(mint, programId),
      wellWsolAta: wellWsolAta(mint, programId),
      wsolMint: NATIVE_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      dammProgram: DAMM_V2_PROGRAM_ID,
      dammPoolAuthority: DAMM_POOL_AUTHORITY,
      dammEventAuthority: DAMM_EVENT_AUTHORITY,
      dammPool: pk(quantum.dammPool),
      dammPosition: pk(quantum.dammPosition),
      dammNftAccount: pk(quantum.dammNftAccount),
      dammVaultA: pk(damm.tokenAVault),
      dammVaultB: pk(damm.tokenBVault),
    })
    .instruction()
  return [ix]
}

// DAMM v2 concentrated liquidity over the pool's range [sqrtMin, sqrtMax] (Q64.64 sqrt prices): the
// liquidity `amountA` coin and `amountB` lamports fund at sqrt price P (the smaller of the two).
function fullRangeLiquidity(damm, nextSqrtPrice, amountA, amountB) {
  const Q64 = 1n << 64n
  const P = BigInt((nextSqrtPrice ?? damm.raw.sqrtPrice).toString())
  const lo = BigInt(damm.raw.sqrtMinPrice.toString())
  const hi = BigInt(damm.raw.sqrtMaxPrice.toString())
  if (P <= lo || P >= hi) return 0n
  const fromA = (amountA * P * hi) / ((hi - P) * Q64)
  const fromB = (amountB * Q64 * Q64) / (P - lo)
  return fromA < fromB ? fromA : fromB
}

// ---------------------------------------------------------------------------------------------
// Entanglement, Time Dilation and config
// ---------------------------------------------------------------------------------------------

const toBytes32 = (value) => {
  const bytes =
    typeof value === 'string' ? Buffer.from(value.replace(/^0x/, ''), 'hex') : Buffer.from(value)
  if (bytes.length !== 32) throw new Error('Expected 32 bytes')
  return Array.from(bytes)
}

export async function buildPostEpochInstruction({
  connection,
  keeper,
  mint,
  index,
  root,
  total,
  leafCount,
  programId,
}) {
  mint = pk(mint)
  if (index === undefined || index === null) {
    const quantum = await fetchQuantum(connection, mint, programId)
    if (!quantum) throw new Error(`${mint.toBase58()} is not a Quantum coin`)
    index = quantum.epochCount
  }
  return quantumProgram(connection, programId)
    .methods.postEntanglement(toBytes32(root), bn(total), Number(leafCount))
    .accountsStrict({
      keeper: pk(keeper),
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      epoch: epochPda(mint, index, programId),
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export async function buildClaimInstruction({
  connection,
  claimant,
  mint,
  index,
  leafIndex,
  amount,
  proof,
  programId,
}) {
  mint = pk(mint)
  return quantumProgram(connection, programId)
    .methods.claimEntanglement(
      Number(index),
      Number(leafIndex),
      bn(amount),
      (proof || []).map(toBytes32),
    )
    .accountsStrict({
      claimant: pk(claimant),
      quantum: quantumPda(mint, programId),
      well: wellPda(mint, programId),
      epoch: epochPda(mint, index, programId),
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export async function buildCloseEpochInstruction({
  connection,
  caller,
  mint,
  index,
  payer,
  programId,
}) {
  mint = pk(mint)
  if (!payer) {
    const epoch = await fetchEpoch(connection, mint, index, programId)
    if (!epoch) throw new Error(`Epoch ${index} of ${mint.toBase58()} does not exist`)
    payer = epoch.payer
  }
  void caller // anyone may close; the fee payer signs the transaction
  return quantumProgram(connection, programId)
    .methods.closeEpoch(Number(index))
    .accountsStrict({
      quantum: quantumPda(mint, programId),
      epoch: epochPda(mint, index, programId),
      payer: pk(payer),
    })
    .instruction()
}

/**
 * Authority only, before the epoch's `claimStart`: returns the epoch's total to the coin's
 * Entanglement reserve and closes the account (its rent goes to `config.keeper`, read from the
 * chain unless `keeper` is given).
 */
export async function buildCancelEpochInstruction({
  connection,
  authority,
  mint,
  index,
  keeper,
  programId,
}) {
  mint = pk(mint)
  if (!keeper) {
    const config = await fetchConfig(connection, programId)
    if (!config) throw new Error('Quantum config is not initialized')
    keeper = config.keeper
  }
  return quantumProgram(connection, programId)
    .methods.cancelEpoch(Number(index))
    .accountsStrict({
      authority: pk(authority),
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      epoch: epochPda(mint, index, programId),
      keeper: pk(keeper),
    })
    .instruction()
}

export async function buildLockInstruction({
  connection,
  launcher,
  mint,
  amount,
  cliffSecs,
  durationSecs,
  programId,
}) {
  launcher = pk(launcher)
  mint = pk(mint)
  return quantumProgram(connection, programId)
    .methods.lock(bn(amount), bn(cliffSecs), bn(durationSecs))
    .accountsStrict({
      launcher,
      quantum: quantumPda(mint, programId),
      mint,
      launcherToken: getAssociatedTokenAddressSync(mint, launcher, true, TOKEN_PROGRAM_ID),
      lockAta: lockAta(mint, programId),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export async function buildReleaseInstruction({ connection, launcher, mint, programId }) {
  launcher = pk(launcher)
  mint = pk(mint)
  return quantumProgram(connection, programId)
    .methods.release()
    .accountsStrict({
      launcher,
      quantum: quantumPda(mint, programId),
      mint,
      launcherToken: getAssociatedTokenAddressSync(mint, launcher, true, TOKEN_PROGRAM_ID),
      lockAta: lockAta(mint, programId),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

/** Only the program's upgrade authority can sign this (prevents front-running the deploy). */
export async function buildInitializeConfigInstruction({
  connection,
  authority,
  treasury,
  keeper,
  protocolBps,
  maxBurnLamports,
  minActionInterval,
  keeperGrace,
  claimDelay = DEFAULT_CLAIM_DELAY,
  programId,
}) {
  return quantumProgram(connection, programId)
    .methods.initializeConfig(
      pk(treasury),
      pk(keeper),
      Number(protocolBps),
      bn(maxBurnLamports),
      bn(minActionInterval),
      bn(keeperGrace),
      bn(claimDelay),
    )
    .accountsStrict({
      authority: pk(authority),
      config: configPda(programId),
      program: pid(programId),
      programData: programDataPda(programId),
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

/**
 * update_config: fields left undefined keep their current on-chain value (requires `connection`).
 * The instruction carries `expectedVersion` (default: the config version read now), so it fails
 * with ConfigChanged if any other change (a pause, a keeper rotation) lands before it. It cannot
 * pause or unpause: use buildSetPausedInstruction.
 */
export async function buildUpdateConfigInstruction({
  connection,
  authority,
  programId,
  expectedVersion,
  ...changes
}) {
  if (changes.paused !== undefined)
    throw new Error('update_config does not change `paused`; use buildSetPausedInstruction')
  const current = await fetchConfig(connection, programId)
  if (!current) throw new Error('Quantum config is not initialized')
  const next = { ...current, newAuthority: current.authority }
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) next[k] = v
  return quantumProgram(connection, programId)
    .methods.updateConfig(
      bn(expectedVersion ?? current.version),
      pk(next.treasury),
      pk(next.keeper),
      Number(next.protocolBps),
      bn(next.maxBurnLamports),
      bn(next.minActionInterval),
      bn(next.keeperGrace),
      bn(next.claimDelay),
      pk(next.newAuthority),
    )
    .accountsStrict({ authority: pk(authority), config: configPda(programId) })
    .instruction()
}

/** set_paused: authority only; always lands (no expected version) and bumps the config version. */
export async function buildSetPausedInstruction({ connection, authority, paused, programId }) {
  if (typeof paused !== 'boolean') throw new Error('paused must be true or false')
  return quantumProgram(connection, programId)
    .methods.setPaused(paused)
    .accountsStrict({ authority: pk(authority), config: configPda(programId) })
    .instruction()
}

/** set_launch_configs: authority only; the Meteora DBC configs new coins may launch under. */
export async function buildSetLaunchConfigsInstruction({
  connection,
  authority,
  configs,
  expectedVersion,
  programId,
}) {
  let version = expectedVersion
  if (version === undefined) {
    const current = await fetchConfig(connection, programId)
    if (!current) throw new Error('Quantum config is not initialized')
    version = current.version
  }
  return quantumProgram(connection, programId)
    .methods.setLaunchConfigs(bn(version), configs.map(pk))
    .accountsStrict({ authority: pk(authority), config: configPda(programId) })
    .instruction()
}
