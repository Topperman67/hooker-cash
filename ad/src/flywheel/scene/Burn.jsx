// Buyback & burn: out along the pink slice stands the token's supply, a stack of chrome coins. The
// pink line carries the burn share out from the flywheel; each packet that lands buys coins off the
// top of the stack, and they arc up into the furnace, heat white-pink and break into embers. The
// stack only ever gets shorter.
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { SUPPLY, FURNACE, FURNACE_R, BURN_CURVE, coinPath, coinsLeft } from '../layout.js'
import { CUES, COLORS, BURN_EVENTS } from '../timeline.js'
import { prog, ease, rand } from '../../anim.js'
import { makeSprites, makeLine, hdr } from './fx.js'

const PER = SUPPLY.perBurn
const STACK_FROM = CUES.whip + 0.15 // the supply stacks up as the camera arrives
const SHARDS = 26 // per coin
const EMBERS = 46 // per coin
const IDLE = 70 // the furnace's own slow embers

const chrome = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 })
/** the token: satin silver, so a stack reads as coins rather than a mirror */
const silver = new THREE.MeshPhysicalMaterial({ color: '#dfe5f0', metalness: 1, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.08 })

/** a coin with a rounded, raised rim (lathed), centred on y = 0 */
function coinGeometry() {
  const R = SUPPLY.radius
  const h = SUPPLY.thick / 2
  const e = 0.03
  const pts = [new THREE.Vector2(0, h - 0.012), new THREE.Vector2(R - 0.12, h - 0.012), new THREE.Vector2(R - 0.09, h)]
  for (let k = 0; k <= 8; k++) {
    const a = Math.PI / 2 - (k / 8) * Math.PI
    pts.push(new THREE.Vector2(R - e + Math.cos(a) * e, Math.sin(a) * h))
  }
  pts.push(new THREE.Vector2(R - 0.09, -h), new THREE.Vector2(R - 0.12, -h + 0.012), new THREE.Vector2(0, -h + 0.012))
  const g = new THREE.LatheGeometry(pts, 72)
  g.computeVertexNormals()
  return g
}

/** every bought coin: which burn, which coin of it, when it leaves the stack and from where */
const COINS = (() => {
  const out = []
  let n = SUPPLY.coins
  for (const b of CUES.burns) {
    for (let j = 0; j < PER; j++) {
      const y = SUPPLY.base.y + (n - 1 - j + 0.5) * SUPPLY.pitch
      out.push({ b, j, start: b + j * 0.07, y, seed: out.length })
    }
    n -= PER
  }
  return out
})()

/** the furnace's heat at t: a flare on every burn */
export function furnaceHeat(t) {
  let h = 0
  for (const c of COINS) {
    const at = c.start + BURN_EVENTS.shatter
    if (t >= at && t - at < 1.5) h += Math.exp(-(t - at) * 3.5) / PER
  }
  return Math.min(1.6, h)
}

export function Burn({ t }) {
  const { camera } = useThree()
  const stack = useMemo(() => {
    const mesh = new THREE.InstancedMesh(coinGeometry(), silver, SUPPLY.coins)
    mesh.frustumCulled = false
    return mesh
  }, [])
  const flying = useMemo(
    () =>
      COINS.map(() => {
        const hot = silver.clone()
        hot.emissive = new THREE.Color(COLORS.burn)
        return { mat: hot }
      }),
    [],
  )
  const coinGeo = useMemo(coinGeometry, [])
  const curves = useMemo(() => COINS.map((c) => coinPath(c.y, c.j)), [])
  const shards = useMemo(() => {
    const geo = new THREE.TetrahedronGeometry(0.07)
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const mesh = new THREE.InstancedMesh(geo, mat, COINS.length * SHARDS)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COINS.length * SHARDS * 3), 3)
    mesh.frustumCulled = false
    return mesh
  }, [])
  const embers = useMemo(() => makeSprites(COINS.length * EMBERS + IDLE + 40), [])
  const line = useMemo(() => makeLine(BURN_CURVE, { radius: 0.03, color: COLORS.burn, glow: 2.8, white: 0.3 }), [])
  const ring = useMemo(
    () => ({
      laser: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      core: new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        // a slow swirl of fire, hottest in the middle, fading to nothing at the ring
        fragmentShader: `uniform vec3 uColor; uniform float uR, uTime; varying vec2 vP;
          void main(){
            float r = length(vP) / uR;
            float a = atan(vP.y, vP.x);
            float swirl = 0.5 + 0.5 * sin(a * 5.0 - uTime * 3.0 + r * 9.0) * sin(a * 3.0 + uTime * 2.1 - r * 6.0);
            float g = exp(-r * r * 2.6) * (0.65 + 0.55 * swirl) * smoothstep(1.0, 0.7, r);
            gl_FragColor = vec4(uColor * g, 1.0); }`,
        uniforms: { uColor: { value: new THREE.Color() }, uR: { value: FURNACE_R * 0.94 }, uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    }),
    [],
  )
  const furnace = useRef()

  const heat = furnaceHeat(t)
  const away = 1 - ease.inOut(prog(t, CUES.arrows - 0.6, CUES.final - 0.1))
  const reach = ease.inOut(prog(t, CUES.whip + 0.2, CUES.whip + 0.8))
  const on = ease.out(prog(t, CUES.whip + 0.6, CUES.whip + 1.0))
  const left = coinsLeft(t)

  useLayoutEffect(() => {
    // the furnace always faces the camera a little, so it reads as a ring of fire, not a stripe
    const look = camera.position.clone()
    look.y = FURNACE.y + (look.y - FURNACE.y) * 0.3
    furnace.current.lookAt(look)

    // a pink packet runs out along the line before every buy
    let packet = -1
    for (const b of CUES.burns) if (t >= b - 0.5 && t < b + 0.1) packet = (t - (b - 0.5)) / 0.5
    line.reveal(0, reach * away, reach > 0 ? 0.7 + 0.3 * (packet >= 0 ? 1 : 0) : 0)

    // the supply stacks itself up, a coin at a time, as the line arrives
    const m = new THREE.Matrix4()
    for (let i = 0; i < SUPPLY.coins; i++) {
      const drop = ease.in(prog(t, STACK_FROM + i * 0.022, STACK_FROM + i * 0.022 + 0.16))
      const y = SUPPLY.base.y + (i + 0.5) * SUPPLY.pitch + (1 - drop) * 1.6
      m.makeRotationY(i * 0.37).setPosition(SUPPLY.base.x, y, SUPPLY.base.z)
      if (drop <= 0) m.scale(new THREE.Vector3(0, 0, 0))
      stack.setMatrixAt(i, m)
    }
    stack.instanceMatrix.needsUpdate = true
    stack.count = left
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const sc = new THREE.Vector3()
    const col = new THREE.Color()
    embers.clear()
    const pinkHot = hdr(COLORS.burnLight, 3.2, 0.15)
    const pink = hdr(COLORS.burn, 2.4)
    const white = hdr('#ffffff', 4)
    let si = 0

    COINS.forEach((c, i) => {
      const u = t - c.start
      const sinceShatter = u - BURN_EVENTS.shatter
      // shards and embers once it breaks
      for (let k = 0; k < SHARDS; k++) {
        const idx = i * SHARDS + k
        if (sinceShatter < 0 || sinceShatter > 1.2) {
          shards.setMatrixAt(idx, m.makeScale(0, 0, 0))
          continue
        }
        const a = rand(idx * 3 + 1) * Math.PI * 2
        const z = rand(idx * 3 + 2) * 2 - 1
        const dir = p.set(Math.sqrt(1 - z * z) * Math.cos(a), z, Math.sqrt(1 - z * z) * Math.sin(a))
        const v = 1.6 + 2.6 * rand(idx * 3 + 3)
        const s = sinceShatter
        const pos = FURNACE.clone().addScaledVector(dir, v * s * (1 - 0.35 * s))
        pos.y += 0.6 * s - 1.4 * s * s
        e.set(s * 11 + k, s * 7, s * 5)
        q.setFromEuler(e)
        const fade = Math.max(0, 1 - s / 1.1)
        m.compose(pos, q, sc.setScalar((0.6 + rand(idx) * 0.9) * fade))
        shards.setMatrixAt(idx, m)
        shards.setColorAt(idx, col.copy(pinkHot).multiplyScalar(0.35 + 1.6 * fade * fade))
      }
      if (sinceShatter >= 0 && sinceShatter < 1.8) {
        for (let k = 0; k < EMBERS; k++) {
          const idx = i * EMBERS + k
          const s = sinceShatter - (k % 5) * 0.02
          if (s < 0) continue
          const a = rand(idx * 5 + 11) * Math.PI * 2
          const r = (0.6 + 1.6 * rand(idx * 5 + 12)) * Math.min(1, s * 2.2)
          p.set(FURNACE.x + Math.cos(a) * r * 0.8, FURNACE.y + s * (0.8 + 1.4 * rand(idx * 5 + 13)) + Math.sin(a) * r * 0.5, FURNACE.z + Math.sin(a) * r * 0.6)
          p.x += 0.12 * Math.sin(s * 6 + k)
          const life = Math.max(0, 1 - s / (1.1 + 0.7 * rand(idx * 5 + 14)))
          const flick = 0.7 + 0.3 * Math.sin(t * 31 + k * 1.7)
          embers.set(si++, p, 0.05 + 0.07 * rand(idx * 5 + 15), rand(idx) < 0.3 ? white : pinkHot, life * flick)
        }
      }
    })
    shards.instanceMatrix.needsUpdate = true
    shards.instanceColor.needsUpdate = true

    // idle embers rising from the furnace once it is lit
    for (let k = 0; k < IDLE; k++) {
      const life = 1.6
      const x = t + (k / IDLE) * life
      const s = x % life
      const a = rand(k * 3 + 900 + Math.floor(x / life) * 131) * Math.PI * 2
      p.set(FURNACE.x + Math.cos(a) * FURNACE_R * 0.8, FURNACE.y + Math.sin(a) * FURNACE_R * 0.8 + s * 0.9, FURNACE.z + 0.2 * Math.sin(a * 3))
      embers.set(si++, p, 0.045, pink, on * (0.25 + 0.5 * heat) * Math.sin(Math.PI * (s / life)))
    }
    // the packet itself, and a flash on the stack where it lands
    if (packet >= 0 && packet <= 1) {
      BURN_CURVE.getPoint(ease.in(Math.min(1, packet)), p)
      embers.set(si++, p, 0.5, white, 1)
    }
    for (const b of CUES.burns) {
      if (t >= b && t < b + 0.6) {
        p.set(SUPPLY.base.x, SUPPLY.base.y + (left + PER) * SUPPLY.pitch, SUPPLY.base.z)
        embers.set(si++, p, 0.8 * Math.exp(-(t - b) * 6), pinkHot, 0.6 * Math.exp(-(t - b) * 6))
      }
    }
    embers.commit()

    ring.laser.color.copy(hdr(COLORS.burnLight, (0.5 + 2.2 * on + 3.5 * heat) * on, 0.2 + 0.3 * heat))
    ring.core.uniforms.uColor.value.copy(hdr(COLORS.burn, (0.25 + 1.1 * heat) * on, 0.1 * heat))
    ring.core.uniforms.uTime.value = t
  }, [t, camera, line, stack, shards, embers, ring, reach, on, heat, left, away])

  return (
    <group>
      <primitive object={line.group} />
      <group position={SUPPLY.base} scale={Math.max(0.0001, away)} visible={away > 0.001}>
        <group position={[-SUPPLY.base.x, -SUPPLY.base.y, -SUPPLY.base.z]}>
          <primitive object={stack} />
        </group>
      </group>
      {COINS.map((c, i) => {
        const u = t - c.start
        if (u < 0 || u >= BURN_EVENTS.shatter) return null
        const pth = ease.inOut(prog(u, 0, BURN_EVENTS.arrive))
        const pos = curves[i].getPoint(pth)
        const glow = ease.in(prog(u, 0.15, BURN_EVENTS.shatter))
        flying[i].mat.emissiveIntensity = glow * 4
        const shake = glow * 0.03 * Math.sin(t * 95 + i)
        return (
          <mesh
            key={i}
            geometry={coinGeo}
            material={flying[i].mat}
            position={[pos.x + shake, pos.y, pos.z]}
            rotation={[pth * Math.PI * 1.5 + 0.3 * c.j, pth * 2, 0.2]}
            scale={0.8 - 0.25 * glow}
          />
        )
      })}
      <primitive object={shards} />
      <primitive object={embers.points} />
      <group ref={furnace} position={FURNACE} scale={Math.max(0.0001, ease.outBack(prog(t, CUES.whip + 0.55, CUES.whip + 0.95)) * away)}>
        <mesh material={chrome}>
          <torusGeometry args={[FURNACE_R, 0.075, 24, 120]} />
        </mesh>
        <mesh material={ring.laser}>
          <torusGeometry args={[FURNACE_R - 0.085, 0.016, 8, 120]} />
        </mesh>
        <mesh material={ring.core}>
          <circleGeometry args={[FURNACE_R * 0.92, 64]} />
        </mesh>
      </group>
    </group>
  )
}
