// The four hook lines leaving the Q's tail: each draws itself on its beat, flares where it
// lands, and in shot 4 carries a coloured pulse on every bar.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useCurrentFrame } from 'remotion'
import { FPS, CUES, DRAW } from '../timeline.js'
import { prog, ease } from '../anim.js'
import { LINES } from './layout.js'
import { glow, dotTexture } from './materials.js'

const SEGMENTS = 220
const RADIAL = 10

/** 0..1, how much of a hook's line is drawn at time t */
export const lineReach = (hook, t) => ease.out(prog(t, hook.at, hook.at + DRAW))

function spriteMaterial(hex, intensity) {
  return new THREE.SpriteMaterial({
    map: dotTexture(),
    color: new THREE.Color(hex).multiplyScalar(intensity),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  })
}

function Line({ hook, curve, end, t }) {
  const parts = useMemo(() => {
    const core = new THREE.TubeGeometry(curve, SEGMENTS, 0.026, RADIAL, false)
    const halo = new THREE.TubeGeometry(curve, SEGMENTS, 0.075, RADIAL, false)
    const white = new THREE.Color(hook.color).lerp(new THREE.Color('#ffffff'), 0.35)
    return {
      core,
      halo,
      coreMat: new THREE.MeshBasicMaterial({ color: white.multiplyScalar(3.2), toneMapped: false }),
      haloMat: glow(hook.color, 1.4, { transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
      head: spriteMaterial(hook.glow, 4),
      flash: spriteMaterial(hook.glow, 5),
    }
  }, [curve, hook])

  const reach = t < 8 ? 0 : lineReach(hook, t)
  useLayoutEffect(() => {
    const n = Math.floor(reach * SEGMENTS) * RADIAL * 6
    parts.core.setDrawRange(0, n)
    parts.halo.setDrawRange(0, n)
  }, [reach, parts])

  const drawing = reach > 0 && reach < 1
  const landed = t - (hook.at + DRAW)
  const flash = landed >= 0 && landed < 0.4 ? 1 - landed / 0.4 : 0
  parts.flash.opacity = flash
  const pulses = CUES.pulses
    .map((at) => prog(t, at + 0.5, at + 1.45))
    .filter((q) => q > 0 && q < 1)

  return (
    <group visible={reach > 0 && t < 20}>
      <mesh geometry={parts.core} material={parts.coreMat} />
      <mesh geometry={parts.halo} material={parts.haloMat} />
      {drawing && <sprite material={parts.head} position={curve.getPointAt(reach)} scale={0.9} />}
      {flash > 0 && <sprite material={parts.flash} position={end} scale={0.5 + 2.6 * ease.out(1 - flash)} />}
      {pulses.map((q, i) => (
        <sprite key={i} material={parts.head} position={curve.getPointAt(ease.inOut(q))} scale={0.75} />
      ))}
    </group>
  )
}

export function HookLines() {
  const t = useCurrentFrame() / FPS
  return (
    <group>
      {LINES.map((l) => (
        <Line key={l.hook.key} {...l} t={t} />
      ))}
    </group>
  )
}
