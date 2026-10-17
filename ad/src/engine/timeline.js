// The payout engine film: every timing, read by the picture (Engine.jsx) and the soundtrack
// (scripts/make-engine-audio.mjs), so the two cannot drift. 120 BPM: a beat is half a second, a
// bar two seconds, and every scene starts on a bar.
import { QUANTP } from '../../../shared/network.mjs'

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

// The facts the film states, from the engine's own rules (shared/network.mjs) and the chain.
export const FACTS = {
  wallet: QUANTP.engine.wallet,
  walletShort: `${QUANTP.engine.wallet.slice(0, 4)}…${QUANTP.engine.wallet.slice(-4)}`,
  holdersPct: QUANTP.holdersShareBps / 100, // 60
  buybackPct: QUANTP.buybackShareBps / 100, // 40
  minHoldPct: QUANTP.engine.minHoldBps / 100, // 0.15
  poolFee: QUANTP.postGradFeeBps / 100, // 5
  tiers: QUANTP.engine.tiers, // 20% / 50% / 100% of the wallet a day, by market cap
  url: 'quantpad.company/quantp',
  // The first run, simulated on mainnet on 2026-10-16 without the key: it burns what the payout
  // wallet had bought back plus its own buy.
  simulatedBurn: 3_121_201,
  // The site's Payouts & burns panel on 2026-10-17 (round 1, by hand, before the engine).
  site: { paid: '0.55 SOL', wallets: 51, eligible: 31, waiting: '1.022 SOL' },
}

// Fee coins in the fees scene: one per trade, from the trades' arrival at the pool.
export const TRADES = Array.from({ length: 22 }, (_, i) => 4.4 + i * 0.22)
export const COIN_FLIGHT = 0.9 // pool → wallet, seconds
export const TRADE_FLIGHT = 1.0 // left edge → pool

// The hourly scene: the hand sweeps an hour in 2 s, three times; each sweep releases a slice
// as big as the tier it lights.
export const SWEEPS = [
  { from: 10.5, to: 12, tier: 0 },
  { from: 12, to: 13.5, tier: 1 },
  { from: 13.5, to: 15, tier: 2 },
]

// The holders scene.
export const HOLDERS_T = {
  rise: [16.3, 17.6], // the bars grow, biggest first
  line: [17.8, 18.6], // the 0.15% line sweeps across
  light: [18.6, 19.4], // the eligible bars light, left to right
  beams: [19.6, 22.8], // SOL beams to each, by balance
}

// The burn scene.
export const BURN_T = {
  coins: [24.6, 27.4], // SOL into the pool
  tokens: [25.0, 28.2], // $QUANTP out into the fire
  count: [25.4, 28.8], // the supply counter
}

// Sound cues (seconds), for the soundtrack.
export const CUES = {
  whooshes: [3.6, 9.6, 15.6, 23.6, 29.6, 33.6],
  titleHit: 0.9,
  sweepsDone: SWEEPS.map((s) => s.to),
  tierSteps: SWEEPS.map((s) => s.from + 0.05),
  lineSweep: HOLDERS_T.line[0],
  endHit: 34.0,
}
