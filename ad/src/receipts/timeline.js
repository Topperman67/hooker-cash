// "The receipts": the $QUANTP payout engine's first day, as a printed log. Every timing lives here
// and is read by the picture (Receipts.jsx) and the soundtrack (scripts/make-receipts-audio.mjs),
// so the two cannot drift. 128 BPM: a beat is 0.46875 s, a bar 1.875 s, and every scene starts on a
// bar. Square, for the feed.
import { QUANTP } from '../../../shared/network.mjs'
import { SNAPSHOT } from './runs.js'

export const FPS = 30
export const WIDTH = 1080
export const HEIGHT = 1080
export const BPM = 128
export const BEAT = 60 / BPM
export const BAR = BEAT * 4
export const SECONDS = BAR * 16 // 30 s
export const DURATION = Math.round(FPS * SECONDS)

/** the time of a beat, counted from the top */
export const beat = (n) => n * BEAT

export const SCENES = {
  title: { from: 0, to: beat(8) },
  rule: { from: beat(8), to: beat(16) },
  receipt: { from: beat(16), to: beat(40) },
  scale: { from: beat(40), to: beat(48) },
  burn: { from: beat(48), to: beat(56) },
  end: { from: beat(56), to: beat(64) },
}

// What the film states: the engine's rules (shared/network.mjs) and the snapshot's figures.
const engine = QUANTP.engine
export const FACTS = {
  minHoldPct: engine.minHoldBps / 100, // 0.15
  minHoldTokens: (Number(QUANTP.supply) / 10 ** QUANTP.decimals) * (engine.minHoldBps / 10_000), // 1.5M
  holdersPct: QUANTP.holdersShareBps / 100, // 60
  buybackPct: QUANTP.buybackShareBps / 100, // 40
  tiers: engine.tiers, // 20% / 50% / 100% of the wallet a day, a 24th of it each hour
  url: 'quantpad.company/engine',
  date: '17 OCT 2026',
  ...SNAPSHOT,
}
if (FACTS.holdersPct !== 60 || FACTS.minHoldPct !== 0.15 || engine.tiers.length !== 3)
  throw Error('The film states a 60/40 split, a 0.15% floor and three tiers: redraw it first.')

// The title: three words on the beat, then the stamp.
export const TITLE_T = { words: [beat(0), beat(1), beat(2)], line: beat(4), stamp: beat(6) }
// The rule: one row every two beats.
export const RULE_T = { rows: [beat(8.5), beat(10.5), beat(12.5)], note: beat(14.5) }
// The receipt: its header, then one hourly run per beat, then the total and the PAID stamp.
const R0 = SCENES.receipt.from
export const RECEIPT_T = {
  header: R0 + beat(0.5),
  runs: FACTS.runs.map((_, i) => R0 + beat(2 + i)),
  total: R0 + beat(2 + FACTS.runs.length + 1),
  stamp: R0 + beat(2 + FACTS.runs.length + 3),
}
// The scale: the steps draw, then the marker runs from this morning's market cap to now's.
const S0 = SCENES.scale.from
export const SCALE_T = { steps: [S0 + beat(0.5), S0 + beat(1), S0 + beat(1.5)], marker: [S0 + beat(3), S0 + beat(5)], line: S0 + beat(5.5) }
// The burn: the page burns away, the count runs up, the supply line lands.
const B0 = SCENES.burn.from
export const BURN_T = { paper: [B0, B0 + beat(1.5)], count: [B0 + beat(1), B0 + beat(5)], supply: B0 + beat(5.5) }
// The end: three lines on the beat, the address, the lockup.
const E0 = SCENES.end.from
export const END_T = { lines: [E0, E0 + beat(1), E0 + beat(2)], url: E0 + beat(4), lockup: E0 + beat(5) }

// Sound cues (seconds), for the soundtrack.
export const CUES = {
  slams: [...TITLE_T.words, TITLE_T.stamp],
  rows: RULE_T.rows,
  prints: RECEIPT_T.runs,
  burnsAt: RECEIPT_T.runs.filter((_, i) => FACTS.runs[i].burned > 0),
  total: RECEIPT_T.total,
  paid: RECEIPT_T.stamp,
  steps: SCALE_T.steps,
  marker: SCALE_T.marker,
  burn: B0,
  supply: BURN_T.supply,
  lines: END_T.lines,
  url: END_T.url,
}
