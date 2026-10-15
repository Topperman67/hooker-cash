// The finale: the buyback & burn arrows. Three comet arcs of pink light with white-hot arrowheads
// draw themselves round the flywheel, spin up to speed on the hit and keep circling, shedding
// embers, with faint shutter ghosts behind them for speed.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { RING, ringAngle, polar } from '../layout.js'
import { CUES, COLORS } from '../timeline.js'
import { prog, ease, rand } from '../../anim.js'
import { makeSprites, hdr } from './fx.js'

const SPAN = (Math.PI * 2) / RING.arcs
const LEN = SPAN - RING.gap
const GHOSTS = [
  { lag: 0.05, k: 0.32 },
  { lag: 0.1, k: 0.16 },
  { lag: 0.16, k: 0.07 },
]
const SPARK_RATE = 46 // per arrow per second
const SPARK_LIFE = 0.75

/** a comet arc as tapered tube geometry: thin, dim tail → full, bright head (vertex colours) */
function cometGeometry(a0, radius, tube, color, tailWhite = 0) {
  const pts = []
  for (let k = 0; k <= 120; k++) {
    const a = a0 - (LEN * k) / 120 // runs clockwise
    pts.push(polar(a, radius, 0))
  }
  const curve = new THREE.CatmullRomCurve3(pts)
  const segs = 160
  const radial = 12
  const g = new THREE.TubeGeometry(curve, segs, tube, radial, false)
  const pos = g.attributes.position
  const colors = new Float32Array(pos.count * 3)
  const p = new THREE.Vector3()
  const v = new THREE.Vector3()
  const head = hdr(color, 1, 0)
  const tail = hdr(color, 1, tailWhite)
  for (let i = 0; i <= segs; i++) {
    const u = i / segs // 0 = tail, 1 = head
    curve.getPointAt(u, p)
    const taper = 0.18 + 0.82 * u ** 0.8
    const bright = 0.08 + 0.92 * u ** 1.6
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j
      v.fromBufferAttribute(pos, idx).sub(p).multiplyScalar(taper).add(p)
      pos.setXYZ(idx, v.x, v.y, v.z)
      const c = tail.clone().lerp(head, u).multiplyScalar(bright)
      colors.set([c.r, c.g, c.b], idx * 3)
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return { geometry: g, curve, segs, radial }
}

export function Ring({ t }) {
  const arcs = useMemo(() => {
    const coreMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const haloMat = coreMat.clone()
    const tipMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const out = []
    for (let i = 0; i < RING.arcs; i++) {
      const a0 = Math.PI / 2 + 0.5 - i * SPAN
      const core = cometGeometry(a0, RING.radius, 0.06, hdr(COLORS.burnLight, 4.4, 0.3), 0)
      const halo = cometGeometry(a0, RING.radius, 0.22, hdr(COLORS.burn, 0.9), 0)
      const a1 = a0 - LEN
      const tangent = new THREE.Vector3(Math.sin(a1), 0, Math.cos(a1)) // clockwise
      out.push({
        a0,
        a1,
        core,
        halo,
        tip: polar(a1, RING.radius, 0).addScaledVector(tangent, 0.2),
        quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent),
      })
    }
    return { out, coreMat, haloMat, tipMat }
  }, [])
  const sparks = useMemo(() => makeSprites(RING.arcs * Math.ceil(SPARK_RATE * SPARK_LIFE) + 8), [])
  const flat = useMemo(
    () => ({
      track: new THREE.MeshBasicMaterial({ color: hdr(COLORS.burn, 0.6), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      wave: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    }),
    [],
  )
  const ghosts = useMemo(() => GHOSTS.map(() => ({ core: arcs.coreMat.clone(), tip: arcs.tipMat.clone() })), [arcs])

  const draw = ease.inOut(prog(t, CUES.arrows, CUES.arrows + 0.7)) // light runs round each arc
  const on = draw > 0 ? 1 : 0
  const turn = ringAngle(t)
  const speed = (ringAngle(t + 0.01) - turn) / 0.01
  const hit = t >= CUES.final ? Math.exp(-(t - CUES.final) * 3) : 0

  useLayoutEffect(() => {
    // draw-on: show each arc from its tail up to `draw`
    for (const a of arcs.out) {
      for (const part of [a.core, a.halo]) {
        const per = part.radial * 6
        part.geometry.setDrawRange(0, Math.ceil(draw * part.segs) * per)
      }
    }
    flat.track.opacity = 0.35 * draw
    const w = prog(t, CUES.final, CUES.final + 0.9)
    flat.wave.color.copy(hdr(COLORS.burnLight, 2.4 * (1 - w) ** 2, 0.3))
    arcs.coreMat.opacity = on
    arcs.haloMat.opacity = on * (0.8 + 0.6 * hit)
    arcs.tipMat.color.copy(hdr('#ffd6ea', 5 + 6 * hit))
    arcs.tipMat.opacity = ease.out(prog(draw, 0.85, 1))
    const blur = Math.min(1, speed / 2.4)
    ghosts.forEach((g, i) => {
      g.core.opacity = on * GHOSTS[i].k * blur
      g.tip.color.copy(arcs.tipMat.color)
      g.tip.opacity = arcs.tipMat.opacity * GHOSTS[i].k * blur
    })

    // embers flung off the arrowheads, born on a fixed clock so every frame agrees
    sparks.clear()
    const pinkHot = hdr(COLORS.burnLight, 3, 0.2)
    const white = hdr('#ffffff', 3.4)
    const p = new THREE.Vector3()
    let n = 0
    if (t > CUES.arrows + 0.6) {
      const first = Math.ceil((t - SPARK_LIFE) * SPARK_RATE)
      const last = Math.floor(t * SPARK_RATE)
      for (let e = first; e <= last; e++) {
        const born = e / SPARK_RATE
        if (born < CUES.arrows + 0.6) continue
        const age = t - born
        for (let i = 0; i < RING.arcs; i++) {
          const seed = e * 7 + i * 3
          const head = arcs.out[i].a1 - ringAngle(born)
          const out = polar(head, 1, 0) // outward
          const back = new THREE.Vector3(-Math.sin(head), 0, -Math.cos(head)) // against the spin
          p.copy(polar(head, RING.radius, RING.y))
            .addScaledVector(out, age * (0.4 + 1.1 * rand(seed)))
            .addScaledVector(back, age * (0.6 + 0.8 * rand(seed + 1)))
          p.y += age * (0.5 + 0.9 * rand(seed + 2)) - 0.9 * age * age
          const life = 1 - age / SPARK_LIFE
          sparks.set(n++, p, 0.06 + 0.08 * rand(seed + 3), rand(seed + 4) < 0.25 ? white : pinkHot, life * life * Math.min(1, speed / 1.5))
        }
      }
    }
    sparks.commit()
  }, [t, arcs, ghosts, sparks, flat, draw, on, hit, speed])

  if (!on) return null
  return (
    <group position-y={RING.y}>
      <group rotation-y={-turn}>
        {arcs.out.map((a, i) => (
          <group key={i}>
            <mesh geometry={a.halo.geometry} material={arcs.haloMat} />
            <mesh geometry={a.core.geometry} material={arcs.coreMat} />
            <mesh position={a.tip} quaternion={a.quat} material={arcs.tipMat}>
              <coneGeometry args={[0.24, 0.6, 32]} />
            </mesh>
          </group>
        ))}
      </group>
      {/* shutter ghosts, trailing the spin */}
      {GHOSTS.map((gh, gi) => (
        <group key={gi} rotation-y={-turn + gh.lag * Math.min(1, speed / 2.4)}>
          {arcs.out.map((a, i) => (
            <group key={i}>
              <mesh geometry={a.core.geometry} material={ghosts[gi].core} />
            </group>
          ))}
        </group>
      ))}
      <mesh material={flat.track} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[RING.radius - 0.012, RING.radius + 0.012, 256]} />
      </mesh>
      {t >= CUES.final && t < CUES.final + 0.9 && (
        <mesh material={flat.wave} rotation-x={-Math.PI / 2} scale={1 + 1.6 * ease.out(prog(t, CUES.final, CUES.final + 0.9))}>
          <ringGeometry args={[RING.radius - 0.05, RING.radius + 0.05, 256]} />
        </mesh>
      )}
      <group position-y={-RING.y}>
        <primitive object={sparks.points} />
      </group>
    </group>
  )
}
