// How $QUANTP's fee split is paid out, in the same words everywhere the site describes it (the
// $QUANTP page, the home page's showcase and flywheel, the coin card and the docs), and the real
// figures from /api/quantp's `payouts` (server/quantp.mjs ledgerSummary). The rules come from
// QUANTP.engine, which the payout engine (server/quantp-engine.mjs) runs on.
import { QUANTP } from '../../shared/network.mjs'
import { compact, sol, toSol } from '../lib/format.js'

const minHoldPct = QUANTP.engine.minHoldBps / 100
export const HOLDERS_PCT = QUANTP.holdersShareBps / 100
export const BUYBACK_PCT = QUANTP.buybackShareBps / 100

/** Who gets the holders' share, and how. */
export const HOLDERS_RULE = `In SOL every hour, to each wallet holding at least ${minHoldPct}% of the supply, by balance.`
/** What the buyback share does. */
export const BUYBACK_RULE = `Every hour it buys $${QUANTP.symbol} in its pool and burns it.`
/** Who runs it, and what that means. */
export const ENGINE_NOTE = `The team sends the creator’s share of the fees to its payout wallet, and Quant Pad’s payout engine pays it out from there every hour: a little at a time while the market cap is small, more as it grows. The engine runs on Quant Pad’s server, not in an on-chain program, so it depends on the team funding the wallet.`
/** What the figures are. */
export const PAID_NOTE = `What the payout wallet has actually paid holders, spent on buybacks and burned, read from the chain.`
/** The one-line disclosure for $QUANTP cards. */
export const QUANTP_DISCLOSURE = `Quant Pad’s own token. Its ${HOLDERS_PCT}/${BUYBACK_PCT} fee split is paid out every hour by Quant Pad’s payout engine from a wallet the team funds; nothing on-chain enforces it. Memecoins are extremely risky. Not financial advice.`

const finite = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)

/** The real figures, as numbers (SOL and whole tokens), each null when unknown. */
export function payoutFigures(payouts, decimals = QUANTP.decimals) {
  return {
    paidSol: payouts ? toSol(payouts.paidLamports) : null,
    wallets: finite(payouts?.wallets),
    boughtSol: payouts ? toSol(payouts.boughtLamports) : null,
    burned: payouts ? Number(payouts.burnedAmount) / 10 ** decimals : null,
    waitingSol: payouts?.waitingLamports == null ? null : toSol(payouts.waitingLamports),
  }
}

export const solFigure = (value) =>
  value == null ? '—' : sol(value, { digits: value !== 0 && value < 10 ? 3 : 2 })
export const tokenFigure = (value) => (value == null ? '—' : compact(value))
