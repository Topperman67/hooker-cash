// The payout engine film's timeline (src/engine/timeline.js): every sound that answers the
// picture lands on the frame its picture event does, the hourly scene's hand never jumps, and the
// holders scene pays the wallets the engine itself would. Run with node --test (npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { ease, prog } from '../src/anim.js'
import {
  BEAM_FLIGHT,
  BURN_COIN_FLIGHT,
  BURN_COINS,
  BURN_TOKEN_FLIGHT,
  BURN_TOKENS,
  COIN_FLIGHT,
  CUES,
  DURATION,
  ELIGIBLE,
  FACTS,
  FPS,
  HOLDERS_T,
  PAID,
  SCENES,
  SWEEPS,
  TRADES,
  assertRules,
  beamAt,
  sweepAt,
} from '../src/engine/timeline.js'
import { SUPPLY } from '../src/engine/holders.js'
// Node-side only: the film's bundle never imports the server.
import { planRun } from '../../server/quantp-engine.mjs'
import { QUANTP } from '../../shared/network.mjs'

const FRAME = 1 / FPS
/** the time of the first frame at which `shown(t)` holds */
function firstFrame(shown) {
  for (let f = 0; f < DURATION; f++) if (shown(f / FPS)) return f / FPS
  return Infinity
}
/** a flight from `a` lasting `d` has arrived: the picture's prog() reaches 1 */
const arrived = (a, d) => (t) => prog(t, a, a + d) >= 1

/** checks each { i, t } cue against the frame its picture event i shows on */
function inSync(cues, events, label) {
  assert.ok(cues.length > 0, `${label}: no cues`)
  for (const { i, t } of cues) {
    assert.ok(i >= 0 && i < events.length, `${label}: cue for event ${i} of ${events.length}`)
    const shown = firstFrame(events[i])
    assert.ok(Math.abs(t - shown) <= FRAME + 1e-9, `${label} ${i}: sound at ${t.toFixed(3)} s, picture at ${shown.toFixed(3)} s`)
  }
}

test('each fee coin clinks as it lands in the payout wallet', () => {
  assert.equal(CUES.fees.length, TRADES.length)
  inSync(
    CUES.fees,
    TRADES.map((a) => arrived(a, COIN_FLIGHT)),
    'fee',
  )
})

test('the plucks land as the bars light, left to right', () => {
  // The picture's look: round(n × ease.out(p)) bars are lit at p through HOLDERS_T.light.
  const [g0, g1] = HOLDERS_T.light
  const n = ELIGIBLE.length
  const lit = ELIGIBLE.map((_, i) => (t) => Math.round(n * ease.out(prog(t, g0, g1))) > i)
  assert.equal(CUES.plucks.length, Math.ceil(n / 2))
  inSync(CUES.plucks, lit, 'bar')
})

test('a clink lands with every other beam, and beams go only to the wallets paid', () => {
  const beams = PAID.map((_, i) => arrived(beamAt(i, PAID.length), BEAM_FLIGHT))
  assert.equal(CUES.beams.length, Math.ceil(PAID.length / 2))
  inSync(CUES.beams, beams, 'beam')
  // the last beam lands before the scene starts to fade
  assert.ok(firstFrame(beams.at(-1)) < SCENES.holders.to - 0.5)
})

test('the burn scene: clinks as SOL reaches the pool, whomps as $QUANTP reaches the fire', () => {
  inSync(
    CUES.burnCoins,
    BURN_COINS.map((a) => arrived(a, BURN_COIN_FLIGHT)),
    'burn coin',
  )
  inSync(
    CUES.burnTokens,
    BURN_TOKENS.map((a) => arrived(a, BURN_TOKEN_FLIGHT)),
    'burn token',
  )
})

test('each sweep starts at the top on its tick, and its tier lights there', () => {
  for (const w of SWEEPS) {
    const start = firstFrame((t) => sweepAt(t)?.tier === w.tier)
    assert.ok(Math.abs(start - w.from) <= FRAME + 1e-9, `sweep ${w.tier} starts at ${start} s, its tick at ${w.from} s`)
    assert.equal(sweepAt(w.from).angle, 0)
  }
})

test('the hourly hand moves at most 30° a frame and never vanishes mid-scene', () => {
  const first = Math.ceil(SWEEPS[0].from * FPS)
  const last = Math.floor((SWEEPS.at(-1).to + 0.6) * FPS) - 1
  let prev = null
  let largest = 0
  for (let f = first; f <= last; f++) {
    const sweep = sweepAt(f / FPS)
    assert.ok(sweep, `no hand at frame ${f}`)
    if (prev != null) {
      const d = Math.abs(sweep.angle - prev) % (2 * Math.PI)
      largest = Math.max(largest, (Math.min(d, 2 * Math.PI - d) * 180) / Math.PI)
    }
    prev = sweep.angle
  }
  assert.ok(largest <= 30, `the hand jumps ${largest.toFixed(1)}° in one frame`)
})

test('the holders scene pays the wallets planRun pays, on the same snapshot and pot', () => {
  // A policy that releases the whole balance to holders, so the holders' pot is the stated one;
  // the share rule and minimum transfer are the engine's own.
  const holders = ELIGIBLE.map((h, i) => ({ owner: `holder${i}`, amount: BigInt(h.tokens) * 10n ** 6n }))
  const plan = planRun({
    balance: BigInt(FACTS.pot),
    marketCapUsd: 0,
    holders,
    policy: { ...QUANTP.engine, reserveLamports: '0', everySecs: 86_400, tiers: [{ belowUsd: null, dailyBps: 10_000 }], maxRunLamports: String(FACTS.pot) },
    holdersShareBps: 10_000,
  })
  assert.equal(plan.holdersPot, BigInt(FACTS.pot))
  assert.equal(PAID.length, plan.payouts.length)
  assert.deepEqual(
    PAID.map((h) => `holder${ELIGIBLE.indexOf(h)}`),
    plan.payouts.map((p) => p.wallet),
  )
  assert.ok(PAID.length <= ELIGIBLE.length)
})

test('the supply counter ends at the supply less the first engine burn', () => {
  assert.equal(SUPPLY - FACTS.firstBurn.amount, 996_880_767)
})

test('the film refuses to build once the engine changes a rule it states, hourly runs included', () => {
  assert.doesNotThrow(() => assertRules())
  assert.equal(FACTS.runsPerDay, 24)
  const engine = (change) => ({ ...QUANTP, engine: { ...QUANTP.engine, ...change } })
  const changed = [
    { ...QUANTP, holdersShareBps: 5000, buybackShareBps: 5000 },
    { ...QUANTP, postGradFeeBps: 400 },
    engine({ minHoldBps: 10 }),
    engine({ everySecs: 1800 }),
    engine({ tiers: QUANTP.engine.tiers.map((t, i) => (i ? t : { ...t, dailyBps: 1000 })) }),
  ]
  for (const q of changed) assert.throws(() => assertRules(q), /rules changed/)
})
