// The fee flywheel still: a glass donut chart of the trading fee (60% to holders in Entanglement
// green, 40% to buyback and burn in Quantum Burn pink), circled by a glowing arrow ring that turns
// clockwise. Same cobalt glass studio as Glass.jsx. Labels and copy are set afterwards in HTML
// (social/flywheel/flywheel.html); FLYWHEEL_CAMERA and PIE are exported so scripts can project
// label anchors onto the frame.
import { useMemo } from 'react'
import * as THREE from 'three'
import { Glass, Piece, Ray, GlassStudio, Backdrop, Shot, Post, Stage } from './Glass.jsx'

export const FLYWHEEL = { width: 3200, height: 1800 }
export const FLYWHEEL_CAMERA = { pos: [0.4, 5.2, 10.6], target: [0.9, 0.2, 0], fov: 30 }
/** the chart: centre, radii, and slices (share, colour, height), clockwise from the back */
export const PIE = {
  center: [2.7, 0, 0],
  inner: 1.05,
  outer: 2.55,
  gap: 0.14,
  ring: 3.2,
  slices: [
    { key: 'holders', share: 0.6, color: '#12C26E', light: '#8dffc6', depth: 0.95 },
    { key: 'burn', share: 0.4, color: '#FF3EA5', light: '#ffb0d6', depth: 0.7 },
  ],
}

/** start/end angles (shape space, radians) for each slice, clockwise from the back (θ = 90°) */
export function sliceAngles() {
  let at = Math.PI / 2
  return PIE.slices.map((s) => {
    const end = at
    const start = at - s.share * Math.PI * 2
    at = start
    return { ...s, start, end, mid: (start + end) / 2 }
  })
}

function sliceGeometry(start, end, depth, bevel = 0.2) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, PIE.outer, start, end, false)
  shape.absarc(0, 0, PIE.inner, end, start, true)
  shape.closePath()
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelOffset: -bevel * 0.8,
    bevelSegments: 16,
    curveSegments: 160,
  })
  g.translate(0, 0, bevel)
  g.rotateX(-Math.PI / 2) // lie flat: extrusion becomes height, shape y becomes -z
  g.computeVertexNormals()
  return g
}

function Slice({ start, end, mid, depth, color, light }) {
  const geometry = useMemo(() => sliceGeometry(start, end, depth), [start, end, depth])
  const offset = [Math.cos(mid) * PIE.gap, 0, -Math.sin(mid) * PIE.gap]
  return (
    <mesh geometry={geometry} position={offset}>
      <Glass
        resolution={2048}
        color={light}
        attenuationColor={color}
        attenuationDistance={3.5}
        emissive={color}
        emissiveIntensity={0.55}
        thickness={2.2}
        roughness={0.04}
        chromaticAberration={0.06}
        envMapIntensity={2}
      />
    </mesh>
  )
}

/** the flywheel: three glowing arcs round the chart with arrowheads, turning clockwise */
function FlywheelRing({ radius = PIE.ring, y = 0.4, arcs = 3, gap = 0.34 }) {
  const parts = useMemo(() => {
    const out = []
    const span = (Math.PI * 2) / arcs
    for (let i = 0; i < arcs; i++) {
      // clockwise from above = decreasing θ; each arc runs from a0 down to a1
      const a0 = Math.PI / 2 + 0.5 - i * span
      const a1 = a0 - span + gap
      const pts = []
      for (let k = 0; k <= 96; k++) {
        const a = a0 + ((a1 - a0) * k) / 96
        pts.push(new THREE.Vector3(Math.cos(a) * radius, y, -Math.sin(a) * radius))
      }
      const tangent = new THREE.Vector3(Math.sin(a1), 0, Math.cos(a1)).normalize()
      out.push({
        curve: new THREE.CatmullRomCurve3(pts),
        tip: new THREE.Vector3(Math.cos(a1) * radius, y, -Math.sin(a1) * radius).addScaledVector(tangent, 0.12),
        quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent),
      })
    }
    return out
  }, [radius, y, arcs, gap])
  const tipMat = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color('#dfe5ff').multiplyScalar(3), toneMapped: false }), [])
  return (
    <group>
      {parts.map((p, i) => (
        <group key={i}>
          <Ray curve={p.curve} radius={0.022} color="#8fa4ff" white={0.6} glow={3.2} halo={0.14} spill={0.025} />
          <mesh position={p.tip} quaternion={p.quat} material={tipMat}>
            <coneGeometry args={[0.12, 0.34, 32]} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/** a soft cobalt pool of light under the chart */
function Glow({ radius = 4.6, y = -0.25, color = '#3b57ff', opacity = 0.3 }) {
  const texture = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 512
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.4, 'rgba(255,255,255,0.45)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 512, 512)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [])
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[radius * 2, radius * 2]} />
      <meshBasicMaterial map={texture} color={color} transparent opacity={opacity} depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
    </mesh>
  )
}

const GLOWS = [
  { x: 0.5, y: 0.5, r: 0.75, color: '#0e1e8e', alpha: 0.8 },
  { x: 0.66, y: 0.28, r: 0.3, color: '#2e4bff', alpha: 0.7 },
  { x: 0.18, y: 0.3, r: 0.3, color: '#172dbe', alpha: 0.5 },
]

export function Flywheel() {
  const { width, height } = FLYWHEEL
  const slices = sliceAngles()
  return (
    <Stage width={width} height={height} background="#04061a">
      <Backdrop width={width} height={height} glows={GLOWS} base="#04061a" />
      <GlassStudio />
      <Shot pos={FLYWHEEL_CAMERA.pos} target={FLYWHEEL_CAMERA.target} fov={FLYWHEEL_CAMERA.fov} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[-4, 9, 6]} intensity={2.4} />

      <group position={PIE.center}>
        {slices.map((s) => (
          <Slice key={s.key} {...s} />
        ))}
        <FlywheelRing />
        <Glow />
      </group>

      {/* glass around the edges, kept off the copy on the left */}
      <Piece kind="sphere" position={[6.2, 2.2, 1.0]} scale={0.22} />
      <Piece kind="sphere" position={[0.0, 2.4, -2.5]} scale={0.16} />
      <Piece kind="sphere" position={[4.2, -0.3, 3.4]} scale={0.22} />
      <Piece kind="pill" args={[0.5, 2.2]} position={[-8.5, 4.4, -9]} rotation={[0.3, 0.3, -0.7]} frost={0.25} tint />

      <Post focus={11.7} range={4.5} bokeh={10} bloom={0.7} vignette={0.45} />
    </Stage>
  )
}
