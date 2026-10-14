import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { MeshReflectorMaterial } from '@react-three/drei'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  DepthOfFieldEffect,
  ChromaticAberrationEffect,
  VignetteEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing'
import { useCurrentFrame } from 'remotion'
import { FPS, SHOTS } from '../timeline.js'
import { prog, ease } from '../anim.js'
import { pose, look } from './direction.js'
import { FLOOR_Y } from './layout.js'
import { Studio } from './Studio.jsx'
import { Mark } from './ChromeQ.jsx'
import { Beam } from './Beam.jsx'
import { HookLines } from './HookLines.jsx'
import { Payoffs } from './Payoffs.jsx'
import { Tunnel } from './Tunnel.jsx'
import { EndLockup } from './EndLockup.jsx'

/** applies the camera and the studio look for the current frame, before R3F renders it */
function Direction() {
  const frame = useCurrentFrame()
  const { camera, scene } = useThree()
  useLayoutEffect(() => {
    const t = frame / FPS
    const p = pose(t)
    camera.position.set(...p.pos)
    camera.up.set(0, 1, 0)
    camera.lookAt(...p.target)
    camera.rotateZ(p.roll)
    camera.fov = p.fov
    camera.near = 0.1
    camera.far = 400
    camera.updateProjectionMatrix()

    const L = look(t)
    scene.background.set(L.bg)
    scene.fog.color.set(L.bg)
    scene.fog.density = L.fog
    scene.environmentIntensity = L.env
    scene.environmentRotation.set(0, L.envRot, 0)
  }, [frame, camera, scene])
  return null
}

function Floor() {
  const frame = useCurrentFrame()
  const material = useRef()
  // Set on the material itself each frame: a mutated Color passed as a prop keeps its identity,
  // so R3F would never re-apply it and a render tab would keep its first frame's floor.
  useLayoutEffect(() => {
    const m = material.current
    m.color.set(look(frame / FPS).bg)
    m.emissive.copy(m.color)
    // in the pearl studio the floor glows pearl itself, so it reads as one seamless sweep with
    // the backdrop instead of picking up the dark parts of the environment
    const lum = 0.2126 * m.color.r + 0.7152 * m.color.g + 0.0722 * m.color.b
    m.emissiveIntensity = THREE.MathUtils.clamp((lum - 0.1) / 0.6, 0, 1) * 0.8
  }, [frame])
  return (
    <mesh rotation-x={-Math.PI / 2} position={[60, FLOOR_Y, -40]}>
      <planeGeometry args={[500, 500]} />
      <MeshReflectorMaterial
        ref={material}
        resolution={1024}
        blur={[400, 120]}
        mixBlur={1}
        mixStrength={0.9}
        mirror={0.6}
        roughness={0.9}
        metalness={0.3}
        depthScale={0.8}
        minDepthThreshold={0.3}
        maxDepthThreshold={1.4}
      />
    </mesh>
  )
}

function HeroQ() {
  const t = useCurrentFrame() / FPS
  // a gentle sway while it is the hero, settled before the lines attach to its tail
  const sway = t < SHOTS.refraction.from ? Math.sin((t - 4) * 1.1) * 0.09 * (1 - ease.sine(prog(t, 6.8, 8))) : 0
  return <Mark visible={t < SHOTS.headline.from} rotation={[sway * 0.3, sway, 0]} />
}

// Built synchronously (not via @react-three/postprocessing, whose composer appears a render
// later), so the very first frame a render tab draws already has its effects.
function Effects() {
  const frame = useCurrentFrame()
  const { gl, scene, camera, size } = useThree()
  const fx = useMemo(() => {
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 8 })
    composer.addPass(new RenderPass(scene, camera))
    const dof = new DepthOfFieldEffect(camera, { worldFocusRange: 5, bokehScale: 3 })
    dof.target = new THREE.Vector3()
    const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.95, luminanceSmoothing: 0.25, intensity: 0.85, radius: 0.72 })
    const ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(), radialModulation: true, modulationOffset: 0.15 })
    composer.addPass(new EffectPass(camera, dof))
    composer.addPass(new EffectPass(camera, bloom))
    composer.addPass(new EffectPass(camera, ca))
    composer.addPass(
      new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }), new VignetteEffect({ offset: 0.28, darkness: 0.5 })),
    )
    return { composer, dof, ca }
  }, [gl, scene, camera])
  useLayoutEffect(() => fx.composer.setSize(size.width, size.height), [fx, size])
  useLayoutEffect(() => () => fx.composer.dispose(), [fx])

  useLayoutEffect(() => {
    const t = frame / FPS
    const tunnel = t >= SHOTS.headline.from && t < SHOTS.end.from
    fx.dof.target.set(...pose(t).target)
    fx.dof.cocMaterial.worldFocusRange = tunnel ? 30 : 5
    fx.dof.bokehScale = tunnel ? 1.5 : 3
    const ca = look(t).ca
    fx.ca.offset.set(ca, ca * 0.6)
  }, [frame, fx])

  useFrame((_, delta) => fx.composer.render(delta), 1)
  return null
}

export function World() {
  return (
    <>
      <color attach="background" args={['#000000']} />
      <fogExp2 attach="fog" args={['#000000', 0.02]} />
      <Studio />
      <Direction />
      <Floor />
      <HeroQ />
      <Beam />
      <HookLines />
      <Payoffs />
      <Tunnel />
      <EndLockup />
      <Effects />
    </>
  )
}
