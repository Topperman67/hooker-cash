// Spend and slippage maths for the trade ticket, in bigint lamports / raw token units. The amount a
// person enters to buy is the most they spend: slippage only lowers the minimum they receive.
export const BPS = 10_000n

export const slippageBps = (pct) => BigInt(Math.round(Math.max(0, Number(pct) || 0) * 100))

/** Platform fee on `lamports` at `feeBps`. */
export const platformFee = (lamports, feeBps) =>
  feeBps && lamports > 0n ? (lamports * BigInt(feeBps)) / BPS : 0n

/** `amount` reduced by the slippage tolerance: the least a trade may deliver. */
export const minimumOut = (amount, slippagePct) => (amount * (BPS - slippageBps(slippagePct))) / BPS

/**
 * The quote to price a PumpSwap v1 `buy` with when its cost cap (`quote × (1 + slippage)`, which is
 * also what gets wrapped into WSOL) must not exceed `budget`.
 */
export const quoteForMaxSpend = (budget, slippagePct) =>
  (budget * BPS) / (BPS + slippageBps(slippagePct))

/** pump-swap-sdk's cost cap for a quote: `quote × floor((1 + s/100) × 1e9) / 1e9`. */
export const sdkMaxQuote = (quote, slippagePct) =>
  (quote * BigInt(Math.floor((1 + Number(slippagePct) / 100) * 1_000_000_000))) / 1_000_000_000n

// SOL kept aside for network fees and the accounts a buy may open: the coin's token account
// (~0.0021 SOL) on either venue, plus a temporary WSOL account (~0.002 SOL, refunded when it is
// closed in the same transaction) for a PumpSwap pool, plus priority fees.
export const BUY_RESERVE = { curve: 5_000_000n, pool: 7_000_000n }
// "Max" leaves this much more on top, so the result does not sit exactly on the limit.
export const MAX_HEADROOM = 5_000_000n

const reserveFor = (venue) => (venue === 'pool' ? BUY_RESERVE.pool : BUY_RESERVE.curve)

/** Total SOL a buy of `lamports` can take from the wallet. */
export const buyCost = (lamports, { feeBps = 0, venue = 'curve' } = {}) =>
  lamports + platformFee(lamports, feeBps) + reserveFor(venue)

/** Whether `balance` cannot cover a buy of `lamports`. */
export const buyExceedsBalance = (lamports, balance, options) =>
  balance != null && buyCost(lamports, options) > balance

/** The largest buy the "Max" button should fill in for `balance`. */
export function maxBuy(balance, { feeBps = 0, venue = 'curve' } = {}) {
  if (balance == null) return 0n
  const spendable = balance - reserveFor(venue) - MAX_HEADROOM
  if (spendable <= 0n) return 0n
  return (spendable * BPS) / (BPS + BigInt(feeBps || 0))
}
