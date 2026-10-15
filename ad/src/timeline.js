// Single source of truth for timing. The visuals (Remotion) and the soundtrack
// (scripts/make-audio.mjs) both read this file, so picture and sound cannot drift.

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080
export const SECONDS = 30
export const DURATION = FPS * SECONDS
export const BPM = 120
export const BEAT = (60 / BPM) * FPS // 15 frames
export const BAR = BEAT * 4 // 60 frames

/** seconds → frame */
export const f = (sec) => Math.round(sec * FPS)

// End-card URL. Empty until there is a production domain.
export const URL = ''

export const SHOTS = {
  ignition: { from: 0, to: 4 },
  reveal: { from: 4, to: 8 },
  refraction: { from: 8, to: 14 },
  pulse: { from: 14, to: 20 },
  headline: { from: 20, to: 25 },
  end: { from: 25, to: 30 },
}

// Names and one-liners come from the app (src/lib/hooks.js); colours from DESIGN.md.
export const HOOKS = [
  {
    key: 'creator',
    name: 'Creator share',
    short: 'Paid to you every pulse',
    color: '#2E4BFF',
    glow: '#5C76FF',
    at: 8.0,
    note: 57, // A3 (MIDI)
    pan: -0.6,
    split: 30,
  },
  {
    key: 'burn',
    name: 'Quantum Burn',
    short: 'Buys the coin and burns it',
    color: '#FF3EA5',
    glow: '#FF6FBE',
    at: 9.5,
    note: 61, // C#4
    pan: -0.2,
    split: 30,
  },
  {
    key: 'entangle',
    name: 'Entanglement',
    short: 'Shares SOL with holders',
    color: '#12C26E',
    glow: '#3EE592',
    at: 11.0,
    note: 64, // E4
    pan: 0.2,
    split: 20,
  },
  {
    key: 'fusion',
    name: 'Fusion',
    short: 'Adds locked liquidity',
    color: '#FFC21A',
    glow: '#FFD45C',
    at: 12.5,
    note: 69, // A4
    pan: 0.6,
    split: 20,
  },
]

// Each hook line takes DRAW seconds to reach its payoff, then its payoff plays. Offsets are from
// the hook's `at`; the soundtrack places its per-hook layers on the same moments.
export const DRAW = 0.55
export const HOOK_EVENTS = {
  creator: { pop: DRAW, slot: 1.2 },
  burn: { ignite: DRAW, shatter: 0.85 },
  entangle: { spread: 0.6, lit: 1.2 },
  fusion: { fill: DRAW, lock: 1.15 },
}

// Seconds. Everything lands on the 0.5 s beat grid.
export const CUES = {
  drone: 0.0,
  ignite: 0.5,
  reveal: 4.0,
  glint: 5.5,
  groove: 8.0,
  drop: 14.0,
  pulses: [14.0, 16.0, 18.0],
  cardRise: 16.0,
  titles: [20.0, 21.5, 23.0],
  riser: { from: 23.0, to: 25.0 },
  silence: 25.0,
  final: 25.5,
}

export const SUPERS = [
  { text: 'Every trade pays a creator fee.', from: 1.5, to: 3.75 },
  { text: 'Rules locked at launch. Enforced on-chain.', from: 16.5, to: 19.75 },
]

export const TITLES = [
  // `mark`: the logo shown just before the word `before`
  { text: 'Launch on Meteora.', from: 20.0, to: 21.5, mark: { src: 'meteora-mark.png', before: 'Meteora' } },
  { text: 'Route every fee through', from: 21.5, to: 23.0 },
  { text: 'Quantum Hooks.', from: 23.0, to: 25.0, chrome: true },
]
