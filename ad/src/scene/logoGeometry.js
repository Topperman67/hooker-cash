// Turns the brand SVG paths into bevelled 3D geometry. The hairline gap between the Q and its
// tail is cut exactly as the SVG mask cuts it: the tail slab grown by half the mask's stroke
// width (mitred) and subtracted from the body.
import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import clip from 'polygon-clipping'
import LOGO from './logo-data.js'

const loader = new SVGLoader()

// One SVG path → closed rings of [x, y], with y flipped so up is up.
function rings(d) {
  const { paths } = loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`)
  return paths[0].subPaths.map((sp) => {
    const pts = sp.getPoints(24).map((p) => [p.x, -p.y])
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (a[0] !== b[0] || a[1] !== b[1]) pts.push([a[0], a[1]])
    return pts
  })
}

const fill = (d, rule) => {
  const polys = rings(d).map((r) => [r])
  return rule === 'evenodd' ? clip.xor(...polys) : clip.union(...polys)
}

// Offset a convex ring outwards by r with mitred corners (an SVG miter stroke of width 2r).
function grow(ring, r) {
  const pts = ring.slice(0, -1)
  const n = pts.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % n]
    area += x1 * y2 - x2 * y1
  }
  const s = area > 0 ? 1 : -1
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n]
    const dx = q[0] - p[0]
    const dy = q[1] - p[1]
    const len = Math.hypot(dx, dy)
    return { p: [p[0] + (s * dy * r) / len, p[1] - (s * dx * r) / len], d: [dx, dy] }
  })
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
  const out = pts.map((_, i) => {
    const A = lines[(i - 1 + n) % n]
    const B = lines[i]
    const t = cross([B.p[0] - A.p[0], B.p[1] - A.p[1]], B.d) / cross(A.d, B.d)
    return [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t]
  })
  out.push([...out[0]])
  return out
}

function toShapes(multi) {
  const v = (ring) => ring.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y))
  return multi.map(([outer, ...holes]) => {
    const shape = new THREE.Shape(v(outer))
    shape.holes = holes.map((h) => new THREE.Path(v(h)))
    return shape
  })
}

function extrude(multi, { depth, bevel, offset = [0, 0] }) {
  const g = new THREE.ExtrudeGeometry(toShapes(multi), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8,
    bevelSegments: 8,
    curveSegments: 24,
  })
  g.translate(-offset[0], -offset[1], -depth / 2)
  const smooth = toCreasedNormals(g, Math.PI / 5)
  g.dispose()
  smooth.computeBoundingBox()
  return smooth
}

const bboxCenter = (ring) => {
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

// ---- the mark ------------------------------------------------------------------------------

const markRings = rings(LOGO.mark.body)
const markTailRing = rings(LOGO.mark.tail)[0]
/** centre of the Q's counter, in SVG units (y up). The 3D mark is centred here. */
export const COUNTER = bboxCenter(markRings[1])
// The tail's outer edge is the side of the slab farthest from the counter.
const tailOuter = (() => {
  const pts = markTailRing.slice(0, -1)
  const d = (p) => Math.hypot(p[0] - COUNTER[0], p[1] - COUNTER[1])
  const far = [...pts].sort((a, b) => d(b) - d(a)).slice(0, 2)
  return [(far[0][0] + far[1][0]) / 2, (far[0][1] + far[1][1]) / 2]
})()
/** where the four lines leave the tail, relative to the counter, in SVG units */
export const TAIL_EXIT = [tailOuter[0] - COUNTER[0], tailOuter[1] - COUNTER[1]]

let markCache
/** { body, tail } geometries in SVG units, counter at the origin */
export function markGeometry() {
  if (markCache) return markCache
  const body = clip.difference(fill(LOGO.mark.body, 'evenodd'), [grow(markTailRing, LOGO.mark.gap / 2)])
  const opts = { depth: 64, bevel: 10, offset: COUNTER }
  markCache = { body: extrude(body, opts), tail: extrude([[markTailRing]], opts) }
  return markCache
}

// ---- the wordmark --------------------------------------------------------------------------

let wordCache
/** one geometry per letter (Q first) plus the Q's tail, in wordmark units (y up, top-left at 0,0) */
export function wordmarkGeometry() {
  if (wordCache) return wordCache
  const tailRing = rings(LOGO.wordmark.tail)[0]
  const gap = [grow(tailRing, LOGO.wordmark.gap / 2)]
  const opts = { depth: 30, bevel: 2.4 }
  // the SVG masks the whole letter group, so cut every letter (in practice the Q and the U's edge)
  const letters = LOGO.wordmark.letters
    .map(({ d, rule }) => clip.difference(fill(d, rule), gap))
    .filter((shape) => shape.length)
    .map((shape) => extrude(shape, opts))
  wordCache = { letters, tail: extrude([[tailRing]], opts) }
  return wordCache
}

export const LOCKUP = LOGO.lockup
