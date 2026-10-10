// Quantum Hooks client, shared by the browser bundle (Vite) and the Node keeper. No Node-only
// imports. Amounts cross this API as bigint (lamports / raw token units); timestamps as numbers.
// The browser needs a global `Buffer` (pump.fun's SDK uses it without importing it).
import { Buffer } from 'buffer'
import BN from 'bn.js'
import { AnchorProvider, BorshCoder, EventParser, Program } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  creatorVaultPda,
  getBuyTokenAmountFromSolAmount,
  getFeeRecipient,
  getPumpProgram,
  userVolumeAccumulatorPda,
} from '#pump-sdk'
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  lpMintPda,
  userVolumeAccumulatorPda as ammUserVolumeAccumulatorPda,
} from '@pump-fun/pump-swap-sdk'
import idl from './idl/quantum_hooks.json' with { type: 'json' }

export const QUANTUM_IDL = idl
export const QUANTUM_PROGRAM_ID = new PublicKey(idl.address)
export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const BPS = 10_000
export const MAX_SPLITS = 4
export const MAX_PROTOCOL_BPS = 1_000
export const MIN_PULSE_LAMPORTS = 1_000_000n
export const MAX_LOCK_DURATION = 4 * 365 * 86_400
// Rent-exempt minimum of a 0-byte account (the well, pump.fun's creator vault).
export const RENT_EXEMPT_EMPTY = 890_880n
// Rent-exempt minimum of a 165-byte SPL Token account (the well's WSOL ATA). `pulse` refunds it to
// the transaction payer when it closes that ATA; it is never creator fees.
export const RENT_EXEMPT_TOKEN_ACCOUNT = 2_039_280n

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
export const lockAta = (mint, programId) =>
  getAssociatedTokenAddressSync(pk(mint), quantumPda(mint, programId), true, TOKEN_2022_PROGRAM_ID)
export const wellTokenAta = (mint, programId, tokenProgram = TOKEN_2022_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(pk(mint), wellPda(mint, programId), true, pk(tokenProgram))
export const wellWsolAta = (mint, programId) =>
  getAssociatedTokenAddressSync(NATIVE_MINT, wellPda(mint, programId), true, TOKEN_PROGRAM_ID)
export const programDataPda = (programId) =>
  PublicKey.findProgramAddressSync([pid(programId).toBuffer()], BPF_UPGRADEABLE_LOADER)[0]
export const canonicalPool = (mint) => canonicalPumpPoolPda(pk(mint))

// ---------------------------------------------------------------------------------------------
// Account reads
// ---------------------------------------------------------------------------------------------

export function decodeConfig(data) {
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
  }
}

export function decodeQuantum(data) {
  const raw = coder.accounts.decode('Quantum', Buffer.from(data))
  const splitCount = num(field(raw, 'split_count'))
  const u64 = (name) => big(field(raw, name))
  const i64 = (name) => num(field(raw, name))
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
  }
}

export function decodeEpoch(data) {
  const raw = coder.accounts.decode('Epoch', Buffer.from(data))
  return {
    mint: b58(field(raw, 'mint')),
    index: num(field(raw, 'index')),
    root: Uint8Array.from(field(raw, 'root')),
    total: big(field(raw, 'total')),
    claimed: big(field(raw, 'claimed')),
    leafCount: num(field(raw, 'leaf_count')),
    createdAt: num(field(raw, 'created_at')),
    expiresAt: num(field(raw, 'expires_at')),
    payer: b58(field(raw, 'payer')),
    bitmap: Uint8Array.from(field(raw, 'bitmap')),
  }
}

export async function fetchConfig(connection, programId) {
  const info = await connection.getAccountInfo(configPda(programId))
  return info ? decodeConfig(info.data) : null
}

export async function fetchQuantum(connection, mint, programId) {
  const info = await connection.getAccountInfo(quantumPda(mint, programId))
  if (!info) return null
  return { ...decodeQuantum(info.data), well: wellPda(mint, programId).toBase58() }
}

export async function fetchEpoch(connection, mint, index, programId) {
  const info = await connection.getAccountInfo(epochPda(mint, index, programId))
  return info ? decodeEpoch(info.data) : null
}

export function isLeafClaimed(epoch, leafIndex) {
  return (epoch.bitmap[leafIndex >> 3] & (1 << (leafIndex & 7))) !== 0
}

const reservedOf = (q) => q.burnReserve + q.entangleReserve + q.entangleOwed + q.fusionReserve

// The well's lamports above rent and module ledgers. fetchWellBalance().unallocated and the
// well term of pendingCreatorFees must be this same amount: the keeper subtracts one from the
// other to see creator fees still outside the well.
function wellLedger(wellInfo, quantumInfo) {
  const lamports = BigInt(wellInfo?.lamports ?? 0)
  const reserved = quantumInfo ? reservedOf(decodeQuantum(quantumInfo.data)) : 0n
  const free = lamports - RENT_EXEMPT_EMPTY - reserved
  return { lamports, reserved, unallocated: free > 0n ? free : 0n }
}

/** The well's lamports split into rent, module ledgers and what the next pulse would allocate. */
export async function fetchWellBalance(connection, mint, programId) {
  const [wellInfo, quantumInfo] = await connection.getMultipleAccountsInfo([
    wellPda(mint, programId),
    quantumPda(mint, programId),
  ])
  const { lamports, reserved, unallocated } = wellLedger(wellInfo, quantumInfo)
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

/** Lamports of the well's WSOL ATA that `pulse` counts as fees (everything above its rent). */
export function wsolFeeLamports(wsolInfo) {
  if (!wsolInfo || !wsolInfo.owner.equals(TOKEN_PROGRAM_ID)) return 0n
  const fees = BigInt(wsolInfo.lamports) - RENT_EXEMPT_TOKEN_ACCOUNT
  return fees > 0n ? fees : 0n
}

/**
 * Lamports a pulse would allocate right now: pump.fun creator vault (curve, above rent) and the
 * unswept curve bucket, the PumpSwap coin-creator vault and unswept pool bucket, WSOL already in
 * the well's WSOL ATA (not its rent, which `pulse` refunds), and unallocated lamports in the well.
 */
export async function pendingCreatorFees(connection, mint, programId) {
  mint = pk(mint)
  const well = wellPda(mint, programId)
  const pool = canonicalPumpPoolPda(mint)
  const ammVaultAta = coinCreatorVaultAtaPda(
    coinCreatorVaultAuthorityPda(well),
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
  )
  const wsolAta = wellWsolAta(mint, programId)
  const [wellInfo, quantumInfo, curveInfo, vaultInfo, poolInfo, ammVaultInfo, wsolInfo] =
    await connection.getMultipleAccountsInfo([
      well,
      quantumPda(mint, programId),
      bondingCurvePda(mint),
      creatorVaultPda(well),
      pool,
      ammVaultAta,
      wsolAta,
    ])
  let total = 0n
  if (vaultInfo && BigInt(vaultInfo.lamports) > RENT_EXEMPT_EMPTY)
    total += BigInt(vaultInfo.lamports) - RENT_EXEMPT_EMPTY
  if (curveInfo) {
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo)
    if (curve.creator.equals(well)) total += big(curve.creatorFee)
  }
  if (poolInfo) {
    const decoded = PUMP_AMM_SDK.decodePool(poolInfo)
    if (decoded.coinCreator.equals(well)) total += big(decoded.creatorFees)
  }
  total += tokenAmount(ammVaultAta, ammVaultInfo, TOKEN_PROGRAM_ID)
  total += wsolFeeLamports(wsolInfo)
  total += wellLedger(wellInfo, quantumInfo).unallocated
  return total
}

/** Whether `mint` is registered and its pump.fun curve pays the well (the binding clients check). */
export async function verifyQuantumCoin(connection, mint, programId) {
  mint = pk(mint)
  const [quantumInfo, curveInfo] = await connection.getMultipleAccountsInfo([
    quantumPda(mint, programId),
    bondingCurvePda(mint),
  ])
  const curve = curveInfo ? PUMP_SDK.decodeBondingCurve(curveInfo) : null
  return {
    registered: !!quantumInfo,
    curveExists: !!curve,
    creatorIsWell: !!curve && curve.creator.equals(wellPda(mint, programId)),
    complete: !!curve?.complete,
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
 * them be written, so they could never be paid), this program, pump.fun and PumpSwap, and, when
 * `mint` is known, the coin's well and Quantum account.
 */
function unpayableSplitWallets({ mint, programId } = {}) {
  const out = new Set([
    ...RESERVED_ACCOUNT_KEYS,
    pid(programId).toBase58(),
    PUMP_PROGRAM_ID.toBase58(),
    PUMP_AMM_PROGRAM_ID.toBase58(),
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

// pump.fun create_v2 (Token-2022, SOL quote) plus an optional buy_v2 by `user`. buy_v2 buys an exact
// token amount for at most solLamports × (1 + slippage), so the tokens received are known up front.
async function pumpCreateInstructions({
  connection,
  creator,
  user,
  mint,
  name,
  symbol,
  uri,
  devBuy,
}) {
  if (!devBuy || BigInt(devBuy.solLamports) <= 0n) {
    const create = await PUMP_SDK.createV2Instruction({
      mint,
      name,
      symbol,
      uri,
      creator,
      user,
      mayhemMode: false,
    })
    return { instructions: [create], devBuyTokens: 0n }
  }
  const online = new OnlinePumpSdk(connection)
  const [global, feeConfig] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig().catch(() => null),
  ])
  const quoteAmount = bn(devBuy.solLamports)
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  })
  if (amount.lten(0)) throw new Error('Dev buy is too small to buy any tokens')
  const instructions = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint,
    name,
    symbol,
    uri,
    creator,
    user,
    amount,
    quoteAmount,
    mayhemMode: false,
    slippage: Number(devBuy.slippagePct ?? 1),
  })
  return { instructions, devBuyTokens: big(amount) }
}

/**
 * A Quant Pad launch. Returned in three stages that must be sent as three transactions, in order:
 * `register` (launcher + mint keypair sign), `launch` (pump.fun create_v2 with creator = well and
 * the optional dev buy; launcher + mint sign), `lock` (optional; launcher signs).
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
  programId,
}) {
  launcher = pk(launcher)
  mint = pk(mint)
  const valid = validateHooks(hooks, { mint, programId })
  const program = quantumProgram(connection, programId)
  const well = wellPda(mint, programId)

  const { instructions: launch, devBuyTokens } = await pumpCreateInstructions({
    connection,
    creator: well,
    user: launcher,
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
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const lock = lockTerms
    ? [
        await program.methods
          .lock(bn(lockAmount), bn(lockTerms.cliffSecs), bn(lockTerms.durationSecs))
          .accountsStrict({
            launcher,
            quantum: quantumPda(mint, programId),
            mint,
            launcherToken: getAssociatedTokenAddressSync(
              mint,
              launcher,
              true,
              TOKEN_2022_PROGRAM_ID,
            ),
            lockAta: lockAta(mint, programId),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ]
    : []

  const stages = { register: [register], launch, lock }
  return {
    instructions: [...stages.register, ...stages.launch, ...stages.lock],
    stages,
    devBuyTokens,
    lockAmount,
  }
}

/** A plain pump.fun launch (creator = launcher); no Quantum Hooks. */
export async function buildStandardLaunchInstructions({
  connection,
  launcher,
  mint,
  name,
  symbol,
  uri,
  devBuy = null,
}) {
  launcher = pk(launcher)
  mint = pk(mint)
  const { instructions, devBuyTokens } = await pumpCreateInstructions({
    connection,
    creator: launcher,
    user: launcher,
    mint,
    name,
    symbol,
    uri,
    devBuy,
  })
  return {
    instructions,
    stages: { register: [], launch: instructions, lock: [] },
    devBuyTokens,
    lockAmount: 0n,
  }
}

// ---------------------------------------------------------------------------------------------
// Keeper actions
// ---------------------------------------------------------------------------------------------

/**
 * The coin mint's token program, read from the mint account's owner: Token-2022 for `create_v2`
 * coins, SPL Token for coins made with pump.fun's legacy `create`.
 */
export function mintTokenProgram(mintInfo) {
  if (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (mintInfo?.owner?.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error(mintInfo ? 'Mint is not an SPL Token mint' : 'Mint account not found')
}

/** Where the coin trades now: the bonding curve until it completes, then the canonical pool. */
export async function fetchVenue(connection, mint) {
  mint = pk(mint)
  const pool = canonicalPumpPoolPda(mint)
  const [curveInfo, poolInfo] = await connection.getMultipleAccountsInfo([
    bondingCurvePda(mint),
    pool,
  ])
  const curve = curveInfo ? PUMP_SDK.decodeBondingCurve(curveInfo) : null
  if (curve && !curve.complete) return { kind: 'curve', curve, curveInfo, pool, poolInfo }
  if (poolInfo) return { kind: 'pool', curve, curveInfo, pool, poolInfo }
  return { kind: curve ? 'completed' : 'none', curve, curveInfo, pool, poolInfo }
}

/**
 * pump.fun / PumpSwap sweep + collect into the well, then `pulse`. Legs are included only when
 * they have something to move, which keeps the transaction small.
 */
export async function buildPulseInstructions({ connection, payer, mint, programId }) {
  payer = pk(payer)
  mint = pk(mint)
  const program = quantumProgram(connection, programId)
  const well = wellPda(mint, programId)
  const pool = canonicalPumpPoolPda(mint)
  const ammVaultAuthority = coinCreatorVaultAuthorityPda(well)
  const ammVaultAta = coinCreatorVaultAtaPda(ammVaultAuthority, NATIVE_MINT, TOKEN_PROGRAM_ID)
  const wsolAta = wellWsolAta(mint, programId)
  const [quantumInfo, configInfo, curveInfo, vaultInfo, poolInfo, ammVaultInfo, wsolInfo] =
    await connection.getMultipleAccountsInfo([
      quantumPda(mint, programId),
      configPda(programId),
      bondingCurvePda(mint),
      creatorVaultPda(well),
      pool,
      ammVaultAta,
      wsolAta,
    ])
  if (!quantumInfo) throw new Error(`${mint.toBase58()} is not a Quantum coin`)
  if (!configInfo) throw new Error('Quantum config is not initialized')
  const quantum = decodeQuantum(quantumInfo.data)
  const config = decodeConfig(configInfo.data)

  const curveLeg = []
  let curveSweep = false
  if (curveInfo) {
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo)
    let collect = vaultInfo && BigInt(vaultInfo.lamports) > RENT_EXEMPT_EMPTY
    if (curve.creator.equals(well) && curve.creatorFee.gtn(0)) {
      curveLeg.push(
        await PUMP_SDK.sweepCreatorFeeInstruction({
          payer,
          mint,
          creator: well,
          quoteMint: curve.quoteMint,
        }),
      )
      curveSweep = true
      collect = true
    }
    if (collect) {
      curveLeg.push(
        await getPumpProgram(connection)
          .methods.collectCreatorFee()
          .accountsPartial({ creator: well })
          .instruction(),
      )
    }
  }
  const poolLeg = []
  if (poolInfo) {
    const decoded = PUMP_AMM_SDK.decodePool(poolInfo)
    if (decoded.coinCreator.equals(well)) {
      let collect = tokenAmount(ammVaultAta, ammVaultInfo, TOKEN_PROGRAM_ID) > 0n
      if (decoded.creatorFees.gtn(0)) {
        poolLeg.push(
          await PUMP_SDK.sweepPoolCreatorFeeInstruction({
            payer,
            mint,
            coinCreator: well,
            quoteMint: NATIVE_MINT,
          }),
        )
        collect = true
      }
      if (collect) {
        // Creates the vault ATA and the well's WSOL ATA when missing (payer pays); `pulse` closes
        // the WSOL ATA into the well and refunds its rent to the payer (`rent_payer`).
        poolLeg.push(
          ...(await PUMP_AMM_SDK.collectCoinCreatorFee(
            {
              coinCreator: well,
              quoteMint: NATIVE_MINT,
              quoteTokenProgram: TOKEN_PROGRAM_ID,
              coinCreatorVaultAuthority: ammVaultAuthority,
              coinCreatorVaultAta: ammVaultAta,
              coinCreatorTokenAccount: wsolAta,
              coinCreatorVaultAtaAccountInfo: ammVaultInfo,
              coinCreatorTokenAccountInfo: wsolInfo,
            },
            payer,
          )),
        )
      }
    }
  }
  // A curve sweep plus the PumpSwap leg overflow 1232 bytes without a lookup table: take the
  // curve this time; the next pulse picks up the pool fees.
  const instructions = curveSweep && poolLeg.length ? curveLeg : [...curveLeg, ...poolLeg]
  const unwrap =
    (!!wsolInfo && wsolInfo.owner.equals(TOKEN_PROGRAM_ID)) ||
    instructions.some((ix) => poolLeg.includes(ix))

  instructions.push(
    await program.methods
      .pulse()
      .accountsStrict({
        rentPayer: payer,
        config: configPda(programId),
        quantum: quantumPda(mint, programId),
        well,
        treasury: pk(config.treasury),
        launcher: pk(quantum.launcher),
        wellWsolAta: unwrap ? wsolAta : null,
        tokenProgram: unwrap ? TOKEN_PROGRAM_ID : null,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        // A reserved key is always read-only on-chain (the program defers its share).
        quantum.splits.map((s) => ({
          pubkey: pk(s.wallet),
          isWritable: !isReservedAccountKey(s.wallet),
          isSigner: false,
        })),
      )
      .instruction(),
  )
  return instructions
}

const lessPct = (value, pct) => (value * BigInt(Math.round((100 - Number(pct)) * 100))) / 10_000n
const asRemaining = (ix) =>
  ix.keys.map((k) => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false }))
// sha256("global:<name>")[..8] of the PumpSwap instructions picked out of the SDK's output.
const PUMP_AMM_DISCRIMINATORS = {
  buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
}
const pickInstruction = (instructions, programId, name) => {
  const disc = Buffer.from(PUMP_AMM_DISCRIMINATORS[name])
  const found = instructions.find(
    (ix) => ix.programId.equals(programId) && Buffer.from(ix.data.subarray(0, 8)).equals(disc),
  )
  if (!found) throw new Error(`pump SDK did not produce a ${name} instruction`)
  return found
}

async function ensureVolumeAccumulators(connection, payer, user, { curve = false, pool = false }) {
  const keys = []
  if (curve) keys.push(['curve', userVolumeAccumulatorPda(user)])
  if (pool) keys.push(['pool', ammUserVolumeAccumulatorPda(user)])
  if (!keys.length) return []
  const infos = await connection.getMultipleAccountsInfo(keys.map(([, k]) => k))
  const out = []
  for (let i = 0; i < keys.length; i++) {
    if (infos[i]) continue
    out.push(
      keys[i][0] === 'curve'
        ? await PUMP_SDK.initUserVolumeAccumulator({ payer, user })
        : await PUMP_AMM_SDK.initUserVolumeAccumulator({ payer, user }),
    )
  }
  return out
}

async function wellPoolBuy({ connection, well, pool, spend, slippagePct }) {
  const state = await new OnlinePumpAmmSdk(connection).swapSolanaState(pool, well)
  const { base } = buyQuoteInput({
    quote: bn(spend),
    slippage: Number(slippagePct),
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: state.pool.coinCreator,
    creator: state.pool.creator,
    feeConfig: state.feeConfig,
    quoteMint: state.pool.quoteMint,
    isMayhemMode: state.pool.isMayhemMode,
    creatorFeeBps: state.pool.creatorFeeBps,
  })
  const minBase = lessPct(big(base), slippagePct)
  if (minBase <= 0n) throw new Error('Spend is too small to buy any tokens')
  const built = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(state, bn(spend), bn(minBase))
  return {
    state,
    minBase,
    ix: pickInstruction(built, PUMP_AMM_PROGRAM_ID, 'buy_exact_quote_in_v2'),
    extra: built,
  }
}

/**
 * Quantum Burn: the well buys with `spendLamports` from the burn reserve (curve or canonical
 * PumpSwap pool) and the program burns everything bought. Returns the instructions to send.
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
  const program = quantumProgram(connection, programId)
  const well = wellPda(mint, programId)
  const [venue, mintInfo] = await Promise.all([
    fetchVenue(connection, mint),
    connection.getAccountInfo(mint),
  ])
  const tokenProgram = mintTokenProgram(mintInfo)
  const pre = []
  let buy
  if (venue.kind === 'curve') {
    pre.push(...(await ensureVolumeAccumulators(connection, caller, well, { curve: true })))
    const online = new OnlinePumpSdk(connection)
    const [global, feeConfig] = await Promise.all([
      online.fetchGlobal(),
      online.fetchFeeConfig().catch(() => null),
    ])
    const supply = unpackMint(mint, mintInfo, tokenProgram).supply
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: bn(supply),
      bondingCurve: venue.curve,
      amount: bn(lessPct(spend, slippagePct)),
      quoteMint: venue.curve.quoteMint,
    })
    if (amount.lten(0)) throw new Error('Spend is too small to buy any tokens')
    // Legacy `buy` (exact tokens, max cost = spend): the smallest account list, so the keeper's
    // transaction fits without a lookup table.
    buy = await PUMP_SDK.getBuyInstructionRaw({
      user: well,
      mint,
      creator: venue.curve.creator,
      amount,
      solAmount: bn(spend),
      feeRecipient: getFeeRecipient(global, venue.curve.isMayhemMode),
      tokenProgram,
    })
  } else if (venue.kind === 'pool') {
    pre.push(...(await ensureVolumeAccumulators(connection, caller, well, { pool: true })))
    buy = (await wellPoolBuy({ connection, well, pool: venue.pool, spend, slippagePct })).ix
  } else {
    throw new Error(`No pump.fun market to burn on (${venue.kind})`)
  }
  const poolRoute = venue.kind === 'pool'
  const ix = await program.methods
    .quantumBurn(bn(spend), Buffer.from(buy.data))
    .accountsStrict({
      caller,
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well,
      mint,
      wellTokenAta: wellTokenAta(mint, programId, tokenProgram),
      wellWsolAta: poolRoute ? wellWsolAta(mint, programId) : null,
      wsolMint: poolRoute ? NATIVE_MINT : null,
      tokenProgram,
      quoteTokenProgram: poolRoute ? TOKEN_PROGRAM_ID : null,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      targetProgram: buy.programId,
    })
    .remainingAccounts(asRemaining(buy))
    .instruction()
  return [...pre, ix]
}

/**
 * Fusion (post-graduation): ~45% of `spendLamports` buys base on the canonical pool, the rest
 * deposits both sides; LP stays in the well forever, leftovers are burned / unwrapped.
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
  const program = quantumProgram(connection, programId)
  const well = wellPda(mint, programId)
  const [venue, mintInfo] = await Promise.all([
    fetchVenue(connection, mint),
    connection.getAccountInfo(mint),
  ])
  if (venue.kind !== 'pool') throw new Error('Fusion needs a graduated coin with a PumpSwap pool')
  const tokenProgram = mintTokenProgram(mintInfo)
  const pre = await ensureVolumeAccumulators(connection, caller, well, { pool: true })

  const buySpend = (spend * 45n) / 100n
  const {
    state,
    minBase,
    ix: buy,
  } = await wellPoolBuy({ connection, well, pool: venue.pool, spend: buySpend, slippagePct })

  // Reserves after the buy, bounded so the deposit never needs more than we hold.
  const liquidity = await new OnlinePumpAmmSdk(connection).liquiditySolanaState(venue.pool, well)
  const lpSupply = big(liquidity.pool.lpSupply)
  const poolBase = big(state.poolBaseAmount)
  const realQuote =
    big(liquidity.poolQuoteTokenAccount.amount) -
    big(liquidity.pool.protocolFees) -
    big(liquidity.pool.creatorFees)
  const baseAfter = poolBase - minBase
  const quoteLeft = spend - buySpend
  let lp = (minBase * lpSupply) / baseAfter
  lp = (lp * 99n) / 100n
  const quoteBound = ((realQuote + buySpend) * lp) / lpSupply + 2n
  if (quoteBound > quoteLeft) lp = (lp * quoteLeft) / quoteBound
  if (lp <= 0n) throw new Error('Fusion spend is too small to mint LP tokens')
  const built = await PUMP_AMM_SDK.depositInstructionsInternal(
    liquidity,
    bn(lp),
    bn(minBase),
    bn(quoteLeft),
  )
  const deposit = pickInstruction(built, PUMP_AMM_PROGRAM_ID, 'deposit')

  const buyAccounts = asRemaining(buy)
  const ix = await program.methods
    .fusion(bn(spend), Buffer.from(buy.data), buyAccounts.length, Buffer.from(deposit.data))
    .accountsStrict({
      caller,
      config: configPda(programId),
      quantum: quantumPda(mint, programId),
      well,
      mint,
      wellTokenAta: wellTokenAta(mint, programId, tokenProgram),
      wellWsolAta: wellWsolAta(mint, programId),
      wsolMint: NATIVE_MINT,
      pool: venue.pool,
      lpMint: lpMintPda(venue.pool),
      // PumpSwap LP mints are always Token-2022, whatever the coin's token program.
      wellLpAta: getAssociatedTokenAddressSync(
        lpMintPda(venue.pool),
        well,
        true,
        TOKEN_2022_PROGRAM_ID,
      ),
      tokenProgram,
      lpTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      targetProgram: PUMP_AMM_PROGRAM_ID,
    })
    .remainingAccounts([...buyAccounts, ...asRemaining(deposit)])
    .instruction()
  return [...pre, ix]
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
      launcherToken: getAssociatedTokenAddressSync(mint, launcher, true, TOKEN_2022_PROGRAM_ID),
      lockAta: lockAta(mint, programId),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
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
      launcherToken: getAssociatedTokenAddressSync(mint, launcher, true, TOKEN_2022_PROGRAM_ID),
      lockAta: lockAta(mint, programId),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
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

/** Fields left undefined keep their current on-chain value (requires `connection`). */
export async function buildUpdateConfigInstruction({
  connection,
  authority,
  programId,
  ...changes
}) {
  const current = await fetchConfig(connection, programId)
  if (!current) throw new Error('Quantum config is not initialized')
  const next = { ...current, newAuthority: current.authority }
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) next[k] = v
  return quantumProgram(connection, programId)
    .methods.updateConfig(
      pk(next.treasury),
      pk(next.keeper),
      Number(next.protocolBps),
      bn(next.maxBurnLamports),
      bn(next.minActionInterval),
      bn(next.keeperGrace),
      !!next.paused,
      pk(next.newAuthority),
    )
    .accountsStrict({ authority: pk(authority), config: configPda(programId) })
    .instruction()
}
