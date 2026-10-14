// The white beam of creator fees: a hot core, two soft volumetric shells, a travelling head in
// the opening shot, dust motes that catch it, and the white pulses of shot 4.
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useCurrentFrame } from 'remotion'
import { FPS, CUES } from '../timeline.js'
import { prog, ease, rand } from '../anim.js'
import { BEAM_FROM, COUNTER } from './layout.js'
import { glow, dotTexture } from './materials.js'

const AXIS = COUNTER.clone().sub(BEAM_FROM)
const LENGTH = AXIS.length()
const DIR = AXIS.clone().normalize()
const QUAT = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), DIR)

const shellMaterial = (strength, power) =>
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { strength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vY = uv.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float strength; varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        float f = pow(abs(dot(vN, vV)), ${power.toFixed(1)});
        float ends = smoothstep(0.0, 0.08, vY) * smoothstep(1.0, 0.97, vY);
        vec3 c = vec3(0.93, 0.96, 1.0) * f * strength * ends;
        gl_FragColor = vec4(c, 1.0);
      }`,
  })

/** where the beam's head is: it draws itself from 0.5 s and strikes the Q on the 4.0 downbeat */
export const beamReach = (t) => ease.inOut(prog(t, CUES.ignite, CUES.reveal))

const DUST = 700

export function Beam() {
  const frame = useCurrentFrame()
  const t = frame / FPS
  const reach = beamReach(t)
  const visible = t < 20 && reach > 0

  const mats = useMemo(
    () => ({ core: glow('#ffffff', 5), inner: shellMaterial(0.55, 3), outer: shellMaterial(0.16, 2) }),
    [],
  )
  const head = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: dotTexture(),
        color: new THREE.Color(5, 5, 5.4),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  )

  // dust motes scattered around the beam's axis
  const dust = useMemo(() => {
    const ref = Math.abs(DIR.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
    const u = new THREE.Vector3().crossVectors(DIR, ref).normalize()
    const w = new THREE.Vector3().crossVectors(DIR, u).normalize()
    const seeds = Array.from({ length: DUST }, (_, i) => ({
      s: rand(i * 7 + 1),
      r: 2.2 * Math.sqrt(rand(i * 7 + 2)),
      a: rand(i * 7 + 3) * Math.PI * 2,
      ph: rand(i * 7 + 4) * Math.PI * 2,
      sp: 0.2 + rand(i * 7 + 5) * 0.5,
      tw: 0.5 + rand(i * 7 + 6),
    }))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3))
    const mat = new THREE.PointsMaterial({
      size: 0.05,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    return { geo, mat, seeds, u, w }
  }, [])

  const pointsRef = useRef()
  useLayoutEffect(() => {
    const { geo, seeds, u, w } = dust
    const pos = geo.attributes.position.array
    const col = geo.attributes.color.array
    // dust only reads against the dark studios
    const dark = t < 4 ? 1 : t < 4.9 ? 1 - prog(t, 4, 4.9) : t >= 8 && t < 20 ? 0.45 : 0
    const p = new THREE.Vector3()
    seeds.forEach((d, i) => {
      const drift = t * d.sp
      const r = d.r + 0.15 * Math.sin(drift + d.ph)
      const a = d.a + 0.1 * drift
      p.copy(BEAM_FROM)
        .addScaledVector(DIR, ((d.s + 0.012 * drift) % 1) * LENGTH)
        .addScaledVector(u, Math.cos(a) * r)
        .addScaledVector(w, Math.sin(a) * r)
      p.y += 0.12 * Math.sin(drift * 0.7 + d.ph)
      pos.set([p.x, p.y, p.z], i * 3)
      const along = d.s <= reach ? 1 : 0
      const lit = Math.exp(-((r / 0.9) ** 2)) * along
      const twinkle = 0.6 + 0.4 * Math.sin(t * 3 * d.tw + d.ph)
      const b = (0.05 + 1.6 * lit) * twinkle * dark
      col.set([b, b, b * 1.05], i * 3)
    })
    geo.attributes.position.needsUpdate = true
    geo.attributes.color.needsUpdate = true
  }, [frame, dust, reach, t])

  // white pulses on each bar of shot 4
  const pulses = CUES.pulses
    .map((at) => prog(t, at, at + 0.5))
    .filter((q) => q > 0 && q < 1)
    .map((q) => BEAM_FROM.clone().addScaledVector(DIR, ease.in(q) * LENGTH))

  const len = Math.max(0.001, reach * LENGTH)
  const mid = BEAM_FROM.clone().addScaledVector(DIR, len / 2)
  const tip = BEAM_FROM.clone().addScaledVector(DIR, len)
  const flare = t < CUES.reveal ? 1 : Math.max(0, 1 - (t - CUES.reveal) * 3)

  return (
    <group>
      <points ref={pointsRef} geometry={dust.geo} material={dust.mat} visible={t < 20} frustumCulled={false} />
      <group visible={visible} position={mid} quaternion={QUAT} scale={[1, len, 1]}>
        <mesh material={mats.core}>
          <cylinderGeometry args={[0.022, 0.022, 1, 12, 1, true]} />
        </mesh>
        <mesh material={mats.inner}>
          <cylinderGeometry args={[0.16, 0.16, 1, 48, 1, true]} />
        </mesh>
        <mesh material={mats.outer}>
          <cylinderGeometry args={[0.6, 0.6, 1, 48, 1, true]} />
        </mesh>
      </group>
      {flare > 0 && reach > 0 && (
        <sprite material={head} position={tip} scale={0.8 + flare * 0.5} />
      )}
      {pulses.map((p, i) => (
        <sprite key={i} material={head} position={p} scale={1.1} />
      ))}
    </group>
  )
}
