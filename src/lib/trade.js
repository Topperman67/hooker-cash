// Quotes and swap instructions for pump.fun coins: the bonding curve before graduation and the
// canonical PumpSwap pool after. Amounts are bigints in lamports / raw token units.
import BN from 'bn.js'
import { PublicKey, Keypair } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
} from '#pump-sdk'
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  buyQuoteInput,
  sellBaseInput,
  supportsTradeV2,
} from '@pump-fun/pump-swap-sdk'
import { connection, platformFeeInstruction } from './solana.js'
import { minimumOut, quoteForMaxSpend } from './amounts.js'

const sdk = new OnlinePumpSdk(connection)
const amm = new OnlinePumpAmmSdk(connection)
const ammOffline = new PumpAmmSdk()
const placeholder = Keypair.generate().publicKey
const bn = (v) => new BN(v.toString())
const big = (v) => BigInt(v.toString())

let shared = { at: 0 }
async function curveGlobals() {
  if (Date.now() - shared.at < 60000) return shared
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()])
  shared = { at: Date.now(), global, feeConfig }
  return shared
}

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

// Where the coin trades right now and the state needed to quote it.
export async function marketState(mint, user) {
  const mintKey = new PublicKey(mint)
  const owner = user ? new PublicKey(user) : placeholder
  const tokenProgram = await tokenProgramFor(mintKey)
  const curve = await sdk.fetchBuyState(mintKey, owner, tokenProgram).catch(() => null)
  if (curve && !curve.bondingCurve.complete) {
    const { global, feeConfig } = await curveGlobals()
    return { venue: 'curve', mint: mintKey, user: owner, tokenProgram, global, feeConfig, ...curve }
  }
  const poolKey = canonicalPumpPoolPda(mintKey)
  const swap = await amm.swapSolanaState(poolKey, owner)
  return { venue: 'pool', mint: mintKey, user: owner, tokenProgram, poolKey, swap }
}

/**
 * How a PumpSwap buy of `lamports` is built so that it never spends, or wraps into WSOL, more than
 * `lamports`: `buy_exact_quote_in_v2` (spends `lamports`, at least `minTokens` out) when the pool
 * takes v2 instructions; otherwise v1 `buy`, whose cost cap is quote × (1 + slippage), quoted for
 * the largest amount whose cap still fits in `lamports`. `maxSpend` is what the swap may take.
 */
export function poolBuyPlan(swap, lamports, slippagePct) {
  const v2 = supportsTradeV2(swap.pool)
  const quote = v2 ? lamports : quoteForMaxSpend(lamports, slippagePct)
  const result = buyQuoteInput({
    quote: bn(quote),
    slippage: slippagePct,
    baseReserve: swap.poolBaseAmount,
    quoteReserve: swap.poolQuoteAmount,
    virtualQuoteReserves: swap.pool.virtualQuoteReserves,
    globalConfig: swap.globalConfig,
    baseMintAccount: swap.baseMintAccount,
    baseMint: swap.baseMint,
    coinCreator: swap.pool.coinCreator,
    creator: swap.pool.creator,
    feeConfig: swap.feeConfig,
    quoteMint: swap.pool.quoteMint,
    isMayhemMode: swap.pool.isMayhemMode,
    creatorFeeBps: swap.pool.creatorFeeBps,
  })
  const tokens = big(result.base)
  return {
    v2,
    quote,
    tokens,
    minTokens: minimumOut(tokens, slippagePct),
    maxSpend: v2 ? lamports : big(result.maxQuote),
  }
}

export function quoteBuy(state, lamports, slippagePct = 1) {
  if (lamports <= 0n) return { tokens: 0n }
  if (state.venue === 'curve') {
    const tokens = getBuyV3TokenAmountFromQuoteAmount({
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: bn(lamports),
      curveBaseTokenBalance: state.curveBaseTokenBalance,
    })
    return { tokens: big(tokens) }
  }
  return { tokens: poolBuyPlan(state.swap, lamports, slippagePct).tokens }
}

export function quoteSell(state, tokens, slippagePct = 1) {
  if (tokens <= 0n) return { lamports: 0n }
  if (state.venue === 'curve') {
    const lamports = getSellSolAmountFromTokenAmount({
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: bn(tokens),
    })
    return { lamports: big(lamports) }
  }
  const { swap } = state
  const result = sellBaseInput({
    base: bn(tokens),
    slippage: slippagePct,
    baseReserve: swap.poolBaseAmount,
    quoteReserve: swap.poolQuoteAmount,
    virtualQuoteReserves: swap.pool.virtualQuoteReserves,
    globalConfig: swap.globalConfig,
    baseMintAccount: swap.baseMintAccount,
    baseMint: swap.baseMint,
    coinCreator: swap.pool.coinCreator,
    creator: swap.pool.creator,
    feeConfig: swap.feeConfig,
    quoteMint: swap.pool.quoteMint,
    isMayhemMode: swap.pool.isMayhemMode,
  })
  return { lamports: big(result.uiQuote) }
}

// Buy with an exact SOL budget: `lamports` is the most the swap spends on either venue. The platform
// fee (if any) is a separate, visible transfer.
export async function buyInstructions({ mint, user, lamports, slippagePct, platform }) {
  const state = await marketState(mint, user)
  const fee = await platformFeeInstruction(user, platform, lamports)
  if (state.venue === 'curve') {
    const { tokens } = quoteBuy(state, lamports)
    if (tokens <= 0n) throw Error('That amount is too small to buy any tokens.')
    const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint: state.mint,
      user: state.user,
      amount: bn(tokens),
      quoteAmount: bn(lamports),
      slippage: slippagePct,
      tokenProgram: state.tokenProgram,
    })
    return { instructions: fee ? [...ixs, fee] : ixs, venue: 'curve', expected: tokens }
  }
  const plan = poolBuyPlan(state.swap, lamports, slippagePct)
  if (plan.minTokens <= 0n) throw Error('That amount is too small to buy any tokens.')
  const ixs = plan.v2
    ? await ammOffline.buyExactQuoteInV2Instructions(state.swap, bn(lamports), bn(plan.minTokens))
    : await ammOffline.buyQuoteInput(state.swap, bn(plan.quote), slippagePct)
  return { instructions: fee ? [...ixs, fee] : ixs, venue: 'pool', expected: plan.tokens }
}

export async function sellInstructions({ mint, user, tokens, slippagePct, platform }) {
  const state = await marketState(mint, user)
  const { lamports } = quoteSell(state, tokens, slippagePct)
  const fee = await platformFeeInstruction(user, platform, lamports)
  const ixs =
    state.venue === 'curve'
      ? await PUMP_SDK.sellV3Instructions({
          bondingCurve: state.bondingCurve,
          mint: state.mint,
          user: state.user,
          amount: bn(tokens),
          quoteAmount: bn(lamports),
          slippage: slippagePct,
          tokenProgram: state.tokenProgram,
        })
      : await ammOffline.sellBaseInput(state.swap, bn(tokens), slippagePct)
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
