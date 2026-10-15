// The fee flywheel's layout and shapes, in world units. The camera, chart and ring match the ad
// studio still (ad/src/social/Flywheel.jsx) that public/art/flywheel-*.webp was rendered from, so
// the live scene fades in over that image without the chart jumping.
import * as THREE from 'three'

export const CAMERA = { pos: [0.4, 5.2, 10.6], target: [0.9, 0.2, 0], fov: 30 }
/** The render's frame (the card's wide layout): every label position is a share of it. */
export const ASPECT = 16 / 9

/** The chart: centre, radii, and slices (share, colour, height), clockwise from the back. */
export const PIE = {
  center: [2.7, 0, 0],
  inner: 1.05,
  outer: 2.55,
  gap: 0.14,
  ring: 3.2,
  ringY: 0.4,
  slices: [
    { key: 'holders', share: 0.6, color: '#12C26E', light: '#8dffc6', depth: 0.95 },
    { key: 'burn', share: 0.4, color: '#FF3EA5', light: '#ffb0d6', depth: 0.7 },
  ],
}

/** Start/end angles (shape space, radians) for each slice, clockwise from the back (θ = 90°). */
export function sliceAngles() {
  let at = Math.PI / 2
  return PIE.slices.map((s) => {
    const end = at
    const start = at - s.share * Math.PI * 2
    at = start
    return { ...s, start, end, mid: (start + end) / 2 }
  })
}

/** Shape-space angle → chart-local point (the shape's y runs along -z once the slice lies flat). */
export const onChart = (angle, radius, y) =>
  new THREE.Vector3(Math.cos(angle) * radius, y, -Math.sin(angle) * radius)

/** One slice: an annular sector extruded upwards with a round bevel. */
export function sliceGeometry(start, end, depth, bevel = 0.2) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, PIE.outer, start, end, false)
  shape.absarc(0, 0, PIE.inner, end, start, true)
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8,
    bevelSegments: 12,
    curveSegments: 128,
  })
  g.translate(0, 0, bevel)
  g.rotateX(-Math.PI / 2) // lie flat: extrusion becomes height, shape y becomes -z
  g.computeVertexNormals()
  return g
}

/**
 * The flywheel's three arcs, clockwise from above, each ending in an arrowhead. `basis` turns an
 * arrowhead (a cone along +y) to point along the arc, lying flat in the ring's plane.
 */
export function ringArcs({ radius = PIE.ring, y = PIE.ringY, arcs = 3, gap = 0.34 } = {}) {
  const out = []
  const span = (Math.PI * 2) / arcs
  for (let i = 0; i < arcs; i++) {
    // clockwise from above = decreasing θ; each arc runs from a0 down to a1
    const a0 = Math.PI / 2 + 0.5 - i * span
    const a1 = a0 - span + gap
    const pts = []
    for (let k = 0; k <= 96; k++) pts.push(onChart(a0 + ((a1 - a0) * k) / 96, radius, y))
    const tangent = new THREE.Vector3(Math.sin(a1), 0, Math.cos(a1)).normalize()
    const inward = onChart(a1, -1, 0)
    const basis = new THREE.Matrix4().makeBasis(inward, tangent, new THREE.Vector3(0, 1, 0))
    out.push({
      curve: new THREE.CatmullRomCurve3(pts),
      tip: onChart(a1, radius, y).addScaledVector(tangent, 0.17),
      quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
    })
  }
  return out
}

/** Where the fee gathers: the middle of the chart's hole. */
export const HUB = new THREE.Vector3(0, 0.42, 0)

/**
 * Trades leave the flywheel as white light: each jumps off the ring at the back of the chart,
 * arcs over the glass and drops into the hub (kept low enough to pass under the 7% label).
 */
export function tradeCurves() {
  return [
    [Math.PI * 0.5, 1.45],
    [Math.PI * 0.18, 1.25],
    [Math.PI * 0.82, 1.3],
    [Math.PI * -0.06, 1.15],
  ].map(
    ([a, peak]) =>
      new THREE.CubicBezierCurve3(
        onChart(a, PIE.ring, PIE.ringY),
        onChart(a, PIE.ring * 0.72, peak),
        onChart(a, 0.85, peak + 0.25),
        HUB.clone(),
      ),
  )
}

/** From the hub, up and out over a slice, and down into its glass (ending inside it). */
export function splitCurve(angle, top) {
  return new THREE.CubicBezierCurve3(
    HUB.clone(),
    HUB.clone().setY(HUB.y + 1.3),
    onChart(angle, 1.55, top + 0.95),
    onChart(angle, 1.8, top - 0.35),
  )
}
