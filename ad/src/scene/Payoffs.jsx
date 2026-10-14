// What each hook does, shown where its line lands:
//   Creator share  – a coin flips into a wallet slot
//   Quantum Burn   – a coin heats up and breaks into embers
//   Entanglement   – the line splits into filaments that light up holders
//   Fusion         – light fills a glass vault and a lock ring seals it
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useCurrentFrame } from 'remotion'
import { RoundedBox } from '@react-three/drei'
import { FPS, HOOKS, HOOK_EVENTS } from '../timeline.js'
import { prog, ease, rand } from '../anim.js'
import { LINE } from './layout.js'
import { chrome, cobalt, graphite, darkSlot, glow, dotTexture } from './materials.js'

const H = Object.fromEntries(HOOKS.map((h) => [h.key, h]))
const VISIBLE_UNTIL = 20

function useT() {
  return useCurrentFrame() / FPS
}

// ---- Creator share ----------------------------------------------------------------------------

function Creator({ t }) {
  const hook = H.creator
  const ev = HOOK_EVENTS.creator
  const E = LINE.creator.end
  const wallet = useMemo(() => E.clone().add(new THREE.Vector3(0, -1.55, 0)), [E])
  const slotTop = wallet.y + 0.55
  const mats = useMemo(
    () => ({ face: cobalt, side: chrome, slot: glow(hook.glow, 3, { transparent: true }), stripe: glow(hook.color, 2.2) }),
    [hook],
  )

  const u = t - hook.at
  const pop = ease.outBack(prog(u, ev.pop, ev.pop + 0.18))
  const fall = prog(u, ev.pop + 0.12, ev.slot)
  const y = THREE.MathUtils.lerp(E.y, slotTop - 0.45, ease.in(fall))
  const spin = ease.in(fall) * Math.PI * 4
  const inSlot = u >= ev.slot
  mats.slot.opacity = inSlot ? 0.35 + 0.65 * Math.exp(-(u - ev.slot) * 3) : 0.15

  return (
    <group visible={t >= hook.at - 0.1 && t < VISIBLE_UNTIL}>
      <RoundedBox args={[1.9, 1.1, 0.5]} radius={0.12} smoothness={6} position={wallet} material={graphite} />
      <mesh position={[wallet.x, slotTop + 0.001, wallet.z]} material={darkSlot}>
        <boxGeometry args={[1.0, 0.012, 0.14]} />
      </mesh>
      <mesh position={[wallet.x, slotTop + 0.004, wallet.z]} material={mats.slot}>
        <boxGeometry args={[0.96, 0.01, 0.06]} />
      </mesh>
      <mesh position={[wallet.x, wallet.y - 0.28, wallet.z + 0.251]} material={mats.stripe}>
        <boxGeometry args={[1.3, 0.035, 0.005]} />
      </mesh>
      {!inSlot && u >= ev.pop && (
        <group position={[E.x, y, E.z]} rotation={[Math.PI / 2 + spin, 0.35, 0]} scale={pop}>
          <mesh material={[mats.side, mats.face, mats.face]}>
            <cylinderGeometry args={[0.36, 0.36, 0.07, 64]} />
          </mesh>
          {[-1, 1].map((k) => (
            <mesh key={k} position-y={k * 0.036} rotation-x={Math.PI / 2} material={chrome}>
              <torusGeometry args={[0.33, 0.022, 12, 64]} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  )
}

// ---- Quantum Burn -----------------------------------------------------------------------------

const SHARDS = 110
const EMBERS = 160

function Burn({ t }) {
  const hook = H.burn
  const ev = HOOK_EVENTS.burn
  const C = useMemo(() => LINE.burn.end.clone().add(new THREE.Vector3(0.55, 0, 0)), [])
  const coinFace = useMemo(
    () => new THREE.MeshPhysicalMaterial({ color: '#2a2f38', metalness: 1, roughness: 0.18, emissive: new THREE.Color(hook.color) }),
    [hook],
  )
  const shards = useMemo(() => {
    const geo = new THREE.TetrahedronGeometry(0.075)
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(hook.glow), toneMapped: false })
    const mesh = new THREE.InstancedMesh(geo, mat, SHARDS)
    mesh.frustumCulled = false
    const seeds = Array.from({ length: SHARDS }, (_, i) => {
      const a = rand(i * 5 + 11) * Math.PI * 2
      const r = Math.sqrt(rand(i * 5 + 12)) * 0.5
      return {
        p: new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0),
        v: new THREE.Vector3(Math.cos(a), Math.sin(a), (rand(i * 5 + 13) - 0.5) * 1.6).multiplyScalar(1.2 + rand(i * 5 + 14) * 2.4),
        spin: new THREE.Vector3(rand(i), rand(i + 99), rand(i + 199)).multiplyScalar(14),
        s: 0.5 + rand(i * 5 + 15),
      }
    })
    return { mesh, seeds }
  }, [hook])
  const embers = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3))
    const mat = new THREE.PointsMaterial({
      size: 0.09,
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const seeds = Array.from({ length: EMBERS }, (_, i) => ({
      x: (rand(i * 3 + 501) - 0.5) * 1.1,
      z: (rand(i * 3 + 502) - 0.5) * 0.8,
      up: 0.6 + rand(i * 3 + 503) * 1.6,
      ph: rand(i * 3 + 504) * 6.28,
    }))
    return { geo, mat, seeds }
  }, [])
  const ring = useMemo(() => glow(hook.color, 2.4, { transparent: true }), [hook])

  const u = t - hook.at
  const heat = ease.in(prog(u, ev.ignite, ev.shatter))
  const broken = u >= ev.shatter
  const since = u - ev.shatter
  coinFace.emissiveIntensity = heat * 4
  ring.opacity = broken ? Math.min(1, since * 3) * 0.8 : 0

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const fade = broken ? Math.max(0, 1 - since / 1.1) : 0
    shards.seeds.forEach((s, i) => {
      const k = Math.max(0, since)
      p.copy(s.p).addScaledVector(s.v, k).add(C)
      p.y += 0.5 * k * k
      e.set(s.spin.x * k, s.spin.y * k, s.spin.z * k)
      q.setFromEuler(e)
      const sc = broken ? s.s * fade : 0
      m.compose(p, q, new THREE.Vector3(sc, sc, sc))
      shards.mesh.setMatrixAt(i, m)
    })
    shards.mesh.instanceMatrix.needsUpdate = true
    shards.mesh.material.color.set(hook.glow).multiplyScalar(1 + 4 * fade)

    const pos = embers.geo.attributes.position.array
    const col = embers.geo.attributes.color.array
    const c = new THREE.Color(hook.glow)
    embers.seeds.forEach((s, i) => {
      const k = Math.max(0, since - (i % 7) * 0.03)
      pos.set([C.x + s.x + 0.08 * Math.sin(k * 5 + s.ph), C.y + k * s.up, C.z + s.z], i * 3)
      const b = broken ? Math.max(0, 1 - k / 1.3) * (0.7 + 0.3 * Math.sin(t * 30 + s.ph)) * 3 : 0
      col.set([c.r * b, c.g * b, c.b * b], i * 3)
    })
    embers.geo.attributes.position.needsUpdate = true
    embers.geo.attributes.color.needsUpdate = true
  }, [t, broken, since, shards, embers, C, hook])

  const shake = heat > 0 && !broken ? 0.02 * heat * Math.sin(t * 90) : 0
  return (
    <group visible={t >= hook.at - 0.1 && t < VISIBLE_UNTIL}>
      {!broken && (
        <group position={[C.x + shake, C.y, C.z]} rotation={[Math.PI / 2, 0, 0.2 + u * 0.6]}>
          <mesh material={[chrome, coinFace, coinFace]}>
            <cylinderGeometry args={[0.5, 0.5, 0.09, 64]} />
          </mesh>
        </group>
      )}
      <primitive object={shards.mesh} />
      <points geometry={embers.geo} material={embers.mat} frustumCulled={false} />
      <mesh position={C} material={ring}>
        <torusGeometry args={[0.42, 0.012, 8, 96]} />
      </mesh>
    </group>
  )
}

// ---- Entanglement -----------------------------------------------------------------------------

const NODES = 38

function Entangle({ t }) {
  const hook = H.entangle
  const ev = HOOK_EVENTS.entangle
  const E = LINE.entangle.end
  const net = useMemo(() => {
    const center = E.clone().add(new THREE.Vector3(1.55, -0.35, 0))
    const nodes = Array.from({ length: NODES }, (_, i) => {
      const a = rand(i * 4 + 801) * Math.PI * 2
      const b = Math.acos(2 * rand(i * 4 + 802) - 1)
      const r = 0.35 + Math.cbrt(rand(i * 4 + 803)) * 1.0
      return center
        .clone()
        .add(new THREE.Vector3(Math.sin(b) * Math.cos(a) * r * 1.5, Math.cos(b) * r * 1.05, Math.sin(b) * Math.sin(a) * r))
    })
    const far = Math.max(...nodes.map((n) => n.distanceTo(E)))
    const reachAt = nodes.map((n, i) => ev.spread + (ev.lit - ev.spread) * (n.distanceTo(E) / far) * (0.85 + 0.15 * rand(i + 900)))
    // each node also links to its nearest neighbour once both are lit
    const links = nodes.map((n, i) => {
      let best = -1
      let d = Infinity
      nodes.forEach((m, j) => {
        const dd = n.distanceTo(m)
        if (j !== i && dd < d) [best, d] = [j, dd]
      })
      return best
    })
    const fil = new THREE.BufferGeometry()
    fil.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NODES * 2 * 3), 3))
    const lnk = new THREE.BufferGeometry()
    lnk.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NODES * 2 * 3), 3))
    const sphere = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.055, 16, 12),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      NODES,
    )
    sphere.frustumCulled = false
    return {
      nodes,
      reachAt,
      links,
      fil,
      lnk,
      sphere,
      filMat: new THREE.LineBasicMaterial({ color: new THREE.Color(hook.glow).multiplyScalar(2.2), toneMapped: false, transparent: true, opacity: 0.85 }),
      lnkMat: new THREE.LineBasicMaterial({ color: new THREE.Color(hook.color).multiplyScalar(1.2), toneMapped: false, transparent: true, opacity: 0.35 }),
      sizes: nodes.map((_, i) => 0.7 + rand(i + 1200) * 0.9),
    }
  }, [E, ev, hook])

  const u = t - hook.at
  useLayoutEffect(() => {
    const fp = net.fil.attributes.position.array
    const lp = net.lnk.attributes.position.array
    const m = new THREE.Matrix4()
    const dim = new THREE.Color('#3b4250')
    const lit = new THREE.Color(hook.glow).multiplyScalar(3)
    const tmp = new THREE.Vector3()
    net.nodes.forEach((n, i) => {
      const k = ease.out(prog(u, ev.spread - 0.05, net.reachAt[i]))
      tmp.copy(E).lerp(n, k)
      fp.set([E.x, E.y, E.z, tmp.x, tmp.y, tmp.z], i * 6)
      const on = u >= net.reachAt[i]
      const j = net.links[i]
      const both = on && u >= net.reachAt[j]
      const lk = both ? ease.out(prog(u, Math.max(net.reachAt[i], net.reachAt[j]), Math.max(net.reachAt[i], net.reachAt[j]) + 0.3)) : 0
      const to = n.clone().lerp(net.nodes[j], lk)
      lp.set([n.x, n.y, n.z, to.x, to.y, to.z], i * 6)
      const pop = on ? 1 + 0.8 * Math.exp(-(u - net.reachAt[i]) * 8) : 1
      const s = net.sizes[i] * pop
      m.makeScale(s, s, s).setPosition(n)
      net.sphere.setMatrixAt(i, m)
      net.sphere.setColorAt(i, on ? lit : dim)
    })
    net.fil.attributes.position.needsUpdate = true
    net.lnk.attributes.position.needsUpdate = true
    net.sphere.instanceMatrix.needsUpdate = true
    if (net.sphere.instanceColor) net.sphere.instanceColor.needsUpdate = true
  }, [u, net, E, ev, hook])

  return (
    <group visible={t >= hook.at - 0.1 && t < VISIBLE_UNTIL}>
      <primitive object={net.sphere} />
      <lineSegments geometry={net.fil} material={net.filMat} visible={u >= ev.spread - 0.05} frustumCulled={false} />
      <lineSegments geometry={net.lnk} material={net.lnkMat} frustumCulled={false} />
    </group>
  )
}

// ---- Fusion -----------------------------------------------------------------------------------

function Fusion({ t }) {
  const hook = H.fusion
  const ev = HOOK_EVENTS.fusion
  const E = LINE.fusion.end
  const V = useMemo(() => E.clone().add(new THREE.Vector3(0, -1.15, 0)), [E])
  const mats = useMemo(
    () => ({
      glass: new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        metalness: 0,
        roughness: 0.04,
        transparent: true,
        opacity: 0.22,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMapIntensity: 2.2,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      liquid: glow(hook.color, 1.5, { transparent: true, opacity: 0.92 }),
      stream: glow(hook.glow, 3),
      flash: glow(hook.glow, 4, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    }),
    [hook],
  )

  const u = t - hook.at
  const fill = ease.out(prog(u, ev.fill, ev.lock - 0.25))
  const level = 1.25 * fill
  const bottom = V.y - 0.72
  const drop = ease.in(prog(u, ev.lock - 0.25, ev.lock))
  const ringY = THREE.MathUtils.lerp(V.y + 2.4, V.y + 0.78, drop)
  const twist = ease.outBack(prog(u, ev.lock, ev.lock + 0.25)) * (Math.PI / 4)
  const flash = u >= ev.lock ? Math.max(0, 1 - (u - ev.lock) / 0.35) : 0
  mats.flash.opacity = flash
  const pouring = u >= ev.fill - 0.05 && u < ev.lock

  return (
    <group visible={t >= hook.at - 0.1 && t < VISIBLE_UNTIL}>
      {/* glass vault on a chrome base */}
      <mesh position={V} material={mats.glass} renderOrder={2}>
        <cylinderGeometry args={[0.62, 0.62, 1.5, 96, 1, true]} />
      </mesh>
      <mesh position={[V.x, bottom - 0.08, V.z]} material={chrome}>
        <cylinderGeometry args={[0.72, 0.76, 0.16, 96]} />
      </mesh>
      {level > 0.001 && (
        <mesh position={[V.x, bottom + level / 2, V.z]} material={mats.liquid}>
          <cylinderGeometry args={[0.56, 0.56, level, 96]} />
        </mesh>
      )}
      {pouring && (
        <mesh position={[E.x, (E.y + bottom + level) / 2, E.z]} material={mats.stream}>
          <cylinderGeometry args={[0.03, 0.03, Math.max(0.01, E.y - bottom - level), 12]} />
        </mesh>
      )}
      {/* the lock ring drops onto the rim and turns to seal it */}
      <group position={[V.x, ringY, V.z]} rotation={[0, twist, 0]} visible={u >= ev.lock - 0.3}>
        <mesh rotation-x={Math.PI / 2} material={chrome}>
          <torusGeometry args={[0.66, 0.075, 24, 96]} />
        </mesh>
        {[0, 1, 2, 3].map((k) => (
          <mesh key={k} position={[Math.cos((k * Math.PI) / 2) * 0.66, 0, Math.sin((k * Math.PI) / 2) * 0.66]} rotation-y={(-k * Math.PI) / 2} material={cobalt}>
            <boxGeometry args={[0.1, 0.2, 0.2]} />
          </mesh>
        ))}
      </group>
      {flash > 0 && (
        <mesh position={[V.x, V.y + 0.78, V.z]} rotation-x={Math.PI / 2} scale={1 + 0.5 * (1 - flash)} material={mats.flash}>
          <torusGeometry args={[0.7, 0.03, 8, 96]} />
        </mesh>
      )}
    </group>
  )
}

export function Payoffs() {
  const t = useT()
  if (t < 7.9 || t >= VISIBLE_UNTIL) return null
  return (
    <group>
      <Creator t={t} />
      <Burn t={t} />
      <Entangle t={t} />
      <Fusion t={t} />
    </group>
  )
}
