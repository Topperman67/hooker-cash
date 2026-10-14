// Camera and lighting direction for every moment of the film, as pure functions of time.
import { HOOKS, CUES, FPS } from '../timeline.js'
import { prog, ease, mix3, lerp, mixHex } from '../anim.js'
import { LINE, TUNNEL, END } from './layout.js'

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const arr = (v) => [v.x, v.y, v.z]

function orbit(center, radius, az, el) {
  return [
    center[0] + radius * Math.sin(az) * Math.cos(el),
    center[1] + radius * Math.sin(el),
    center[2] + radius * Math.cos(az) * Math.cos(el),
  ]
}

// Where each hook's payoff sits relative to its line end, and where the camera looks from.
export const PAYOFF = {
  creator: { focus: [0.3, -0.75, 0], from: [-2.4, 0.9, 6.6] },
  burn: { focus: [0.55, 0, 0], from: [-2.3, 0.45, 6.1] },
  entangle: { focus: [1.45, -0.3, 0], from: [-1.6, 0.9, 7.6] },
  fusion: { focus: [0, -0.85, 0], from: [-2.1, 1.3, 6.6] },
}

const D = (x) => (x * Math.PI) / 180

/** camera at time t (seconds): { pos, target, fov, roll } */
export function pose(t) {
  const frame = Math.round(t * FPS)

  if (t < 4) {
    const p = ease.sine(prog(t, 0, 4))
    return {
      pos: mix3([-3.2, 4.8, 16.5], [-2.2, 2.9, 12.2], p),
      target: mix3([-7.6, 5.1, -2.6], [-3.1, 1.9, -0.8], p),
      fov: 32,
      roll: lerp(-0.03, 0, p),
    }
  }

  if (t < 8) {
    const p = ease.sine(prog(t, 4, 8))
    const center = [0.25, -0.3, 0]
    return {
      pos: orbit(center, lerp(14.5, 12.4, p), D(lerp(-40, -4, p)), D(lerp(11, 3, p))),
      target: center,
      fov: 30,
      roll: 0,
    }
  }

  if (t < 14) {
    const i = Math.min(3, Math.floor((t - 8) / 1.5))
    const hook = HOOKS[i]
    const u = t - hook.at
    const line = LINE[hook.key]
    const P = PAYOFF[hook.key]
    const focus = add(arr(line.end), P.focus)
    const start = arr(line.curve.getPointAt(0.3))
    const target = mix3(start, focus, ease.inOut(prog(u, 0, 0.8)))
    const push = lerp(1.06, 0.93, ease.sine(prog(u, 0, 1.5)))
    return { pos: add(target, scale(P.from, push)), target, fov: 32, roll: 0 }
  }

  if (t < 20) {
    const p = ease.sine(prog(t, 14, 20))
    const shift = ease.inOut(prog(t, 15.6, 17.2))
    return {
      pos: mix3([1.8, -1.2, 29.5], [3.6, -2.0, 26], p),
      target: add(mix3([2.1, -3.2, 0], [3.0, -3.4, 0], p), [3.6 * shift, 0, 0]),
      fov: 30,
      roll: 0,
    }
  }

  if (t < 25) {
    // the chrome tunnel, cut on the beat with each title
    const T = arr(TUNNEL)
    let z, off, roll, fov
    if (t < 21.5) {
      const p = prog(t, 20, 21.5)
      z = lerp(8, -42, ease.sine(p) * 0.5 + p * 0.5)
      off = [0.55, 0.35]
      roll = lerp(0, 0.18, p)
      fov = 56
    } else if (t < 23) {
      const p = prog(t, 21.5, 23)
      z = lerp(-52, -104, p)
      off = [-0.65, 0.25]
      roll = lerp(-0.55, -0.3, p)
      fov = 60
    } else {
      // out of the far end of the tunnel, into the dark where only the lines run on
      const p = prog(t, 23, 25)
      z = lerp(-158, -176, ease.outExpo(p))
      off = [0, 0]
      roll = lerp(0.14, 0, ease.out(p))
      fov = lerp(50, 40, ease.out(p))
    }
    const pos = add(T, [off[0], off[1], z])
    return { pos, target: add(pos, [-off[0] * 0.3, -off[1] * 0.3, -10]), fov, roll }
  }

  // end card
  const E = arr(END)
  const p = ease.out(prog(t, 25.33, 30))
  const pos = add(E, [0, lerp(0.55, 0.38, p), lerp(14.6, 13.2, p)])
  const hit = Math.round(CUES.final * FPS)
  const jolt = { [hit]: -0.07, [hit + 1]: 0.035, [hit + 2]: -0.012 }[frame] || 0
  return { pos: add(pos, [0, jolt, 0]), target: add(E, [0, -0.45 + jolt, 0]), fov: 30, roll: 0 }
}

const BLACK = '#05070a'
const PEARL = '#e9ecf0'
const GRAPHITE = '#12151a'

/** studio look at time t: background, fog, environment, chromatic aberration */
export function look(t) {
  const impact = (at, amount, decay = 9) => (t >= at ? amount * Math.exp(-(t - at) * decay) : 0)
  const ca = impact(CUES.reveal, 0.006) + impact(CUES.final, 0.007) + CUES.titles.reduce((s, at) => s + impact(at, 0.0025, 14), 0)

  if (t < 4) {
    return { bg: BLACK, fog: 0.03, env: lerp(0.03, 0.09, prog(t, 2.5, 4)), envRot: 0.4, ca }
  }
  if (t < 8) {
    // lights snap on with a one-frame stutter, then the backdrop lifts to pearl
    const on = prog(t, 4, 4 + 2 / FPS)
    const stutter = t >= 4 + 3 / FPS && t < 4 + 5 / FPS ? 0.65 : 1
    const glint = ease.inOut(prog(t, CUES.glint - 0.3, CUES.glint + 0.9))
    return {
      bg: mixHex(BLACK, PEARL, ease.out(prog(t, 4, 4.9))),
      fog: lerp(0.03, 0.006, prog(t, 4, 4.9)),
      env: lerp(0.09, 1.05, on) * stutter,
      envRot: 0.4 + 1.5 * glint + 0.04 * (t - 4),
      ca,
    }
  }
  if (t < 20) {
    return { bg: GRAPHITE, fog: 0.016, env: 0.95, envRot: 0.55 + 0.035 * (t - 8), ca }
  }
  if (t < 25) {
    return { bg: '#010102', fog: 0.05, env: 0.45, envRot: 0.7 * t, ca }
  }
  if (t < 25.33) return { bg: '#000000', fog: 0.0, env: 0, envRot: 0, ca: 0 }
  const rake = ease.inOut(prog(t, CUES.final, CUES.final + 1.6))
  return { bg: PEARL, fog: 0.006, env: 1.05, envRot: -0.6 + 2.0 * rake, ca }
}
