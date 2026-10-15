// Where everything in the flywheel film sits, and the paths things travel, as pure functions of
// time. The scene, the camera and the overlay labels all read this file.
//
// The glass chart (the flywheel) lies flat at the origin, the same chart as the home page still
// (ad/src/social/Flywheel.jsx): 60% holders in green on the right, 40% buyback & burn in pink on
// the left. Trades race round it on a track; the gate on the front of the track slices the fee off
// every trade and sends it up to the well above the chart. The holders sit out along the green
// slice, the burn rig out along the pink one.
import * as THREE from 'three'
import { SPLIT, COLORS, CUES, BEAT, SECONDS } from './timeline.js'
import { prog, ease, rand, lerp } from '../anim.js'

const TAU = Math.PI * 2
const V = (x, y, z) => new THREE.Vector3(x, y, z)

/** shape angle θ (radians, counter-clockwise seen from above, 90° = the back) → world point */
export const polar = (theta, r, y = 0) => V(Math.cos(theta) * r, y, -Math.sin(theta) * r)

// ---- the chart -----------------------------------------------------------------------------------

export const ROTOR = { inner: 1.05, outer: 2.55, gap: 0.14 }

/** slices clockwise from the back: holders spans [start, end] = [90° − 216°, 90°], burn the rest */
export const SLICES = (() => {
  let at = Math.PI / 2
  return [
    { key: 'holders', share: SPLIT.holders / 100, color: COLORS.holders, light: COLORS.holdersLight, depth: 0.95 },
    { key: 'burn', share: SPLIT.burn / 100, color: COLORS.burn, light: COLORS.burnLight, depth: 0.7 },
  ].map((s) => {
    const end = at
    const start = at - s.share * TAU
    at = start
    return { ...s, start, end, mid: (start + end) / 2, span: end - start }
  })
})()
export const HOLDERS_SLICE = SLICES[0]
export const BURN_SLICE = SLICES[1]

/** The light comes in at the front-left seam between the slices and runs both ways round the
 *  ring: green counter-clockwise through 216°, pink clockwise through 144°, at the same speed. */
export const SEAM = HOLDERS_SLICE.start // = BURN_SLICE.end − 2π
const MID_R = (ROTOR.inner + ROTOR.outer) / 2
export const SPLIT_POINT = polar(SEAM, MID_R, 1.0)

/** how far each slice has filled (0..1) at time t; both fronts move at the same angular speed */
export function fillOf(slice, t) {
  const speed = (HOLDERS_SLICE.span) / (CUES.fill.to - CUES.fill.from) // the green one takes the whole window
  return Math.min(1, Math.max(0, ((t - CUES.fill.from) * speed) / slice.span))
}

// ---- the trades track and the gate ------------------------------------------------------------

export const TRACK = { radius: 4.7, y: 0.42, far: 15 }
export const LANES = [
  { dr: -0.17, dy: 0.1 },
  { dr: 0.0, dy: -0.07 },
  { dr: 0.17, dy: 0.05 },
]
export const GATE_ANGLE = -Math.PI / 2 // the front of the track
export const GATE = polar(GATE_ANGLE, TRACK.radius, TRACK.y)
/** the direction trades travel through the gate (clockwise seen from above) */
export const GATE_TANGENT = V(-1, 0, 0)
export const TRADE_PRE = 3.2 // seconds a trade is on screen before the gate
export const TRADE_POST = 2.4 // and after

/** Trades are timed by when they cross the gate, so each slice lands on the rhythm grid. */
function crossingInterval(T) {
  if (T < 20) return BEAT / 2
  return BEAT / 4
}
function speedAt(T) {
  // angular speed (rad/s) on the track: slower through the close-up at the gate, then spinning up
  if (T < 4) return 1.25
  if (T < 8) return 0.8
  if (T < 20) return lerp(1.0, 1.25, prog(T, 8, 20))
  return lerp(1.4, 1.9, ease.out(prog(T, 20, 25)))
}

export const TRADES = (() => {
  const out = []
  let T = -2.0
  let k = 0
  while (T < SECONDS + TRADE_PRE) {
    const j = rand(k * 7 + 3) - 0.5
    out.push({
      k,
      T,
      lane: LANES[k % 3],
      v: speedAt(T),
      len: 0.55 + 0.35 * rand(k * 7 + 4),
      inY: (rand(k * 7 + 5) < 0.5 ? 1 : -1) * (1.2 + 2.4 * rand(k * 7 + 6)),
      wob: j,
      // the fee is only sliced off once the gate is lit
      fee: T >= CUES.gate - 1e-6,
    })
    T += crossingInterval(T)
    k++
  }
  return out
})()

/** a trade's position at time t, plus its brightness (0 when it is not on screen) */
export function tradeAt(tr, t, out = new THREE.Vector3()) {
  const u = t - tr.T
  if (u < -TRADE_PRE || u > TRADE_POST) return { pos: out.set(0, -999, 0), alpha: 0, u }
  const theta = GATE_ANGLE - tr.v * u // clockwise
  // spiral in from the dark, settle onto the lane well before the gate
  const inward = ease.inOut(prog(-u, 1.1, TRADE_PRE))
  const r = TRACK.radius + tr.lane.dr + (TRACK.far - TRACK.radius) * inward * inward
  const y = TRACK.y + tr.lane.dy + tr.inY * inward
  out.copy(polar(theta, r, y))
  const alpha = ease.out(prog(u, -TRADE_PRE, -TRADE_PRE + 0.8)) * (1 - ease.in(prog(u, TRADE_POST - 0.9, TRADE_POST)))
  return { pos: out, alpha, u, theta, r, y }
}

// ---- the well ----------------------------------------------------------------------------------

export const WELL = V(0, 3.9, 0)
export const WELL_R = 0.62
export const SLIVER_FLIGHT = 0.95

/** the sliver sliced off trade `tr` flies from the gate up into the well */
export function sliverCurve(tr) {
  const start = polar(GATE_ANGLE, TRACK.radius + tr.lane.dr, TRACK.y + tr.lane.dy)
  return new THREE.CubicBezierCurve3(
    start,
    start.clone().add(V(-0.4, 1.9, 0.35)),
    WELL.clone().add(V(0.1, 1.5, 1.9)),
    WELL.clone().add(V(0, 0.05, 0.05)),
  )
}

/** the well pours on the downbeat of every bar from the first pour on */
export const POURS = (() => {
  const out = []
  for (let t = CUES.pour; t < SECONDS; t += 2) out.push(t)
  return out
})()

/** how full the well is at t (0..1): slivers that have arrived since the last pour */
export function wellFill(t) {
  const last = POURS.filter((p) => p <= t).pop()
  const since = last === undefined ? -Infinity : last
  const drain = last === undefined ? 0 : 1 - ease.in(prog(t, last, last + 0.35))
  let n = 0
  for (const tr of TRADES) {
    if (!tr.fee || tr.T > CUES.arrows - 0.9) continue
    const at = tr.T + SLIVER_FLIGHT
    if (at <= t && at > since) n++
  }
  const before = last === undefined ? 0 : wellFillBefore(last)
  return Math.min(1, n / 14 + before * drain)
}
function wellFillBefore(t) {
  // what was in the well just before the pour at t
  const prev = POURS.filter((p) => p < t).pop()
  let n = 0
  for (const tr of TRADES) {
    if (!tr.fee) continue
    const at = tr.T + SLIVER_FLIGHT
    if (at <= t && at > (prev ?? -Infinity)) n++
  }
  return Math.min(1, n / 14)
}

/** the pour: from the well down to the seam between the slices, a 45° diagonal */
export const POUR_CURVE = new THREE.LineCurve3(WELL.clone().add(V(0, -WELL_R * 0.7, 0)), SPLIT_POINT)

// ---- holders ----------------------------------------------------------------------------------

export const HOLDERS = (() => {
  const center = polar(HOLDERS_SLICE.mid, 10.4, -0.25)
  const count = 34
  const radius = 2.35
  const golden = Math.PI * (3 - Math.sqrt(5))
  const nodes = Array.from({ length: count }, (_, i) => {
    const r = radius * Math.sqrt((i + 0.6) / count)
    const a = i * golden + 0.4
    // bigger bags further in, with some noise: a column's height is the holder's balance
    const size = 0.25 + 1.0 * (1 - r / radius) ** 1.4 * (0.6 + 0.8 * rand(i + 40)) + 0.15 * rand(i + 80)
    return { pos: center.clone().add(V(Math.cos(a) * r, 0, Math.sin(a) * r)), size, r }
  })
  return { center, nodes, radius, hub: center.clone().add(V(0, 2.45, 0)), dial: radius + 0.75 }
})()

// ---- the snapshot dial ------------------------------------------------------------------------

/** the dial's hand (radians): idle turn, then a roulette spin that stops on the snapshot */
const SPIN = { from: CUES.holdersReach, omega: 15 }
const STOP = 4.25 // where it lands: an arbitrary, "random" angle
export function handAngle(t) {
  const D = CUES.snapshot - SPIN.from
  const total = (SPIN.omega * D) / 2
  if (t < SPIN.from) return STOP - total - (SPIN.from - t) * 0.6
  if (t < CUES.snapshot) {
    const u = t - SPIN.from
    return STOP - total + SPIN.omega * (u - (u * u) / (2 * D))
  }
  // after the snapshot it creeps on towards the next one
  return STOP + Math.max(0, t - CUES.paid - 0.6) * 0.35
}

/** the green line from the holders slice out to the holders' hub */
export const HOLDERS_CURVE = (() => {
  const a = polar(HOLDERS_SLICE.mid, ROTOR.outer + 0.05, 0.85)
  const out = polar(HOLDERS_SLICE.mid, 1, 0).normalize()
  return new THREE.CubicBezierCurve3(
    a,
    a.clone().addScaledVector(out, 2.6).add(V(0, 2.4, 0)),
    HOLDERS.hub.clone().addScaledVector(out, -2.6).add(V(0, 1.4, 0)),
    HOLDERS.hub,
  )
})()

/** when each holder lights up: filaments leave the hub at CUES.paid and reach the far ones last */
export const HOLDER_REACH = HOLDERS.nodes.map((n, i) => CUES.paid + 0.08 + 0.55 * (n.r / HOLDERS.radius) + 0.06 * rand(i + 300))

// ---- the burn rig -------------------------------------------------------------------------------

export const SUPPLY = (() => {
  const base = polar(BURN_SLICE.mid, 10.0, -0.62)
  return { base, coins: 26, radius: 0.7, thick: 0.09, pitch: 0.118, perBurn: 3 }
})()
/** the furnace hangs up and to the right of the stack, towards the chart */
export const FURNACE = SUPPLY.base.clone().add(V(2.6, 3.7, 1.0))
export const FURNACE_R = 1.1

/** top of the stack (y) for a stack of n coins */
export const stackTop = (n) => SUPPLY.base.y + n * SUPPLY.pitch

/** coins left on the stack at t: each burn lifts SUPPLY.perBurn off the top */
export function coinsLeft(t) {
  let n = SUPPLY.coins
  for (const b of CUES.burns) {
    for (let j = 0; j < SUPPLY.perBurn; j++) if (t >= b + j * 0.07) n--
  }
  return n
}

/** the pink line from the burn slice out to the top of the stack */
export const BURN_CURVE = (() => {
  const a = polar(BURN_SLICE.mid, ROTOR.outer + 0.05, 0.62)
  const out = polar(BURN_SLICE.mid, 1, 0).normalize()
  const top = SUPPLY.base.clone().add(V(0, SUPPLY.coins * SUPPLY.pitch + 0.25, 0))
  return new THREE.CubicBezierCurve3(
    a,
    a.clone().addScaledVector(out, 2.4).add(V(0, 3.0, 0)),
    top.clone().add(V(0.6, 3.4, 0.6)),
    top,
  )
})()

/** a bought coin's path from the stack into the furnace */
export function coinPath(fromY, j) {
  const start = V(SUPPLY.base.x, fromY, SUPPLY.base.z)
  const side = V(0.15 * (j - 1), 0, 0.2 * (j - 1))
  return new THREE.CubicBezierCurve3(
    start,
    start.clone().add(V(0, 1.3, 0)).add(side),
    FURNACE.clone().add(V(-1.2, 0.3, -0.2)).add(side),
    FURNACE,
  )
}

// ---- the flywheel ring ------------------------------------------------------------------------

export const RING = { radius: 3.45, y: 0.5, arcs: 3, gap: 0.55 }

/** the ring's turn (radians, clockwise) at t: it lights at CUES.arrows and is at full speed by the hit */
export function ringAngle(t) {
  const a = CUES.arrows
  const full = 2.6 // rad/s
  if (t < a) return 0
  const spin = CUES.final - a
  if (t < CUES.final) {
    const u = (t - a) / spin
    return full * spin * (u * u * u) * 0.5 * (2 - u) // eases up to full speed
  }
  return full * spin * 0.5 + full * (t - CUES.final)
}
