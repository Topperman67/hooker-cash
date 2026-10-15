// Quotes and swap instructions for Meteora coins: the Dynamic Bonding Curve before migration and
// the DAMM v2 pool after. Amounts are bigints in lamports / raw token units.
import { PublicKey, Keypair } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
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

const quote = (state, side, amountIn, slippagePct) => {
  const slippage = Number(slippageBps(slippagePct))
  return state.venue === 'curve'
    ? dbcQuote({
        pool: state.pool,
        config: state.config,
        side,
        amountIn,
        slippageBps: slippage,
        currentPoint: state.point,
      })
    : dammQuote({
        damm: state.damm,
        side,
        amountIn,
        slippageBps: slippage,
        currentPoint: state.point,
      })
}

export function quoteBuy(state, lamports, slippagePct = 1) {
  if (lamports <= 0n || state.venue === 'migrating') return { tokens: 0n, minTokens: 0n }
  const { out, minOut } = quote(state, 'buy', lamports, slippagePct)
  return { tokens: out, minTokens: minOut }
}

export function quoteSell(state, tokens, slippagePct = 1) {
  if (tokens <= 0n || state.venue === 'migrating') return { lamports: 0n, minLamports: 0n }
  const { out, minOut } = quote(state, 'sell', tokens, slippagePct)
  return { lamports: out, minLamports: minOut }
}

function tradable(state) {
  if (state.venue === 'migrating')
    throw Error(
      'The bonding curve is full. Trading resumes as soon as Meteora opens this coin’s DAMM v2 pool.',
    )
  if (!state.tokenProgram.equals(TOKEN_PROGRAM_ID))
    throw Error('Token-2022 Meteora coins cannot be traded on Quant Pad yet.')
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
// fee (if any) is a separate, visible transfer.
export async function buyInstructions({ mint, user, lamports, slippagePct, platform, dbcPool }) {
  const state = await marketState(mint, user, dbcPool)
  tradable(state)
  const { tokens, minTokens } = quoteBuy(state, lamports, slippagePct)
  if (minTokens <= 0n) throw Error('That amount is too small to buy any tokens.')
  const fee = await platformFeeInstruction(user, platform, lamports)
  const ixs = await swapInstructions(state, 'buy', lamports, minTokens)
  return { instructions: fee ? [...ixs, fee] : ixs, venue: state.venue, expected: tokens }
}

export async function sellInstructions({ mint, user, tokens, slippagePct, platform, dbcPool }) {
  const state = await marketState(mint, user, dbcPool)
  tradable(state)
  const { lamports, minLamports } = quoteSell(state, tokens, slippagePct)
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
