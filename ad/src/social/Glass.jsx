// Liquid-glass stills: the Q in clear glass with a cobalt glass tail, floating in a cobalt studio
// with glass pebbles, pills, rings and tiles, and the four hook lines raking behind at 45° so the
// glass has something to bend. Pinned is the pinned-post image; BannerPlate is the banner's
// background (its text is set afterwards in HTML, social/banner/banner.html).
import { useEffect, useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { AbsoluteFill, useDelayRender } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import { useThree, useFrame } from '@react-three/fiber'
import { Environment, Lightformer, MeshTransmissionMaterial, RoundedBox } from '@react-three/drei'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  DepthOfFieldEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { puffyMarkGeometry, TAIL_EXIT } from '../scene/logoGeometry.js'
import { HOOKS } from '../timeline.js'

const S = 0.01 // SVG units → world (the Q is about 4.2 across)

// ---- glass -------------------------------------------------------------------------------------

/** clear liquid glass: thick, lensing, a touch of dispersion at the rims */
const CLEAR = {
  samples: 12,
  thickness: 1.4,
  roughness: 0,
  ior: 1.45,
  chromaticAberration: 0.08,
  anisotropicBlur: 0.08,
  distortion: 0,
  clearcoat: 1,
  clearcoatRoughness: 0,
  envMapIntensity: 1.6,
  color: '#ffffff',
  attenuationColor: '#e8eeff',
  attenuationDistance: 3,
  backside: true,
  backsideThickness: 0.6,
}

/** the floating pieces: solid glass (no backside pass), so they lens what is behind them */
const SOLID = { backside: false, thickness: 2.4, chromaticAberration: 0.12 }
/** cobalt-tinted glass, like the tail */
const TINTED = { color: '#c3cdff', attenuationColor: '#2e4bff', attenuationDistance: 1.4 }

export function Glass({ resolution = 1024, ...props }) {
  return <MeshTransmissionMaterial resolution={resolution} backsideResolution={resolution} {...CLEAR} {...props} />
}

// ---- shapes ------------------------------------------------------------------------------------

/** a squircle tile (the Q's own outline family), extruded with a round bevel */
function squircleGeometry(size = 2, depth = 0.24, bevel = 0.16, n = 4.5) {
  const shape = new THREE.Shape()
  const r = size / 2 - bevel * 0.8
  for (let i = 0; i <= 128; i++) {
    const t = (i / 128) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const x = Math.sign(c) * Math.abs(c) ** (2 / n) * r
    const y = Math.sign(s) * Math.abs(s) ** (2 / n) * r
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 16,
    curveSegments: 64,
  })
  g.translate(0, 0, -depth / 2)
  g.computeVertexNormals()
  return g
}

/** a wobbly liquid drop: a sphere pushed about by a few slow waves */
function blobGeometry(seed = 1, amount = 0.12) {
  const g = new THREE.IcosahedronGeometry(1, 48)
  const p = g.attributes.position
  const v = new THREE.Vector3()
  const a = [1.7 + seed * 0.31, 2.3 + seed * 0.17, 1.3 + seed * 0.23]
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize()
    const w =
      Math.sin(v.x * a[0] + seed) * Math.cos(v.y * a[1] - seed * 0.7) +
      0.6 * Math.sin(v.z * a[2] + v.x * 1.1 + seed * 1.9)
    v.multiplyScalar(1 + amount * w)
    p.setXYZ(i, v.x, v.y, v.z)
  }
  g.computeVertexNormals()
  return g
}

export function Piece({ kind, args = [], tint = false, frost = 0, glass = {}, ...props }) {
  const look = { ...SOLID, ...(tint ? TINTED : {}), ...(frost ? { roughness: frost, anisotropicBlur: 0.3 } : {}), ...glass }
  const geometry = useMemo(() => {
    switch (kind) {
      case 'sphere':
        return new THREE.SphereGeometry(1, 128, 96)
      case 'pill':
        return new THREE.CapsuleGeometry(args[0] ?? 0.5, args[1] ?? 2, 32, 96)
      case 'ring':
        return new THREE.TorusGeometry(args[0] ?? 1, args[1] ?? 0.34, 96, 192)
      case 'tile':
        return squircleGeometry(...args)
      case 'blob':
        return blobGeometry(...args)
      default:
        return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ...args])
  if (kind === 'box') {
    return (
      <RoundedBox args={args.slice(0, 3)} radius={args[3] ?? 0.2} smoothness={10} {...props}>
        <Glass {...look} />
      </RoundedBox>
    )
  }
  return (
    <mesh geometry={geometry} {...props}>
      <Glass {...look} />
    </mesh>
  )
}

function GlassQ({ glass = {}, tailGlass = {}, routes, children, ...props }) {
  const g = useMemo(() => puffyMarkGeometry({ depth: 70, bevel: 34, segments: 20 }), [])
  return (
    <group {...props}>
      {routes && <Prism routes={routes} />}
      {children}
      <group scale={S}>
        <mesh geometry={g.body}>
          <Glass resolution={2048} thickness={2.6} chromaticAberration={0.14} {...glass} />
        </mesh>
        <mesh geometry={g.tail} position-z={2}>
          <Glass
            resolution={2048}
            color="#b9c5ff"
            attenuationColor="#3b57ff"
            attenuationDistance={2.5}
            emissive="#2e4bff"
            emissiveIntensity={0.35}
            roughness={0.12}
            anisotropicBlur={0.2}
            chromaticAberration={0.05}
            backside={false}
            thickness={1.2}
            {...tailGlass}
          />
        </mesh>
      </group>
    </group>
  )
}

// ---- light -------------------------------------------------------------------------------------

const OUT = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0) // down the tail, outwards
const ALONG = new THREE.Vector3(Math.SQRT1_2, Math.SQRT1_2, 0) // along the tail's outer edge

/** a line of light: an HDR core the bloom catches and a faint halo */
export function Ray({ curve, radius, color, glow = 2.6, halo = 0.16, white = 0.2, spill = 0.03 }) {
  const parts = useMemo(() => {
    const c = new THREE.Color(color)
    return {
      core: new THREE.TubeGeometry(curve, 240, radius, 12, false),
      halo: new THREE.TubeGeometry(curve, 240, radius * 3.4, 12, false),
      spill: new THREE.TubeGeometry(curve, 240, radius * 16, 12, false),
      coreMat: new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color('#ffffff'), white).multiplyScalar(glow), toneMapped: false }),
      haloMat: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: halo, depthWrite: false, toneMapped: false }),
      spillMat: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: spill, depthWrite: false, toneMapped: false }),
    }
  }, [curve, radius, color, glow, halo, white, spill])
  return (
    <group>
      <mesh geometry={parts.core} material={parts.coreMat} />
      <mesh geometry={parts.halo} material={parts.haloMat} />
      {spill > 0 && <mesh geometry={parts.spill} material={parts.spillMat} />}
    </group>
  )
}

/** The Refractor in glass (mark-local units): a white fee beam runs down the Q's diagonal, through
 *  the counter and along the tail, and leaves the tail's outer edge as the four hook lines. */
function Prism({ routes, from = 12, radius = 0.03 }) {
  const exit = new THREE.Vector3(TAIL_EXIT[0] * S, TAIL_EXIT[1] * S, 0)
  const beam = useMemo(
    () => new THREE.LineCurve3(exit.clone().addScaledVector(OUT, -from), exit.clone().addScaledVector(OUT, -0.12)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from],
  )
  const curves = useMemo(
    () =>
      routes.map((r) => {
        const start = exit.clone().addScaledVector(ALONG, r.slot).addScaledVector(OUT, -0.12)
        const c1 = start.clone().addScaledVector(OUT, r.out ?? 1.2)
        return new THREE.CubicBezierCurve3(start, c1, exit.clone().add(new THREE.Vector3(...r.c2)), exit.clone().add(new THREE.Vector3(...r.end)))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes],
  )
  return (
    <group>
      <Ray curve={beam} radius={radius * 1.5} color="#ffffff" glow={3} halo={0.12} white={0} />
      {HOOKS.map((h, i) => (
        <Ray key={h.key} curve={curves[i]} radius={radius} color={h.color} />
      ))}
    </group>
  )
}

/** The four hook lines raking across the studio at 45° (y = x + c in world units), at depth z,
 *  behind the glass so it bends them. */
function Rake({ c = 0, pitch = 0.3, z = -5, radius = 0.035, length = 30 }) {
  const curves = useMemo(
    () =>
      HOOKS.map((_, i) => {
        const k = c + (i - 1.5) * pitch * Math.SQRT2
        const d = length / 2 / Math.SQRT2
        return new THREE.LineCurve3(new THREE.Vector3(-d - k / 2, -d + k / 2, z), new THREE.Vector3(d - k / 2, d + k / 2, z))
      }),
    [c, pitch, z, length],
  )
  return (
    <group>
      {HOOKS.map((h, i) => (
        <Ray key={h.key} curve={curves[i]} radius={radius} color={h.color} glow={3.4} halo={0.12} />
      ))}
    </group>
  )
}

/** What the glass reflects: softboxes and rim strips, and four small hook-coloured cards so the
 *  rims pick up the lines' colours. Cobalt: a dark studio with a faint cobalt floor bounce. Pearl:
 *  a light studio with black flags, so clear glass gets dark, defined edges. */
export function GlassStudio({ mood = 'cobalt' }) {
  const pearl = mood === 'pearl'
  return (
    <Environment resolution={1024} frames={1}>
      <color attach="background" args={[pearl ? '#b9c0ca' : '#05060b']} />
      <Lightformer form="rect" intensity={12} scale={[12, 0.7]} position={[0, 7, 3]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={12} scale={[0.4, 12]} position={[-8, 1, 3]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={8} scale={[0.3, 12]} position={[8, 0, 2]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={4} scale={[16, 0.2]} position={[0, 2.2, 9]} target={[0, 0, 0]} />
      <Lightformer form="circle" intensity={14} scale={1.2} position={[-4, 5, 7]} target={[0, 0, 0]} />
      {/* behind: white rims on the silhouettes */}
      <Lightformer form="rect" intensity={6} scale={[0.6, 14]} position={[-7, 0, -6]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={6} scale={[0.6, 14]} position={[7, 0, -6]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={5} scale={[14, 0.6]} position={[0, 6, -6]} target={[0, 0, 0]} />
      {pearl ? (
        <>
          <Lightformer form="rect" color="#000000" scale={[3, 14]} position={[-6, 0, 5]} target={[0, 0, 0]} />
          <Lightformer form="rect" color="#000000" scale={[3, 14]} position={[6, 0, 5]} target={[0, 0, 0]} />
          <Lightformer form="rect" color="#000000" scale={[18, 3]} position={[0, -6, 4]} target={[0, 0, 0]} />
        </>
      ) : (
        <Lightformer form="rect" color="#2e4bff" intensity={1.2} scale={[20, 6]} position={[0, -7, 2]} target={[0, 0, 0]} />
      )}
      {HOOKS.map((h, i) => (
        <Lightformer
          key={h.key}
          form="rect"
          color={h.color}
          intensity={5}
          scale={[0.35, 6]}
          position={[5 + i * 0.6, -1 + i * 0.6, 6]}
          rotation={[0, 0, -Math.PI / 4]}
          target={[0, 0, 0]}
        />
      ))}
    </Environment>
  )
}

/** screen-space backdrop: deep cobalt, a bright bloom of blue where the light comes from */
export function Backdrop({ width, height, glows, base = '#050a26' }) {
  const { scene } = useThree()
  useLayoutEffect(() => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const g = c.getContext('2d')
    g.fillStyle = base
    g.fillRect(0, 0, width, height)
    for (const { x, y, r, color, alpha = 1 } of glows) {
      const grad = g.createRadialGradient(x * width, y * height, 0, x * width, y * height, r * Math.max(width, height))
      // canvas wants sRGB: read the hex directly (THREE.Color would hand back linear values)
      const [cr, cg, cb] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      const rgba = (a) => `rgba(${cr},${cg},${cb},${a})`
      grad.addColorStop(0, rgba(alpha))
      grad.addColorStop(0.45, rgba(alpha * 0.45))
      grad.addColorStop(1, rgba(0))
      g.fillStyle = grad
      g.fillRect(0, 0, width, height)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    scene.background = tex
    return () => tex.dispose()
  }, [scene, width, height, glows, base])
  return null
}

// ---- camera, settling, post --------------------------------------------------------------------

export function Shot({ pos, target, fov }) {
  const { camera } = useThree()
  useLayoutEffect(() => {
    camera.position.set(...pos)
    camera.up.set(0, 1, 0)
    camera.lookAt(...target)
    camera.fov = fov
    camera.near = 0.1
    camera.far = 200
    camera.updateProjectionMatrix()
  }, [camera, pos, target, fov])
  return null
}

/** Each glass piece samples the others from the previous frame, so a still needs a few frames to
 *  settle: hold the render until they have run. */
function Settle({ frames = 4 }) {
  const advance = useThree((s) => s.advance)
  const { delayRender, continueRender } = useDelayRender()
  useEffect(() => {
    const handle = delayRender('Letting the glass settle')
    let n = 0
    let raf
    const step = () => {
      advance(performance.now())
      if (++n < frames) raf = requestAnimationFrame(step)
      else continueRender(handle)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [advance, frames, delayRender, continueRender])
  return null
}

export function Post({ focus, range = 3, bokeh = 4, bloom = 0.8, vignette = 0.4 }) {
  const { gl, scene, camera, size } = useThree()
  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 8 })
    c.addPass(new RenderPass(scene, camera))
    if (focus) c.addPass(new EffectPass(camera, new DepthOfFieldEffect(camera, { focusDistance: focus, focusRange: range, bokehScale: bokeh, resolutionScale: 1 })))
    c.addPass(
      new EffectPass(
        camera,
        new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.25, intensity: bloom, radius: 0.7 }),
      ),
    )
    const out = new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }), new VignetteEffect({ offset: 0.32, darkness: vignette }))
    out.dithering = true
    c.addPass(out)
    return c
  }, [gl, scene, camera, focus, range, bokeh, bloom, vignette])
  useLayoutEffect(() => composer.setSize(size.width, size.height), [composer, size])
  useLayoutEffect(() => () => composer.dispose(), [composer])
  useFrame((_, delta) => composer.render(delta), 1)
  return null
}

export function Stage({ width, height, background = '#050a26', children }) {
  return (
    <AbsoluteFill style={{ background }}>
      <ThreeCanvas
        width={width}
        height={height}
        dpr={1}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true }}
        camera={{ fov: 28, near: 0.1, far: 200, position: [0, 0, 16] }}
      >
        {children}
        <Settle />
      </ThreeCanvas>
    </AbsoluteFill>
  )
}

// ---- compositions ------------------------------------------------------------------------------

export const PINNED = { width: 3200, height: 1800 }
export const BANNER_PLATE = { width: 3000, height: 1000 }

const MOODS = {
  cobalt: {
    base: '#04061a',
    glows: [
      { x: 0.5, y: 0.5, r: 0.75, color: '#0e1e8e', alpha: 0.9 },
      { x: 0.56, y: 0.42, r: 0.42, color: '#2e4bff', alpha: 0.9 },
      { x: 0.63, y: 0.34, r: 0.18, color: '#8fa4ff', alpha: 0.6 },
    ],
  },
  pearl: {
    base: '#c9cfd8',
    glows: [
      { x: 0.55, y: 0.4, r: 0.6, color: '#fbfcfd', alpha: 1 },
      { x: 0.6, y: 0.36, r: 0.25, color: '#ffffff', alpha: 1 },
    ],
  },
}

function PinnedScene({ mood }) {
  const { width, height } = PINNED
  const m = MOODS[mood]
  return (
    <Stage width={width} height={height} background={m.base}>
      <Backdrop width={width} height={height} glows={m.glows} base={m.base} />
      <GlassStudio mood={mood} />
      <Shot pos={[0, 0, 16]} target={[0, 0, 0]} fov={28} />
      <ambientLight intensity={0.2} />
      <directionalLight position={[-5, 6, 8]} intensity={2.5} />

      <Rake c={1.5} z={-2} pitch={0.24} radius={0.02} />
      <GlassQ position={[0, 0.1, 0]} rotation={[0.14, -0.42, 0.03]} scale={1.28} glass={{ envMapIntensity: 2.2 }} />

      {/* far, soft */}
      <Piece kind="tile" args={[4.2, 0.36, 0.3]} position={[-8.2, 2.6, -8]} rotation={[0.2, 0.55, -0.35]} frost={0.2} />
      <Piece kind="tile" args={[3.4, 0.3, 0.24]} position={[8.4, -1.6, -8]} rotation={[0.25, -0.6, 0.5]} tint />
      <Piece kind="pill" args={[0.6, 2.6]} position={[-6.8, -3.6, -6]} rotation={[0.3, 0.3, -0.7]} frost={0.25} tint />
      {/* mid */}
      <Piece kind="pill" args={[0.42, 1.8]} position={[4.8, 3.0, -3]} rotation={[0.2, -0.2, -0.75]} frost={0.2} />
      <Piece kind="tile" args={[1.7, 0.2, 0.16]} position={[5.6, -1.2, -1.2]} rotation={[-0.25, -0.35, 0.5]} />
      <Piece kind="pill" args={[0.3, 1.0]} position={[-5.4, -0.9, -1.5]} rotation={[0.4, 0.3, 0.9]} />
      {/* droplets around the Q */}
      <Piece kind="sphere" position={[3.5, -2.6, 1.4]} scale={0.34} />
      <Piece kind="sphere" position={[-3.6, 2.6, 1.0]} scale={0.26} />
      <Piece kind="sphere" position={[2.9, 3.0, 0.8]} scale={0.15} />
      <Piece kind="sphere" position={[-3.0, -3.1, 0.6]} scale={0.18} />
      <Piece kind="sphere" position={[6.2, 1.2, 0.5]} scale={0.12} />

      <Post focus={16} range={4} bokeh={12} bloom={0.7} vignette={mood === 'pearl' ? 0.2 : 0.5} />
    </Stage>
  )
}

export const Pinned = () => <PinnedScene mood="cobalt" />
export const PinnedPearl = () => <PinnedScene mood="pearl" />

// The banner keeps its middle (where the HTML text goes) calm: glass at the edges, the hook lines
// on the right. Mobile apps crop about 140 px (of 1500) off each side and put the status bar over
// the top 125; desktop puts the avatar over the bottom left, so the left pieces sit high.
const BANNER_GLOWS = [
  { x: 0.5, y: 0.55, r: 0.6, color: '#0e1e8e', alpha: 0.9 },
  { x: 0.5, y: 0.5, r: 0.34, color: '#2e4bff', alpha: 0.75 },
  { x: 0.82, y: 0.35, r: 0.22, color: '#2e4bff', alpha: 0.8 },
  { x: 0.86, y: 0.3, r: 0.1, color: '#8fa4ff', alpha: 0.5 },
  { x: 0.12, y: 0.25, r: 0.18, color: '#2e4bff', alpha: 0.6 },
]

export function BannerPlate() {
  const { width, height } = BANNER_PLATE
  return (
    <Stage width={width} height={height} background="#04061a">
      <Backdrop width={width} height={height} glows={BANNER_GLOWS} base="#04061a" />
      <GlassStudio />
      <Shot pos={[0, 0, 16]} target={[0, 0, 0]} fov={20} />
      <ambientLight intensity={0.2} />
      <directionalLight position={[-5, 6, 8]} intensity={2.5} />

      <Rake c={-6.6} z={-2} pitch={0.2} radius={0.016} />

      {/* left, high */}
      <Piece kind="tile" args={[2.8, 0.26, 0.2]} position={[-7.7, 1.7, -4]} rotation={[0.25, 0.6, -0.4]} frost={0.2} />
      <Piece kind="pill" args={[0.26, 1.1]} position={[-6.2, 0.1, -0.8]} rotation={[0.3, 0.3, 0.85]} />
      <Piece kind="sphere" position={[-5.5, 1.9, 1]} scale={0.2} />
      <Piece kind="sphere" position={[-8.4, -0.2, 0.5]} scale={0.14} />
      {/* right, with the lines running behind */}
      <Piece kind="tile" args={[2.3, 0.22, 0.18]} position={[7.2, 0.5, -1.2]} rotation={[0.3, -0.55, 0.42]} />
      <Piece kind="pill" args={[0.3, 1.3]} position={[5.9, 1.9, -1.8]} rotation={[0.2, -0.2, -0.75]} frost={0.2} tint />
      <Piece kind="ring" args={[0.55, 0.21]} position={[5.8, -1.6, -0.3]} rotation={[0.5, -0.5, 0.2]} />
      <Piece kind="sphere" position={[8.3, -1.7, 0.6]} scale={0.34} />
      <Piece kind="sphere" position={[4.9, 0.4, 0.8]} scale={0.12} />

      <Post focus={16} range={4} bokeh={8} bloom={0.65} vignette={0.3} />
    </Stage>
  )
}
