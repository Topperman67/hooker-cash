// Synthesizes the flywheel film's soundtrack (music bed and every sound effect) from the film's own
// timeline and layout, so each sound lands on the frame that makes it, and writes
// public/flywheel-soundtrack.wav: 48 kHz, 24-bit stereo, −14 LUFS, true peak under −1 dBTP.
//
// The fee slices are the music: every trade the gate cuts plays the next note of a glassy
// arpeggio, on the eighth-note grid the trades are timed to.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECONDS, BPM, CUES, LOOP, BURN_EVENTS } from '../src/flywheel/timeline.js'
import { TRADES, SLIVER_FLIGHT, POURS, HOLDERS, HOLDER_REACH, SUPPLY, RING, ringAngle, handAngle } from '../src/flywheel/layout.js'
import { SR, TAU, mtof, db, rng, Biquad, synth, osc, ad, Bus, freeverb, lufs, limit, writeWav24, sat } from './dsp.mjs'
import { noise, kick, clap, hat, snare, bassNote, pad, pluck, bell, metal, boom, whoosh, swell, crackle, zap, clink, thud, crumble, whomp, shimmer, riser } from './instruments.mjs'

const N = Math.ceil(SECONDS * SR)
const BEAT = 60 / BPM
const BAR = BEAT * 4
const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const ARROWS_FROM = CUES.arrows
const SILENCE = CUES.final - BEAT / 2 // half a beat of hard silence before the hit

const music = new Bus(N)
const musicVerb = new Bus(N)
const arpBus = new Bus(N)
const sfx = new Bus(N)
const hall = new Bus(N)
const duck = new Float32Array(N)

function key(t0, depth, release) {
  const s0 = Math.round(t0 * SR)
  for (let i = 0; i < SR * 6 * release && s0 + i < N; i++) {
    const v = depth * Math.exp(-i / (release * SR))
    if (s0 + i >= 0) duck[s0 + i] = Math.max(duck[s0 + i], v)
  }
}

const CHORDS = {
  'F#m': { pad: [54, 57, 61, 66], root: 42 },
  D: { pad: [50, 54, 57, 62], root: 38 },
  A: { pad: [52, 57, 61, 64], root: 45 },
  E: { pad: [52, 56, 59, 64], root: 40 },
  Amaj: { pad: [45, 57, 61, 64, 69], root: 45 },
}
const PROG = ['F#m', 'D', 'A', 'E']
const chordAt = (t) => {
  if (t >= CUES.final) return 'Amaj'
  const bar = Math.floor(t / BAR + 1e-6)
  return bar >= 10 ? (bar === 10 ? 'A' : 'E') : PROG[bar % 4]
}

/** cut a stereo buffer's tail at the pre-hit silence */
const until = (t0, buf, end = SILENCE) => buf.subarray(0, Math.max(0, Math.round((end - t0) * SR)))

// ================================================================================================
// the bed
// ================================================================================================

// 0–4: a sub drone and a slow air swell under the trades
{
  const o1 = osc('sine'), o2 = osc('sine'), o3 = osc('saw'), lp = new Biquad('lowpass', 180, 0.8)
  const d = synth(CUES.gate + 0.3, (t) => {
    const e = Math.min(1, t / 1.2) * (t > CUES.gate ? Math.exp(-(t - CUES.gate) / 0.08) : 1)
    return (o1(55) * 0.7 + o2(110) * 0.18 + lp.run(o3(55.3)) * 0.25) * e * (0.85 + 0.15 * Math.sin(TAU * 0.5 * t))
  })
  music.add(0, d, 0.5)
  sfx.add(0, swell(CUES.gate, 31), 0.13, (t) => -0.4 + 0.8 * (t / CUES.gate))
  const [l, r] = pad(CHORDS['F#m'].pad, CUES.gate - 0.2, { cutoff: 700, attack: 1.4, release: 0.5, seed: 3 })
  music.add2(0, l, r, 0.4)
  musicVerb.add2(0, l, r, 0.3)
}

// pads from the gate to the silence, then the A major of the end card
for (let t0 = CUES.gate; t0 < SILENCE - 1e-6; t0 += BAR) {
  const c = CHORDS[chordAt(t0)]
  const cut = t0 < 8 ? 900 : t0 < 20 ? 1500 : 1300 + (t0 - 20) * 300
  const [L, R] = pad(c.pad, Math.min(BAR, SILENCE - t0), { cutoff: cut, attack: t0 === CUES.gate ? 0.2 : 0.08, release: 0.4, seed: 6 + t0 })
  music.add2(t0, until(t0, L), until(t0, R), 0.5)
  musicVerb.add2(t0, until(t0, L), until(t0, R), 0.25)
}
{
  const [L, R] = pad(CHORDS.Amaj.pad, SECONDS - CUES.final - 0.9, { cutoff: 1900, attack: 0.6, release: 1.0, seed: 60 })
  music.add2(CUES.final + 0.03, L, R, 0.5)
  musicVerb.add2(CUES.final + 0.03, L, R, 0.35)
}

// drums
const K = kick(1), C = clap(2), HC = hat(3), HO = hat(4, true)
const beats = (a, b, step = BEAT) => {
  const out = []
  for (let t = a; t < b - 1e-6; t += step) out.push(+t.toFixed(4))
  return out
}
// the gate: four on the floor, hats on the off-beats
for (const t of beats(CUES.gate, 8)) {
  music.add(t, K, 0.75)
  key(t, 0.45, 0.16)
  music.add(t + BEAT / 2, HC, 0.26, 0.25)
}
// the groove, 8 → the silence
for (const t of beats(8, SILENCE)) {
  if (t >= 23 && t < 24) continue // a bar of air for the riser
  music.add(t, K, 0.85)
  key(t, 0.55, 0.16)
  const beat = Math.round((t % BAR) / BEAT)
  if (beat === 1 || beat === 3) {
    music.add(t, C, 0.5, 0.05)
    musicVerb.add(t, C, 0.25)
  }
  music.add(t + BEAT / 2, t >= 12 ? HO : HC, t >= 12 ? 0.24 : 0.3, 0.25)
  music.add(t + BEAT / 4, HC, 0.09, -0.3)
  music.add(t + (3 * BEAT) / 4, HC, 0.12, 0.35)
}
// the end card: half-time, lighter
for (const t of beats(CUES.final + BAR / 2, SECONDS - 0.5)) {
  const beat = Math.round(((t - CUES.final) % BAR) / BEAT)
  if (beat === 0) music.add(t, K, 0.7)
  if (beat === 2) {
    music.add(t, C, 0.4, 0.05)
    musicVerb.add(t, C, 0.3)
  }
  music.add(t + BEAT / 2, HC, 0.2, 0.25)
}

// bass: long notes under the gate, eighths in the groove, held through the build
for (let t0 = CUES.gate; t0 < SILENCE - 1e-6; t0 += BAR) {
  const root = CHORDS[chordAt(t0)].root
  if (t0 < 8 || t0 >= 22) {
    music.add(t0, until(t0, bassNote(root, Math.min(BAR, SILENCE - t0) - 0.04)), 0.5)
    continue
  }
  for (let k = 0; k < 8; k++) {
    const t = t0 + (k * BEAT) / 2
    music.add(t, bassNote(root + (k % 4 === 3 ? 12 : 0), BEAT / 2 - 0.04, 5 + k), t0 >= 14 ? 0.72 : 0.6)
  }
}
music.add(CUES.final, bassNote(45, SECONDS - CUES.final - 0.6), 0.55)

// ================================================================================================
// sound effects
// ================================================================================================

// trades: a soft zip as each one goes by the gate, and once the gate is lit, the slice is a note
{
  const ARP = [0, 1, 2, 3, 2, 1, 3, 2]
  let step = 0
  for (const tr of TRADES) {
    if (tr.T < 0.3 || tr.T >= ARROWS_FROM) continue
    const r = rng(1000 + tr.k)
    const zip = whoosh(0.32, 900, 5200, { peak: 0.55, q: 1.6, seed: 1100 + tr.k })
    sfx.add(tr.T - 0.16, zip, tr.T < CUES.gate ? 0.13 : 0.07, (t) => 0.6 - 1.2 * (t / 0.32)) // passes right to left
    if (!tr.fee) continue
    const c = CHORDS[chordAt(tr.T)].pad
    const m = c[ARP[step++ % 8]] + 24
    const featured = tr.T < 8
    arpBus.add(tr.T, pluck(m, step), featured ? 0.2 : 0.09, (r() - 0.5) * 0.5)
    // the cut itself: a tiny bright tick
    const [tick] = bell(mtof(m + 12), 0.05, { partials: [1, 2.4, 3.9], amps: [1, 0.5, 0.3] })
    sfx.add(tr.T, tick, featured ? 0.09 : 0.035, 0)
    // and a soft glassy landing in the well
    if (featured || tr.T % 1 === 0) {
      const [land] = bell(mtof(m + 7), 0.25)
      hall.add(tr.T + SLIVER_FLIGHT, land, featured ? 0.05 : 0.025)
    }
  }
}

// impacts: sub boom + metal + a bell tail
function impact(t0, { big = 1, base = 420, seed = 200 } = {}) {
  sfx.add(t0, boom(130, 36, 0.9 * big, 2.2), 0.95 * big)
  sfx.add(t0, kick(seed, 1.4), 0.6 * big)
  const m = metal(base, 1.1, seed)
  sfx.add(t0, m, 0.45 * big, -0.15)
  sfx.add(t0 + 0.004, metal(base * 1.007, 1.1, seed + 1), 0.35 * big, 0.2)
  hall.add(t0, m, 0.55 * big)
  const [bl, br] = bell(mtof(93), 2.4)
  sfx.add2(t0 + 0.01, bl, br, 0.16 * big)
  hall.add2(t0 + 0.01, bl, br, 0.4 * big)
  key(t0, 0.85, 0.5)
}

// 4.0 the gate lights
impact(CUES.gate, { big: 0.7, base: 520, seed: 210 })
sfx.add(CUES.gate, zap(69, 77), 0.4, 0)

// 8.0 the pour: a down-swoosh into the seam, the hit, then the light splits both ways round
sfx.add(CUES.pour - 0.3, whoosh(0.55, 6000, 300, { peak: 0.8, q: 0.9, seed: 801, curve: 2 }), 0.6, (t) => 0.2 - 0.5 * t)
impact(CUES.pour + 0.25, { big: 1, base: 410, seed: 220 })
sfx.add(CUES.split, zap(64, 81), 0.42, 0.55) // green, round to the right
sfx.add(CUES.split + 0.02, zap(69, 82), 0.42, -0.55) // pink, round to the left
{
  const [l, r] = shimmer(CUES.fill.to - CUES.fill.from + 0.4, [85, 88, 93])
  sfx.add2(CUES.fill.from, l, r, 0.16)
  hall.add2(CUES.fill.from, l, r, 0.22)
}
// every later pour: a whomp, and a soft fall down the beam
POURS.slice(1).forEach((at, i) => {
  if (at >= ARROWS_FROM) return
  const c = CHORDS[chordAt(at)]
  sfx.add(at, whomp(c.pad.map((m) => m - 12), 91 + i), 0.42)
  sfx.add(at, whoosh(0.3, 4000, 600, { peak: 0.7, q: 1.2, seed: 830 + i }), 0.15, 0.1)
})

// 12: the green line runs out to the holders and lands
sfx.add(CUES.holdersReach - 0.55, whoosh(0.6, 500, 6000, { peak: 0.85, q: 1.2, seed: 901 }), 0.35, (t) => -0.3 + 1.2 * t)
{
  const [l, r] = bell(mtof(88), 0.9)
  sfx.add2(CUES.holdersReach, l, r, 0.18)
  hall.add2(CUES.holdersReach, l, r, 0.25)
}
// the dial spins like a roulette wheel: a click each time the hand passes one of its 12 ticks
{
  const step = TAU / 12
  let prev = handAngle(CUES.holdersReach)
  for (let t = CUES.holdersReach; t <= CUES.snapshot + 1e-6; t += 0.001) {
    const a = handAngle(t)
    if (Math.floor(a / step) !== Math.floor(prev / step)) {
      const n = noise(Math.round(t * 1000)), hp = new Biquad('highpass', 3500, 0.8)
      const click = synth(0.03, (s) => hp.run(n()) * Math.exp(-s / 0.003) + Math.sin(TAU * 2600 * s) * Math.exp(-s / 0.006) * 0.4)
      sfx.add(t, click, 0.32, 0.15)
    }
    prev = a
  }
}
// 13.75 the snapshot: a shutter, a flash and a low thump
{
  const at = CUES.snapshot
  for (const [d, f] of [
    [0, 1800],
    [0.055, 1200],
  ]) {
    const n = noise(950 + f), bp = new Biquad('bandpass', f, 1.4)
    sfx.add(at + d, synth(0.05, (s) => bp.run(n()) * Math.exp(-s / 0.008) * 2.4), 0.5, 0.15)
  }
  sfx.add(at, thud(120, 50, 0.1), 0.6, 0.1)
  sfx.add(at, whoosh(0.35, 2000, 12000, { peak: 0.1, q: 0.7, seed: 960 }), 0.32, 0.1)
  const [l, r] = bell(mtof(100), 1.2)
  hall.add2(at, l, r, 0.3)
  key(at, 0.6, 0.3)
}
// 14: SOL lands in every column, a chime each, lower for bigger bags
{
  const scale = [69, 71, 73, 76, 78, 81, 83, 85, 88, 90, 93] // A major pentatonic
  const sizes = HOLDERS.nodes.map((n) => n.size)
  const lo = Math.min(...sizes), hi = Math.max(...sizes)
  HOLDERS.nodes.forEach((n, i) => {
    const k = Math.round((1 - (n.size - lo) / (hi - lo)) * (scale.length - 1))
    const [l, r] = bell(mtof(scale[k] + 12), 0.4)
    const pan = Math.max(-0.8, Math.min(0.8, (n.pos.x - HOLDERS.center.x) / HOLDERS.radius))
    sfx.add(HOLDER_REACH[i], l, 0.075, pan)
    hall.add2(HOLDER_REACH[i], l, r, 0.08)
  })
  sfx.add(CUES.paid, whoosh(0.5, 7000, 1500, { peak: 0.2, q: 1, seed: 970 }), 0.25, 0)
}

// 16: the whip across, and the supply stacking itself up, coin by coin
sfx.add(CUES.whip - 0.1, whoosh(0.9, 200, 5000, { peak: 0.45, q: 0.9, seed: 1001 }), 0.6, (t) => 0.7 - 1.6 * t)
{
  const from = CUES.whip + 0.15
  for (let i = 0; i < SUPPLY.coins; i++) {
    const at = from + i * 0.022 + 0.16
    sfx.add(at, clink(2400 + i * 40, 1010 + i), 0.12, -0.25)
  }
  sfx.add(from + SUPPLY.coins * 0.022 + 0.16, thud(150, 60, 0.08), 0.5, -0.25)
  // the furnace springs open with a low roar
  const n = noise(1050), lp = new Biquad('lowpass', 200, 0.8)
  const roar = synth(1.2, (s) => {
    if ((Math.round(s * SR) & 15) === 0) lp.set(200 + 1600 * Math.min(1, s / 0.3) * Math.exp(-s / 0.8))
    return lp.run(n()) * Math.min(1, s / 0.05) * Math.exp(-s / 0.5) * 1.8
  })
  sfx.add(CUES.whip + 0.55, roar, 0.45, 0.2)
}

// each buyback: a packet runs down the pink line, coins come off the stack, burn and crumble
CUES.burns.forEach((b, bi) => {
  const near = b < 20 ? 1 : 0.45 // the wide-shot burns sit further back in the mix
  sfx.add(b - 0.5, whoosh(0.5, 700, 4500, { peak: 0.9, q: 1.3, seed: 1100 + bi, curve: 2.5 }), 0.32 * near, (t) => 0.5 - 0.8 * t)
  sfx.add(b, thud(130, 55, 0.08), 0.55 * near, -0.2)
  for (let j = 0; j < SUPPLY.perBurn; j++) {
    const start = b + j * 0.07
    sfx.add(start, clink(2900 - j * 230, 1120 + bi * 3 + j), 0.22 * near, -0.2)
    // fire builds as it flies in, then it breaks up
    const span = BURN_EVENTS.shatter - 0.15
    const n = noise(1150 + bi * 5 + j), lp = new Biquad('lowpass', 300, 0.8)
    const fire = synth(span + 0.6, (s) => {
      if ((Math.round(s * SR) & 15) === 0) lp.set(300 + 2600 * Math.min(1, s / span), 0.8)
      return lp.run(n()) * (s < span ? (s / span) ** 1.5 : Math.exp(-(s - span) / 0.22)) * 1.2
    })
    sfx.add(start + 0.15, fire, 0.28 * near, 0.25)
    const at = start + BURN_EVENTS.shatter
    sfx.add(at, crumble(0.8, 1170 + bi * 5 + j), 0.5 * near, 0.3)
    sfx.add(at, crackle(1.0, 0.012, 1180 + bi * 5 + j), 0.32 * near, 0.3)
    const r = rng(1190 + bi * 5 + j)
    for (let k = 0; k < 4; k++) {
      const [l] = bell(2200 + r() * 4200, 0.09)
      sfx.add(at + r() * 0.25, l, 0.08 * near, 0.3 + (r() - 0.5) * 0.8)
    }
  }
  sfx.add(b + BURN_EVENTS.shatter, thud(110, 45, 0.12), 0.55 * near, 0.3)
  hall.add(b + BURN_EVENTS.shatter, metal(1400, 0.25, 1200 + bi), 0.3 * near)
  key(b + BURN_EVENTS.shatter, 0.5 * near, 0.25)
})

// 20: the pull back to the whole machine
sfx.add(CUES.wide - 0.4, whoosh(1.4, 3000, 250, { peak: 0.3, q: 0.8, seed: 1300 }), 0.4, 0)
sfx.add(CUES.wide, boom(90, 32, 1.0, 2.4), 0.6)
key(CUES.wide, 0.7, 0.4)
// the loop chips light in turn: a rising blip for each, a turn for the ↻
LOOP.steps.forEach((_, i) => {
  const at = LOOP.from + 0.2 + i * 0.5
  const [l, r] = bell(mtof([81, 85, 88, 93][i]), 0.5)
  sfx.add(at, l, 0.14, -0.4 + i * 0.27)
  hall.add2(at, l, r, 0.12)
})
sfx.add(LOOP.from + 2.2, whoosh(0.8, 800, 6000, { peak: 0.6, q: 1.1, seed: 1310 }), 0.28, (t) => Math.sin(TAU * 1.25 * t) * 0.7)

// 23–24.75: snare roll and riser into the arrows; half a beat of silence; the hit
{
  const S = snare(4)
  let t = 23
  while (t < SILENCE - 0.01) {
    const p = (t - 23) / (SILENCE - 23)
    music.add(t, S, 0.1 + 0.45 * p * p, 0)
    musicVerb.add(t, S, 0.15)
    t += p < 0.45 ? BEAT / 2 : p < 0.75 ? BEAT / 4 : BEAT / 8
  }
  sfx.add(23, riser(SILENCE - 23), 0.62, (t) => 0.35 * Math.sin(TAU * 1.2 * t))
}
// 24: the arrows draw themselves round: a zap and a rising sweep that circles the stereo field
sfx.add(ARROWS_FROM, zap(69, 1400), 0.45, 0)
{
  const o = osc('sine')
  const sweep = synth(0.75, (t) => o(330 * 4 ** (t / 0.75)) * ad(t, 0.02, 0.4) * 0.3)
  sfx.add(ARROWS_FROM, sweep, 0.5, (t) => Math.sin(TAU * 1.3 * t) * 0.8)
}
impact(CUES.final, { big: 1.15, base: 360, seed: 1500 })
;[57, 61, 64, 69].forEach((m, i) => {
  const [l, r] = bell(mtof(m + 12), 1.8)
  sfx.add(CUES.final + i * 0.06, l, 0.2, -0.6 + i * 0.4)
  hall.add2(CUES.final + i * 0.06, l, r, 0.3)
})
// the arrows passing the front of the ring, right to left, one whoosh each
{
  const front = -Math.PI / 2 - 0.25
  const span = TAU / RING.arcs
  const heads = Array.from({ length: RING.arcs }, (_, i) => Math.PI / 2 + 0.5 - i * span - (span - RING.gap))
  let prev = null
  for (let t = CUES.final - 0.3; t < SECONDS - 0.4; t += 0.002) {
    const turn = ringAngle(t)
    const now = heads.map((h) => ((((h - turn - front) % TAU) + TAU) % TAU))
    if (prev) {
      now.forEach((v, i) => {
        if (v > prev[i] + Math.PI) {
          // this head just swept past the front
          sfx.add(t - 0.25, whoosh(0.55, 500, 3800, { peak: 0.45, q: 1.1, seed: 1600 + Math.round(t * 100) }), 0.3, (s) => 0.7 - 1.4 * (s / 0.55))
        }
      })
    }
    prev = now
  }
  sfx.add(CUES.final, crackle(SECONDS - CUES.final, 0.004, 1700), 0.22, 0)
}

// ================================================================================================
// mix
// ================================================================================================

// arp: ping-pong delay (3/16) into the music bus
{
  const d = Math.round(((3 * BEAT) / 4) * SR)
  const L = arpBus.L, R = arpBus.R
  const outL = new Float32Array(N), outR = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const fbL = i >= d ? outR[i - d] * 0.4 : 0
    const fbR = i >= d ? outL[i - d] * 0.4 : 0
    outL[i] = L[i] + fbR * 0.9
    outR[i] = R[i] + fbL
  }
  for (let i = 0; i < N; i++) {
    music.L[i] += outL[i]
    music.R[i] += outR[i]
    musicVerb.L[i] += outL[i] * 0.3
    musicVerb.R[i] += outR[i] * 0.3
  }
}

const roomWet = freeverb(musicVerb, { room: 0.7, damp: 0.45, width: 1, predelay: 0.015 })
const hallWet = freeverb(hall, { room: 0.93, damp: 0.25, width: 1, predelay: 0.03 })

let env = 0
for (let i = 0; i < N; i++) {
  env = duck[i] > env ? duck[i] : env + (duck[i] - env) * 0.0015
  const g = 1 - Math.min(0.7, env)
  music.L[i] = (music.L[i] + roomWet.L[i] * 0.9) * g
  music.R[i] = (music.R[i] + roomWet.R[i] * 0.9) * g
}

const master = new Bus(N)
music.mixInto(master, db(-5))
sfx.mixInto(master, 1)
hallWet.mixInto(master, 1.1)

{
  const hpL = new Biquad('highpass', 28, 0.7), hpR = new Biquad('highpass', 28, 0.7)
  const shL = new Biquad('highshelf', 9000, 0.7, 1.5), shR = new Biquad('highshelf', 9000, 0.7, 1.5)
  for (let i = 0; i < N; i++) {
    master.L[i] = sat(shL.run(hpL.run(master.L[i])) * 0.9, 1.15)
    master.R[i] = sat(shR.run(hpR.run(master.R[i])) * 0.9, 1.15)
  }
}

// half a beat of hard silence before the hit (3 ms edges), and a soft last half-second
{
  const a = Math.round(SILENCE * SR), b = Math.round(CUES.final * SR), e = Math.round(0.003 * SR)
  for (let i = a - e; i < b; i++) {
    const g = i < a ? (a - i) / e : 0
    master.L[i] *= g
    master.R[i] *= g
  }
  for (let i = 0; i < 48; i++) {
    master.L[b + i] *= i / 48
    master.R[b + i] *= i / 48
  }
  const f0 = Math.round((SECONDS - 0.6) * SR)
  for (let i = f0; i < N; i++) {
    const g = 1 - (i - f0) / (N - f0)
    master.L[i] *= g * g
    master.R[i] *= g * g
  }
}

const TARGET = -14
let gr = 0
for (let pass = 0; pass < 4; pass++) {
  const now = lufs(master.L, master.R)
  const g = db(TARGET - now)
  for (let i = 0; i < N; i++) {
    master.L[i] *= g
    master.R[i] *= g
  }
  gr = limit(master.L, master.R, -2.0)
  if (Math.abs(TARGET - now) < 0.1) break
}
const final = lufs(master.L, master.R)
let peak = 0
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(master.L[i]), Math.abs(master.R[i]))

writeFileSync(here('../public/flywheel-soundtrack.wav'), writeWav24(master.L, master.R))
console.log(
  `flywheel-soundtrack.wav: ${SECONDS}s, ${final.toFixed(2)} LUFS, sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, max limiting ${gr.toFixed(1)} dB`,
)
