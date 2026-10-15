// Cheap light for a CPU renderer: additive point sprites (trails, embers, sparks, dust) sized in
// world units, and light-line tubes that can draw themselves on. Colours are HDR (above 1 blooms).
import * as THREE from 'three'

/** pixels per world unit at distance 1, shared by every sprite pool; the camera sets it */
export const spriteScale = { value: 540 }

const SPRITE_VERT = /* glsl */ `
  attribute float size;
  attribute vec4 tint;
  uniform float scale;
  varying vec4 vTint;
  void main() {
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.05, -mv.z);
    if (tint.a <= 0.0) gl_PointSize = 0.0;
    gl_Position = projectionMatrix * mv;
  }
`
const SPRITE_FRAG = /* glsl */ `
  uniform float hardness;
  varying vec4 vTint;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);
    if (d > 1.0) discard;
    float core = exp(-d * hardness);
    float soft = (1.0 - d) * (1.0 - d);
    gl_FragColor = vec4(vTint.rgb * (core * 0.75 + soft * 0.25) * vTint.a, 1.0);
  }
`

/** A pool of `count` additive sprites. Call clear(), then set(i, pos, size, color, alpha) for the
 *  ones to show this frame (alpha 0 hides one), then commit(). */
export function makeSprites(count, { hardness = 3.2, depthTest = true } = {}) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(count * 3)
  const size = new Float32Array(count)
  const tint = new Float32Array(count * 4)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('size', new THREE.BufferAttribute(size, 1))
  geo.setAttribute('tint', new THREE.BufferAttribute(tint, 4))
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPRITE_VERT,
    fragmentShader: SPRITE_FRAG,
    uniforms: { scale: spriteScale, hardness: { value: hardness } },
    transparent: true,
    depthWrite: false,
    depthTest,
    blending: THREE.AdditiveBlending,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  return {
    points,
    count,
    clear() {
      tint.fill(0)
    },
    set(i, p, s, c, a = 1) {
      pos[i * 3] = p.x
      pos[i * 3 + 1] = p.y
      pos[i * 3 + 2] = p.z
      size[i] = s
      tint[i * 4] = c.r
      tint[i * 4 + 1] = c.g
      tint[i * 4 + 2] = c.b
      tint[i * 4 + 3] = a
    },
    commit() {
      geo.attributes.position.needsUpdate = true
      geo.attributes.size.needsUpdate = true
      geo.attributes.tint.needsUpdate = true
    },
  }
}

/** an HDR colour: hex lifted towards white by `white`, times `gain` */
export function hdr(hex, gain = 1, white = 0) {
  return new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), white).multiplyScalar(gain)
}

/** A light line along `curve`: a hot core, a halo and a faint wide spill (bloom does the rest).
 *  Returns meshes plus reveal(a, b) to show only the stretch between fractions a and b. */
export function makeLine(curve, { radius = 0.03, color = '#ffffff', glow = 2.6, white = 0.25, halo = 0.16, spill = 0.03, segments = 200 } = {}) {
  const c = new THREE.Color(color)
  const radial = 10
  const geos = [radius, radius * 3.2, radius * 12].map((r) => new THREE.TubeGeometry(curve, segments, r, radial, false))
  const mats = [
    new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color('#fff'), white).multiplyScalar(glow), transparent: true }),
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: halo, depthWrite: false }),
    new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: spill, depthWrite: false, blending: THREE.AdditiveBlending }),
  ]
  const base = [1, halo, spill]
  const group = new THREE.Group()
  geos.forEach((g, i) => {
    if (i === 2 && spill <= 0) return
    const m = new THREE.Mesh(g, mats[i])
    m.frustumCulled = false
    group.add(m)
  })
  const per = radial * 6
  return {
    group,
    /** show the stretch [a, b] (fractions along the curve), at overall opacity k */
    reveal(a = 0, b = 1, k = 1) {
      const s0 = Math.max(0, Math.min(segments, Math.floor(a * segments)))
      const s1 = Math.max(s0, Math.min(segments, Math.ceil(b * segments)))
      geos.forEach((g) => g.setDrawRange(s0 * per, (s1 - s0) * per))
      mats.forEach((m, i) => (m.opacity = base[i] * k))
      group.visible = k > 0.001 && s1 > s0
    },
  }
}
