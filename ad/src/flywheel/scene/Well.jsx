// The well: a glass orb above the flywheel where the fee collects as white light. On the downbeat
// of every bar from CUES.pour it empties down a 45° beam onto the seam between the slices, where
// the light refracts: green one way round the wheel, pink the other.
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { WELL, WELL_R, POUR_CURVE, POURS, SPLIT_POINT, TRADES, SLIVER_FLIGHT, wellFill } from '../layout.js'
import { CUES, COLORS } from '../timeline.js'
import { prog, ease, rand } from '../../anim.js'
import { makeSprites, makeLine, hdr } from './fx.js'

const SPARKS = 40
const BURST = 48
const PACKET = 14

const shell = new THREE.MeshPhysicalMaterial({
  color: '#dfe5ff',
  metalness: 0,
  roughness: 0.04,
  transmission: 1,
  thickness: 0.6,
  ior: 1.3,
  attenuationColor: new THREE.Color('#8fa4ff'),
  attenuationDistance: 3,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
  envMapIntensity: 1.6,
  emissive: new THREE.Color('#2e4bff'),
  emissiveIntensity: 0.12,
})
// a cool fresnel rim, so it reads as a glass orb rather than a disc
shell.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <emissivemap_fragment>',
    `#include <emissivemap_fragment>
      float fres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.4);
      totalEmissiveRadiance += vec3(0.55, 0.65, 1.6) * fres;`,
  )
}
shell.customProgramCacheKey = () => 'flywheel-well'

/** the brightness of the newest pour at t (1 as it leaves the well, fading over the bar) */
export function pourPulse(t) {
  const last = POURS.filter((p) => p <= t).pop()
  if (last === undefined) return 0
  return Math.exp(-(t - last) * 3.2)
}

/** 1 while the machine runs, falling to 0 as the finale clears the frame for the arrows */
export const finaleAway = (t) => 1 - ease.inOut(prog(t, CUES.arrows - 0.5, CUES.final))

export function Well({ t }) {
  const core = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff' }), [])
  const sparks = useMemo(() => makeSprites(SPARKS), [])
  const burst = useMemo(() => makeSprites(BURST + PACKET * 3), [])
  const beam = useMemo(() => makeLine(POUR_CURVE, { radius: 0.03, color: '#dfe5ff', glow: 3.2, white: 0.5, halo: 0.14, spill: 0.03 }), [])
  const seeds = useMemo(
    () =>
      Array.from({ length: SPARKS }, (_, i) => ({
        r: 0.12 + 0.36 * Math.cbrt(rand(i + 7000)),
        a: rand(i + 7100) * Math.PI * 2,
        tilt: (rand(i + 7200) - 0.5) * 2.2,
        w: 1.5 + 2.5 * rand(i + 7300),
      })),
    [],
  )
  const burstSeeds = useMemo(
    () =>
      Array.from({ length: BURST }, (_, i) => ({
        d: new THREE.Vector3(rand(i + 8000) - 0.5, rand(i + 8100) * 0.9, rand(i + 8200) - 0.5).normalize(),
        v: 1.5 + 3 * rand(i + 8300),
        green: i % 2 === 0,
      })),
    [],
  )

  const fill = wellFill(t)
  const away = finaleAway(t)
  // the well grows in before the first slices arrive, and bows out for the finale
  const present = ease.outBack(prog(t, 2.6, 3.5)) * away
  // a little kick each time a sliver lands in it
  let land = 0
  for (const tr of TRADES) {
    if (!tr.fee) continue
    const at = tr.T + SLIVER_FLIGHT
    if (at <= t && t - at < 0.4) land += Math.exp(-(t - at) * 12)
  }
  const pulse = pourPulse(t)

  useLayoutEffect(() => {
    // sparks swirling inside the well, more as it fills
    sparks.clear()
    const tmp = new THREE.Vector3()
    const ice = hdr('#ffffff', 2.4)
    seeds.forEach((s, i) => {
      if (i / SPARKS > 0.15 + fill) return
      const a = s.a + t * s.w
      tmp.set(Math.cos(a) * s.r, Math.sin(a) * s.r * Math.sin(s.tilt), Math.sin(a) * s.r * Math.cos(s.tilt)).multiplyScalar(present).add(WELL)
      sparks.set(i, tmp, 0.06, ice, present * (0.5 + 0.5 * Math.sin(t * 7 + i)))
    })
    sparks.commit()

    // the pour: a packet of light down the beam on each bar, and a burst where it lands
    burst.clear()
    const last = POURS.filter((p) => p <= t).pop()
    if (last !== undefined && away > 0.05) {
      const u = t - last
      const travel = 0.25
      const green = hdr(COLORS.holdersLight, 3)
      const pink = hdr(COLORS.burnLight, 3)
      const white = hdr('#ffffff', 4)
      if (u < travel + 0.1) {
        for (let k = 0; k < PACKET; k++) {
          const p = Math.min(1, Math.max(0, (u - k * 0.012) / travel))
          POUR_CURVE.getPoint(ease.in(p), tmp)
          burst.set(BURST + k, tmp, k === 0 ? 0.55 : 0.2 * (1 - k / PACKET), white, (1 - k / PACKET) * (u < travel ? 1 : 1 - (u - travel) / 0.1))
        }
      }
      const since = u - travel
      if (since >= 0 && since < 1.2) {
        // the first pour is the big one
        const big = last === CUES.pour ? 1.6 : 0.8
        burstSeeds.forEach((s, i) => {
          tmp.copy(SPLIT_POINT).addScaledVector(s.d, s.v * since * big * 0.55)
          tmp.y -= 1.5 * since * since
          burst.set(i, tmp, 0.08, s.green ? green : pink, Math.max(0, 1 - since / 0.9) * big)
        })
        burst.set(BURST + PACKET, SPLIT_POINT, 1.6 * big, white, Math.exp(-since * 7))
      }
    }
    burst.commit()

    // the beam draws down on the first pour, glows with each one, and retracts for the finale
    const draw = ease.in(prog(t, CUES.pour, CUES.pour + 0.25))
    beam.reveal(0, draw * away, draw > 0 ? 0.35 + 0.65 * pulse : 0)
  }, [t, sparks, burst, beam, seeds, burstSeeds, fill, present, away, pulse])

  core.color.copy(hdr('#e8edff', 1.2 + 1.6 * fill + 1.5 * land, 0))
  const coreScale = (0.1 + 0.42 * Math.cbrt(fill)) * (1 + 0.12 * land) * WELL_R
  return (
    <group>
      <group position={WELL} scale={Math.max(0.0001, present)} visible={present > 0.001}>
        <mesh material={shell}>
          <sphereGeometry args={[WELL_R, 64, 48]} />
        </mesh>
        <mesh material={core} scale={coreScale} visible={fill > 0.01 || land > 0.01}>
          <sphereGeometry args={[1, 32, 24]} />
        </mesh>
      </group>
      <primitive object={sparks.points} />
      <primitive object={burst.points} />
      <primitive object={beam.group} />
    </group>
  )
}
