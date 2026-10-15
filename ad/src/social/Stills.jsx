// Still compositions for the Twitter/X profile images: the chrome Q from the ad, shot as a
// product photo in the pearl studio. Text is added afterwards in HTML (social/drafts/render3d/).
// Rendered at 2x (Avatar 800×800, Banner 3000×1000) and scaled down for clean edges.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { AbsoluteFill } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import { useThree, useFrame } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { markGeometry, TAIL_EXIT } from '../scene/logoGeometry.js'
import { HOOKS } from '../timeline.js'

const S = 0.01 // SVG units → world (the Q is about 4.2 across)

// ---- materials -------------------------------------------------------------------------------

// Black chrome (DESIGN.md: the lockup on pearl). A mid-grey metal base so the studio's bands come
// through as the mark's chrome gradient: black where it faces the dark, white where it faces a box.
const inkChrome = new THREE.MeshPhysicalMaterial({
  color: '#7d8593',
  metalness: 1,
  roughness: 0.04,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
})
const silverChrome = new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 0.035 })
const cobalt = new THREE.MeshPhysicalMaterial({
  color: '#3552ff',
  metalness: 1,
  roughness: 0.18,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
})

// ---- studio ----------------------------------------------------------------------------------

/** Orientation for the studio so the mark's (rotated) face reflects it as a frontal face would:
 *  local +z of the returned frame is the direction the face's centre mirrors the camera into. */
function faceFrame(markRot, markPos, camPos) {
  const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...markRot))
  const v = new THREE.Vector3(...markPos).sub(new THREE.Vector3(...camPos)).normalize()
  const r = v.clone().sub(n.multiplyScalar(2 * v.dot(n))).normalize()
  return [Math.asin(-r.y), Math.atan2(r.x, r.z), 0]
}

/** The studio the chrome reflects, laid out like the ad's (scene/Studio.jsx) around the face's
 *  mirror direction: bright sky, a dark horizon, a lighter floor, strip boxes for the bevels, and
 *  the four light lines as a tight group of hairline strips at 45°, crossing the face as crisp,
 *  separate lines. `lines.c` moves the group along the face's diagonal (0 = through the centre,
 *  positive = towards the upper left); `lines.k` converts face units into studio units. */
function StillStudio({ frame, lines }) {
  const k = lines.k
  return (
    <Environment resolution={1024} frames={1}>
      <color attach="background" args={['#1c2027']} />
      <group rotation={[frame[0], frame[1], 0, 'YXZ']}>
        <Lightformer form="rect" intensity={2.4} scale={[30, 3.2]} position={[0, 1.6, 9]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.3} scale={[30, 4]} position={[0, 5.2, 8]} target={[0, 0, 0]} />
        <Lightformer form="rect" color="#ffffff" intensity={6} scale={[30, 0.16]} position={[0, -0.1, 9]} target={[0, 0, 0]} />
        <Lightformer form="rect" color="#cfd5de" intensity={1.2} scale={[30, 2.6]} position={[0, -2.6, 9]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={2.6} scale={[10, 8]} position={[0, 8, -1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={3.2} scale={[1.4, 14]} position={[-7, 0.5, 1.5]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={2.6} scale={[1.0, 14]} position={[7, 0.5, 0.5]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.8} scale={[16, 1.2]} position={[0, 2.5, -8]} target={[0, 0, 0]} />
        {HOOKS.map((h, i) => {
          // a line y = x + c on the face; its studio twin sits at z 9, scaled by k
          const c = (lines.c - (i - 1.5) * lines.pitch) * k
          return (
            <Lightformer
              key={h.key}
              form="rect"
              color={h.color}
              intensity={lines.intensity}
              scale={[lines.width * k, 30]}
              position={[-c / 2, c / 2, 9]}
              rotation={[0, 0, -Math.PI / 4]}
            />
          )
        })}
      </group>
    </Environment>
  )
}

/** screen-space backdrop: a pearl sweep, brightest behind the subject */
function useBackdrop({ width, height, cx, cy, inner = '#fbfcfd', outer = '#d9dee5', r = 0.8 }) {
  const { scene } = useThree()
  useLayoutEffect(() => {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(cx * width, cy * height, 0, cx * width, cy * height, r * Math.max(width, height))
    grad.addColorStop(0, inner)
    grad.addColorStop(1, outer)
    g.fillStyle = grad
    g.fillRect(0, 0, width, height)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    scene.background = tex
    return () => tex.dispose()
  }, [scene, width, height, cx, cy, inner, outer, r])
}

// ---- the mark and its lines ------------------------------------------------------------------

function StillMark({ metal = 'black', tail = cobalt, ...props }) {
  const body = metal === 'silver' ? silverChrome : inkChrome
  const g = useMemo(markGeometry, [])
  return (
    <group {...props}>
      <group scale={S}>
        <mesh geometry={g.body} material={body} castShadow />
        <mesh geometry={g.tail} material={tail} position-z={4} castShadow />
      </group>
    </group>
  )
}

const OUT = new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0) // the tail edge's outward normal
const ALONG = new THREE.Vector3(Math.SQRT1_2, Math.SQRT1_2, 0) // along the tail edge

/** four lines leaving the tail's outer edge (in the mark's local space), fanning by `routes` */
function TailLines({ routes, radius = 0.032 }) {
  const tail = new THREE.Vector3(TAIL_EXIT[0] * S, TAIL_EXIT[1] * S, 0)
  const parts = useMemo(
    () =>
      HOOKS.map((h, i) => {
        const r = routes[i]
        const start = tail.clone().addScaledVector(ALONG, r.slot).addScaledVector(OUT, -0.05)
        const c1 = start.clone().addScaledVector(OUT, r.out ?? 1.2)
        const c2 = tail.clone().add(new THREE.Vector3(...r.c2))
        const end = tail.clone().add(new THREE.Vector3(...r.end))
        const curve = new THREE.CubicBezierCurve3(start, c1, c2, end)
        const color = new THREE.Color(h.color)
        return {
          key: h.key,
          core: new THREE.TubeGeometry(curve, 200, radius, 12, false),
          halo: new THREE.TubeGeometry(curve, 200, radius * 3.2, 12, false),
          coreMat: new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color('#ffffff'), 0.18).multiplyScalar(1.6), toneMapped: false }),
          haloMat: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false }),
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, radius],
  )
  return (
    <group scale={1}>
      {parts.map((p) => (
        <group key={p.key}>
          <mesh geometry={p.core} material={p.coreMat} />
          <mesh geometry={p.halo} material={p.haloMat} />
        </group>
      ))}
    </group>
  )
}

/** a soft shadow catcher behind the mark */
function ShadowWall({ z = -2.5, opacity = 0.22 }) {
  return (
    <mesh position={[0, 0, z]} receiveShadow>
      <planeGeometry args={[80, 40]} />
      <shadowMaterial transparent opacity={opacity} color="#1b2230" />
    </mesh>
  )
}

function KeyLight({ position = [-5, 7, 9], radius = 18 }) {
  const light = useMemo(() => {
    const l = new THREE.DirectionalLight('#ffffff', 2)
    l.castShadow = true
    l.shadow.mapSize.set(2048, 2048)
    l.shadow.camera.left = -8
    l.shadow.camera.right = 8
    l.shadow.camera.top = 8
    l.shadow.camera.bottom = -8
    l.shadow.camera.near = 0.5
    l.shadow.camera.far = 40
    l.shadow.radius = radius
    l.shadow.blurSamples = 25
    l.shadow.bias = -0.0005
    return l
  }, [radius])
  return <primitive object={light} position={position} />
}

// ---- camera + post ---------------------------------------------------------------------------

function Shot({ pos, target, fov }) {
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

function Post({ bloom = 0.7, vignette = 0.35 }) {
  const { gl, scene, camera, size } = useThree()
  const composer = useMemo(() => {
    const c = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 8 })
    c.addPass(new RenderPass(scene, camera))
    c.addPass(
      new EffectPass(
        camera,
        new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.2, intensity: bloom, radius: 0.6 }),
      ),
    )
    c.addPass(
      new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }), new VignetteEffect({ offset: 0.3, darkness: vignette })),
    )
    return c
  }, [gl, scene, camera, bloom, vignette])
  useLayoutEffect(() => composer.setSize(size.width, size.height), [composer, size])
  useLayoutEffect(() => () => composer.dispose(), [composer])
  useFrame((_, delta) => composer.render(delta), 1)
  return null
}

function Backdrop(props) {
  useBackdrop(props)
  return null
}

function Stage({ width, height, children }) {
  return (
    <AbsoluteFill style={{ background: '#e9ecf0' }}>
      <ThreeCanvas
        width={width}
        height={height}
        dpr={1}
        shadows="variance"
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true }}
        camera={{ fov: 30, near: 0.1, far: 200, position: [0, 0, 14] }}
      >
        {children}
      </ThreeCanvas>
    </AbsoluteFill>
  )
}

// ---- compositions ----------------------------------------------------------------------------

export const AVATAR = { width: 800, height: 800 }
export const BANNER = { width: 3000, height: 1000 }

// Lines out of the avatar's tail: short, steep, running off the circle at the lower right.
const AVATAR_ROUTES = [
  { slot: 0.27, out: 0.8, c2: [2.2, 0.4, -0.4], end: [4.2, 0.6, -0.8] },
  { slot: 0.09, out: 0.8, c2: [2.0, -0.6, 0.0], end: [3.8, -1.2, 0.0] },
  { slot: -0.09, out: 0.8, c2: [1.5, -1.5, 0.3], end: [2.8, -3.0, 0.4] },
  { slot: -0.27, out: 0.8, c2: [0.6, -2.0, 0.2], end: [1.0, -4.2, 0.2] },
]

export function Avatar() {
  const { width, height } = AVATAR
  return (
    <Stage width={width} height={height}>
      <Backdrop width={width} height={height} cx={0.42} cy={0.36} inner="#ffffff" outer="#cfd5dd" r={0.75} />
      <StillStudio lines={{ x: -2.9, y: 0.4, gap: 0.26, width: 0.09, intensity: 7 }} />
      <Shot pos={[0.3, 0.25, 14]} target={[0.3, -0.25, 0]} fov={26} />
      <ambientLight intensity={0} />
      <KeyLight position={[-5, 7, 10]} radius={22} />
      <group rotation={[0.1, -0.32, 0.0]}>
        <StillMark />
        <TailLines routes={AVATAR_ROUTES} radius={0.045} />
      </group>
      <ShadowWall z={-2.6} opacity={0.2} />
      <Post bloom={0.6} vignette={0.25} />
    </Stage>
  )
}

// Banner lines: the homepage Refractor's fan, run long so they leave the frame on the right.
const BANNER_ROUTES = [
  { slot: 0.27, out: 1.4, c2: [4.0, 2.2, -1.0], end: [12, 3.2, -2.0] },
  { slot: 0.09, out: 1.4, c2: [4.2, 0.2, 0.2], end: [12, 0.2, 0.6] },
  { slot: -0.09, out: 1.4, c2: [3.6, -2.6, 0.8], end: [10, -4.6, 1.2] },
  { slot: -0.27, out: 1.4, c2: [1.4, -3.4, 0.4], end: [2.6, -8, 0.4] },
]

export function Banner() {
  const { width, height } = BANNER
  return (
    <Stage width={width} height={height}>
      <Backdrop width={width} height={height} cx={0.68} cy={0.4} inner="#ffffff" outer="#d3d9e0" r={0.6} />
      <StillStudio lines={{ x: -2.9, y: 0.4, gap: 0.26, width: 0.09, intensity: 7 }} />
      <Shot pos={[-3.2, 0.3, 17]} target={[-3.2, 0, 0]} fov={24} />
      <KeyLight position={[-6, 7, 10]} radius={22} />
      <group position={[2.4, 0.1, 0]} rotation={[0.08, -0.38, 0.0]}>
        <StillMark />
        <TailLines routes={BANNER_ROUTES} radius={0.034} />
      </group>
      <ShadowWall z={-2.8} opacity={0.18} />
      <Post bloom={0.6} vignette={0.2} />
    </Stage>
  )
}
