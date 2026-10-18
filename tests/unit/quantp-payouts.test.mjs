// How the site words and reads $QUANTP's payouts (src/components/quantpPayouts.js): the engine's
// state from /api/quantp/engine, the daily share of the hourly release, and the real figures from
// /api/quantp's `payouts`, whatever the route sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  atLeast,
  BUYBACK_RULE,
  dailyShare,
  ENGINE_STATE_LABEL,
  engineState,
  HOLDERS_RULE,
  keepComplete,
  payoutFigures,
  QUANTP_DISCLOSURE,
  solFigure,
  tokenFigure,
} from '../../src/components/quantpPayouts.js'

const HOUR = 3600
// 2026-10-16 07:00:00 UTC, the top of a clock hour
const H7 = Date.UTC(2026, 9, 16, 7) / 1000
const engine = (over = {}) => ({
  configured: true,
  live: true,
  everySecs: HOUR,
  lastRunAt: H7,
  next: { release: '8349000', holders: '4958000', buyback: '3340000', paying: 28 },
  ...over,
})

test('the engine is late only once a whole clock hour was missed, after a 10-minute grace', () => {
  // a run at 07:00 covers the 07 hour; the 08 hour's run is due until 08:59
  assert.equal(engineState(engine(), H7 + 20 * 60), 'running')
  assert.equal(engineState(engine(), H7 + HOUR + 59 * 60), 'running', '1h59m is not late')
  // the 08 hour was missed: late from 09:10, not at 09:00
  assert.equal(engineState(engine(), H7 + 2 * HOUR + 9 * 60 + 59), 'running')
  assert.equal(engineState(engine(), H7 + 2 * HOUR + 10 * 60), 'late')
  assert.equal(engineState(engine(), H7 + 3 * HOUR), 'late', 'three clock hours is late')
  // a run late in its hour (07:59) is not behind at 08:59
  assert.equal(engineState(engine({ lastRunAt: H7 + 59 * 60 }), H7 + HOUR + 59 * 60), 'running')
  // ...and a run at 06:59 followed by a missed 07 hour is late from 08:10, not 08:59
  assert.equal(engineState(engine({ lastRunAt: H7 - 60 }), H7 + HOUR + 10 * 60), 'late')
  assert.equal(engineState(engine({ lastRunAt: H7 - 60 }), H7 + HOUR + 9 * 60), 'running')
})

test('an engine with nothing to send is idle, before it can look late', () => {
  const idle = engine({ next: { release: '1000', holders: '600', buyback: '0', paying: 0 } })
  assert.equal(engineState(idle, H7 + 600), 'idle')
  assert.equal(engineState(idle, H7 + 5 * HOUR), 'idle')
  assert.equal(ENGINE_STATE_LABEL.idle, 'Idle: below the payout minimums')
  // paying no one but still buying back, or paying with no buyback, is not idle
  assert.equal(
    engineState(engine({ next: { buyback: '3340000', paying: 0 } }), H7 + 600),
    'running',
  )
  assert.equal(engineState(engine({ next: { buyback: '0', paying: 3 } }), H7 + 600), 'running')
  // no `next` (or a garbled buyback) never counts as idle
  assert.equal(engineState(engine({ next: undefined }), H7 + 600), 'running')
  assert.equal(engineState(engine({ next: { buyback: 'x', paying: 0 } }), H7 + 600), 'running')
})

test('runs that keep going without paying anyone are failing, once lastPaidAt is known', () => {
  const now = H7 + 600
  // the store says it ran at 07:00, the chain's last payout is from 04:00
  assert.equal(engineState(engine({ lastPaidAt: H7 - 3 * HOUR }), now), 'failing')
  assert.equal(ENGINE_STATE_LABEL.failing, 'Runs are not paying')
  // exactly two hours is not failing yet
  assert.equal(engineState(engine({ lastPaidAt: H7 - 2 * HOUR }), now), 'running')
  // nobody to pay: not failing
  const quiet = engine({ lastPaidAt: H7 - 9 * HOUR, next: { buyback: '3340000', paying: 0 } })
  assert.equal(engineState(quiet, now), 'running')
  // without lastPaidAt (an engine from before it was reported), never failing
  assert.equal(engineState(engine({ lastPaidAt: null }), now), 'running')
})

test('unknown, paused and pending engines keep their states and labels', () => {
  assert.equal(engineState(null), null)
  assert.equal(engineState(undefined), null)
  assert.equal(engineState({ configured: false }), null)
  assert.equal(engineState(engine({ live: false }), H7), 'paused')
  assert.equal(engineState(engine({ lastRunAt: null }), H7), 'pending')
  assert.equal(engineState(engine({ lastRunAt: 0 }), H7), 'pending')
  assert.equal(ENGINE_STATE_LABEL.running, 'Running hourly')
  assert.equal(ENGINE_STATE_LABEL.late, 'Running late')
  assert.equal(ENGINE_STATE_LABEL.pending, 'Waiting for its first run')
  assert.equal(ENGINE_STATE_LABEL.paused, 'Paused')
})

test('the daily share of an hourly release compounds over 24 runs', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0005, `${a} is not about ${b}`)
  near(dailyShare(2000), 0.182)
  near(dailyShare(5000), 0.397)
  near(dailyShare(10_000), 0.64)
  assert.equal(dailyShare(0), 0)
})

test('the payout figures are numbers, or null when the route sends nothing usable', () => {
  assert.deepEqual(
    payoutFigures({
      paidLamports: '549999974',
      wallets: 51,
      boughtLamports: '552559872',
      burnedAmount: '3119233145959',
      waitingLamports: '1021862000',
    }),
    {
      paidSol: 0.549999974,
      wallets: 51,
      boughtSol: 0.552559872,
      burned: 3_119_233.145959,
      waitingSol: 1.021862,
      partial: false,
    },
  )
  const none = {
    paidSol: null,
    wallets: null,
    boughtSol: null,
    burned: null,
    waitingSol: null,
    partial: false,
  }
  assert.deepEqual(payoutFigures(null), none)
  assert.deepEqual(payoutFigures(undefined), none)
  assert.deepEqual(payoutFigures({}), none)
  assert.deepEqual(
    payoutFigures({
      paidLamports: 'abc',
      wallets: 'many',
      boughtLamports: '',
      burnedAmount: {},
      waitingLamports: null,
    }),
    none,
  )
  assert.deepEqual(payoutFigures({ paidLamports: [], wallets: true, burnedAmount: NaN }), none)
  // a figure the route sends as a number still reads
  assert.equal(payoutFigures({ paidLamports: 1e9 }).paidSol, 1)
  // and each one prints "—" when unknown
  assert.equal(solFigure(null), '—')
  assert.equal(tokenFigure(null), '—')
  assert.equal(solFigure(0.000265899), '0.000266 SOL')
})

test('the rules and the disclosure promise no fixed hour and no right to a payment', () => {
  assert.equal(
    HOLDERS_RULE,
    'In SOL about once an hour, to wallets holding at least 0.15% of the supply, by balance.',
  )
  assert.equal(
    BUYBACK_RULE,
    'About once an hour it buys $QUANTP in its pool and burns it, when its share is at least 0.002 SOL.',
  )
  assert.match(QUANTP_DISCLOSURE, /holding \$QUANTP gives no right to any payment/)
  assert.match(QUANTP_DISCLOSURE, /about once an hour/)
  assert.doesNotMatch(QUANTP_DISCLOSURE, /every hour/)
})

test('payout totals still being read show as "at least", and never replace complete ones', () => {
  const complete = { paidLamports: '650000000', burnedAmount: '3486347208070', complete: true }
  const partial = {
    paidLamports: '42405758',
    burnedAmount: '49979400711',
    waitingLamports: '2768041908',
    complete: false,
  }
  assert.equal(payoutFigures(complete).partial, false)
  assert.equal(payoutFigures(partial).partial, true)
  // an older server without `complete` is read as complete
  assert.equal(payoutFigures({ paidLamports: '1' }).partial, false)
  assert.equal(atLeast(solFigure(0.042405758), true), '≥ 0.042 SOL')
  assert.equal(atLeast(solFigure(0.042405758), false), '0.042 SOL')
  assert.equal(atLeast('—', true), '—')
  // a partial summary keeps the complete totals already shown, with the live balance
  assert.deepEqual(keepComplete(complete, partial), { ...complete, waitingLamports: '2768041908' })
  // a complete one, or a partial one with nothing complete before it, is taken as it is
  const newer = { ...complete, paidLamports: '760000000' }
  assert.equal(keepComplete(partial, newer), newer)
  assert.equal(keepComplete(null, partial), partial)
  assert.equal(
    keepComplete(partial, { ...partial, paidLamports: '50000000' }).paidLamports,
    '50000000',
  )
  // a server that has not read the ledger yet keeps what was shown
  assert.equal(keepComplete(complete, null), complete)
  assert.equal(keepComplete(null, null), null)
})
