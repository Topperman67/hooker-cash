// The flywheel film's 3D world: the cobalt glass studio of the home page still, the camera for
// each frame, the machine, and a light post stack (bloom, tone mapping, vignette) that a CPU
// renderer can afford.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useThree, useFrame } from '@react-three/fiber'
import { useCurrentFrame } from 'remotion'
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ChromaticAberrationEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing'
import { Backdrop } from '../../social/Glass.jsx'
import { FlywheelStudio } from './Studio.jsx'
import { FPS, WIDTH, HEIGHT, CUES } from '../timeline.js'
import { pose } from '../camera.js'
import { spriteScale } from './fx.js'
import { Floor, Dust } from './Ambience.jsx'
import { Rotor } from './Rotor.jsx'
import { Trades } from './Trades.jsx'
import { Well } from './Well.jsx'
import { Holders } from './Holders.jsx'
import { Burn } from './Burn.jsx'
import { Ring } from './Ring.jsx'

const GLOWS = [
  { x: 0.5, y: 0.5, r: 0.8, color: '#0e1e8e', alpha: 0.85 },
  { x: 0.62, y: 0.3, r: 0.32, color: '#2e4bff', alpha: 0.6 },
  { x: 0.2, y: 0.28, r: 0.3, color: '#172dbe', alpha: 0.45 },
]

/** poses the camera for the frame before R3F renders it */
function Direction({ t }) {
  const { camera } = useThree()
  useLayoutEffect(() => {
    const p = pose(t)
    camera.position.set(...p.pos)
    camera.up.set(0, 1, 0)
    camera.lookAt(...p.target)
    camera.rotateZ(p.roll)
    camera.fov = p.fov
    camera.near = 0.1
    camera.far = 400
    camera.updateProjectionMatrix()
    spriteScale.value = HEIGHT / 2 / Math.tan(THREE.MathUtils.degToRad(p.fov / 2))
  }, [t, camera])
  return null
}

// Built synchronously, so the very first frame a render tab draws already has its effects.
function Effects({ t }) {
  const { gl, scene, camera, size } = useThree()
  const fx = useMemo(() => {
    const composer = new EffectComposer(gl, { frameBufferType: THREE.HalfFloatType, multisampling: 4 })
    composer.addPass(new RenderPass(scene, camera))
    const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.0, luminanceSmoothing: 0.3, intensity: 0.8, radius: 0.72 })
    const ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(), radialModulation: true, modulationOffset: 0.2 })
    composer.addPass(new EffectPass(camera, bloom))
    composer.addPass(new EffectPass(camera, ca))
    const out = new EffectPass(camera, new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL }), new VignetteEffect({ offset: 0.3, darkness: 0.5 }))
    out.dithering = true
    composer.addPass(out)
    return { composer, ca }
  }, [gl, scene, camera])
  useLayoutEffect(() => fx.composer.setSize(size.width, size.height), [fx, size])
  useLayoutEffect(() => () => fx.composer.dispose(), [fx])
  useLayoutEffect(() => {
    // a kick of chromatic aberration on the pour and the final hit only
    const hit = (at, k) => (t >= at ? k * Math.exp(-(t - at) * 9) : 0)
    const a = hit(CUES.pour + 0.25, 0.004) + hit(CUES.final, 0.006)
    fx.ca.offset.set(a, a * 0.6)
  }, [t, fx])
  useFrame((_, delta) => fx.composer.render(delta), 1)
  return null
}

export function World() {
  const t = useCurrentFrame() / FPS
  return (
    <>
      <Backdrop width={WIDTH} height={HEIGHT} glows={GLOWS} base="#04061a" />
      <FlywheelStudio />
      <ambientLight intensity={0.25} />
      <directionalLight position={[-4, 9, 6]} intensity={2.2} />
      <Direction t={t} />
      <Floor />
      <Dust t={t} />
      <Rotor t={t} />
      <Trades t={t} />
      <Well t={t} />
      <Holders t={t} />
      <Burn t={t} />
      <Ring t={t} />
      <Effects t={t} />
    </>
  )
}
