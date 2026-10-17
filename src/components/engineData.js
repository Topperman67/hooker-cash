// The engine page's figures from /api/quantp/ledger and /api/quantp/engine (server/quantp.mjs
// quantpLedger, server/quantp-engine.mjs status): the running totals its charts draw, the mixed
// payouts-and-burns feed, the countdown to the next run and the clean axis ticks. Pure, so tests
// can run them. The engine's state comes from quantpPayouts.js engineState.
import { QUANTP } from '../../shared/network.mjs'

const big = (v) => BigInt(v ?? 0)

/**
 * What was paid to holders over time, oldest first: one point per burst with the running total
 * (`v`) and that burst's own amount (`d`), in SOL, and how many wallets it paid (`n`).
 */
export function paidSeries(bursts) {
  let total = 0n
  return [...(bursts || [])]
    .filter((b) => b.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((b) => {
      total += big(b.lamports)
      return {
        t: b.timestamp,
        v: Number(total) / 1e9,
        d: Number(b.lamports) / 1e9,
        n: b.recipients,
      }
    })
}

/**
 * What the team burned over time, oldest first: the running total (`v`) and each burn (`d`) in
 * whole tokens, and the SOL its buyback spent (`sol`, null when nothing was bought for it).
 */
export function burnSeries(burns, decimals = QUANTP.decimals) {
  let total = 0n
  const scale = 10 ** decimals
  return [...(burns || [])]
    .filter((b) => b.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot)
    .map((b) => {
      total += big(b.amount)
      return {
        t: b.timestamp,
        v: Number(total) / scale,
        d: Number(b.amount) / scale,
        sol: b.solSpent == null ? null : Number(b.solSpent) / 1e9,
      }
    })
}

/** Payout bursts and burns in one list, newest first, each tagged with its `kind`. */
export function activityOf(ledger) {
  if (!ledger) return []
  return [
    ...(ledger.payouts || []).map((p) => ({
      kind: 'payout',
      key: `p:${p.transactions[0]?.signature}`,
      t: p.timestamp,
      ...p,
    })),
    ...(ledger.burns || []).map((b) => ({
      kind: 'burn',
      key: `b:${b.signature}:${b.wallet}`,
      t: b.timestamp,
      ...b,
    })),
  ].sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
}

/**
 * When the next run comes (unix seconds), the time left until then and how far through the wait
 * the engine is (0..1), or null when it is not live. It runs once in each UTC clock hour
 * (server/quantp-engine.mjs), so after a run the next comes in the following hour; Vercel Cron on
 * Hobby starts each hour's run anywhere within it, so `at` is the earliest. With no run yet, the
 * first is due now.
 */
export function nextRun(engine, nowSecs) {
  if (!engine?.live) return null
  const every = engine.everySecs || QUANTP.engine.everySecs
  if (!engine.lastRunAt) return { at: nowSecs, left: 0, progress: 1 }
  const at = (Math.floor(engine.lastRunAt / every) + 1) * every
  const left = Math.max(0, at - nowSecs)
  return { at, left, progress: Math.min(1, Math.max(0, 1 - left / every)) }
}

/** "mm:ss" (or "h:mm:ss") for a countdown in seconds. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** The release tier at `marketCapUsd`, as an index into `tiers` (the lowest when unknown). */
export function tierIndex(marketCapUsd, tiers = QUANTP.engine.tiers) {
  if (!(Number(marketCapUsd) >= 0)) return 0
  const i = tiers.findIndex((t) => t.belowUsd == null || Number(marketCapUsd) < t.belowUsd)
  return i < 0 ? tiers.length - 1 : i
}

/** A y-axis from 0 to a clean top above `max`, with about `count` evenly spaced clean ticks. */
export function niceTicks(max, count = 4) {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1]
  const raw = max / count
  const pow = 10 ** Math.floor(Math.log10(raw))
  const n = raw / pow
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow
  const steps = Math.ceil(max / step - 1e-9)
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)))
}

const DAY_FMT = { month: 'short', day: 'numeric' }
const HOUR_FMT = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }

/**
 * Time ticks across [t0, t1], at most one per `gap` px: on whole hours (every 1, 2, 3, 6 or 12)
 * with midnights labelled by their date, or on midnights every 1, 2, 7, 14 or 30 days.
 */
export function timeTicks(t0, t1, width, gap = 64) {
  const most = Math.max(2, Math.floor(width / gap))
  const span = t1 - t0
  const hours = [1, 2, 3, 6, 12].find((h) => span / (h * 3600) <= most)
  const days = [1, 2, 7, 14, 30].find((n) => span / (n * 86_400) <= most) ?? 30
  const d = new Date(t0 * 1000)
  if (hours) d.setHours(Math.ceil(d.getHours() / hours) * hours, 0, 0, 0)
  else d.setHours(24, 0, 0, 0)
  const ticks = []
  while (d.getTime() / 1000 <= t1 && ticks.length < 60) {
    const t = d.getTime() / 1000
    const midnight = d.getHours() === 0
    if (t >= t0)
      ticks.push({
        t,
        label: d.toLocaleString('en-US', !hours || midnight ? DAY_FMT : HOUR_FMT),
      })
    if (hours) d.setHours(d.getHours() + hours)
    else d.setDate(d.getDate() + days)
  }
  return ticks
}
