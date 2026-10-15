// The camera for the flywheel film: one continuous take, as a pure function of time. Keys are
// joined by a cubic Hermite spline with tangents taken over time, so the move stays smooth through
// every key; a key marked `still` has zero velocity (the camera eases in and out of it).
import * as THREE from 'three'
import { WIDTH, HEIGHT, CUES, FPS } from './timeline.js'
import { HOLDERS, SUPPLY, FURNACE, GATE } from './layout.js'

const H = HOLDERS.center
const B = SUPPLY.base
const F = FURNACE

// prettier-ignore
const KEYS = [
  // 0–4: almost straight down on the trades spiralling in to the dark wheel, craning down
  { t: 0.0, pos: [0.3, 16.5, 5.2], target: [0, 0, 0.6], fov: 34, roll: 0.45, still: true },
  { t: 3.3, pos: [3.4, 8.6, 13.4], target: [0, 0.6, 1.4], fov: 32, roll: 0.0 },
  // 4–8: down to the gate as it lights, then up with the slivers to the well
  { t: 5.1, pos: [2.1, 1.25, 8.55], target: [0.15, 0.7, GATE.z], fov: 30, roll: 0 },
  { t: 6.3, pos: [1.7, 1.55, 8.15], target: [0.05, 1.2, GATE.z - 0.3], fov: 30, roll: 0 },
  { t: 7.6, pos: [2.6, 3.9, 10.6], target: [0, 2.7, 1.2], fov: 31, roll: 0 },
  // 8–12: the pour and the split, arcing round the chart as it fills
  { t: 9.2, pos: [-2.6, 6.3, 9.4], target: [-0.2, 1.0, 0.3], fov: 32, roll: 0 },
  { t: 11.2, pos: [2.2, 5.9, 9.6], target: [0.9, 0.8, 0.4], fov: 32, roll: 0 },
  // 12–16: out along the green line to the holders
  { t: 12.8, pos: [H.x - 3.9, 5.0, H.z + 8.8], target: [H.x - 1.5, 0.95, H.z], fov: 32, roll: 0 },
  { t: 15.5, pos: [H.x - 3.4, 4.7, H.z + 8.3], target: [H.x - 1.7, 0.85, H.z], fov: 32, roll: 0 },
  // 16–20: whip across behind the chart to the burn rig
  { t: 16.45, pos: [0.5, 6.4, 6.5], target: [-4.0, 1.4, -1.6], fov: 34, roll: 0.06 },
  { t: 17.0, pos: [B.x + 5.6, 3.1, B.z + 10.4], target: [(B.x + F.x) / 2 + 0.2, 1.75, B.z + 0.5], fov: 32, roll: 0 },
  { t: 19.6, pos: [B.x + 4.6, 2.9, B.z + 9.8], target: [(B.x + F.x) / 2, 1.8, B.z + 0.5], fov: 32, roll: 0 },
  // 20–24: the whole machine, from high and wide
  { t: 21.1, pos: [1.5, 15.5, 19.5], target: [0, -0.4, 0], fov: 38, roll: 0 },
  { t: 23.4, pos: [-1.0, 12.5, 17.0], target: [-0.3, 0, 0], fov: 36, roll: 0 },
  // 24–30: the hero three-quarter view, chart to the right, copy on the left
  { t: 25.0, pos: [-4.4, 6.9, 14.7], target: [-2.6, 0.15, 0], fov: 30, roll: 0 },
  { t: 30.0, pos: [-3.5, 6.2, 13.6], target: [-2.4, 0.2, 0], fov: 30, roll: 0, still: true },
]

function hermite(p0, p1, m0, m1, dt, u) {
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * m1
}

/** tangent at key i for channel `get` (time-weighted Catmull-Rom; zero for still keys) */
function tangent(i, get) {
  const k = KEYS[i]
  if (k.still || i === 0 || i === KEYS.length - 1) return 0
  const a = KEYS[i - 1]
  const b = KEYS[i + 1]
  return (get(b) - get(a)) / (b.t - a.t)
}

function channel(t, get) {
  if (t <= KEYS[0].t) return get(KEYS[0])
  const last = KEYS.length - 1
  if (t >= KEYS[last].t) return get(KEYS[last])
  let i = 0
  while (KEYS[i + 1].t < t) i++
  const a = KEYS[i]
  const b = KEYS[i + 1]
  const dt = b.t - a.t
  return hermite(get(a), get(b), tangent(i, get), tangent(i + 1, get), dt, (t - a.t) / dt)
}

const getters = {
  pos: [0, 1, 2].map((j) => (k) => k.pos[j]),
  target: [0, 1, 2].map((j) => (k) => k.target[j]),
  fov: (k) => k.fov,
  roll: (k) => k.roll,
}

/** camera at time t (seconds): { pos, target, fov, roll } */
export function pose(t) {
  const frame = Math.round(t * FPS)
  const hit = Math.round(CUES.final * FPS)
  // a two-frame jolt on the one big hit
  const jolt = { [hit]: -0.06, [hit + 1]: 0.03, [hit + 2]: -0.01 }[frame] || 0
  const pos = getters.pos.map((g) => channel(t, g))
  const target = getters.target.map((g) => channel(t, g))
  pos[1] += jolt
  target[1] += jolt
  return { pos, target, fov: channel(t, getters.fov), roll: channel(t, getters.roll) }
}

/** a THREE camera posed for time t: for the overlays, which pin labels to things in the scene */
const cam = new THREE.PerspectiveCamera(30, WIDTH / HEIGHT, 0.1, 400)
export function cameraAt(t) {
  const p = pose(t)
  cam.position.set(...p.pos)
  cam.up.set(0, 1, 0)
  cam.lookAt(...p.target)
  cam.rotateZ(p.roll)
  cam.fov = p.fov
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

/** world point → screen pixels { x, y, behind } at time t */
export function project(t, point) {
  const c = cameraAt(t)
  const v = new THREE.Vector3(...(Array.isArray(point) ? point : [point.x, point.y, point.z])).project(c)
  return { x: ((v.x + 1) / 2) * WIDTH, y: ((1 - v.y) / 2) * HEIGHT, behind: v.z > 1 }
}

