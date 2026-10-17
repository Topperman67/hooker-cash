// The payout engine film: every timing, read by the picture (Engine.jsx) and the soundtrack
// (scripts/make-engine-audio.mjs), so the two cannot drift: each sound that answers the picture
// is placed by the same schedule the picture draws from. 120 BPM: a beat is half a second, a bar
// two seconds, and every scene starts on a bar.
import { QUANTP } from '../../../shared/network.mjs'
import { ease, prog } from '../anim.js'
import { HOLDERS } from './holders.js'

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080
export const SECONDS = 38
export const DURATION = FPS * SECONDS
export const BPM = 120

export const SCENES = {
  title: { from: 0, to: 4 },
  fees: { from: 4, to: 10 },
  hourly: { from: 10, to: 16 },
  holders: { from: 16, to: 24 },
  burn: { from: 24, to: 30 },
  site: { from: 30, to: 34 },
  end: { from: 34, to: 38 },
}

// The rules the film states, in its copy, its tier card and holders.js's split into eligible and
// below. Should shared/network.mjs change any of them, the film refuses to build rather than show
// the old ones: update the film, then this.
const STATED = {
  holdersShareBps: 6000,
  buybackShareBps: 4000,
  postGradFeeBps: 500,
  minHoldBps: 15,
  tiers: [
    { belowUsd: 100_000, dailyBps: 2000 },
    { belowUsd: 1_000_000, dailyBps: 5000 },
    { belowUsd: null, dailyBps: 10_000 },
  ],
}
const RULES = {
  holdersShareBps: QUANTP.holdersShareBps,
  buybackShareBps: QUANTP.buybackShareBps,
  postGradFeeBps: QUANTP.postGradFeeBps,
  minHoldBps: QUANTP.engine.minHoldBps,
  tiers: QUANTP.engine.tiers.map(({ belowUsd, dailyBps }) => ({ belowUsd, dailyBps })),
}
if (JSON.stringify(RULES) !== JSON.stringify(STATED))
  throw new Error(`The payout engine's rules changed (shared/network.mjs): ${JSON.stringify(RULES)}. The film still states ${JSON.stringify(STATED)}.`)

// The facts the film states, from the engine's own rules (shared/network.mjs) and the chain.
export const FACTS = {
  walletShort: `${QUANTP.engine.wallet.slice(0, 4)}…${QUANTP.engine.wallet.slice(-4)}`,
  holdersPct: QUANTP.holdersShareBps / 100, // 60
  buybackPct: QUANTP.buybackShareBps / 100, // 40
  minHoldPct: QUANTP.engine.minHoldBps / 100, // 0.15
  poolFee: QUANTP.postGradFeeBps / 100, // 5
  tiers: QUANTP.engine.tiers, // 1/120, 1/48 and 1/24 of the wallet each hour, by market cap
  maxRunSol: Number(QUANTP.engine.maxRunLamports) / 1e9, // released in one run at most
  url: 'quantpad.company/quantp', // the site scene's page: the panel it draws is this one's
  engineUrl: 'quantpad.company/engine', // the end card's: the engine's own page
  // The engine's first burn (slot 457945899). The payout wallet held 3,070,967 $QUANTP from round
  // 1's buyback, by hand; the engine's first buyback bought 49,758 more, and it burned all but
  // 1,493 of them.
  firstBurn: { amount: 3_119_233, sig: 'wo7Tyt8d…', at: '17 Oct 2026 07:00 UTC', bought: 49_758, fromRound1: 3_070_967 },
  // The holders' pot the holders scene pays out, in lamports: 60% of the 7,822,072 the engine's
  // next run would release, per /api/quantp/engine at 2026-10-17 14:58 UTC.
  pot: 4_693_243,
  // The site's Payouts & burns panel, from /api/quantp/ledger and /api/quantp/engine at
  // 2026-10-17 14:58:30 UTC: the engine's hourly rate then, its totals and its newest payouts.
  site: {
    at: '17 Oct 2026, 14:58 UTC',
    hourly: '0.83%',
    minHold: '1.49M',
    paid: '0.594 SOL',
    wallets: 67,
    eligible: 31,
    waiting: '0.959 SOL',
    rows: [
      { age: '47m', sol: '0.0047', wallets: 30, txs: 2 },
      { age: '1h', sol: '0.0047', wallets: 30, txs: 2 },
    ],
  },
}

// Fee coins in the fees scene: one per trade, from the trades' arrival at the pool.
export const TRADES = Array.from({ length: 22 }, (_, i) => 4.4 + i * 0.22)
export const COIN_FLIGHT = 0.9 // pool → wallet, seconds
export const TRADE_FLIGHT = 1.0 // left edge → pool
/** when trade i's fee coin lands in the payout wallet */
export const feeLandsAt = (i) => TRADES[i] + COIN_FLIGHT

// The hourly scene: the hand sweeps an hour in 1.5 s, three times; each sweep releases a slice
// as big as the tier it lights.
export const SWEEPS = [
  { from: 10.5, to: 12, tier: 0 },
  { from: 12, to: 13.5, tier: 1 },
  { from: 13.5, to: 15, tier: 2 },
]
/**
 * The hand at `t`: the latest sweep begun, held 0.6 s past its end, with its angle (radians from
 * the top), or null. Each sweep starts at the top on its tick, as its tier lights.
 */
export function sweepAt(t) {
  const sweep = SWEEPS.findLast((w) => t >= w.from && t < w.to + 0.6)
  return sweep ? { ...sweep, angle: ease.inOut(prog(t, sweep.from, sweep.to)) * Math.PI * 2 } : null
}

// The holders scene.
export const HOLDERS_T = {
  rise: [16.3, 17.6], // the bars grow, biggest first
  line: [17.8, 18.6], // the 0.15% line sweeps across
  light: [18.6, 19.4], // the eligible bars light, left to right
  beams: [19.6, 22.8], // SOL beams to each wallet paid, by balance
}
export const BEAM_FLIGHT = 0.9 // payout wallet → bar

// The wallets over the 0.15% line (holders.js), biggest first, and those a run pays: each gets
// floor(pot × balance / held) lamports, and a share under QUANTP.engine.minTransferLamports is not
// sent, by the engine's own rule (planRun in server/quantp-engine.mjs).
export const ELIGIBLE = HOLDERS.filter((h) => h.kind === 'eligible')
const HELD = ELIGIBLE.reduce((s, h) => s + BigInt(h.tokens), 0n)
export const PAID = ELIGIBLE.filter((h) => (BigInt(FACTS.pot) * BigInt(h.tokens)) / HELD >= BigInt(QUANTP.engine.minTransferLamports))

/** when eligible bar i of n lights: left to right, easing out over HOLDERS_T.light */
export const lightAt = (i, n) => HOLDERS_T.light[0] + (HOLDERS_T.light[1] - HOLDERS_T.light[0]) * (1 - Math.cbrt(1 - (i + 0.5) / n))
/** when the beam to paid wallet i of n leaves the payout wallet; it lands BEAM_FLIGHT later */
export const beamAt = (i, n) => HOLDERS_T.beams[0] + (i / n) * (HOLDERS_T.beams[1] - HOLDERS_T.beams[0] - 1.2)
export const beamLandsAt = (i, n) => beamAt(i, n) + BEAM_FLIGHT

// The burn scene.
export const BURN_T = {
  coins: [24.6, 27.4], // SOL into the pool
  tokens: [25.0, 28.2], // $QUANTP out into the fire
  count: [25.4, 28.8], // the supply counter
}
export const BURN_COIN_FLIGHT = 0.8 // payout wallet → pool
export const BURN_TOKEN_FLIGHT = 1 // pool → fire
/** when each SOL coin and each $QUANTP token sets off */
export const BURN_COINS = Array.from({ length: 12 }, (_, i) => BURN_T.coins[0] + (i / 12) * (BURN_T.coins[1] - BURN_T.coins[0] - BURN_COIN_FLIGHT))
export const BURN_TOKENS = Array.from({ length: 18 }, (_, i) => BURN_T.tokens[0] + (i / 18) * (BURN_T.tokens[1] - BURN_T.tokens[0] - BURN_TOKEN_FLIGHT))

// Sound cues (seconds), for the soundtrack. The ones that answer the picture are { i, t }: event
// i's sound at the time the picture shows it.
const every = (list, step, at) => list.flatMap((_, i) => (i % step ? [] : [{ i, t: at(i) }]))
export const CUES = {
  whooshes: [3.6, 9.6, 15.6, 23.6, 29.6, 33.6],
  titleHit: 0.9,
  fees: every(TRADES, 1, feeLandsAt), // a clink as each fee coin lands
  plucks: every(ELIGIBLE, 2, (i) => lightAt(i, ELIGIBLE.length)), // as every other bar lights
  beams: every(PAID, 2, (i) => beamLandsAt(i, PAID.length)), // as every other beam lands
  burnCoins: every(BURN_COINS, 2, (i) => BURN_COINS[i] + BURN_COIN_FLIGHT), // into the pool
  burnTokens: every(BURN_TOKENS, 3, (i) => BURN_TOKENS[i] + BURN_TOKEN_FLIGHT), // into the fire
  endHit: 34.0,
}
