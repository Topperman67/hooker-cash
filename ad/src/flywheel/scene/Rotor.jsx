// The flywheel itself: the glass donut chart from the home page, 60% holders and 40% buyback &
// burn. It starts as dark, empty glass; at the split two light fronts run round it from the seam
// (green one way, pink the other, at the same speed) and fill each slice behind them. Then light
// comets lap the slices, faster and faster, while the chart keeps still enough to read.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { ROTOR, SLICES, SEAM, fillOf, polar, ringAngle } from '../layout.js'
import { CUES } from '../timeline.js'
import { prog, ease } from '../../anim.js'
import { makeSprites, hdr } from './fx.js'

function sliceGeometry(start, end, depth, bevel = 0.2) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, ROTOR.outer, start, end, false)
  shape.absarc(0, 0, ROTOR.inner, end, start, true)
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8,
    bevelSegments: 10,
    curveSegments: 120,
  })
  g.translate(0, 0, bevel)
  g.rotateX(-Math.PI / 2) // lie flat: extrusion becomes height, shape y becomes −z
  g.computeVertexNormals()
  return g
}

/** Luminous glass that only shows the part of the slice the light has reached: physical
 *  transmission for the see-through, plus a fresnel rim and a glow that rises to the top face. */
export function sliceMaterial(s, uniforms, { ghost = false } = {}) {
  const m = ghost
    ? // the unlit flywheel: dark cobalt glass with a cool rim, waiting for the light
      new THREE.MeshPhysicalMaterial({
        color: '#141c55',
        emissive: '#0a1238',
        emissiveIntensity: 1,
        metalness: 0.15,
        roughness: 0.32,
        clearcoat: 0.6,
        clearcoatRoughness: 0.22,
        envMapIntensity: 0.9,
      })
    : new THREE.MeshPhysicalMaterial({
        color: s.light,
        emissive: s.color,
        emissiveIntensity: 0.62,
        metalness: 0,
        roughness: 0.14,
        transmission: 1,
        thickness: 1.1,
        ior: 1.35,
        attenuationColor: new THREE.Color(s.color),
        attenuationDistance: 4.5,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        specularIntensity: 1,
        envMapIntensity: 1.5,
      })
  const rim = ghost ? new THREE.Color('#5c76ff') : new THREE.Color(s.light).lerp(new THREE.Color('#ffffff'), 0.35)
  const all = {
    ...uniforms,
    uRim: { value: rim },
    uRimGain: uniforms.uRimGain ?? { value: 1.4 },
    uDepth: { value: s.depth },
    uGlow: { value: ghost ? new THREE.Color('#000000') : new THREE.Color(s.color) },
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, all)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vLocal;\nuniform float uFill, uFrom, uDir, uSpan, uRimGain, uDepth;\nuniform vec3 uRim, uGlow;',
      )
      .replace(
        'void main() {',
        `void main() {
          float th = atan(-vLocal.z, vLocal.x);
          float a = mod((th - uFrom) * uDir + 12.566370614, 6.283185307);
          if (${ghost ? 'a <= uFill * uSpan + 0.002' : 'a > uFill * uSpan + 0.002'}) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
          float fres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.6);
          totalEmissiveRadiance += uRim * fres * uRimGain;
          totalEmissiveRadiance += uGlow * smoothstep(0.0, uDepth, vLocal.y) * 0.35;`,
      )
  }
  m.customProgramCacheKey = () => (ghost ? 'flywheel-slice-ghost' : 'flywheel-slice')
  return m
}

const COMETS = 3
const TAIL = 46

/** which slice a ring angle falls in */
function sliceAt(th) {
  const a = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  return SLICES.findIndex((s) => {
    const lo = ((s.start % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
    return ((a - lo + Math.PI * 2) % (Math.PI * 2)) <= s.span
  })
}

/** when a slice's light front has gone all the way round it */
const filledAt = (s) => CUES.fill.from + (s.span / SLICES[0].span) * (CUES.fill.to - CUES.fill.from)

export function Rotor({ t }) {
  const parts = useMemo(
    () =>
      SLICES.map((s) => {
        // the fill runs away from the seam: green counter-clockwise from its start, pink
        // clockwise from its end
        const fromStart = Math.abs(s.start - SEAM) < 1e-6
        const uniforms = {
          uFill: { value: 0 },
          uFrom: { value: fromStart ? s.start : s.end },
          uDir: { value: fromStart ? 1 : -1 },
          uSpan: { value: s.span },
        }
        const geometry = sliceGeometry(s.start, s.end, s.depth)
        const material = sliceMaterial(s, uniforms)
        const ghost = sliceMaterial(s, { ...uniforms, uRimGain: { value: 0.9 } }, { ghost: true })
        const front = new THREE.MeshBasicMaterial({ color: hdr(s.light, 4, 0.3), transparent: true })
        return { s, fromStart, uniforms, geometry, material, ghost, front, offset: polar(s.mid, ROTOR.gap, 0) }
      }),
    [],
  )
  const comets = useMemo(() => makeSprites(COMETS * TAIL), [])
  const colors = useMemo(() => SLICES.map((s) => hdr(s.light, 3.0, 0.08)), [])

  // comets: once the chart is full, light laps the whole wheel clockwise, taking each slice's
  // colour as it crosses into it, faster and faster
  useLayoutEffect(() => {
    comets.clear()
    const on = ease.out(prog(t, CUES.spin, CUES.spin + 0.8))
    if (on > 0) {
      const r = (ROTOR.inner + ROTOR.outer) / 2
      const u = t - CUES.spin
      const turn = u * 1.1 + u * u * 0.04 + ringAngle(t) * 0.6
      const tmp = new THREE.Vector3()
      for (let c = 0; c < COMETS; c++) {
        for (let k = 0; k < TAIL; k++) {
          const th = SEAM - turn - (c / COMETS) * Math.PI * 2 + k * 0.026
          const si = sliceAt(th)
          if (si < 0) continue
          const s = SLICES[si]
          tmp.copy(polar(th, r, s.depth + 0.015)).add(parts[si].offset)
          const fade = (1 - k / TAIL) ** 1.5
          comets.set(c * TAIL + k, tmp, 0.13 * (1 - 0.5 * (k / TAIL)), colors[si], fade * on)
        }
      }
    }
    comets.commit()
  }, [t, parts, comets, colors])

  const r = (ROTOR.inner + ROTOR.outer) / 2
  return (
    <group>
      {parts.map((p) => {
        const fill = fillOf(p.s, t)
        p.uniforms.uFill.value = fill
        const frontAngle = p.fromStart ? p.s.start + fill * p.s.span : p.s.end - fill * p.s.span
        p.front.opacity = fill <= 0 ? 0 : fill < 1 ? 1 : Math.max(0, 1 - (t - filledAt(p.s)) * 3)
        return (
          <group key={p.s.key} position={p.offset}>
            <mesh geometry={p.geometry} material={p.material} visible={fill > 0} />
            <mesh geometry={p.geometry} material={p.ghost} visible={fill < 1} renderOrder={-1} />
            {/* the light front: a bright radial blade where the fill has got to */}
            <mesh material={p.front} position={polar(frontAngle, r, p.s.depth / 2)} rotation={[0, frontAngle, 0]} visible={p.front.opacity > 0.01}>
              <boxGeometry args={[ROTOR.outer - ROTOR.inner + 0.06, p.s.depth + 0.06, 0.035]} />
            </mesh>
          </group>
        )
      })}
      <primitive object={comets.points} />
    </group>
  )
}
