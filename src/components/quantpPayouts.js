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

/** The payout engine's own page (pages/EnginePage.jsx). */
export const ENGINE_PATH = '/engine'

/**
 * Where the engine stands, from /api/quantp/engine: 'running' (it ran within the last two hours),
 * 'late' (its last run is older than that), 'pending' (switched on, not run yet) or 'paused' (not
 * live). Null while unknown or not set up.
 */
export function engineState(engine, nowSecs = Date.now() / 1000) {
  if (!engine?.configured) return null
  if (!engine.live) return 'paused'
  if (!engine.lastRunAt) return 'pending'
  return nowSecs - engine.lastRunAt > 2 * engine.everySecs ? 'late' : 'running'
}
export const ENGINE_STATE_LABEL = {
  running: 'Running hourly',
  late: 'Running late',
  pending: 'Waiting for its first run',
  paused: 'Paused',
}

/**
 * When the engine's next run is due, in seconds, from its last run: it runs once in each UTC clock
 * hour (each `everySecs` period), so after a run this hour the next one comes at the top of the
 * next hour. Null when it has never run, or when this hour's run has not come yet (it is due now).
 */
export function nextRunAt(engine, nowSecs = Date.now() / 1000) {
  const every = engine?.everySecs
  if (!engine?.lastRunAt || !every) return null
  const period = Math.floor(nowSecs / every)
  return Math.floor(engine.lastRunAt / every) < period ? null : (period + 1) * every
}

/** "17:00": the UTC time of day of a timestamp in seconds. */
export const utcTime = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 16)

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
