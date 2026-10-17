// Synthesizes the soundtrack of "The receipts" from src/receipts/timeline.js (the picture reads the
// same file) and writes public/receipts-soundtrack.wav: 48 kHz, 24-bit stereo, -14 LUFS, peaks
// under -2 dBFS. Punchier than the engine film: 128 BPM house in D minor (Dm Bb F C), slams on the
// words, a printer that ticks as each hourly run prints, stamps, and the page burning.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECONDS, BPM, CUES, SCENES, FACTS, BURN_T } from '../src/receipts/timeline.js'
import { SR, mtof, db, Biquad, synth, sat, Bus, freeverb, lufs, limit, writeWav24, rng } from './dsp.mjs'
import { kick, clap, hat, snare, bassNote, pad, pluck, bell, boom, whoosh, crackle, clink, thud, whomp, shimmer, riser, metal } from './instruments.mjs'

const N = Math.ceil(SECONDS * SR)
const BEAT = 60 / BPM
const BAR = BEAT * 4
const here = (p) => fileURLToPath(new URL(p, import.meta.url))

const music = new Bus(N)
const musicVerb = new Bus(N)
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

const CHORDS = [
  { pad: [50, 53, 57, 62], root: 38 }, // Dm
  { pad: [50, 53, 58, 62], root: 34 }, // Bb
  { pad: [48, 53, 57, 60], root: 41 }, // F
  { pad: [48, 52, 55, 60], root: 36 }, // C
]
const BARS = Math.round(SECONDS / BAR)
const chordAt = (bar) => CHORDS[bar % 4]
// D minor pentatonic, for the printer's chimes
const PENTA = [74, 77, 79, 81, 84, 86, 89, 91, 93]
const inScene = (t, s) => t >= s.from - 1e-6 && t < s.to - 1e-6

// ---- the groove --------------------------------------------------------------------------------

// pads: thin under the title, open from the rule on, dark under the burn, wide at the end
for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR
  const c = chordAt(bar)
  const burn = inScene(t0, SCENES.burn)
  const end = inScene(t0, SCENES.end)
  const cut = bar < 2 ? 900 : burn ? 600 : end ? 2400 : 1800
  const [L, R] = pad(burn ? [38, 50, 53, 57] : c.pad, BAR + (end && bar === BARS - 1 ? 1.5 : 0), { cutoff: cut, attack: 0.05, release: 0.3, seed: 40 + bar })
  music.add2(t0, L, R, burn ? 0.5 : 0.36)
  musicVerb.add2(t0, L, R, 0.22)
}

// drums: the title has only its slams; four on the floor from the rule to the scale; hats alone
// through the burn; back for the end's first bar
{
  const K = kick(9, 1.2)
  const C = clap(12)
  const HC = hat(13)
  const HO = hat(14, true)
  const on = (t) => inScene(t, SCENES.rule) || inScene(t, SCENES.receipt) || inScene(t, SCENES.scale) || (t >= SCENES.end.from && t < SCENES.end.from + BAR * 1.5)
  for (let t = 0; t < SECONDS - 1e-6; t += BEAT / 2) {
    const b = Math.round(t / BEAT * 2) // eighth index
    const onBeat = b % 2 === 0
    const beatInBar = Math.round((t % BAR) / BEAT)
    if (on(t) && onBeat) {
      music.add(t, K, 0.95)
      key(t, 0.5, 0.14)
      if (beatInBar === 1 || beatInBar === 3) {
        music.add(t, C, 0.5, 0.06)
        musicVerb.add(t, C, 0.3)
      }
    }
    if (on(t) && !onBeat) music.add(t, HO, 0.24, 0.25)
    if ((on(t) || inScene(t, SCENES.burn)) && t >= SCENES.rule.from) {
      music.add(t + BEAT / 4, HC, 0.12, -0.3)
      if (inScene(t, SCENES.burn)) music.add(t, HC, 0.14, 0.3)
    }
  }
  // a snare roll into the end
  const S = snare(17)
  const from = SCENES.end.from - BAR
  let t = from
  while (t < SCENES.end.from - 0.01) {
    const p = (t - from) / BAR
    music.add(t, S, 0.08 + 0.35 * p * p)
    t += p < 0.5 ? BEAT / 2 : p < 0.75 ? BEAT / 4 : BEAT / 8
  }
}

// bass: offbeat octaves with the groove, a held root under the title and the burn
for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR
  const root = chordAt(bar).root
  if (t0 < SCENES.rule.from || inScene(t0, SCENES.burn)) {
    music.add(t0, bassNote(inScene(t0, SCENES.burn) ? 26 : root, BAR - 0.05, 3 + bar), 0.5)
    continue
  }
  if (t0 >= SCENES.end.from + BAR) {
    music.add(t0, bassNote(38, BAR * 1.2, 70), 0.5)
    continue
  }
  for (let k = 0; k < 8; k++) {
    const m = root + (k % 2 ? 12 : 0)
    music.add(t0 + (k * BEAT) / 2, bassNote(m, BEAT / 2 - 0.05, 20 + k), k % 2 ? 0.55 : 0.68)
  }
}

// ---- the hits ------------------------------------------------------------------------------------

// title: each word slams, then the 16/16 stamp
CUES.slams.forEach((t, i) => {
  const last = i === CUES.slams.length - 1
  sfx.add(t, boom(last ? 140 : 110 + i * 15, 40, last ? 0.5 : 0.28), last ? 0.95 : 0.7)
  sfx.add(t, thud(260, 70, 0.07), 0.6)
  sfx.add(t, clap(30 + i), last ? 0.5 : 0.35)
  key(t, 0.6, 0.25)
  if (last) {
    sfx.add(t, metal(220, 0.7, 77), 0.18)
    hall.add(t, clap(31), 0.35)
  }
})
sfx.add(0, whoosh(0.35, 6000, 400, { peak: 0.2, seed: 5 }), 0.25)

// rule: a swipe and a thud as each row lands
CUES.rows.forEach((t, i) => {
  sfx.add(t - 0.12, whoosh(0.3, 500, 5200, { peak: 0.6, seed: 61 + i }), 0.3, (u) => -0.8 + u * 1.6)
  sfx.add(t, thud(180, 60, 0.1), 0.5)
  const [l] = bell(mtof([69, 72, 76][i]), 0.9)
  sfx.add(t + 0.05, l, 0.18)
})

// receipt: the printer ticks while it prints, a chime per run, a low whomp on runs that burned
{
  const r = rng(99)
  const tick = synth(0.012, (t) => (r() * 2 - 1) * Math.exp(-t / 0.003))
  const hp = new Biquad('highpass', 3500, 0.7)
  const T = tick.map((v) => hp.run(v))
  CUES.prints.forEach((t, i) => {
    for (let k = 0; k < 6; k++) sfx.add(t - 0.04 + k * 0.024, T, 0.22, 0.45)
    const m = PENTA[Math.min(PENTA.length - 1, Math.floor((i / CUES.prints.length) * PENTA.length))]
    sfx.add(t + 0.03, clink(mtof(m), 200 + i), 0.16, -0.2)
    hall.add(t + 0.03, clink(mtof(m), 200 + i), 0.06)
  })
  CUES.burnsAt.forEach((t, i) => sfx.add(t + 0.06, whomp([38, 50], 300 + i), 0.18, 0.3))
  // the total, then the PAID stamp
  const [l] = bell(mtof(86), 1.6)
  sfx.add(CUES.total, l, 0.3)
  hall.add(CUES.total, l, 0.3)
  sfx.add(CUES.paid, boom(130, 42, 0.45), 0.85)
  sfx.add(CUES.paid, thud(300, 80, 0.08), 0.6)
  sfx.add(CUES.paid, clap(41), 0.45)
  key(CUES.paid, 0.6, 0.25)
}

// scale: a rising pluck for each step, a riser as the marker climbs, a ping when it lands
CUES.steps.forEach((t, i) => {
  sfx.add(t, pluck([62, 69, 74][i] + 12, 500 + i), 0.3, -0.4 + i * 0.4)
  sfx.add(t, thud(140 + i * 40, 60, 0.06), 0.3)
})
{
  const [m0, m1] = CUES.marker
  sfx.add(m0, riser(m1 - m0, 113), 0.22, (u) => -0.3 + 0.6 * u)
  const [l] = bell(mtof(81), 1.4)
  sfx.add(m1, l, 0.32)
  hall.add(m1, l, 0.3)
}

// burn: the page catches, the drop, crackle under the count, a thud when the supply lands
{
  const b0 = CUES.burn
  sfx.add(b0 - BAR / 2, riser(BAR / 2, 117), 0.25)
  sfx.add(b0, boom(90, 28, 0.9, 2.5), 1.0)
  sfx.add(b0, whoosh(0.9, 200, 2400, { peak: 0.3, seed: 71 }), 0.35)
  key(b0, 0.85, 0.5)
  sfx.add(b0, crackle(SCENES.burn.to - b0, 0.009, 47), 0.4, 0.2)
  sfx.add(b0 + 0.05, crackle(BURN_T.paper[1] - b0 + 0.3, 0.03, 48), 0.5, -0.3)
  sfx.add(CUES.supply, thud(220, 55, 0.12), 0.7)
  sfx.add(CUES.supply, whomp([26, 38], 333), 0.3)
  const [L, R] = shimmer(2, [62, 65, 69, 74], 120)
  sfx.add2(BURN_T.count[1] - 0.2, L, R, 0.12)
}

// end: a hit on each line, a bell for the address, the last shimmer
CUES.lines.forEach((t, i) => {
  sfx.add(t, thud(240, 60, 0.08), 0.55)
  sfx.add(t, clap(80 + i), 0.3)
  if (i === 0) {
    sfx.add(t, boom(120, 36, 0.6), 0.9)
    key(t, 0.7, 0.4)
  }
})
{
  const [l] = bell(mtof(86), 2.2)
  sfx.add(CUES.url, l, 0.3)
  hall.add(CUES.url, l, 0.45)
  const [L, R] = shimmer(3.2, [62, 69, 74, 77, 81], 121)
  sfx.add2(CUES.url, L, R, 0.2)
  hall.add2(CUES.url, L, R, 0.2)
}

// ---- mix and master -----------------------------------------------------------------------------

const roomWet = freeverb(musicVerb, { room: 0.6, damp: 0.5, width: 1, predelay: 0.012 })
const hallWet = freeverb(hall, { room: 0.9, damp: 0.3, width: 1, predelay: 0.025 })
let env = 0
for (let i = 0; i < N; i++) {
  env = duck[i] > env ? duck[i] : env + (duck[i] - env) * 0.0018
  const g = 1 - Math.min(0.75, env)
  music.L[i] = (music.L[i] + roomWet.L[i] * 0.8) * g
  music.R[i] = (music.R[i] + roomWet.R[i] * 0.8) * g
}
const master = new Bus(N)
music.mixInto(master, db(-4))
sfx.mixInto(master, 1)
hallWet.mixInto(master, 1)
{
  const hpL = new Biquad('highpass', 30, 0.7), hpR = new Biquad('highpass', 30, 0.7)
  const shL = new Biquad('highshelf', 8000, 0.7, 2), shR = new Biquad('highshelf', 8000, 0.7, 2)
  for (let i = 0; i < N; i++) {
    master.L[i] = sat(shL.run(hpL.run(master.L[i])) * 0.9, 1.2)
    master.R[i] = sat(shR.run(hpR.run(master.R[i])) * 0.9, 1.2)
  }
}
for (let i = N - Math.round(1.0 * SR); i < N; i++) {
  const g = (N - i) / (1.0 * SR)
  master.L[i] *= g
  master.R[i] *= g
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
writeFileSync(here('../public/receipts-soundtrack.wav'), writeWav24(master.L, master.R))
console.log(`receipts-soundtrack.wav: ${SECONDS}s, ${final.toFixed(2)} LUFS, sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, max limiting ${gr.toFixed(1)} dB (${FACTS.runs.length} runs)`)
