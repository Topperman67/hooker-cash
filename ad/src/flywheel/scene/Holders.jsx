// Holders: a sunflower of glass columns out along the green slice, each as tall as that holder's
// bag. The green line carries their share out from the flywheel to a hub above them. Round them
// runs a 2-hour dial: its hand spins like a roulette wheel, stops at a random moment, and the
// snapshot fires (a flash and a scan across every column). Then filaments drop from the hub to
// every column and fill it with green SOL, more for bigger bags.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { HOLDERS, HOLDERS_CURVE, HOLDER_REACH, POURS, handAngle } from '../layout.js'
import { CUES, COLORS } from '../timeline.js'
import { prog, ease } from '../../anim.js'
import { makeSprites, makeLine, hdr } from './fx.js'
import { FLOOR_Y } from './Ambience.jsx'

const N = HOLDERS.nodes.length
const COL_R = 0.15
const HEIGHT = 1.25 // column height per unit of bag size
const BASE_Y = FLOOR_Y + 0.01

const SWEEP_FRAG = /* glsl */ `
  uniform float uHand, uOn, uFlash;
  uniform vec3 uColor;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    float a = atan(vP.y, vP.x);
    float behind = mod(uHand - a + 6.2831853, 6.2831853);
    float trail = exp(-behind * 2.2) * smoothstep(0.15, 0.6, r);
    float edge = smoothstep(1.0, 0.97, r);
    float flash = uFlash * (0.25 + 0.75 * smoothstep(0.0, 1.0, r)) * edge;
    gl_FragColor = vec4(uColor * (trail * 0.22 * uOn + flash) * edge, 1.0);
  }
`
const SWEEP_VERT = /* glsl */ `
  varying vec2 vP;
  uniform float uR;
  void main() {
    vP = position.xy / uR;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const glassMat = new THREE.MeshPhysicalMaterial({
  color: '#c9d3ff',
  metalness: 0.1,
  roughness: 0.12,
  transparent: true,
  opacity: 0.38,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  envMapIntensity: 1.6,
  depthWrite: false,
})
glassMat.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    `#include <emissivemap_fragment>
      float fres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
      totalEmissiveRadiance += vec3(0.35, 0.45, 1.2) * fres;`,
  )
}
glassMat.customProgramCacheKey = () => 'flywheel-holder-glass'

export function Holders({ t }) {
  const columns = useMemo(() => {
    const geo = new THREE.CylinderGeometry(COL_R, COL_R, 1, 32, 1)
    geo.translate(0, 0.5, 0)
    const glass = new THREE.InstancedMesh(geo, glassMat, N)
    const fillGeo = new THREE.CylinderGeometry(COL_R * 0.62, COL_R * 0.62, 1, 24, 1)
    fillGeo.translate(0, 0.5, 0)
    const fill = new THREE.InstancedMesh(fillGeo, new THREE.MeshBasicMaterial({ color: '#ffffff' }), N)
    fill.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3)
    glass.frustumCulled = fill.frustumCulled = false
    return { glass, fill }
  }, [])
  const line = useMemo(() => makeLine(HOLDERS_CURVE, { radius: 0.03, color: COLORS.holders, glow: 2.8, white: 0.3 }), [])
  const sprites = useMemo(() => makeSprites(N * 3 + 64), [])
  const filaments = useMemo(() => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3))
    const mat = new THREE.LineBasicMaterial({ color: hdr(COLORS.holdersLight, 2.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const seg = new THREE.LineSegments(geo, mat)
    seg.frustumCulled = false
    return seg
  }, [])
  const dial = useMemo(() => {
    const sweep = new THREE.ShaderMaterial({
      vertexShader: SWEEP_VERT,
      fragmentShader: SWEEP_FRAG,
      uniforms: { uHand: { value: 0 }, uOn: { value: 0 }, uFlash: { value: 0 }, uR: { value: HOLDERS.dial }, uColor: { value: hdr(COLORS.holdersLight, 1) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const ring = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const hand = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    return { sweep, ring, hand }
  }, [])

  const away = 1 - ease.inOut(prog(t, CUES.arrows - 0.6, CUES.final - 0.1))
  const reach = ease.inOut(prog(t, CUES.holdersReach - 0.55, CUES.holdersReach)) * away
  /** each column grows out of the floor as the line arrives, the middle of the field first */
  const rise = (n) => ease.outBack(prog(t, CUES.holdersReach - 0.35 + 0.35 * (n.r / HOLDERS.radius), CUES.holdersReach + 0.15 + 0.35 * (n.r / HOLDERS.radius)))
  const lit = ease.out(prog(t, CUES.holdersReach - 0.2, CUES.holdersReach + 0.4))
  const snap = t >= CUES.snapshot ? Math.exp(-(t - CUES.snapshot) * 5) : 0
  const hand = handAngle(t)

  useLayoutEffect(() => {
    // the green line draws out from the flywheel, then carries a packet on every pour
    let pulse = 0
    for (const p of POURS) if (t >= p + 0.3 && t < p + 1.2) pulse = Math.max(pulse, Math.exp(-(t - p - 0.3) * 2.2))
    line.reveal(0, reach, reach > 0 ? 0.7 + 0.3 * pulse : 0)

    const c = new THREE.Color()
    const m = new THREE.Matrix4()
    const tmp = new THREE.Vector3()
    const pos = filaments.geometry.attributes.position.array
    const green = hdr(COLORS.holdersLight, 3.2, 0.1)
    const white = hdr('#ffffff', 3)
    const dim = hdr('#8fa4ff', 0.5)
    sprites.clear()
    // the scan ring of the snapshot, from the hub's foot out across the columns
    const scanR = HOLDERS.dial * ease.out(prog(t, CUES.snapshot, CUES.snapshot + 0.45))
    HOLDERS.nodes.forEach((n, i) => {
      const grown = rise(n) * away
      const h = n.size * HEIGHT * Math.max(0.0001, grown)
      m.makeScale(grown > 0 ? 1 : 0, h, grown > 0 ? 1 : 0).setPosition(n.pos.x, BASE_Y, n.pos.z)
      columns.glass.setMatrixAt(i, m)
      const top = tmp.set(n.pos.x, BASE_Y + h, n.pos.z)
      // filament from the hub down to this column
      const k = ease.out(prog(t, CUES.paid, HOLDER_REACH[i]))
      const fade = 1 - ease.in(prog(t, HOLDER_REACH[i] + 0.2, HOLDER_REACH[i] + 0.9))
      const end = HOLDERS.hub.clone().lerp(top, k)
      pos.set([HOLDERS.hub.x, HOLDERS.hub.y, HOLDERS.hub.z, end.x, end.y, end.z], i * 6)
      // the SOL drop at the filament's tip
      if (k > 0 && k < 1) sprites.set(i * 3, end, 0.16, green, 1)
      // the column fills with green once paid, by its bag
      const paid = ease.out(prog(t, HOLDER_REACH[i], HOLDER_REACH[i] + 0.45))
      m.makeScale(paid > 0 ? 1 : 0, Math.max(0.0001, h * 0.96 * paid), paid > 0 ? 1 : 0).setPosition(n.pos.x, BASE_Y + 0.01, n.pos.z)
      columns.fill.setMatrixAt(i, m)
      const land = t >= HOLDER_REACH[i] ? Math.exp(-(t - HOLDER_REACH[i]) * 5) : 0
      c.set(COLORS.holders).multiplyScalar(1.2 + 2.2 * land)
      columns.fill.setColorAt(i, c)
      // the snapshot catches each column as the scan passes it
      const passed = scanR > 0 && Math.abs(scanR - n.r) < 0.5 ? 1 - Math.abs(scanR - n.r) / 0.5 : 0
      const glint = passed * (t < CUES.snapshot + 0.6 ? 1 : 0)
      sprites.set(i * 3 + 1, top, 0.18 + 0.2 * glint, glint > 0.01 ? white : paid > 0 ? green : dim, ((0.35 + 1.2 * glint) * lit + paid * 0.5 + 0.6 * land) * Math.min(1, grown))
      if (land > 0.01) sprites.set(i * 3 + 2, top, 0.45 * land + 0.1, green, 0.7 * land)
    })
    // the hub glows when the line reaches it, and flares as it pays out
    const payout = t >= CUES.paid ? Math.exp(-(t - CUES.paid) * 3) : 0
    sprites.set(N * 3, HOLDERS.hub, 0.36 + 0.45 * payout, green, (lit * (0.6 + 0.25 * Math.sin(t * 6)) + 0.8 * payout) * away)
    sprites.set(N * 3 + 1, HOLDERS.center.clone().setY(BASE_Y + 0.05), 4.5 * snap, white, snap * 0.8)
    sprites.commit()
    filaments.geometry.attributes.position.needsUpdate = true
    filaments.material.opacity = t >= CUES.paid ? 1 - ease.in(prog(t, CUES.paid + 0.7, CUES.paid + 1.5)) : 0
    columns.glass.instanceMatrix.needsUpdate = true
    columns.fill.instanceMatrix.needsUpdate = true
    columns.fill.instanceColor.needsUpdate = true

    dial.sweep.uniforms.uHand.value = hand
    dial.sweep.uniforms.uOn.value = lit * away
    dial.sweep.uniforms.uFlash.value = snap * 0.9
    dial.ring.color.copy(hdr(COLORS.holdersLight, (0.6 + 2.4 * snap) * lit * away, 0.2 + 0.6 * snap))
    dial.hand.color.copy(hdr('#ffffff', (2.6 * lit + 3 * snap) * away))
  }, [t, line, sprites, filaments, columns, dial, reach, lit, snap, hand, rise])

  const R = HOLDERS.dial
  const C = HOLDERS.center
  return (
    <group>
      <primitive object={line.group} />
      <primitive object={columns.glass} />
      <primitive object={columns.fill} />
      <primitive object={filaments} />
      <primitive object={sprites.points} />
      <group position={[C.x, BASE_Y + 0.005, C.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh material={dial.sweep}>
          <circleGeometry args={[R, 96]} />
        </mesh>
        <mesh material={dial.ring}>
          <ringGeometry args={[R - 0.025, R + 0.025, 160]} />
        </mesh>
        {/* twelve ticks: ten minutes each */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i / 12) * Math.PI * 2
          return (
            <mesh key={i} material={dial.ring} position={[Math.cos(a) * (R + 0.16), Math.sin(a) * (R + 0.16), 0]} rotation={[0, 0, a]}>
              <planeGeometry args={[i % 3 === 0 ? 0.3 : 0.16, 0.035]} />
            </mesh>
          )
        })}
        <mesh material={dial.hand} position={[Math.cos(hand) * R * 0.55, Math.sin(hand) * R * 0.55, 0.002]} rotation={[0, 0, hand]}>
          <planeGeometry args={[R * 0.9, 0.035]} />
        </mesh>
      </group>
    </group>
  )
}
