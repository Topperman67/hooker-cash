// The payout engine's schedule and release rate as its page states them (src/components/
// engineSchedule.js): one run in each UTC clock hour, dailyBps / 24 of the wallet each run, and the
// balance below which a run's buyback share is under the minimum.
import test from 'node:test'
import assert from 'node:assert/strict'
import { QUANTP } from '../../shared/network.mjs'
import {
  buybackFloorLamports,
  dailyShare,
  hourlyBps,
  nextRunAt,
  utcClock,
} from '../../src/components/engineSchedule.js'

const at = (hh, mm, ss = 0) => Date.UTC(2026, 9, 16, hh, mm, ss) / 1000
const engine = (over) => ({ everySecs: 3600, lastRunAt: at(7, 0), ...over })

test('the next run is due at the start of the clock hour after the last run', () => {
  // a run late in its hour is followed by the next hour's, not by one an hour later
  assert.equal(nextRunAt(engine({ lastRunAt: at(7, 58) })), at(8, 0))
  assert.equal(nextRunAt(engine({ lastRunAt: at(7, 0, 24) })), at(8, 0))
  assert.equal(nextRunAt(engine({ lastRunAt: at(7, 59, 59) })), at(8, 0))
  assert.equal(nextRunAt(engine({ lastRunAt: at(8, 0) })), at(9, 0))
  // the engine's own figure wins, in seconds (or milliseconds, read as seconds)
  assert.equal(nextRunAt(engine({ lastRunAt: at(7, 58), nextAt: at(9, 0) })), at(9, 0))
  assert.equal(nextRunAt(engine({ nextAt: at(9, 0) * 1000 })), at(9, 0))
  assert.equal(nextRunAt(engine({ lastRunAt: null })), null)
  assert.equal(nextRunAt(null), null)
})

test('a day of hourly runs releases about 18%, 40% or 64% of a wallet nobody refills', () => {
  const [low, mid, top] = QUANTP.engine.tiers.map((t) => dailyShare(t.dailyBps))
  assert.ok(Math.abs(low - 0.182) < 0.001, String(low))
  assert.ok(Math.abs(mid - 0.397) < 0.001, String(mid))
  assert.ok(Math.abs(top - 0.64) < 0.001, String(top))
  assert.equal(dailyShare(0), 0)
})

test('each run releases a 24th of the daily rate', () => {
  assert.ok(Math.abs(hourlyBps(2000) - 83.333) < 0.001)
  assert.equal(hourlyBps(5000), 5000 / 24)
  assert.equal(hourlyBps(10_000), 10_000 / 24)
})

test('buybacks need about 0.62 SOL in the wallet at the 20% tier', () => {
  const floor = buybackFloorLamports(QUANTP.engine, 2000, QUANTP.buybackShareBps)
  assert.ok(Math.abs(floor - 620_000_000) <= 1, String(floor))
  // a wallet at the floor releases a buyback share of the minimum; just under it, less
  const share = (balance, dailyBps = 2000) =>
    ((((balance - 20_000_000) * dailyBps * 3600) / (10_000 * 86_400)) * 4000) / 10_000
  assert.ok(share(floor) >= 2_000_000)
  assert.ok(share(floor - 1_000_000) < 2_000_000)
  // higher tiers release faster, so the floor drops
  assert.ok(Math.abs(buybackFloorLamports(QUANTP.engine, 5000, 4000) - 260_000_000) <= 1)
  assert.ok(Math.abs(buybackFloorLamports(QUANTP.engine, 10_000, 4000) - 140_000_000) <= 1)
})

test('times read in UTC, with the day when it is not today', () => {
  assert.equal(utcClock(at(8, 0), at(7, 17)), '08:00')
  assert.equal(utcClock(at(23, 5), at(7, 17)), '23:05')
  assert.equal(utcClock(at(8, 0) - 86_400, at(7, 17)), 'Oct 15, 08:00')
})
