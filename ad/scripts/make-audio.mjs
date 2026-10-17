// Synthesizes the ad's soundtrack (music bed + every sound effect) from src/timeline.js and
// writes public/soundtrack.wav: 48 kHz, 24-bit stereo, -14 LUFS, true peak under -1 dBTP.
// Drop a licensed track at public/music.wav to replace the synthesized bed.
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECONDS, BPM, CUES, HOOKS, HOOK_EVENTS, TITLES } from '../src/timeline.js'
import { SR, TAU, mtof, db, rng, Biquad, synth, osc, expDecay, ad, sat, Bus, freeverb, lufs, limit, writeWav24, readWav } from './dsp.mjs'
import { noise, kick, clap, hat, snare, bassNote, pad, pluck, bell, metal, boom, whoosh, swell, crackle, zap, clink, thud, crumble, pour, whomp, shimmer, riser } from './instruments.mjs'

const N = Math.ceil(SECONDS * SR)
const BEAT = 60 / BPM
const BAR = BEAT * 4
const here = (p) => fileURLToPath(new URL(p, import.meta.url))

// ================================================================================================
// arrangement
// ================================================================================================

const music = new Bus(N)
const musicVerb = new Bus(N) // send
const arpBus = new Bus(N) // gets a ping-pong delay
const sfx = new Bus(N)
const hall = new Bus(N) // send
const duck = new Float32Array(N) // sidechain key for the bed (impacts + kick)

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
}
const PROG = ['F#m', 'D', 'A', 'E']
const chordAt = (bar) => (bar >= 10 ? (bar === 10 ? 'A' : 'E') : PROG[bar % 4])

// ---- the bed ------------------------------------------------------------------------------------

const useLicensed = existsSync(here('../public/music.wav'))

if (!useLicensed) {
  // intro drone (0–4): A1 sub swelling under the beam
  {
    const o1 = osc('sine'), o2 = osc('sine'), o3 = osc('saw'), lp = new Biquad('lowpass', 200, 0.8)
    const d = synth(CUES.reveal, (t) => {
      const e = (t / CUES.reveal) ** 1.6
      return (o1(55) * 0.7 + o2(110) * 0.2 + lp.run(o3(55.2)) * 0.25) * e * (0.85 + 0.15 * Math.sin(TAU * 0.7 * t))
    })
    music.add(0, d, 0.55)
  }

  // pads: from the reveal to the silence, then the final A major
  for (let bar = 2; bar < 13; bar++) {
    const t0 = bar * BAR
    const c = CHORDS[chordAt(bar)]
    const cut = bar < 4 ? 900 : bar < 10 ? 1500 : 1200 + (bar - 10) * 700
    const dur = Math.min(BAR, CUES.silence - t0)
    if (dur <= 0) continue
    const [L, R] = pad(c.pad, dur, { cutoff: cut, attack: bar === 2 ? 0.25 : 0.08, release: 0.4, seed: 6 + bar })
    // cut tails at the silence
    const keep = Math.round((CUES.silence - t0) * SR)
    music.add2(t0, L.subarray(0, keep), R.subarray(0, keep), 0.55)
    musicVerb.add2(t0, L.subarray(0, keep), R.subarray(0, keep), 0.25)
  }

  // drums
  const K = kick(1), C = clap(2), HC = hat(3), HO = hat(4, true)
  const beatsFrom = (a, b) => {
    const out = []
    for (let t = a; t < b - 1e-6; t += BEAT) out.push(+t.toFixed(4))
    return out
  }
  // reveal section: a kick on each bar's downbeat
  for (const t of [4, 6]) { music.add(t, K, 0.8); key(t, 0.5, 0.18) }
  // groove 8–20
  for (const t of beatsFrom(8, 20)) {
    music.add(t, K, 0.85)
    key(t, 0.55, 0.16)
    const beatInBar = Math.round((t % BAR) / BEAT)
    if (beatInBar === 1 || beatInBar === 3) {
      music.add(t, C, 0.5, 0.05)
      musicVerb.add(t, C, 0.25)
    }
    music.add(t + BEAT / 2, t >= 14 ? HO : HC, t >= 14 ? 0.28 : 0.32, 0.25)
    music.add(t + BEAT / 4, HC, 0.1, -0.3)
    music.add(t + (3 * BEAT) / 4, HC, 0.13, 0.35)
  }

  // bass: 8ths on the root from the groove, long notes in the reveal
  for (let bar = 2; bar < 13; bar++) {
    const t0 = bar * BAR
    const root = CHORDS[chordAt(bar)].root
    if (bar < 4) {
      music.add(t0, bassNote(root, BAR - 0.1), 0.55)
      continue
    }
    if (bar >= 10) {
      // breakdown: held, filtered roots
      const dur = Math.min(BAR, CUES.silence - t0) - 0.02
      if (dur > 0) music.add(t0, bassNote(root, dur), 0.4)
      continue
    }
    for (let k = 0; k < 8; k++) {
      const t = t0 + (k * BEAT) / 2
      const m = root + (k % 4 === 3 ? 12 : 0)
      music.add(t, bassNote(m, BEAT / 2 - 0.04, 5 + k), bar >= 7 ? 0.72 : 0.6)
    }
  }

  // glassy pluck arpeggio, 16ths, through a ping-pong delay
  const ARP = [0, 1, 2, 3, 2, 1, 3, 2]
  for (let t = 8; t < CUES.silence - 1e-6; t += BEAT / 4) {
    const bar = Math.floor(t / BAR + 1e-6)
    const notes = CHORDS[chordAt(bar)].pad
    const step = Math.round((t - 8) / (BEAT / 4))
    const m = notes[ARP[step % 8]] + 12
    const g = t < 20 ? 0.12 : 0.12 + 0.1 * ((t - 20) / 5)
    arpBus.add(t, pluck(m, step), g, ((step % 4) - 1.5) * 0.3)
  }

  // breakdown snare roll 23–25, accelerating
  {
    const S = snare(4)
    let t = CUES.riser.from
    while (t < CUES.riser.to - 0.01) {
      const p = (t - CUES.riser.from) / (CUES.riser.to - CUES.riser.from)
      music.add(t, S, 0.12 + 0.45 * p * p, 0)
      musicVerb.add(t, S, 0.15)
      t += p < 0.5 ? BEAT / 2 : p < 0.75 ? BEAT / 4 : BEAT / 8
    }
  }

  // final A major, from the last hit to the end
  {
    const [L, R] = pad([45, 57, 61, 64, 69], SECONDS - CUES.final - 1.2, { cutoff: 1800, attack: 0.9, release: 1.2, seed: 60 })
    music.add2(CUES.final + 0.05, L, R, 0.5)
    musicVerb.add2(CUES.final + 0.05, L, R, 0.35)
    music.add(CUES.final, bassNote(45, 3.2), 0.5)
  }
}

// ---- sound effects -----------------------------------------------------------------------------

// 0.0 air swell into the reveal, cut dead on the hit
sfx.add(CUES.drone, swell(CUES.reveal - CUES.drone, 31), 0.32, (t) => -0.3 + 0.6 * (t / 4))

// 0.5 beam ignition: rising sweep, fwoom, crackle, then a hum that climbs as the beam travels
{
  const o = osc('sine')
  const sweep = synth(0.9, (t) => o(220 * 8 ** (t / 0.9)) * ad(t, 0.01, 0.35) * 0.35)
  sfx.add(CUES.ignite, sweep, 0.6, -0.5)
  sfx.add(CUES.ignite, whoosh(1.6, 250, 3200, { peak: 0.15, q: 0.9, seed: 22 }), 0.7, (t) => -0.7 + t * 0.4)
  sfx.add(CUES.ignite, crackle(1.8, 0.004, 41), 0.5, -0.4)
  const h1 = osc('saw'), h2 = osc('saw', 0.3), lp = new Biquad('lowpass', 500, 2)
  const dur = CUES.reveal - CUES.ignite
  const hum = synth(dur, (t) => {
    const p = t / dur
    if ((Math.round(t * SR) & 31) === 0) lp.set(300 + 1500 * p * p, 2)
    const f = 98 + 60 * p * p
    return lp.run(h1(f) + h2(f * 1.5)) * Math.min(1, t / 0.4) * (0.3 + 0.7 * p * p) * 0.35
  })
  sfx.add(CUES.ignite, hum, 0.55, (t) => -0.6 + 0.6 * (t / dur))
}

// impacts: sub boom + metal + shimmer tail
function impact(t0, { big = 1, base = 420, seed = 200 } = {}) {
  sfx.add(t0, boom(130, 36, 0.9 * big, 2.2), 0.95 * big)
  sfx.add(t0, kick(seed, 1.4), 0.6 * big)
  const m = metal(base, 1.1, seed)
  sfx.add(t0, m, 0.5 * big, -0.15)
  sfx.add(t0 + 0.004, metal(base * 1.007, 1.1, seed + 1), 0.4 * big, 0.2)
  hall.add(t0, m, 0.6 * big)
  const [bl, br] = bell(mtof(93), 2.4)
  sfx.add2(t0 + 0.01, bl, br, 0.18 * big)
  hall.add2(t0 + 0.01, bl, br, 0.4 * big)
  key(t0, 0.85, 0.5)
}

// 4.0 reveal
impact(CUES.reveal, { big: 1, base: 410, seed: 200 })

// 5.5 glint: bright bell that travels left to right with the light
{
  const [l, r] = bell(mtof(100), 1.1)
  sfx.add(CUES.glint, l, 0.32, (t) => -0.7 + 1.4 * Math.min(1, t / 0.9))
  hall.add2(CUES.glint, l, r, 0.35)
  sfx.add(CUES.glint - 0.3, whoosh(1.0, 2000, 9000, { peak: 0.35, q: 1.5, seed: 23 }), 0.2, (t) => -0.7 + 1.4 * t)
}

// 8.0–14.0 hook lines and their payoffs
for (const h of HOOKS) {
  const ev = HOOK_EVENTS[h.key]
  const pan = (t) => h.pan * Math.min(1, t / 0.5)
  const z = zap(h.note, 51 + h.note)
  sfx.add(h.at, z, 0.55, pan)
  hall.add(h.at, z, 0.3)
  sfx.add(h.at, whoosh(0.7, 600, 5000, { peak: 0.5, q: 1.3, seed: 300 + h.note }), 0.4, pan)
  key(h.at, 0.6, 0.3)

  const t = (x) => h.at + x
  if (h.key === 'creator') {
    sfx.add(t(ev.pop), clink(2900, 61), 0.5, h.pan)
    hall.add(t(ev.pop), clink(2900, 62), 0.3)
    // spin flutter as the coin tumbles
    const o = osc('sine')
    const flutter = synth(ev.slot - ev.pop, (s) => o(1800) * (0.5 + 0.5 * Math.sin(TAU * (8 + 30 * s) * s)) * 0.12 * (1 - s / (ev.slot - ev.pop)))
    sfx.add(t(ev.pop + 0.1), flutter, 0.5, h.pan)
    sfx.add(t(ev.slot), clink(2100, 63), 0.45, h.pan)
    sfx.add(t(ev.slot), thud(160, 70, 0.07), 0.55, h.pan)
  }
  if (h.key === 'burn') {
    const n = noise(400), lp = new Biquad('lowpass', 300, 0.8)
    const span = ev.shatter - ev.ignite
    const fire = synth(span + 0.8, (s) => {
      if ((Math.round(s * SR) & 15) === 0) lp.set(300 + 2800 * Math.min(1, s / span), 0.8)
      return lp.run(n()) * (s < span ? (s / span) ** 1.5 : Math.exp(-(s - span) / 0.25)) * 1.4
    })
    sfx.add(t(ev.ignite), fire, 0.55, h.pan)
    sfx.add(t(ev.ignite), crackle(1.2, 0.01, 401), 0.45, h.pan)
    sfx.add(t(ev.shatter), thud(140, 55, 0.1), 0.7, h.pan)
    sfx.add(t(ev.shatter), metal(1500, 0.25, 402), 0.45, h.pan)
    sfx.add(t(ev.shatter), crumble(0.9, 403), 0.7, (s) => h.pan + 0.3 * Math.sin(s * 9))
    const r = rng(404)
    for (let k = 0; k < 10; k++) {
      const [l] = bell(2200 + r() * 4000, 0.1)
      sfx.add(t(ev.shatter + r() * 0.35), l, 0.12, (r() - 0.5) * 1.6)
    }
    hall.add(t(ev.shatter), metal(1500, 0.25, 405), 0.35)
  }
  if (h.key === 'entangle') {
    const scale = [81, 83, 85, 88, 90, 93, 95, 97, 100] // A major pentatonic, high
    const r = rng(500)
    for (let k = 0; k < 18; k++) {
      const at = ev.spread + (ev.lit - ev.spread) * (k / 17) ** 0.8
      const [l, rr] = bell(mtof(scale[Math.floor(r() * scale.length)]), 0.45)
      const p = (r() - 0.5) * 1.6
      sfx.add(t(at), l, 0.1, p)
      hall.add2(t(at), l, rr, 0.12)
    }
  }
  if (h.key === 'fusion') {
    sfx.add(t(ev.fill - 0.02), pour(ev.lock - ev.fill + 0.05, 81), 0.35, h.pan)
    sfx.add(t(ev.lock), thud(100, 46, 0.14), 0.85, h.pan)
    sfx.add(t(ev.lock), metal(640, 0.32, 601), 0.55, h.pan)
    const [gl, gr] = bell(1318, 1.4, { partials: [1, 1.003, 2.01], amps: [1, 0.8, 0.3] })
    sfx.add2(t(ev.lock + 0.01), gl, gr, 0.2)
    hall.add2(t(ev.lock), gl, gr, 0.3)
    key(t(ev.lock), 0.6, 0.3)
  }
}

// 14.0 the drop
sfx.add(CUES.drop, boom(90, 30, 1.3, 2.5), 0.9)
key(CUES.drop, 0.8, 0.5)

// pulses: a whomp on each bar of shot 4, plus a soft tick as each pulse splits into the lines
CUES.pulses.forEach((at, i) => {
  const c = CHORDS[chordAt(Math.floor(at / BAR))]
  sfx.add(at, whomp(c.pad.map((m) => m - 12), 91 + i), 0.5)
  for (const h of HOOKS) sfx.add(at + 0.5, clink(mtof(h.note + 24), 700 + h.note), 0.06, h.pan)
})

// 16.0 card rise
sfx.add(CUES.cardRise - 0.1, whoosh(0.9, 180, 4500, { peak: 0.45, q: 1, seed: 801 }), 0.6, (t) => 0.2 + 0.5 * t)
{
  const [l, r] = shimmer(1.6, [93, 97, 100])
  sfx.add2(CUES.cardRise + 0.3, l, r, 0.18)
  hall.add2(CUES.cardRise + 0.3, l, r, 0.25)
}

// 20.0 / 21.5 / 23.0 title hits, each led by a swoosh; reverse reverb into the last
CUES.titles.forEach((at, i) => {
  const pre = whoosh(0.35, 400, 7000, { peak: 0.98, q: 0.8, seed: 900 + i, curve: 3 })
  sfx.add(at - 0.35, pre, 0.55, i % 2 ? 0.3 : -0.3)
  sfx.add(at, kick(910 + i, 1.2), 0.75)
  sfx.add(at, snare(920 + i), 0.35)
  sfx.add(at, metal(900 + i * 140, 0.35, 930 + i), 0.3, i % 2 ? -0.2 : 0.2)
  hall.add(at, snare(940 + i), 0.4)
  key(at, 0.7, 0.35)
})
{
  // reverse reverb: reverb a chime, flip it, and land its end on the last title
  const at = CUES.titles[2]
  const tmp = new Bus(Math.round(1.6 * SR))
  const [l, r] = bell(mtof(81), 0.5)
  tmp.add2(0, l, r)
  const wet = freeverb(tmp, { room: 0.95, damp: 0.2, predelay: 0 })
  const len = Math.round(1.0 * SR)
  const revL = new Float32Array(len), revR = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const fade = Math.min(1, i / (0.3 * SR))
    revL[i] = wet.L[len - 1 - i] * fade
    revR[i] = wet.R[len - 1 - i] * fade
  }
  sfx.add2(at - 1.0, revL, revR, 1.4)
}

// 23.0–25.0 riser, cut dead at the silence
sfx.add(CUES.riser.from, riser(CUES.riser.to - CUES.riser.from), 0.75, (t) => 0.4 * Math.sin(TAU * 1.5 * t))

// 25.5 final hit: sub drop, chrome hit, and the four hook notes as a chime
impact(CUES.final, { big: 1.15, base: 360, seed: 1000 })
HOOKS.forEach((h, i) => {
  const [l, r] = bell(mtof(h.note + 12), 1.8)
  sfx.add(CUES.final + i * 0.06, l, 0.22, h.pan)
  hall.add2(CUES.final + i * 0.06, l, r, 0.3)
})
// 27.0 a small tick as the button lands
{
  const [l] = bell(mtof(96), 0.12)
  sfx.add(CUES.final + 1.3, l, 0.08, 0)
}

// ================================================================================================
// mix
// ================================================================================================

// licensed bed, if provided
if (useLicensed) {
  const m = readWav(readFileSync(here('../public/music.wav')))
  music.add2(0, m.L.subarray(0, N), m.R.subarray(0, N), 0.8)
}

// arp: ping-pong delay (3/16) into the music bus
{
  const d = Math.round(((3 * BEAT) / 4) * SR)
  const L = arpBus.L, R = arpBus.R
  const outL = new Float32Array(N), outR = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const fbL = i >= d ? outR[i - d] * 0.42 : 0
    const fbR = i >= d ? outL[i - d] * 0.42 : 0
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

// duck the bed under impacts and the kick
let env = 0
for (let i = 0; i < N; i++) {
  env = duck[i] > env ? duck[i] : env + (duck[i] - env) * 0.0015
  const g = 1 - Math.min(0.75, env)
  music.L[i] = (music.L[i] + roomWet.L[i] * 0.9) * g
  music.R[i] = (music.R[i] + roomWet.R[i] * 0.9) * g
}

const master = new Bus(N)
music.mixInto(master, db(-5))
sfx.mixInto(master, 1)
hallWet.mixInto(master, 1.1)

// gentle master glue: low-cut, a touch of air, soft saturation
{
  const hpL = new Biquad('highpass', 28, 0.7), hpR = new Biquad('highpass', 28, 0.7)
  const shL = new Biquad('highshelf', 9000, 0.7, 1.5), shR = new Biquad('highshelf', 9000, 0.7, 1.5)
  for (let i = 0; i < N; i++) {
    master.L[i] = sat(shL.run(hpL.run(master.L[i])) * 0.9, 1.15)
    master.R[i] = sat(shR.run(hpR.run(master.R[i])) * 0.9, 1.15)
  }
}

// half a beat of hard silence before the final hit (with 3 ms edges)
{
  const a = Math.round(CUES.silence * SR), b = Math.round(CUES.final * SR), e = Math.round(0.003 * SR)
  for (let i = a - e; i < b; i++) {
    const g = i < a ? (a - i) / e : 0
    master.L[i] *= g
    master.R[i] *= g
  }
  // the final hit must start clean: fade in over 1 ms
  for (let i = 0; i < 48; i++) {
    master.L[b + i] *= i / 48
    master.R[b + i] *= i / 48
  }
}

// loudness: -14 LUFS integrated, sample peak ceiling -2 dBFS (true peak lands under -1 dBTP)
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

writeFileSync(here('../public/soundtrack.wav'), writeWav24(master.L, master.R))
console.log(
  `soundtrack.wav: ${SECONDS}s, ${final.toFixed(2)} LUFS, sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, ` +
    `max limiting ${gr.toFixed(1)} dB${useLicensed ? ', licensed bed from music.wav' : ''}`,
)
