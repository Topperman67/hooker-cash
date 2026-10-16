// Quotes and swap instructions for Meteora coins: the Dynamic Bonding Curve before migration and
// the DAMM v2 pool after. Amounts are bigints in lamports / raw token units.
//
// SPL Token and Token-2022 coins both trade here, including a Token-2022 coin with a transfer hook
// in a DBC TransferHookPool (such as $QUANTP): its swaps carry the hook's extra accounts, resolved
// from the chain on every market read. Token-2022 extensions that change what a trade moves or who
// controls the coins are refused instead (tradeBlocker).
import { Buffer } from 'buffer'
import BN from 'bn.js'
import { PublicKey, Keypair } from '@solana/web3.js'
import {
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getExtraAccountMetaAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import {
  getTotalFeeNumeratorFromIncludedFeeAmount,
  swapQuotePartialFill,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  DBC_POOL_AUTHORITY,
  SWAP_MODE,
  dammFeeBps,
  dammQuote,
  dammSwapInstructions,
  dbcPoolPda,
  dbcQuote,
  dbcSwapInstructions,
  decodeDbcConfig,
  decodeDbcPool,
  fetchMeteoraVenue,
  migratedPoolFor,
  swapQuoteDetails,
  transferHookAccounts,
  transferHookProgram,
} from '../../shared/meteora.mjs'
import { connection, platformFeeInstruction } from './solana.js'
import { registerTransferHook } from './txerrors.js'
import { slippageBps } from './amounts.js'

const placeholder = Keypair.generate().publicKey
const TIMESTAMP = 1 // Meteora activation_type: 0 slot, 1 timestamp

const programOf = (info) =>
  info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
const programCache = new Map()
export async function tokenProgramFor(mint) {
  const key = mint.toString()
  if (!programCache.has(key)) {
    const info = await connection.getAccountInfo(new PublicKey(mint))
    if (!info) throw Error('That mint does not exist on Solana mainnet.')
    programCache.set(key, programOf(info))
  }
  return programCache.get(key)
}

/** The DBC pool of a coin launched under DBC `config` (for a coin record without `dbcPool`). */
export const dbcPoolFor = (config, mint) => dbcPoolPda(config, mint).toBase58()

// The clock a Meteora pool reads its fee schedule from.
async function currentPoint(activationType) {
  return Number(activationType) === TIMESTAMP
    ? BigInt(Math.floor(Date.now() / 1000))
    : BigInt(await connection.getSlot('confirmed'))
}

// ---- reading a market -------------------------------------------------------------------------

// Per coin, the accounts its last market read needed besides the mint and the DBC pool (the pool's
// config, the hook's extra-account-metas account, the DAMM v2 pool), so a refresh reads them all
// in one getMultipleAccounts call through /api/rpc. Only addresses are kept: the accounts are read
// every time, so a hook whose extra accounts change is picked up on the next refresh.
const relatedAccounts = new Map()

function hookProgramOf(mintKey, info) {
  try {
    return transferHookProgram(mintKey, info)
  } catch {
    return null // an unreadable mint fails in mintFacts instead
  }
}

// What a market read needs once the mint and the pool are in: the mint's extra-account-metas
// account while it has a transfer hook, the pool's config, and the DAMM v2 pool once Meteora
// migrated the coin (its address needs the config).
function relatedTo(mintKey, poolKey, accounts) {
  const keys = []
  const hook = hookProgramOf(mintKey, accounts.get(mintKey.toBase58()))
  if (hook) keys.push(getExtraAccountMetaAddress(mintKey, hook).toBase58())
  const pool = decodeDbcPool(accounts.get(poolKey)?.data)
  if (!pool) return keys
  keys.push(pool.config)
  const config = decodeDbcConfig(accounts.get(pool.config)?.data)
  if (pool.isMigrated && config) keys.push(migratedPoolFor(config, mintKey).toBase58())
  return keys
}

// Reads the mint, the DBC pool and the accounts they lead to (null where missing): one
// getMultipleAccounts call once the coin's related accounts are known, at most three the first time.
async function marketAccounts(mintKey, poolKey) {
  const mint = mintKey.toBase58()
  const accounts = new Map()
  let wanted = [mint, poolKey, ...(relatedAccounts.get(mint) ?? [])]
  for (let round = 0; round < 3; round++) {
    const missing = [...new Set(wanted)].filter((key) => !accounts.has(key))
    if (!missing.length) break
    const infos = await connection.getMultipleAccountsInfo(
      missing.map((key) => new PublicKey(key)),
      'confirmed',
    )
    missing.forEach((key, i) => accounts.set(key, infos[i] ?? null))
    wanted = [mint, poolKey, ...relatedTo(mintKey, poolKey, accounts)]
  }
  relatedAccounts.set(mint, wanted.slice(2))
  return accounts
}

// A connection that answers from this read's accounts first, so fetchMeteoraVenue and the hook
// resolver make no further calls for them.
const prefetched = (accounts) => ({
  getAccountInfo: (key, commitment) => {
    const address = key.toBase58()
    return accounts.has(address)
      ? Promise.resolve(accounts.get(address))
      : connection.getAccountInfo(key, commitment)
  },
})

// Token-2022 extensions that change what a trade moves or who controls the coins. Quant Pad's
// quotes and builds do not cover them, so a coin with one is not traded here.
const BLOCKING_EXTENSIONS = {
  TransferFeeConfig:
    'This coin charges a Token-2022 transfer fee that Quant Pad’s quotes leave out, so it cannot be traded here.',
  NonTransferable: 'This coin cannot be transferred, so it cannot be traded.',
  PermanentDelegate:
    'This coin has a permanent delegate that can move or burn anyone’s tokens, so Quant Pad does not trade it.',
  PausableConfig:
    'This coin’s transfers can be paused by its issuer, so Quant Pad does not trade it.',
  ConfidentialTransferMint:
    'This coin uses confidential transfers, which Quant Pad cannot quote, so it cannot be traded here.',
}
const HOOK_UNRESOLVED =
  'Could not read the accounts this coin’s transfer hook needs. Retrying shortly.'
const HOOK_UNSUPPORTED =
  'This coin’s transfer hook is switched on, and its Meteora pool cannot run it, so it cannot be traded here.'
// Quotes, the ticket and the swap builders (which derive the pool from the config and WSOL) are
// in SOL only.
const NOT_SOL = 'This coin trades against a token other than SOL, which Quant Pad does not support.'
const WSOL = 'So11111111111111111111111111111111111111112'

// The token program, Token-2022 extensions (by name) and active transfer hook of a coin's mint.
function mintFacts(mintKey, info) {
  if (!info) throw Error('That mint does not exist on Solana mainnet.')
  const tokenProgram = programOf(info)
  programCache.set(mintKey.toBase58(), tokenProgram)
  if (tokenProgram !== TOKEN_2022_PROGRAM_ID)
    return { tokenProgram, extensions: [], hookProgram: null }
  const mint = unpackMint(mintKey, { ...info, data: Buffer.from(info.data) }, TOKEN_2022_PROGRAM_ID)
  return {
    tokenProgram,
    extensions: getExtensionTypes(mint.tlvData).map((type) => ExtensionType[type] ?? `#${type}`),
    hookProgram: transferHookProgram(mintKey, info),
  }
}

// The hook's accounts for each side of a curve trade: a buy moves coins from the pool's base vault
// to the buyer's account (DBC's pool authority signs), a sell from the seller's account to the
// vault. A hook's extra accounts may depend on any of these, so each side gets its own.
async function curveHookAccounts(reader, state, mintInfo) {
  const { mint, user, tokenProgram } = state
  const account = getAssociatedTokenAddressSync(mint, user, true, tokenProgram)
  const vault = new PublicKey(state.pool.baseVault)
  const resolve = (source, destination, owner) =>
    transferHookAccounts(reader, mint, { source, destination, owner, mintInfo })
  const [buy, sell] = await Promise.all([
    resolve(vault, account, DBC_POOL_AUTHORITY),
    resolve(account, vault, user),
  ])
  return { buy, sell }
}

/**
 * Where the coin trades right now and the state needed to quote it. `dbcPool` is the coin's DBC
 * pool (from the indexer, or dbcPoolFor). `venue`: 'curve' (DBC), 'pool' (DAMM v2), or
 * 'migrating' (the curve is full and Meteora has not opened its DAMM v2 pool yet: nothing can
 * trade). Also carries the mint's `tokenProgram`, `extensions` and `hookProgram` (an active
 * transfer hook), and on the curve the hook's `hookAccounts` ({ buy, sell }).
 */
export async function marketState(mint, user, dbcPool) {
  const mintKey = new PublicKey(mint)
  const owner = user ? new PublicKey(user) : placeholder
  if (!dbcPool) throw Error('This coin has no Meteora pool.')
  const accounts = await marketAccounts(mintKey, new PublicKey(dbcPool).toBase58())
  const mintInfo = accounts.get(mintKey.toBase58())
  const facts = mintFacts(mintKey, mintInfo)
  const reader = prefetched(accounts)
  const found = await fetchMeteoraVenue(reader, mintKey, { dbcPool })
  if (found.kind === 'none') throw Error('This coin has no Meteora pool.')
  if (facts.hookProgram) registerTransferHook(facts.hookProgram.toBase58())
  const base = { mint: mintKey, user: owner, ...facts, ...found }
  if (found.kind === 'migrating') return { ...base, venue: 'migrating' }
  if (found.kind === 'pool')
    return { ...base, venue: 'pool', point: await currentPoint(found.damm.raw.activationType) }
  const state = { ...base, venue: 'curve', point: await currentPoint(found.config.activationType) }
  if (!facts.hookProgram || !found.pool.transferHook) return state
  try {
    return { ...state, hookAccounts: await curveHookAccounts(reader, state, mintInfo) }
  } catch {
    return state // tradeBlocker says so; the next refresh tries again
  }
}

// ---- quotes -----------------------------------------------------------------------------------

const big = (v) => BigInt(v.toString())

// A curve buy is sent as PARTIAL_FILL (see swapInstructions), so it is quoted the same way: a buy
// larger than what is left on the curve fills to the migration threshold and `spend` is the SOL it
// actually uses (the rest is refunded). Below the threshold this equals an exact-in quote.
function curveBuyQuote(state, lamports, slippage) {
  const q = swapQuotePartialFill(
    state.pool.raw,
    state.config.raw,
    false,
    new BN(lamports.toString()),
    slippage,
    false,
    new BN(state.point.toString()),
    false,
  )
  return {
    ...swapQuoteDetails(q, 'buy', state.pool.raw.poolState.sqrtPrice),
    out: big(q.outputAmount),
    minOut: big(q.minimumAmountOut),
    spend: big(q.includedFeeInputAmount),
  }
}

const quote = (state, side, amountIn, slippagePct) => {
  const slippage = Number(slippageBps(slippagePct))
  try {
    if (state.venue === 'curve')
      return side === 'buy'
        ? curveBuyQuote(state, amountIn, slippage)
        : dbcQuote({
            pool: state.pool,
            config: state.config,
            side,
            amountIn,
            slippageBps: slippage,
            currentPoint: state.point,
          })
    return dammQuote({
      damm: state.damm,
      side,
      amountIn,
      slippageBps: slippage,
      currentPoint: state.point,
    })
  } catch (e) {
    // The SDKs' quote errors, in the words the on-chain errors get (txerrors.js).
    if (e?.name === 'SwapDisabledError') throw Error('Meteora has paused trading in this pool.')
    if (/insufficient liquidity|not enough liquidity/i.test(e?.message))
      throw Error(
        state.venue === 'curve'
          ? 'Not enough liquidity on the curve for that amount.'
          : 'Not enough liquidity in the pool for that amount.',
      )
    throw e
  }
}

/**
 * `spend` is the SOL the buy uses: less than `lamports` when it fills the rest of the curve (absent
 * when nothing is quoted). `fee` is the pool's fee in raw units of `feeToken` ('sol' or 'token'),
 * and `impact` the price impact as a fraction (see swapQuoteDetails in shared/meteora.mjs).
 */
export function quoteBuy(state, lamports, slippagePct = 1) {
  if (lamports <= 0n || state.venue === 'migrating') return { tokens: 0n, minTokens: 0n }
  const q = quote(state, 'buy', lamports, slippagePct)
  const { fee, feeToken, impact } = q
  return { tokens: q.out, minTokens: q.minOut, spend: q.spend ?? lamports, fee, feeToken, impact }
}

export function quoteSell(state, tokens, slippagePct = 1) {
  if (tokens <= 0n || state.venue === 'migrating') return { lamports: 0n, minLamports: 0n }
  const { out, minOut, fee, feeToken, impact } = quote(state, 'sell', tokens, slippagePct)
  return { lamports: out, minLamports: minOut, fee, feeToken, impact }
}

/** Why this market cannot be traded here right now, or null. */
export function tradeBlocker(state) {
  if (!state) return null
  if (state.venue === 'migrating')
    return 'The bonding curve is full. Trading resumes as soon as Meteora opens this coin’s DAMM v2 pool.'
  if (state.config && state.config.quoteMint !== WSOL) return NOT_SOL
  if (state.venue === 'pool' && state.damm?.tokenBMint !== WSOL) return NOT_SOL
  const blocking = (state.extensions ?? []).find((name) => BLOCKING_EXTENSIONS[name])
  if (blocking) return BLOCKING_EXTENSIONS[blocking]
  if (state.hookProgram) {
    // Only DBC's TransferHookPool hands a hook its accounts; DBC revokes the hook at migration.
    if (state.venue !== 'curve' || !state.pool?.transferHook) return HOOK_UNSUPPORTED
    if (!state.hookAccounts) return HOOK_UNRESOLVED
  }
  return null
}

function tradable(state) {
  const blocker = tradeBlocker(state)
  if (blocker) throw Error(blocker)
}

/**
 * The trading tax a curve trade pays at the market's clock, in bps: a launch starts at 25% and falls
 * to its tier's tax over the first 2 minutes (anti-sniper). Null off the curve.
 */
export function currentTaxBps(state) {
  if (state?.venue !== 'curve') return null
  // Called while rendering the ticket: a fee read that fails shows the tier's tax instead.
  try {
    const s = state.pool.raw.poolState
    const numerator = getTotalFeeNumeratorFromIncludedFeeAmount(
      state.config.raw.poolFees,
      s.volatilityTracker,
      new BN(state.point.toString()),
      s.activationPoint,
      new BN(1_000_000_000),
      1, // QuoteToBase
    )
    return Number(numerator.toString()) / 100_000 // fee numerators are over 1e9
  } catch {
    return null
  }
}

/**
 * The fee the coin's pool charges a trade right now, in bps: the curve's (currentTaxBps) or the
 * DAMM v2 pool's. Null while migrating or when it cannot be read.
 */
export function poolFeeBps(state, side = 'buy') {
  if (state?.venue === 'curve') return currentTaxBps(state)
  if (state?.venue !== 'pool') return null
  try {
    return dammFeeBps(state.damm, state.point, side)
  } catch {
    return null
  }
}

const swapInstructions = (state, side, amountIn, minOut) =>
  state.venue === 'curve'
    ? dbcSwapInstructions({
        config: state.pool.config,
        mint: state.mint,
        user: state.user,
        side,
        amountIn,
        minOut,
        // A buy larger than what is left on the curve fills to the threshold and refunds the rest.
        mode: side === 'buy' ? SWAP_MODE.PARTIAL_FILL : SWAP_MODE.EXACT_IN,
        tokenBaseProgram: state.tokenProgram,
        // A TransferHookPool only takes swap2_with_transfer_hook, with the hook's accounts.
        transferHookAccounts: state.pool.transferHook ? (state.hookAccounts?.[side] ?? []) : null,
      })
    : dammSwapInstructions({
        damm: state.damm,
        dammPool: state.dammPool,
        mint: state.mint,
        user: state.user,
        side,
        amountIn,
        minOut,
        tokenAProgram: state.tokenProgram,
      })

// Buy with an exact SOL budget: `lamports` is the most the swap spends on either venue. The platform
// fee (if any) is a separate, visible transfer, charged on the SOL the swap is quoted to use.
export async function buyInstructions({ mint, user, lamports, slippagePct, platform, dbcPool }) {
  const state = await marketState(mint, user, dbcPool)
  tradable(state)
  const { tokens, minTokens, spend } = quoteBuy(state, lamports, slippagePct)
  if (minTokens <= 0n) throw Error('That amount is too small to buy any tokens.')
  const fee = await platformFeeInstruction(user, platform, spend)
  const ixs = await swapInstructions(state, 'buy', lamports, minTokens)
  return { instructions: fee ? [...ixs, fee] : ixs, venue: state.venue, expected: tokens, spend }
}

export async function sellInstructions({ mint, user, tokens, slippagePct, platform, dbcPool }) {
  const state = await marketState(mint, user, dbcPool)
  tradable(state)
  const { lamports, minLamports } = quoteSell(state, tokens, slippagePct)
  // A sell quoted at nothing would give the tokens away for no SOL (min out 0).
  if (minLamports <= 0n) throw Error('That amount is too small to sell for any SOL.')
  const fee = await platformFeeInstruction(user, platform, lamports)
  const ixs = await swapInstructions(state, 'sell', tokens, minLamports)
  return { instructions: fee ? [...ixs, fee] : ixs, venue: state.venue, expected: lamports }
}

export async function tokenBalance(mint, owner) {
  if (!owner) return 0n
  const program = await tokenProgramFor(mint)
  const ata = getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    true,
    program,
  )
  try {
    const { value } = await connection.getTokenAccountBalance(ata, 'confirmed')
    return BigInt(value.amount)
  } catch {
    return 0n
  }
}
