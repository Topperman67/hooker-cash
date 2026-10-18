// How $QUANTP's fee split is paid out, in the same words everywhere the site describes it (the
// $QUANTP page, the home page's showcase and flywheel, the docs and the footer), and the real
// figures from /api/quantp's `payouts` (server/quantp.mjs ledgerSummary). The rules come from
// QUANTP.engine, which the payout engine (server/quantp-engine.mjs) runs on. Every sentence holds
// whatever the team does: the team funds the wallet when it chooses, the engine aims for one run
// each UTC hour, and nobody is owed a payment.
import { QUANTP } from '../../shared/network.mjs'
import { compact, sol, toSol } from '../lib/format.js'

const minHoldPct = QUANTP.engine.minHoldBps / 100
const minBuyback = toSol(QUANTP.engine.minBuybackLamports)
export const HOLDERS_PCT = QUANTP.holdersShareBps / 100
export const BUYBACK_PCT = QUANTP.buybackShareBps / 100

// DBC graduation cannot be undone: $QUANTP's curve graduated into its DAMM v2 pool
// (QUANTP_DAMM_POOL), so pages never show pre-graduation text, even while /api/quantp is loading
// or down. Read it as `GRADUATED || data?.migrated`.
export const GRADUATED = true
export const QUANTP_DAMM_POOL = 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw'

/** Who gets the holders' share, and how. */
export const HOLDERS_RULE = `In SOL about once an hour, to wallets holding at least ${minHoldPct}% of the supply, by balance.`
/** What the buyback share does. */
export const BUYBACK_RULE = `About once an hour it buys $${QUANTP.symbol} in its pool and burns it, when its share is at least ${sol(minBuyback)}.`
/** Who funds the payout wallet, who runs it, and what that means. */
export const ENGINE_NOTE = `The team sends SOL from the creator’s fee claims to the payout wallet when it chooses; nothing on-chain makes it. Quant Pad’s payout engine aims to release a slice of what that wallet holds once each UTC hour: ${HOLDERS_PCT}% to holders, ${BUYBACK_PCT}% to buy back and burn $${QUANTP.symbol}. It runs on Quant Pad’s server, not in an on-chain program.`
/** What the figures are. */
export const PAID_NOTE = `What the payout wallet has actually paid holders, spent on buybacks and burned, read from the chain.`
/** The one-line disclosure for $QUANTP cards and the footer. */
export const QUANTP_DISCLOSURE = `Quant Pad’s own token. Its ${HOLDERS_PCT}/${BUYBACK_PCT} split is paid by Quant Pad’s payout engine about once an hour from a wallet the team funds; nothing on-chain enforces it. Payouts and buybacks are the team’s discretionary policy: they can change, pause or stop at any time, a run can pay nothing, and holding $${QUANTP.symbol} gives no right to any payment. Memecoins are extremely risky. Not financial advice.`

/** The payout engine's own page (pages/EnginePage.jsx). */
export const ENGINE_PATH = '/engine'

/**
 * The share of a fixed balance an engine at `bps` a day releases over a day: each hourly run
 * releases a 24th of the daily rate of what the wallet holds then, so it compounds (about 33%,
 * 64% and 88% at the 40%, 100% and 200% tiers).
 */
export const dailyShare = (bps) => 1 - (1 - bps / 240_000) ** 24

const big = (v) => {
  try {
    return BigInt(v ?? 0)
  } catch {
    return null
  }
}

/**
 * Where the engine stands, from /api/quantp/engine. Null while unknown or not set up, else:
 *   - 'paused': not live;
 *   - 'pending': switched on, not run yet;
 *   - 'idle': the next run would send nothing (every share is under its minimum);
 *   - 'late': a whole clock hour went by without a run, after 10 minutes' grace (it runs once per
 *     UTC hour, anywhere in the hour);
 *   - 'failing': it keeps running but has paid no one for over two runs while it has wallets to
 *     pay (only once the engine reports `lastPaidAt`);
 *   - 'running'.
 */
export function engineState(engine, nowSecs = Date.now() / 1000) {
  if (!engine?.configured) return null
  if (!engine.live) return 'paused'
  if (!engine.lastRunAt) return 'pending'
  const every = engine.everySecs || QUANTP.engine.everySecs
  const next = engine.next
  if (next?.paying === 0 && big(next.buyback) === 0n) return 'idle'
  if (Math.floor((nowSecs - 600) / every) > Math.floor(engine.lastRunAt / every) + 1) return 'late'
  if (engine.lastPaidAt && next?.paying > 0 && engine.lastRunAt - engine.lastPaidAt > 2 * every)
    return 'failing'
  return 'running'
}
export const ENGINE_STATE_LABEL = {
  running: 'Running hourly',
  late: 'Running late',
  idle: 'Idle: below the payout minimums',
  failing: 'Runs are not paying',
  pending: 'Waiting for its first run',
  paused: 'Paused',
}

// a number from a JSON number or integer string; anything else (garbage, '', objects) is unknown
const finite = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')
    ? Number.isFinite(Number(v))
      ? Number(v)
      : null
    : null
const lamportsToSol = (v) => {
  const n = finite(v)
  return n == null ? null : toSol(n)
}

/**
 * The real figures, as numbers (SOL and whole tokens), each null when unknown. `partial` is true
 * while the server is still reading older history (`complete: false`): the totals are then at
 * least these, not all of it.
 */
export function payoutFigures(payouts, decimals = QUANTP.decimals) {
  const burned = finite(payouts?.burnedAmount)
  return {
    paidSol: lamportsToSol(payouts?.paidLamports),
    wallets: finite(payouts?.wallets),
    boughtSol: lamportsToSol(payouts?.boughtLamports),
    burned: burned == null ? null : burned / 10 ** decimals,
    waitingSol: lamportsToSol(payouts?.waitingLamports),
    partial: payouts?.complete === false,
  }
}

/**
 * The summary to show, from the one shown before (`shown`) and the one just read (`fresh`): a
 * summary still reading older history never replaces a complete one, since the totals only grow.
 * Only the payout wallet's balance, which is read live, comes from it then.
 */
export function keepComplete(shown, fresh) {
  if (!fresh) return shown ?? null
  if (fresh.complete !== false || !shown || shown.complete === false) return fresh
  return { ...shown, waitingLamports: fresh.waitingLamports ?? shown.waitingLamports }
}

export const solFigure = (value) =>
  value == null ? '—' : sol(value, { digits: value !== 0 && value < 10 ? 3 : 2 })
export const tokenFigure = (value) => (value == null ? '—' : compact(value))
/** A figure as "≥ 0.042 SOL" while it is a partial total. */
export const atLeast = (text, partial) => (partial && text !== '—' ? `≥ ${text}` : text)
/** Why a figure reads "≥". */
export const PARTIAL_NOTE =
  'Older transactions are still being read from the chain: these totals are at least this much.'
