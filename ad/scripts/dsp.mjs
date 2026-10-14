// Minimal offline DSP toolkit for the soundtrack: oscillators, noise, biquads, envelopes,
// Freeverb, a lookahead limiter and a BS.1770 loudness meter. Everything is deterministic.

export const SR = 48000
export const TAU = Math.PI * 2

export const mtof = (m) => 440 * 2 ** ((m - 69) / 12)
export const db = (d) => 10 ** (d / 20)

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** RBJ cookbook biquad; call set() as often as needed for sweeps */
export class Biquad {
  constructor(type = 'lowpass', f = 1000, q = 0.707, gain = 0) {
    this.type = type
    this.x1 = this.x2 = this.y1 = this.y2 = 0
    this.set(f, q, gain)
  }
  set(f, q = this.q, gain = this.gain) {
    this.q = q
    this.gain = gain
    const w = (TAU * Math.min(f, SR * 0.45)) / SR
    const cw = Math.cos(w)
    const sw = Math.sin(w)
    const alpha = sw / (2 * q)
    const A = 10 ** (gain / 40)
    let b0, b1, b2, a0, a1, a2
    switch (this.type) {
      case 'lowpass':
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'highpass':
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha
        break
      case 'peak':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A
        break
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s)
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s
        break
      }
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s)
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s
        break
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0
    return this
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

/** mono buffer of `dur` seconds from fn(t, i) */
export function synth(dur, fn) {
  const n = Math.max(1, Math.round(dur * SR))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fn(i / SR, i)
  return out
}

/** phase-accumulating oscillator; call with frequency each sample */
export function osc(shape = 'sine', phase0 = 0) {
  let ph = phase0
  return (f) => {
    ph += f / SR
    ph -= Math.floor(ph)
    switch (shape) {
      case 'sine':
        return Math.sin(TAU * ph)
      case 'saw': {
        // polyBLEP saw
        const dt = f / SR
        let v = 2 * ph - 1
        if (ph < dt) { const x = ph / dt; v -= x + x - x * x - 1 }
        else if (ph > 1 - dt) { const x = (ph - 1) / dt; v -= x * x + x + x + 1 }
        return v
      }
      case 'tri':
        return 1 - 4 * Math.abs(ph - 0.5)
      case 'square':
        return ph < 0.5 ? 1 : -1
    }
  }
}

export const expDecay = (t, tau) => (t < 0 ? 0 : Math.exp(-t / tau))
/** attack-then-exponential-decay envelope */
export const ad = (t, a, tau) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / tau))
export const sat = (x, drive = 1) => Math.tanh(x * drive) / Math.tanh(drive)

/** stereo bus with equal-power panning */
export class Bus {
  constructor(n) {
    this.L = new Float32Array(n)
    this.R = new Float32Array(n)
  }
  /** add a mono buffer at time t0 (s). pan in [-1, 1] or a function of local time */
  add(t0, buf, gain = 1, pan = 0) {
    const s0 = Math.round(t0 * SR)
    const fixed = typeof pan === 'number'
    let gl = Math.cos(((fixed ? pan : 0) + 1) * (Math.PI / 4))
    let gr = Math.sin(((fixed ? pan : 0) + 1) * (Math.PI / 4))
    for (let i = 0; i < buf.length; i++) {
      const j = s0 + i
      if (j < 0) continue
      if (j >= this.L.length) break
      if (!fixed && (i & 63) === 0) {
        const p = Math.max(-1, Math.min(1, pan(i / SR)))
        gl = Math.cos((p + 1) * (Math.PI / 4))
        gr = Math.sin((p + 1) * (Math.PI / 4))
      }
      this.L[j] += buf[i] * gain * gl
      this.R[j] += buf[i] * gain * gr
    }
  }
  /** add a stereo pair */
  add2(t0, L, R, gain = 1) {
    const s0 = Math.round(t0 * SR)
    for (let i = 0; i < L.length; i++) {
      const j = s0 + i
      if (j < 0) continue
      if (j >= this.L.length) break
      this.L[j] += L[i] * gain
      this.R[j] += R[i] * gain
    }
  }
  mixInto(dst, gain = 1) {
    for (let i = 0; i < this.L.length; i++) {
      dst.L[i] += this.L[i] * gain
      dst.R[i] += this.R[i] * gain
    }
  }
}

// ---- Freeverb ----------------------------------------------------------------------------------

class Comb {
  constructor(n) { this.b = new Float32Array(n); this.i = 0; this.s = 0 }
  run(x, fb, damp) {
    const y = this.b[this.i]
    this.s = y * (1 - damp) + this.s * damp
    this.b[this.i] = x + this.s * fb
    if (++this.i >= this.b.length) this.i = 0
    return y
  }
}
class Allpass {
  constructor(n) { this.b = new Float32Array(n); this.i = 0 }
  run(x) {
    const b = this.b[this.i]
    this.b[this.i] = x + b * 0.5
    if (++this.i >= this.b.length) this.i = 0
    return b - x
  }
}

/** returns a new wet-only stereo bus */
export function freeverb(src, { room = 0.84, damp = 0.3, width = 1, predelay = 0.02, lowcut = 180, highcut = 9000 } = {}) {
  const k = SR / 44100
  const sp = Math.round(23 * k)
  const cd = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(d * k))
  const ad_ = [556, 441, 341, 225].map((d) => Math.round(d * k))
  const cl = cd.map((d) => new Comb(d)), cr = cd.map((d) => new Comb(d + sp))
  const al = ad_.map((d) => new Allpass(d)), ar = ad_.map((d) => new Allpass(d + sp))
  const fb = room * 0.28 + 0.7
  const dp = damp * 0.4
  const w1 = width / 2 + 0.5, w2 = (1 - width) / 2
  const n = src.L.length
  const out = new Bus(n)
  const pd = Math.round(predelay * SR)
  const hpL = new Biquad('highpass', lowcut, 0.7), hpR = new Biquad('highpass', lowcut, 0.7)
  const lpL = new Biquad('lowpass', highcut, 0.7), lpR = new Biquad('lowpass', highcut, 0.7)
  for (let i = 0; i < n; i++) {
    const j = i - pd
    const x = j >= 0 ? (src.L[j] + src.R[j]) * 0.015 : 0
    let l = 0, r = 0
    for (let c = 0; c < 8; c++) { l += cl[c].run(x, fb, dp); r += cr[c].run(x, fb, dp) }
    for (let a = 0; a < 4; a++) { l = al[a].run(l); r = ar[a].run(r) }
    out.L[i] = lpL.run(hpL.run(l * w1 + r * w2))
    out.R[i] = lpR.run(hpR.run(r * w1 + l * w2))
  }
  return out
}

// ---- loudness and limiting ---------------------------------------------------------------------

/** integrated loudness (LUFS), ITU-R BS.1770-4, 48 kHz */
export function lufs(L, R) {
  const kw = () => {
    const s1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] }
    const s2 = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] }
    const st = [0, 0, 0, 0, 0, 0, 0, 0]
    return (x) => {
      const y1 = s1.b[0] * x + s1.b[1] * st[0] + s1.b[2] * st[1] - s1.a[0] * st[2] - s1.a[1] * st[3]
      st[1] = st[0]; st[0] = x; st[3] = st[2]; st[2] = y1
      const y2 = s2.b[0] * y1 + s2.b[1] * st[4] + s2.b[2] * st[5] - s2.a[0] * st[6] - s2.a[1] * st[7]
      st[5] = st[4]; st[4] = y1; st[7] = st[6]; st[6] = y2
      return y2
    }
  }
  const fl = kw(), fr = kw()
  const n = L.length
  const sq = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = fl(L[i]), b = fr(R[i])
    sq[i] = a * a + b * b
  }
  const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR)
  const pw = []
  let acc = 0
  for (let i = 0; i < block && i < n; i++) acc += sq[i]
  for (let s = 0; s + block <= n; s += hop) {
    if (s > 0) {
      for (let i = s - hop; i < s; i++) acc -= sq[i]
      for (let i = s + block - hop; i < s + block; i++) acc += sq[i]
    }
    pw.push(acc / block)
  }
  const L_ = (p) => -0.691 + 10 * Math.log10(p)
  const abs = pw.filter((p) => L_(p) > -70)
  const mean = abs.reduce((a, b) => a + b, 0) / abs.length
  const rel = abs.filter((p) => L_(p) > L_(mean) - 10)
  return L_(rel.reduce((a, b) => a + b, 0) / rel.length)
}

/** offline lookahead peak limiter (in place). Returns max gain reduction in dB. */
export function limit(L, R, ceilingDb = -2, lookMs = 5, releaseMs = 90) {
  const n = L.length
  const c = db(ceilingDb)
  const look = Math.max(1, Math.round((lookMs / 1000) * SR))
  const tgt = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]))
    tgt[i] = p > c ? c / p : 1
  }
  // min over the next `look` samples (monotonic deque)
  const mf = new Float32Array(n)
  const dq = new Int32Array(n)
  let h = 0, t = 0
  for (let i = n - 1; i >= 0; i--) {
    while (t > h && tgt[dq[t - 1]] >= tgt[i]) t--
    dq[t++] = i
    while (dq[h] > i + look) h++
    mf[i] = tgt[dq[h]]
  }
  // moving average over the previous `look` samples gives a smooth attack that lands on the peak
  const rel = Math.exp(-1 / ((releaseMs / 1000) * SR))
  let sum = 0
  let g = 1
  let worst = 1
  for (let i = 0; i < n; i++) {
    sum += mf[i]
    if (i >= look) sum -= mf[i - look]
    const sm = i >= look ? sum / look : Math.min(1, sum / (i + 1))
    g = sm < g ? sm : g + (sm - g) * (1 - rel)
    const gg = Math.min(g, tgt[i])
    worst = Math.min(worst, gg)
    L[i] *= gg
    R[i] *= gg
  }
  return 20 * Math.log10(worst)
}

// ---- WAV io ------------------------------------------------------------------------------------

export function writeWav24(L, R) {
  const n = L.length
  const buf = Buffer.alloc(44 + n * 6)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 6, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 6, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 6, 40)
  let o = 44
  for (let i = 0; i < n; i++) {
    for (const v of [L[i], R[i]]) {
      const s = Math.max(-8388608, Math.min(8388607, Math.round(v * 8388607)))
      buf.writeIntLE(s, o, 3)
      o += 3
    }
  }
  return buf
}

/** reads 16/24-bit PCM or 32-bit float WAV, resampled linearly to SR, as {L, R} */
export function readWav(bytes) {
  let o = 12
  let fmt, data
  while (o < bytes.length) {
    const id = bytes.toString('ascii', o, o + 4)
    const size = bytes.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { tag: bytes.readUInt16LE(o + 8), ch: bytes.readUInt16LE(o + 10), sr: bytes.readUInt32LE(o + 12), bits: bytes.readUInt16LE(o + 22) }
    if (id === 'data') data = { o: o + 8, size }
    o += 8 + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('music.wav: not a WAV file')
  const bps = fmt.bits / 8
  const frames = Math.floor(data.size / (bps * fmt.ch))
  const read = (i, c) => {
    const p = data.o + (i * fmt.ch + c) * bps
    if (fmt.tag === 3) return bytes.readFloatLE(p)
    if (fmt.bits === 16) return bytes.readInt16LE(p) / 32768
    if (fmt.bits === 24) return bytes.readIntLE(p, 3) / 8388608
    throw new Error(`music.wav: unsupported ${fmt.bits}-bit format`)
  }
  const n = Math.floor((frames * SR) / fmt.sr)
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * fmt.sr) / SR
    const a = Math.floor(x), f = x - a, b = Math.min(frames - 1, a + 1)
    const l = read(a, 0) * (1 - f) + read(b, 0) * f
    const r = fmt.ch > 1 ? read(a, 1) * (1 - f) + read(b, 1) * f : l
    L[i] = l
    R[i] = r
  }
  return { L, R }
}
