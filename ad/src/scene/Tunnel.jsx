// Shot 5: a fly-through of the Q's counter, repeated into a chrome tunnel, with the four light
// lines running along its walls and sparks racing past the camera.
import { useMemo } from 'react'
import * as THREE from 'three'
import { useCurrentFrame } from 'remotion'
import { FPS, HOOKS } from '../timeline.js'
import { rand } from '../anim.js'
import { TUNNEL } from './layout.js'
import { Mark } from './ChromeQ.jsx'
import { glow, dotTexture } from './materials.js'

const RINGS = 22
const GAP = 7
const SCALE = 3.2

function streak(k) {
  const pts = []
  for (let z = 14; z >= -RINGS * GAP - 140; z -= 2) {
    const a = Math.PI / 4 + (k * Math.PI) / 2 + z * 0.028
    pts.push(new THREE.Vector3(Math.cos(a) * 2.45, Math.sin(a) * 2.45, z))
  }
  return new THREE.CatmullRomCurve3(pts)
}

export function Tunnel() {
  const t = useCurrentFrame() / FPS
  const lines = useMemo(
    () =>
      HOOKS.map((h, k) => {
        const curve = streak(k)
        return {
          h,
          curve,
          geo: new THREE.TubeGeometry(curve, 900, 0.018, 8, false),
          mat: glow(h.color, 2.6),
          spark: new THREE.SpriteMaterial({
            map: dotTexture(),
            color: new THREE.Color(h.glow).multiplyScalar(5),
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            toneMapped: false,
          }),
        }
      }),
    [],
  )
  if (t < 19.9 || t >= 25) return null

  return (
    <group position={TUNNEL}>
      {Array.from({ length: RINGS }, (_, i) => (
        <Mark key={i} position={[0, 0, -i * GAP]} rotation={[0, 0, i * 0.42 + t * 0.15]} scale={SCALE} />
      ))}
      {lines.map(({ h, geo, mat, curve, spark }, k) => (
        <group key={h.key}>
          <mesh geometry={geo} material={mat} />
          {Array.from({ length: 6 }, (_, j) => {
            // sparks lap the tunnel faster than the camera flies
            const s = (rand(k * 10 + j) + t * 0.32) % 1
            return <sprite key={j} material={spark} position={curve.getPointAt(s)} scale={0.5} />
          })}
        </group>
      ))}
    </group>
  )
}
