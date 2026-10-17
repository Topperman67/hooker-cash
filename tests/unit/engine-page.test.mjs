// The Payout Engine page's figures (src/components/engineData.js): the running totals its charts
// draw from /api/quantp/ledger, the mixed payouts-and-burns feed, the countdown, the release tier
// and the axis ticks.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activityOf,
  burnSeries,
  clock,
  nextRun,
  niceTicks,
  paidSeries,
  tierIndex,
  timeTicks,
} from '../../src/components/engineData.js'
import { QUANTP } from '../../shared/network.mjs'

const burst = (timestamp, lamports, recipients, signature = `p${timestamp}`) => ({
  timestamp,
  lamports: String(lamports),
  recipients,
  recipient: null,
  transactions: [{ signature, timestamp, lamports: String(lamports), recipients }],
})
const burn = (timestamp, amount, solSpent, signature = `b${timestamp}`) => ({
  signature,
  slot: timestamp,
  timestamp,
  wallet: QUANTP.payoutWallet,
  method: 'burn',
  amount: String(amount),
  solSpent: solSpent == null ? null : String(solSpent),
})

test('the paid chart: a running total in SOL, oldest first, from the newest-first bursts', () => {
  const bursts = [burst(300, 250_000_000, 2), burst(100, 549_999_974, 51), burst(200, 1, 1)]
  assert.deepEqual(paidSeries(bursts), [
    { t: 100, v: 0.549999974, d: 0.549999974, n: 51 },
    { t: 200, v: 0.549999975, d: 1e-9, n: 1 },
    { t: 300, v: 0.799999975, d: 0.25, n: 2 },
  ])
  assert.deepEqual(paidSeries(null), [])
  // a burst the node gave no time for is left out
  assert.deepEqual(paidSeries([burst(0, 5, 1)]), [])
})

test('the burned chart: a running total in whole tokens, with the SOL each buyback spent', () => {
  const burns = [burn(200, 3_000_000_000_000, null), burn(100, 1_500_000_000_000, 250_000_000)]
  assert.deepEqual(burnSeries(burns, 6), [
    { t: 100, v: 1_500_000, d: 1_500_000, sol: 0.25 },
    { t: 200, v: 4_500_000, d: 3_000_000, sol: null },
  ])
})

test('activity mixes payouts and burns, newest first', () => {
  const feed = activityOf({
    payouts: [burst(300, 1, 1), burst(100, 1, 1)],
    burns: [burn(200, 1, 1)],
  })
  assert.deepEqual(
    feed.map((e) => [e.kind, e.t]),
    [
      ['payout', 300],
      ['burn', 200],
      ['payout', 100],
    ],
  )
  assert.equal(new Set(feed.map((e) => e.key)).size, 3)
  assert.deepEqual(activityOf(null), [])
})

test('the countdown: the next run comes in the clock hour after the last, the first one now', () => {
  const HOUR = 1_792_224_000 // on the hour (UTC)
  // it ran at 0:11, so the next comes in the next hour, from 1:00
  const engine = { live: true, everySecs: 3600, lastRunAt: HOUR + 660 }
  const run = nextRun(engine, HOUR + 1800)
  assert.deepEqual([run.at, run.left], [HOUR + 3600, 1800])
  assert.ok(Math.abs(run.progress - 0.5) < 1e-12)
  // past the top of the hour it is due, until it runs (anywhere in that hour)
  assert.deepEqual(nextRun(engine, HOUR + 3700), { at: HOUR + 3600, left: 0, progress: 1 })
  // a run at 0:59 still makes 1:00 the next
  assert.equal(nextRun({ ...engine, lastRunAt: HOUR + 3540 }, HOUR + 3550).at, HOUR + 3600)
  assert.deepEqual(nextRun({ live: true, everySecs: 3600, lastRunAt: null }, 5), {
    at: 5,
    left: 0,
    progress: 1,
  })
  assert.equal(nextRun({ ...engine, live: false }, HOUR), null)
  assert.equal(nextRun(null, HOUR), null)
  assert.equal(clock(2400), '40:00')
  assert.equal(clock(61.9), '01:01')
  assert.equal(clock(3725), '1:02:05')
  assert.equal(clock(-5), '00:00')
})

test('the release tier follows the market cap, the lowest when it is unknown', () => {
  assert.equal(tierIndex(null), 0)
  assert.equal(tierIndex(27_000), 0)
  assert.equal(tierIndex(100_000), 1)
  assert.equal(tierIndex(999_999), 1)
  assert.equal(tierIndex(5_000_000), 2)
})

test('the y-axis runs from 0 to a clean top above the largest value', () => {
  assert.deepEqual(niceTicks(1.157), [0, 0.5, 1, 1.5])
  assert.deepEqual(niceTicks(0.55), [0, 0.2, 0.4, 0.6])
  assert.deepEqual(niceTicks(1_320_000), [0, 500_000, 1_000_000, 1_500_000])
  assert.deepEqual(niceTicks(4), [0, 1, 2, 3, 4])
  assert.deepEqual(niceTicks(0), [0, 1])
})

test('time ticks sit on whole hours or midnights, a midnight named by its date, never crowded', () => {
  const t0 = Date.UTC(2026, 9, 14, 13, 17) / 1000
  for (const [span, width] of [
    [3 * 3600, 500],
    [62 * 3600, 600],
    [62 * 3600, 260],
    [20 * 86_400, 600],
  ]) {
    const ticks = timeTicks(t0, t0 + span, width)
    assert.ok(ticks.length >= 1 && ticks.length <= Math.floor(width / 64), `${span}/${width}`)
    for (const { t, label } of ticks) {
      const d = new Date(t * 1000)
      assert.ok(t >= t0 && t <= t0 + span)
      assert.equal(d.getMinutes(), 0)
      if (d.getHours() === 0) assert.match(label, /^[A-Z][a-z]{2} \d{1,2}$/)
      else assert.match(label, /^\d{2}:00$/)
    }
  }
  // a long span: one tick per day or more, each a date
  const days = timeTicks(t0, t0 + 20 * 86_400, 600)
  assert.ok(days.every((tick) => / \d{1,2}$/.test(tick.label)))
})
