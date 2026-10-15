// One turn of the fee flywheel, in seconds. The live scene (FlywheelScene.jsx) times its light to
// these beats and lights the card's copy (the step chips, the 60% and 40% rows) on the same beats,
// so the text and the 3D tell the story together. Free of three.js on purpose.

/** Length of one loop. */
export const LOOP = 7

/** The slices rising in and the ring drawing on, the first time the card is seen. */
export const ENTER = 2.6

export const BEATS = {
  /** trade pulses fall into the hub: [first start, last arrival] */
  trades: [0, 1.4],
  /** start times of the trade pulses, and how long each takes to reach the hub */
  tradeStarts: [0, 0.18, 0.36, 0.56],
  tradeTravel: 0.85,
  /** the hub flares: the 7% is taken */
  fee: 1.45,
  /** the split lines leave the hub ... */
  holdersOut: 1.62,
  burnOut: 1.76,
  splitTravel: 1.05,
  /** ... and land in their slices */
  holders: 2.67,
  burn: 2.81,
  /** SOL rises out of the holders slice; embers flicker out of the burn slice */
  coins: [2.72, 3.7],
  coinFlight: 1.5,
  embers: [2.86, 5.3],
  /** the ring surges: round again */
  turn: [5.25, 6.6],
}

/** When each child of the step row (.fw-loop: chip, arrow, chip ...) is lit, in DOM order. */
export const STEPS = [
  [0, 1.5], // Trades
  [1.15, 1.8], // →
  [1.35, 2.75], // 7% fee
  [2.35, 2.95], // →
  [2.67, 5.1], // Holders paid
  [2.74, 5.1], // +
  [2.81, 5.3], // Supply burned
  [5.25, 6.7], // ↻
]
