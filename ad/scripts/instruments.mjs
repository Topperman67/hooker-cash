// The ad's instruments and sound effects, synthesized (no samples). Shared by make-audio.mjs (the
// 30 s ad) and make-tour-audio.mjs (the site tour).
import { SR, TAU, mtof, rng, Biquad, synth, osc, expDecay, ad, sat } from './dsp.mjs'

export const noise = (seed) => {
  const r = rng(seed)
  return () => r() * 2 - 1
}

// ================================================================================================
// instruments and effects (each returns a mono Float32Array unless noted)
// ================================================================================================

export function kick(seed = 1, punch = 1) {
  const o = osc('sine'), n = noise(seed), hp = new Biquad('highpass', 3000, 0.7)
  return synth(0.6, (t) => {
    const f = 44 + 120 * Math.exp(-t / 0.032) * punch
    const body = o(f) * ad(t, 0.002, 0.2)
    const click = hp.run(n()) * expDecay(t, 0.004) * 0.35
    return sat(body * 1.3, 1.6) + click
  })
}

export function clap(seed = 2) {
  const n = noise(seed), bp = new Biquad('bandpass', 1300, 0.9), hp = new Biquad('highpass', 500, 0.7)
  return synth(0.45, (t) => {
    let e = 0
    for (const d of [0, 0.011, 0.023]) e += t >= d ? Math.exp(-(t - d) / 0.006) : 0
    e += t >= 0.03 ? Math.exp(-(t - 0.03) / 0.1) * 0.7 : 0
    return hp.run(bp.run(n())) * e * 1.6
  })
}

export function hat(seed = 3, open = false) {
  const n = noise(seed), hp = new Biquad('highpass', 7500, 0.8), pk = new Biquad('peak', 11000, 1.2, 5)
  return synth(open ? 0.45 : 0.08, (t) => pk.run(hp.run(n())) * expDecay(t, open ? 0.13 : 0.022))
}

export function snare(seed = 4) {
  const n = noise(seed), o = osc('sine'), bp = new Biquad('bandpass', 2800, 0.6)
  return synth(0.3, (t) => o(185 + 60 * Math.exp(-t / 0.02)) * expDecay(t, 0.05) * 0.6 + bp.run(n()) * expDecay(t, 0.09))
}

/** bass note: sub sine + filtered saw with a pluck envelope */
export function bassNote(m, dur, seed = 5) {
  const sub = osc('sine'), s1 = osc('saw', 0.1), s2 = osc('saw', 0.6), lp = new Biquad('lowpass', 400, 0.9)
  const f = mtof(m)
  return synth(dur + 0.08, (t) => {
    const env = (t < 0.004 ? t / 0.004 : 1) * (t > dur ? Math.exp(-(t - dur) / 0.02) : 1)
    lp.set(120 + 1100 * Math.exp(-t / 0.09), 0.9)
    const mid = lp.run(s1(f) + s2(f * 1.006)) * 0.45
    return (sub(f / 2) * 0.8 + mid) * env
  })
}

/** pad chord, stereo: detuned saws through a slowly breathing low-pass */
export function pad(notes, dur, { cutoff = 1400, attack = 0.5, release = 1.2, seed = 6 } = {}) {
  const r = rng(seed)
  const side = (det) => {
    const voices = notes.flatMap((m) => [-1, 0, 1].map((k) => ({ o: osc('saw', r()), f: mtof(m) * 2 ** ((k * det) / 1200) })))
    const lp = new Biquad('lowpass', cutoff, 0.7), lp2 = new Biquad('lowpass', cutoff, 0.7)
    return synth(dur + release, (t) => {
      if ((Math.round(t * SR) & 31) === 0) {
        const c = cutoff * (0.8 + 0.25 * Math.sin(TAU * 0.25 * t))
        lp.set(c); lp2.set(c)
      }
      let v = 0
      for (const x of voices) v += x.o(x.f)
      const env = Math.min(1, t / attack) * (t > dur ? Math.exp(-(t - dur) / (release / 3)) : 1)
      return lp2.run(lp.run(v)) * env * (0.5 / voices.length)
    })
  }
  return [side(9), side(-11)]
}

/** glassy FM pluck */
export function pluck(m, seed = 7) {
  const c = osc('sine'), mod = osc('sine'), f = mtof(m)
  return synth(0.7, (t) => {
    const idx = 3.2 * Math.exp(-t / 0.06)
    return Math.sin(TAU * f * t + idx * mod(f * 3.5)) * ad(t, 0.002, 0.22)
  })
}

/** inharmonic bell / chime; returns stereo with a little L/R detune */
export function bell(f, decay = 1.2, { partials = [1, 2.0, 2.76, 4.07, 5.4], amps = [1, 0.5, 0.32, 0.2, 0.12] } = {}) {
  const side = (det) =>
    synth(decay * 4, (t) => {
      let v = 0
      partials.forEach((p, k) => {
        v += Math.sin(TAU * f * p * det * t) * amps[k] * expDecay(t, decay / (1 + k * 0.6))
      })
      return v * Math.min(1, t / 0.0015) * 0.5
    })
  return [side(1), side(1.0015)]
}

/** struck metal: inharmonic partials plus a bright transient */
export function metal(base, decay = 0.9, seed = 11) {
  const n = noise(seed), hp = new Biquad('highpass', 2500, 0.7)
  const ratios = [1, 1.47, 2.09, 2.56, 3.42, 4.11, 5.3, 6.77]
  const r = rng(seed)
  const amps = ratios.map(() => 0.4 + 0.6 * r())
  return synth(decay * 4, (t) => {
    let v = 0
    ratios.forEach((k, i) => (v += Math.sin(TAU * base * k * t) * amps[i] * expDecay(t, decay / (1 + i * 0.35))))
    return v * 0.22 + hp.run(n()) * expDecay(t, 0.008) * 0.7
  })
}

/** pitch-dropping sub boom */
export function boom(f0, f1, decay, drive = 2) {
  const o = osc('sine')
  return synth(decay * 4, (t) => sat(o(f1 + (f0 - f1) * Math.exp(-t / 0.11)) * ad(t, 0.003, decay), drive))
}

/** band-passed noise sweep; fStart→fEnd over dur, envelope peaks at `peak` (0..1 of dur) */
export function whoosh(dur, fStart, fEnd, { peak = 0.6, q = 1.1, seed = 21, curve = 2 } = {}) {
  const n = noise(seed), bp = new Biquad('bandpass', fStart, q), bp2 = new Biquad('bandpass', fStart, q)
  return synth(dur, (t) => {
    const p = t / dur
    if ((Math.round(t * SR) & 15) === 0) {
      const f = fStart * (fEnd / fStart) ** p
      bp.set(f, q); bp2.set(f, q)
    }
    const env = p < peak ? (p / peak) ** curve : Math.exp(-((p - peak) / (1 - peak)) * 4)
    return bp2.run(bp.run(n())) * env * 2.2
  })
}

/** reverse-cymbal style swell that stops dead at its end */
export function swell(dur, seed = 31) {
  const n = noise(seed), hp = new Biquad('highpass', 4500, 0.7), pk = new Biquad('peak', 9000, 1, 6)
  return synth(dur, (t) => pk.run(hp.run(n())) * (t / dur) ** 3)
}

export function crackle(dur, density, seed = 41) {
  const r = rng(seed), bp = new Biquad('bandpass', 2600, 2.5)
  return synth(dur, (t) => bp.run(r() < density ? (r() * 2 - 1) * 6 : 0) * Math.min(1, t / 0.05) * Math.exp(-t / (dur * 0.6)))
}

/** tuned laser zap for a hook line, falling onto its note */
export function zap(m, seed = 51) {
  const f = mtof(m + 12)
  const a = osc('saw'), b = osc('sine'), mod = osc('sine'), lp = new Biquad('lowpass', 6000, 0.8)
  const n = noise(seed), hp = new Biquad('highpass', 3000, 0.7)
  return synth(1.0, (t) => {
    const fr = f * (1 + 3 * Math.exp(-t / 0.045))
    lp.set(1500 + 9000 * Math.exp(-t / 0.08))
    const tone = lp.run(a(fr)) * 0.35 + Math.sin(TAU * fr * t + 1.5 * Math.exp(-t / 0.2) * mod(fr * 2)) * 0.5 + b(fr * 0.5) * 0.25
    return tone * ad(t, 0.002, 0.28) + hp.run(n()) * expDecay(t, 0.015) * 0.5
  })
}

export function clink(f, seed = 61) {
  const [l] = bell(f, 0.16, { partials: [1, 2.32, 4.25, 6.1], amps: [1, 0.6, 0.4, 0.25] })
  const n = noise(seed), hp = new Biquad('highpass', 5000, 0.7)
  return l.map((v, i) => v + hp.run(n()) * expDecay(i / SR, 0.003) * 0.4)
}

export function thud(f0 = 110, f1 = 48, decay = 0.12) {
  const o = osc('sine')
  return synth(0.5, (t) => sat(o(f1 + (f0 - f1) * Math.exp(-t / 0.03)) * ad(t, 0.001, decay), 1.5))
}

/** granular crumble: dense noise grains thinning out */
export function crumble(dur, seed = 71) {
  const r = rng(seed), lp = new Biquad('lowpass', 3500, 0.7), hp = new Biquad('highpass', 600, 0.7)
  let g = 0
  return synth(dur, (t) => {
    const p = t / dur
    if (g <= 0 && r() < 0.012 * (1 - p) ** 2) g = Math.round(SR * (0.002 + r() * 0.006))
    const v = g > 0 ? (r() * 2 - 1) : 0
    g--
    return hp.run(lp.run(v)) * (1 - p)
  })
}

/** liquid pour: resonant noise rising as the vessel fills */
export function pour(dur, seed = 81) {
  const n = noise(seed), bp = new Biquad('bandpass', 300, 9), r = rng(seed + 1)
  let wob = 0
  return synth(dur, (t) => {
    const p = t / dur
    if ((Math.round(t * SR) & 63) === 0) {
      wob += (r() - 0.5) * 0.3
      wob *= 0.9
      bp.set(320 * 4.5 ** p * (1 + wob * 0.2), 9)
    }
    return bp.run(n()) * Math.min(1, t / 0.05) * (1 - p * 0.3) * 4
  })
}

/** low-passed chord stab with a "wub" filter envelope */
export function whomp(notes, seed = 91) {
  const r = rng(seed)
  const vs = notes.map((m) => ({ o: osc('saw', r()), f: mtof(m) }))
  const lp = new Biquad('lowpass', 150, 3), lp2 = new Biquad('lowpass', 150, 1)
  return synth(0.7, (t) => {
    if ((Math.round(t * SR) & 15) === 0) {
      const c = 140 + 1300 * Math.sin(Math.PI * Math.min(1, t / 0.32)) ** 2
      lp.set(c, 3); lp2.set(c, 1)
    }
    let v = 0
    for (const x of vs) v += x.o(x.f)
    return lp2.run(lp.run(v / vs.length)) * ad(t, 0.01, 0.25) * 1.4
  })
}

/** holographic shimmer: beating high sines with tremolo; stereo */
export function shimmer(dur, notes, seed = 101) {
  const side = (off) =>
    synth(dur, (t) => {
      let v = 0
      notes.forEach((m, i) => (v += Math.sin(TAU * (mtof(m) + off * (i + 1)) * t)))
      const trem = 0.6 + 0.4 * Math.sin(TAU * 9 * t)
      return (v / notes.length) * trem * ad(t, 0.12, dur * 0.4) * 0.6
    })
  return [side(2.3), side(-2.9)]
}

/** pitched + noise riser that stops dead at its end */
export function riser(dur, seed = 111) {
  const n = noise(seed), hp = new Biquad('highpass', 400, 0.8), s = osc('saw'), s2 = osc('saw', 0.5), lp = new Biquad('lowpass', 800, 1.5)
  return synth(dur, (t) => {
    const p = t / dur
    if ((Math.round(t * SR) & 15) === 0) {
      hp.set(400 * 22 ** p, 0.8)
      lp.set(600 + 6000 * p * p, 1.5)
    }
    const f = 110 * 4 ** p
    const v = hp.run(n()) * 0.9 + lp.run(s(f) + s2(f * 1.01)) * 0.35
    return v * p ** 2.2
  })
}
