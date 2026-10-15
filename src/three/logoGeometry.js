// The Q-Pad mark as bevelled 3D geometry, built from the brand SVG paths (ported from the ad
// studio, ad/src/scene/logoGeometry.js). The hairline gap between the Q and its tail is cut the way
// the SVG mask cuts it: the tail slab grown by half the mask's stroke width (mitred) and subtracted
// from the body.
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

function extrude(multi, { depth, bevel, offset = [0, 0], segments = 8 }) {
  const g = new THREE.ExtrudeGeometry(toShapes(multi), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8,
    bevelSegments: segments,
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
/** where the four lines leave the tail, relative to the counter, in SVG units (y up) */
export const TAIL_EXIT = [tailOuter[0] - COUNTER[0], tailOuter[1] - COUNTER[1]]

/** SVG units → world units used by the site's scenes (the Q is about 4.1 across) */
export const MARK_UNIT = 0.01

/**
 * The mark with a deep, round bevel for liquid glass: { body, tail } geometries in SVG units,
 * counter at the origin, centred on z. Scale by MARK_UNIT to place it in a scene.
 */
export function glassMarkGeometry({ depth = 70, bevel = 34, segments = 20 } = {}) {
  const body = clip.difference(fill(LOGO.mark.body, 'evenodd'), [
    grow(markTailRing, LOGO.mark.gap / 2),
  ])
  const opts = { depth, bevel, segments, offset: COUNTER }
  return { body: extrude(body, opts), tail: extrude([[markTailRing]], opts) }
}
