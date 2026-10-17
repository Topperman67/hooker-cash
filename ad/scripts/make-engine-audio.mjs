// Synthesizes the payout engine film's soundtrack from src/engine/timeline.js (the picture reads
// the same file, and every sound that answers the picture sits on a CUES time) and writes
// public/engine-soundtrack.wav: 48 kHz, 24-bit stereo, -14 LUFS, true peak under -1 dBTP. The
// ad's instruments and mastering (instruments.mjs, dsp.mjs), its key and tempo: F#m D A E at
// 120 BPM, so the two belong together. render-engine.mjs runs it before every render of the film.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECONDS, BPM, CUES, SWEEPS, HOLDERS_T, BURN_T, SCENES, ELIGIBLE, PAID, assertRules } from '../src/engine/timeline.js'
import { SR, TAU, mtof, db, Biquad, synth, osc, ad, sat, Bus, freeverb, lufs, limit, writeWav24 } from './dsp.mjs'
import { kick, clap, hat, snare, bassNote, pad, pluck, bell, boom, whoosh, swell, crackle, zap, clink, thud, pour, whomp, shimmer, riser } from './instruments.mjs'

assertRules() // the rules the film states are still the engine's, or no soundtrack (and no film)

const N = Math.ceil(SECONDS * SR)
const BEAT = 60 / BPM
const BAR = BEAT * 4
const here = (p) => fileURLToPath(new URL(p, import.meta.url))

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
}
const PROG = ['F#m', 'D', 'A', 'E']
const BARS = Math.round(SECONDS / BAR)
const END_BAR = SCENES.end.from / BAR // 17
const chordAt = (bar) => (bar >= END_BAR ? 'A' : PROG[bar % 4])
// A major pentatonic, for the clinks and plucks that answer the picture
const PENTA = [69, 71, 73, 76, 78, 81, 83, 85, 88]

// ---- the bed ------------------------------------------------------------------------------------

// title (0–4): a sub drone swelling under the ring
{
  const o1 = osc('sine'), o2 = osc('sine'), o3 = osc('saw'), lp = new Biquad('lowpass', 220, 0.8)
  const d = synth(4.2, (t) => {
    const e = Math.min(1, (t / 2.2) ** 1.4) * (t > 3.9 ? Math.max(0, 1 - (t - 3.9) / 0.3) : 1)
    return (o1(46.25) * 0.7 + o2(92.5) * 0.2 + lp.run(o3(46.4)) * 0.25) * e
  })
  music.add(0, d, 0.5)
}

// pads over every bar, opening up through the film
for (let bar = 0; bar < BARS; bar++) {
  const isEnd = bar >= END_BAR
  if (isEnd && bar > END_BAR) continue // one long chord carries the end
  const t0 = bar * BAR
  const c = CHORDS[chordAt(bar)]
  const dur = isEnd ? SECONDS - t0 : BAR
  const cut = bar < 2 ? 700 : bar < 8 ? 1300 : bar < 15 ? 2000 : 1500
  const [L, R] = pad(isEnd ? [45, 57, 61, 64, 69] : c.pad, dur, { cutoff: cut, attack: bar === 0 ? 1.2 : 0.06, release: isEnd ? 1.4 : 0.35, seed: 6 + bar })
  music.add2(t0, L, R, isEnd ? 0.55 : 0.42)
  musicVerb.add2(t0, L, R, 0.25)
}

// drums: in with the fees, bigger for the holders, out for the site, a last hit for the end
{
  const K = kick(1), C = clap(2), HC = hat(3), HO = hat(4, true)
  for (let t = SCENES.fees.from; t < SCENES.site.from - 1e-6; t += BEAT) {
    const big = t >= SCENES.holders.from
    music.add(t, K, big ? 0.9 : 0.75)
    key(t, big ? 0.55 : 0.4, 0.16)
    const beat = Math.round((t % BAR) / BEAT)
    if (big && (beat === 1 || beat === 3)) {
      music.add(t, C, 0.5, 0.05)
      musicVerb.add(t, C, 0.28)
    }
    music.add(t + BEAT / 2, big ? HO : HC, big ? 0.26 : 0.3, 0.25)
    music.add(t + BEAT / 4, HC, 0.1, -0.3)
    music.add(t + (3 * BEAT) / 4, HC, 0.12, 0.35)
  }
  // the site: hats only
  for (let t = SCENES.site.from; t < SCENES.end.from - 1e-6; t += BEAT / 2) music.add(t, HC, 0.16, t % 1 ? 0.3 : -0.3)
  // a snare roll into the end
  {
    const S = snare(4)
    const from = SCENES.end.from - BAR
    let t = from
    while (t < SCENES.end.from - 0.01) {
      const p = (t - from) / BAR
      music.add(t, S, 0.1 + 0.4 * p * p)
      musicVerb.add(t, S, 0.15)
      t += p < 0.5 ? BEAT / 2 : p < 0.75 ? BEAT / 4 : BEAT / 8
    }
  }
}

// bass: long notes in the title, 8ths with the groove, held in the site, the root at the end
for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR
  const root = CHORDS[chordAt(bar)].root
  if (bar >= END_BAR) {
    if (bar === END_BAR) music.add(t0, bassNote(45, 3.6), 0.55)
    continue
  }
  if (t0 < SCENES.fees.from || t0 >= SCENES.site.from) {
    music.add(t0, bassNote(root, BAR - 0.1), 0.45)
    continue
  }
  for (let k = 0; k < 8; k++) {
    const m = root + (k % 4 === 3 ? 12 : 0)
    music.add(t0 + (k * BEAT) / 2, bassNote(m, BEAT / 2 - 0.04, 5 + k), t0 >= SCENES.holders.from ? 0.72 : 0.6)
  }
}

// a glassy pluck arpeggio from the hourly scene, through a ping-pong delay
{
  const ARP = [0, 1, 2, 3, 2, 1, 3, 2]
  for (let t = SCENES.hourly.from; t < SCENES.end.from - 1e-6; t += BEAT / 4) {
    const bar = Math.floor(t / BAR + 1e-6)
    const notes = CHORDS[chordAt(bar)].pad
    const step = Math.round((t - SCENES.hourly.from) / (BEAT / 4))
    const g = t < SCENES.holders.from ? 0.1 : t < SCENES.site.from ? 0.15 : 0.08
    arpBus.add(t, pluck(notes[ARP[step % 8]] + 12, step), g, ((step % 4) - 1.5) * 0.3)
  }
  const d = Math.round(((3 * BEAT) / 4) * SR)
  const outL = new Float32Array(N), outR = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    outL[i] = arpBus.L[i] + (i >= d ? outR[i - d] * 0.42 : 0) * 0.9
    outR[i] = arpBus.R[i] + (i >= d ? outL[i - d] * 0.42 : 0)
  }
  for (let i = 0; i < N; i++) {
    music.L[i] += outL[i]
    music.R[i] += outR[i]
    musicVerb.L[i] += outL[i] * 0.3
    musicVerb.R[i] += outR[i] * 0.3
  }
}

// ---- sound effects -----------------------------------------------------------------------------

// title: air swell into the hit, then the hit itself (boom, bell, shimmer)
sfx.add(0, swell(CUES.titleHit, 31), 0.3, (t) => -0.3 + 0.6 * t)
{
  sfx.add(CUES.titleHit, boom(120, 38, 0.5), 0.9)
  key(CUES.titleHit, 0.7, 0.4)
  const [l] = bell(mtof(69), 2.4)
  sfx.add(CUES.titleHit, l, 0.35, -0.1)
  hall.add(CUES.titleHit, l, 0.4)
  const [L, R] = shimmer(3, [69, 73, 76, 81], 101)
  sfx.add2(CUES.titleHit + 0.05, L, R, 0.22)
  hall.add2(CUES.titleHit + 0.05, L, R, 0.2)
}

// the cuts: a whoosh into every scene
CUES.whooshes.forEach((t, i) => {
  sfx.add(t - 0.1, whoosh(0.7, 300, 4200, { peak: 0.55, q: 1, seed: 21 + i }), 0.45, (u) => -0.8 + u * 2.4)
})

// fees: each SOL coin lands in the wallet with a clink, climbing the scale
for (const { i, t } of CUES.fees) {
  const m = PENTA[i % PENTA.length]
  sfx.add(t, clink(mtof(m), 61 + i), 0.22, ((i % 5) - 2) * 0.25)
  hall.add(t, clink(mtof(m), 61 + i), 0.08)
}

// hourly: a tick at each sweep start (where its tier lights), a bell at each completed hour
SWEEPS.forEach((w, i) => {
  sfx.add(w.from, thud(900, 500, 0.02), 0.2, 0.2)
  const [l] = bell(mtof([69, 73, 76][i]), 1.6)
  sfx.add(w.to, l, 0.4, -0.2 + i * 0.2)
  hall.add(w.to, l, 0.35)
  sfx.add(w.to, whomp([45 + [0, 4, 7][i], 57 + [0, 4, 7][i]], 91 + i), 0.35)
})

// holders: a zap as the line sweeps, plucks as the bars light, a pour and shimmer with the beams,
// a clink as each beam lands
{
  sfx.add(HOLDERS_T.line[0], zap(57), 0.35, (u) => -0.8 + u * 2)
  sfx.add(HOLDERS_T.line[0], whoosh(HOLDERS_T.line[1] - HOLDERS_T.line[0] + 0.3, 600, 5200, { peak: 0.5, seed: 33 }), 0.25, (u) => -0.8 + u * 2)
  for (const { i, t } of CUES.plucks) sfx.add(t, pluck(PENTA[(i / 2) % PENTA.length], 200 + i), 0.16, -0.8 + 1.6 * (i / ELIGIBLE.length))
  const [b0, b1] = HOLDERS_T.beams
  sfx.add(b0, pour(b1 - b0, 81), 0.12, 0.4)
  const [L, R] = shimmer(b1 - b0 + 1, [69, 73, 76, 81, 85], 102)
  sfx.add2(b0, L, R, 0.2)
  hall.add2(b0, L, R, 0.18)
  for (const { i, t } of CUES.beams) sfx.add(t, clink(mtof(PENTA[(i / 2 + 3) % PENTA.length]), 300 + i), 0.14, -0.8 + 1.6 * (i / PAID.length))
}

// burn: the fire crackles, every token that lands goes up with a soft whomp
{
  const { from, to } = SCENES.burn
  sfx.add(from + 0.2, crackle(to - from - 0.4, 0.006, 41), 0.35, 0.45)
  for (const { i, t } of CUES.burnCoins) sfx.add(t, clink(mtof(PENTA[i % 5] - 12), 400 + i), 0.12, -0.3)
  for (const { i, t } of CUES.burnTokens) {
    sfx.add(t, whomp([42, 54], 92 + i), 0.28, 0.4)
    sfx.add(t, boom(80, 34, 0.25, 1.5), 0.35, 0.3)
    key(t, 0.25, 0.2)
  }
  const [n0, n1] = BURN_T.count
  sfx.add(n0, riser(n1 - n0, 112), 0.14, 0.5)
}

// site: a soft thud as each part of the panel appears
for (let i = 0; i < 3; i++) sfx.add(SCENES.site.from + 0.9 + i * 0.25, thud(160, 70, 0.08), 0.35, 0.3)

// end: a riser into the last hit
{
  const from = CUES.endHit - BAR
  sfx.add(from, riser(BAR, 111), 0.3, (u) => -0.4 + 0.8 * u)
  sfx.add(CUES.endHit, boom(110, 34, 0.7), 1.0)
  key(CUES.endHit, 0.8, 0.5)
  const [L, R] = shimmer(3.8, [57, 69, 73, 76, 81], 103)
  sfx.add2(CUES.endHit, L, R, 0.3)
  hall.add2(CUES.endHit, L, R, 0.3)
  const [l] = bell(mtof(81), 3)
  sfx.add(CUES.endHit + 0.02, l, 0.3)
  hall.add(CUES.endHit + 0.02, l, 0.45)
}

// ---- mix and master -----------------------------------------------------------------------------

const roomWet = freeverb(musicVerb, { room: 0.7, damp: 0.45, width: 1, predelay: 0.015 })
const hallWet = freeverb(hall, { room: 0.93, damp: 0.25, width: 1, predelay: 0.03 })
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
{
  const hpL = new Biquad('highpass', 28, 0.7), hpR = new Biquad('highpass', 28, 0.7)
  const shL = new Biquad('highshelf', 9000, 0.7, 1.5), shR = new Biquad('highshelf', 9000, 0.7, 1.5)
  for (let i = 0; i < N; i++) {
    master.L[i] = sat(shL.run(hpL.run(master.L[i])) * 0.9, 1.15)
    master.R[i] = sat(shR.run(hpR.run(master.R[i])) * 0.9, 1.15)
  }
}
// a 1.2 s fade at the very end
for (let i = N - Math.round(1.2 * SR); i < N; i++) {
  const g = (N - i) / (1.2 * SR)
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
writeFileSync(here('../public/engine-soundtrack.wav'), writeWav24(master.L, master.R))
console.log(`engine-soundtrack.wav: ${SECONDS}s, ${final.toFixed(2)} LUFS, sample peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS, max limiting ${gr.toFixed(1)} dB`)
