// Quotes and swap instructions for Meteora coins: the Dynamic Bonding Curve before migration and
// the DAMM v2 pool after. Amounts are bigints in lamports / raw token units.
import BN from 'bn.js'
import { PublicKey, Keypair } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  getTotalFeeNumeratorFromIncludedFeeAmount,
  swapQuotePartialFill,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  SWAP_MODE,
  dammQuote,
  dammSwapInstructions,
  dbcQuote,
  dbcSwapInstructions,
  fetchMeteoraVenue,
} from '../../shared/meteora.mjs'
import { connection, platformFeeInstruction } from './solana.js'
import { slippageBps } from './amounts.js'

const placeholder = Keypair.generate().publicKey
const TIMESTAMP = 1 // Meteora activation_type: 0 slot, 1 timestamp

const programCache = new Map()
export async function tokenProgramFor(mint) {
  const key = mint.toString()
  if (!programCache.has(key)) {
    const info = await connection.getAccountInfo(new PublicKey(mint))
    if (!info) throw Error('That mint does not exist on Solana mainnet.')
    programCache.set(
      key,
      info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    )
  }
  return programCache.get(key)
}

// The clock a Meteora pool reads its fee schedule from.
async function currentPoint(activationType) {
  return Number(activationType) === TIMESTAMP
    ? BigInt(Math.floor(Date.now() / 1000))
    : BigInt(await connection.getSlot('confirmed'))
}

/**
 * Where the coin trades right now and the state needed to quote it. `dbcPool` is the coin's DBC
 * pool (from the indexer). `venue`: 'curve' (DBC), 'pool' (DAMM v2), or 'migrating' (the curve is
 * full and Meteora has not opened its DAMM v2 pool yet: nothing can trade).
 */
export async function marketState(mint, user, dbcPool) {
  const mintKey = new PublicKey(mint)
  const owner = user ? new PublicKey(user) : placeholder
  if (!dbcPool) throw Error('This coin has no Meteora pool.')
  const [tokenProgram, found] = await Promise.all([
    tokenProgramFor(mintKey),
    fetchMeteoraVenue(connection, mintKey, { dbcPool }),
  ])
  if (found.kind === 'none') throw Error('This coin has no Meteora pool.')
  const base = { mint: mintKey, user: owner, tokenProgram, ...found }
  if (found.kind === 'migrating') return { ...base, venue: 'migrating' }
  if (found.kind === 'curve')
    return { ...base, venue: 'curve', point: await currentPoint(found.config.activationType) }
  return { ...base, venue: 'pool', point: await currentPoint(found.damm.raw.activationType) }
}

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
 * when nothing is quoted).
 */
export function quoteBuy(state, lamports, slippagePct = 1) {
  if (lamports <= 0n || state.venue === 'migrating') return { tokens: 0n, minTokens: 0n }
  const { out, minOut, spend = lamports } = quote(state, 'buy', lamports, slippagePct)
  return { tokens: out, minTokens: minOut, spend }
}

export function quoteSell(state, tokens, slippagePct = 1) {
  if (tokens <= 0n || state.venue === 'migrating') return { lamports: 0n, minLamports: 0n }
  const { out, minOut } = quote(state, 'sell', tokens, slippagePct)
  return { lamports: out, minLamports: minOut }
}

/** Why this market cannot be traded here right now, or null. */
export function tradeBlocker(state) {
  if (!state) return null
  if (state.venue === 'migrating')
    return 'The bonding curve is full. Trading resumes as soon as Meteora opens this coin’s DAMM v2 pool.'
  if (!state.tokenProgram.equals(TOKEN_PROGRAM_ID))
    return 'Token-2022 Meteora coins cannot be traded on Quant Pad yet.'
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
      })
    : dammSwapInstructions({
        damm: state.damm,
        dammPool: state.dammPool,
        mint: state.mint,
        user: state.user,
        side,
        amountIn,
        minOut,
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
