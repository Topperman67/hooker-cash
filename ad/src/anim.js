// Small, pure animation helpers. Everything in the film is a function of time, so any frame can
// be rendered on its own, in any order, and always gives the same picture.

export const clamp01 = (x) => Math.min(1, Math.max(0, x))
export const lerp = (a, b, p) => a + (b - a) * p
export const mix3 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p), lerp(a[2], b[2], p)]
/** 0 before a, 1 after b, linear between */
export const prog = (t, a, b) => clamp01((t - a) / (b - a))

export const ease = {
  in: (x) => x * x * x,
  out: (x) => 1 - (1 - x) ** 3,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
  sine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  outExpo: (x) => (x === 1 ? 1 : 1 - 2 ** (-10 * x)),
  inExpo: (x) => (x === 0 ? 0 : 2 ** (10 * x - 10)),
  outBack: (x) => 1 + 2.4 * (x - 1) ** 3 + 1.4 * (x - 1) ** 2,
}

/** deterministic pseudo-random in [0, 1) for an integer seed */
export function rand(seed) {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** sRGB hex → [r, g, b] in 0..1 */
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

/** blend two hex colours, returns hex */
export function mixHex(a, b, p) {
  const A = hex(a)
  const B = hex(b)
  return (
    '#' +
    A.map((v, i) =>
      Math.round(lerp(v, B[i], p) * 255)
        .toString(16)
        .padStart(2, '0'),
    ).join('')
  )
}
