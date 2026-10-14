// World layout. One unit = 100 logo units, so the Q is about 4.2 units across.
// The line routes are the homepage Refractor's (src/components/Refractor.jsx), scaled up and
// given depth so the camera can move between them.
import * as THREE from 'three'
import { TAIL_EXIT } from './logoGeometry.js'
import { HOOKS } from '../timeline.js'

export const MARK_SCALE = 0.01
export const FLOOR_Y = -10

/** the Q's counter sits at the origin; the white fee beam arrives here */
export const COUNTER = new THREE.Vector3(0, 0, 0)
export const BEAM_FROM = new THREE.Vector3(-17, 11, -6)

/** middle of the tail slab's outer edge */
export const TAIL = new THREE.Vector3(TAIL_EXIT[0] * MARK_SCALE, TAIL_EXIT[1] * MARK_SCALE, 0)
const OUT = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0) // the edge's outward normal
const ALONG = new THREE.Vector3(Math.SQRT1_2, Math.SQRT1_2, 0) // along the edge

// Refractor.jsx ROUTES relative to its TAIL [425, 372], y flipped, plus depth.
const PX = 0.039
const ROUTES = {
  creator: { c1: [75, 12], c2: [115, 72], end: [165, 86], z: -1.2, slot: 0.25 },
  burn: { c1: [75, -8], c2: [115, 2], end: [165, 4], z: 0.5, slot: 0.085 },
  entangle: { c1: [45, -38], c2: [95, -78], end: [135, -84], z: 1.0, slot: -0.085 },
  fusion: { c1: [15, -48], c2: [35, -112], end: [50, -134], z: 0.3, slot: -0.25 },
}

const v = ([x, y], z) => new THREE.Vector3(x * PX, y * PX, z)

export const LINES = HOOKS.map((hook) => {
  const r = ROUTES[hook.key]
  const start = TAIL.clone().addScaledVector(ALONG, r.slot)
  const c1 = start.clone().addScaledVector(OUT, 0.9).add(v(r.c1, r.z * 0.2).multiplyScalar(0.5))
  const c2 = TAIL.clone().add(v(r.c2, r.z * 0.7))
  const end = TAIL.clone().add(v(r.end, r.z))
  return { hook, curve: new THREE.CubicBezierCurve3(start, c1, c2, end), end }
})

export const LINE = Object.fromEntries(LINES.map((l) => [l.hook.key, l]))

/** separate sets for the tunnel and the end card, away from the Refractor */
export const TUNNEL = new THREE.Vector3(0, 90, -80)
export const END = new THREE.Vector3(140, -6.9, 0)
