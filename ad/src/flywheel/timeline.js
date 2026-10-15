// The flywheel film: one source of truth for timing, the fee numbers and the copy. The picture
// (Remotion) and the soundtrack (scripts/flywheel-audio.mjs) both read it, so they cannot drift.
//
// One continuous take through a working machine, 30 s at 120 BPM (a bar is 2 s, 60 frames):
//   0–4    trades race round the dormant glass flywheel
//   4–8    the gate slices 7% off every trade; the slivers fly up into the well
//   8–12   the well pours into the hub and the light splits: 60% green, 40% pink
//   12–16  holders: the 2-hour dial fires a snapshot and SOL lands in every lit wallet
//   16–20  buyback & burn: the pink line buys coins off the supply stack and burns them
//   20–24  the whole machine, spinning up
//   24–30  the buyback & burn arrows circle the flywheel; lockup

export const FPS = 30
export const WIDTH = 1920
export const HEIGHT = 1080
export const SECONDS = 30
export const DURATION = FPS * SECONDS
export const BPM = 120
export const BEAT = 60 / BPM // seconds
export const BAR = BEAT * 4

// The flywheel as the home page states it (src/components/Flywheel.jsx). Change them here.
export const FEE = 7
export const SPLIT = { holders: 60, burn: 40 }
export const URL = 'quantpad.company'

export const COLORS = {
  holders: '#12C26E',
  holdersLight: '#8dffc6',
  burn: '#FF3EA5',
  burnLight: '#ffb0d6',
  cobalt: '#2E4BFF',
  ice: '#dfe5ff',
  arrow: '#8fa4ff',
}

export const SHOTS = {
  trades: { from: 0, to: 4 },
  fee: { from: 4, to: 8 },
  split: { from: 8, to: 12 },
  holders: { from: 12, to: 16 },
  burn: { from: 16, to: 20 },
  loop: { from: 20, to: 24 },
  finale: { from: 24, to: 30 },
}

// Seconds. Everything lands on the half-second beat grid.
export const CUES = {
  open: 0,
  gate: 4.0, // first close-up slice on the downbeat
  pour: 8.0, // the well empties into the hub
  split: 8.5, // the beam refracts into the two lines
  fill: { from: 8.5, to: 10.0 }, // the chart fills behind the light fronts
  spin: 10.0, // the flywheel starts to turn
  holdersReach: 12.5, // the green line arrives at the holders
  snapshot: 13.75, // the 2-hour dial fires (an off-grid "random moment", on purpose)
  paid: 14.0, // SOL lands in every lit wallet
  whip: 16.0, // the camera whips across to the burn rig
  burns: [17.0, 18.0, 19.0, 21.0, 23.0], // a buyback lands and burns on each of these
  wide: 20.0,
  arrows: 24.0, // the buyback & burn arrows ignite
  final: 25.0, // the hit: arrows at full speed, lockup in
  hold: 28.5, // clean hold to the end
}

/** how long a bought coin takes to fly from the stack into the furnace, and when it breaks up */
export const BURN_EVENTS = { lift: 0.0, arrive: 0.45, shatter: 0.62 }

export const SUPERS = [{ text: 'Every trade feeds the flywheel.', from: 0.9, to: 3.8 }]

export const CHIPS = {
  fee: { from: 4.6, to: 7.7, pct: `${FEE}%`, title: 'Fee on every trade', body: 'Taken from every buy and every sell.' },
  holders: {
    from: 12.6,
    to: 15.8,
    pct: `${SPLIT.holders}%`,
    title: 'Paid to holders',
    body: 'In SOL, by a snapshot taken at a random moment every 2 hours.',
    color: COLORS.holders,
  },
  burn: {
    from: 16.7,
    to: 19.8,
    pct: `${SPLIT.burn}%`,
    title: 'Buyback & burn',
    body: 'Buys the token on the market and burns it. Supply only shrinks.',
    color: COLORS.burn,
  },
}

export const LOOP = { from: 20.6, to: 23.8, steps: ['Trades', `${FEE}% fee`, 'Holders paid', 'Supply burned'] }

/** seconds → frame */
export const f = (sec) => Math.round(sec * FPS)
