// Trades: streaks of white light that spiral in out of the dark and race round the track. On the
// front of the track they pass through the gate, a chrome ring with a sheet of light across it.
// Once the gate is lit, the sheet slices the fee off every trade that passes: a white-hot sliver
// that tumbles up and away into the well.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { TRADES, tradeAt, sliverCurve, GATE, SLIVER_FLIGHT, TRADE_PRE, TRADE_POST } from '../layout.js'
import { CUES } from '../timeline.js'
import { prog, ease } from '../../anim.js'
import { makeSprites, hdr } from './fx.js'

const SLOTS = 64 // trades on screen at once, at most
const TRAIL = 30
const SLIVERS = 24

const ICE = hdr('#dfe5ff', 2.6, 0.2)
const HALO = hdr('#5c76ff', 1.2)
const HOT = hdr('#ffffff', 5)

/** how hard the gate is flashing at t: a spike on every slice */
export function gateFlash(t) {
  let g = 0
  for (const tr of TRADES) {
    if (!tr.fee || tr.T > t || t - tr.T > 0.6) continue
    g += Math.exp(-(t - tr.T) * 11)
  }
  return Math.min(1.5, g)
}

/** the gate's own light: off until CUES.gate, a flash as it ignites, then a steady glow */
export function gateOn(t) {
  return ease.out(prog(t, CUES.gate - 0.12, CUES.gate + 0.1))
}

export function Trades({ t }) {
  const heads = useMemo(() => {
    const geo = new THREE.CapsuleGeometry(0.034, 1, 6, 12)
    geo.rotateZ(Math.PI / 2) // long axis along x
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const mesh = new THREE.InstancedMesh(geo, mat, SLOTS)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SLOTS * 3), 3)
    mesh.frustumCulled = false
    return mesh
  }, [])
  const trails = useMemo(() => makeSprites(SLOTS * (TRAIL + 1)), [])
  const slivers = useMemo(() => {
    const geo = new THREE.CylinderGeometry(0.085, 0.085, 0.05, 24)
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const mesh = new THREE.InstancedMesh(geo, mat, SLIVERS)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SLIVERS * 3), 3)
    mesh.frustumCulled = false
    return { mesh, glow: makeSprites(SLIVERS * 10) }
  }, [])
  const curves = useMemo(() => new Map(), [])

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const sc = new THREE.Vector3()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const X = new THREE.Vector3(1, 0, 0)
    const col = new THREE.Color()
    trails.clear()
    // in the finale the trades fall back so the flywheel and its arrows own the frame
    const keep = 1 - ease.inOut(prog(t, CUES.arrows - 0.8, CUES.final))
    let slot = 0
    for (let i = 0; i < SLOTS; i++) heads.setMatrixAt(i, m.makeScale(0, 0, 0))
    for (const tr of TRADES) {
      const u = t - tr.T
      if (u < -TRADE_PRE || u > TRADE_POST) continue
      if (slot >= SLOTS) break
      const head = tradeAt(tr, t, a)
      if (head.alpha <= 0) continue
      const prev = tradeAt(tr, t - 0.03, b)
      dir.subVectors(head.pos, prev.pos)
      const speed = dir.length() / 0.03
      dir.normalize()
      // a trade loses its fee at the gate: 7% shorter, a touch dimmer
      const cut = tr.fee && u >= 0 ? 0.93 : 1
      const len = tr.len * cut * Math.min(1.6, 0.4 + speed / 12)
      q.setFromUnitVectors(X, dir)
      sc.set(len, 1, 1)
      m.compose(a.clone().addScaledVector(dir, -len * 0.5), q, sc)
      heads.setMatrixAt(slot, m)
      col.copy(ICE).multiplyScalar(head.alpha * keep * (cut < 1 ? 0.85 : 1))
      heads.setColorAt(slot, col)
      // the trail: where it has just been, fading out
      for (let k = 0; k <= TRAIL; k++) {
        const p = tradeAt(tr, t - 0.01 - k * 0.0095, b)
        const f = 1 - k / TRAIL
        trails.set(slot * (TRAIL + 1) + k, p.pos, k === 0 ? 0.36 : 0.1 * f + 0.025, k === 0 ? HALO : ICE, (k === 0 ? 0.45 : 0.4 * f * f) * head.alpha * p.alpha * keep)
      }
      slot++
    }
    heads.count = SLOTS
    heads.instanceMatrix.needsUpdate = true
    heads.instanceColor.needsUpdate = true
    trails.commit()

    // slivers: one per sliced trade, from the gate up into the well
    const g = slivers.glow
    g.clear()
    let s = 0
    for (let i = 0; i < SLIVERS; i++) slivers.mesh.setMatrixAt(i, m.makeScale(0, 0, 0))
    for (const tr of TRADES) {
      const u = t - tr.T
      if (!tr.fee || tr.T > CUES.arrows - 0.9 || u < 0 || u > SLIVER_FLIGHT || s >= SLIVERS) continue
      if (!curves.has(tr.k)) curves.set(tr.k, sliverCurve(tr))
      const curve = curves.get(tr.k)
      const p = ease.inOut(u / SLIVER_FLIGHT)
      curve.getPoint(p, a)
      q.setFromEuler(new THREE.Euler(u * 9 + tr.k, u * 6, u * 4))
      const shrink = 1 - 0.6 * ease.in(prog(u, SLIVER_FLIGHT * 0.7, SLIVER_FLIGHT))
      m.compose(a, q, sc.set(shrink, shrink, shrink))
      slivers.mesh.setMatrixAt(s, m)
      slivers.mesh.setColorAt(s, col.copy(HOT).multiplyScalar(1 - 0.5 * p))
      for (let k = 0; k < 10; k++) {
        const pk = ease.inOut(Math.max(0, u - k * 0.018) / SLIVER_FLIGHT)
        curve.getPoint(pk, b)
        g.set(s * 10 + k, b, k === 0 ? 0.5 : 0.14 * (1 - k / 10), k === 0 ? HALO : ICE, (k === 0 ? 0.9 : 0.8 * (1 - k / 10)) * shrink)
      }
      s++
    }
    slivers.mesh.instanceMatrix.needsUpdate = true
    slivers.mesh.instanceColor.needsUpdate = true
    g.commit()
  }, [t, heads, trails, slivers, curves])

  return (
    <group>
      <primitive object={heads} />
      <primitive object={trails.points} />
      <primitive object={slivers.mesh} />
      <primitive object={slivers.glow.points} />
      <Gate t={t} />
    </group>
  )
}

const chromeRing = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03 })

function Gate({ t }) {
  const mats = useMemo(
    () => ({
      laser: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      sheet: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
    }),
    [],
  )
  const on = gateOn(t)
  const flash = gateFlash(t) * on
  const away = 1 - ease.inOut(prog(t, CUES.arrows - 0.5, CUES.final))
  const ignite = t >= CUES.gate ? Math.exp(-(t - CUES.gate) * 4) : 0
  mats.laser.color.copy(hdr('#8fa4ff', 0.4 + on * 2.6 + flash * 3 + ignite * 6, 0.3 + 0.4 * flash))
  mats.sheet.color.copy(hdr('#8fa4ff', 0.04 * on + flash * 0.22 + ignite * 0.5, 0.2))
  return (
    <group position={GATE} rotation={[0, Math.PI / 2, 0]} scale={away} visible={away > 0.001}>
      <mesh material={chromeRing}>
        <torusGeometry args={[0.56, 0.07, 24, 96]} />
      </mesh>
      <mesh material={mats.laser}>
        <torusGeometry args={[0.48, 0.012, 8, 96]} />
      </mesh>
      <mesh material={mats.sheet}>
        <circleGeometry args={[0.48, 64]} />
      </mesh>
    </group>
  )
}
