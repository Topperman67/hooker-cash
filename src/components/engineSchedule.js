// When the payout engine (server/quantp-engine.mjs) runs and how fast it releases its wallet, from
// /api/quantp/engine and QUANTP.engine, so the engine's page (pages/EnginePage.jsx) says what the
// engine really does. The engine runs once in each period (everySecs: each UTC clock hour), wherever
// in it the scheduler's tick lands, and each run releases dailyBps / 24 of what the wallet holds
// then, so a day of runs releases less than dailyBps of a balance nobody refills.

const DAY = 86_400

/**
 * When the next run is due, in unix seconds: the start of the period after the last run's, which
 * the status gives as `nextAt` once the engine reports it. Null before the first run.
 */
export function nextRunAt(engine) {
  if (engine?.nextAt != null)
    return engine.nextAt > 1e11 ? Math.floor(engine.nextAt / 1000) : engine.nextAt
  if (!engine?.lastRunAt || !engine.everySecs) return null
  return (Math.floor(engine.lastRunAt / engine.everySecs) + 1) * engine.everySecs
}

/** The share of a wallet that 24 hourly runs at `dailyBps` release when nothing new comes in. */
export const dailyShare = (dailyBps) => 1 - (1 - dailyBps / 240_000) ** 24

/** What one hourly run releases, in bps of the wallet. */
export const hourlyBps = (dailyBps) => dailyBps / 24

/**
 * The least the wallet must hold, in lamports, for a run's buyback share to reach the minimum
 * buyback at `dailyBps`: below it every run skips the buyback and its SOL stays in the wallet.
 */
export function buybackFloorLamports(policy, dailyBps, buybackShareBps) {
  const need = BigInt(policy.minBuybackLamports) * 10_000n * 10_000n * BigInt(DAY)
  const per = BigInt(buybackShareBps) * BigInt(dailyBps) * BigInt(policy.everySecs)
  return Number(BigInt(policy.reserveLamports) + (need + per - 1n) / per)
}

/**
 * What the next run shares out to a holder of `amount` (raw units), in lamports, as the engine
 * works it out: the holders' part of the release, by balance, over `held`, what the wallets it can
 * pay hold (the status's heldEligible). Null without those figures. The status gives no figure for
 * a wallet it skips, so this is also how small a skipped wallet's share was.
 */
export function shareLamports(engine, amount, held = engine?.heldEligible) {
  if (engine?.next?.release == null || engine.holdersShareBps == null) return null
  if (amount == null || held == null || BigInt(held) <= 0n) return null
  const pot = (BigInt(engine.next.release) * BigInt(engine.holdersShareBps)) / 10_000n
  return (pot * BigInt(amount)) / BigInt(held)
}

/** "08:00" for a time today (UTC), "Oct 16, 08:00" for another day. */
export function utcClock(seconds, nowSecs = Date.now() / 1000) {
  const at = new Date(seconds * 1000).toISOString()
  if (at.slice(0, 10) === new Date(nowSecs * 1000).toISOString().slice(0, 10))
    return at.slice(11, 16)
  const day = new Date(seconds * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return `${day}, ${at.slice(11, 16)}`
}
