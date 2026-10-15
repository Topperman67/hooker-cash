// Shared pieces for the site's live WebGL scenes (the hero Q and the fee flywheel), ported from the
// ad studio's liquid-glass stills (ad/src/social/Glass.jsx). Everything here is imported only by
// lazily loaded scene modules, so three.js stays out of the main bundle.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { Environment, Lightformer } from '@react-three/drei'

/** The four light lines, in hook order (DESIGN.md: blue, pink, green, yellow). */
export const LINE_COLORS = {
  creator: '#2E4BFF',
  burn: '#FF3EA5',
  entangle: '#12C26E',
  fusion: '#FFC21A',
}
export const LINES = [
  LINE_COLORS.creator,
  LINE_COLORS.burn,
  LINE_COLORS.entangle,
  LINE_COLORS.fusion,
]

/** Clear liquid glass for drei's MeshTransmissionMaterial: thick, lensing, barely dispersive. */
export const CLEAR_GLASS = {
  samples: 8,
  thickness: 1.4,
  roughness: 0,
  ior: 1.45,
  chromaticAberration: 0.06,
  anisotropicBlur: 0.08,
  distortion: 0,
  clearcoat: 1,
  clearcoatRoughness: 0,
  envMapIntensity: 1.6,
  color: '#ffffff',
  attenuationColor: '#e8eeff',
  attenuationDistance: 3,
}

/** A line of light: an HDR core plus a faint halo (and optional wide spill). */
export function Ray({
  curve,
  radius,
  color,
  glow = 2.6,
  halo = 0.16,
  white = 0.2,
  spill = 0.03,
  segments = 200,
}) {
  const parts = useMemo(() => {
    const c = new THREE.Color(color)
    return {
      core: new THREE.TubeGeometry(curve, segments, radius, 12, false),
      halo: new THREE.TubeGeometry(curve, segments, radius * 3.4, 12, false),
      spill: spill > 0 ? new THREE.TubeGeometry(curve, segments, radius * 16, 12, false) : null,
      coreMat: new THREE.MeshBasicMaterial({
        color: c.clone().lerp(new THREE.Color('#ffffff'), white).multiplyScalar(glow),
        toneMapped: false,
      }),
      haloMat: new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: halo,
        depthWrite: false,
        toneMapped: false,
      }),
      spillMat: new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: spill,
        depthWrite: false,
        toneMapped: false,
      }),
    }
  }, [curve, radius, color, glow, halo, white, spill, segments])
  useEffect(() => () => Object.values(parts).forEach((p) => p?.dispose?.()), [parts])
  return (
    <group>
      <mesh geometry={parts.core} material={parts.coreMat} />
      <mesh geometry={parts.halo} material={parts.haloMat} />
      {parts.spill && <mesh geometry={parts.spill} material={parts.spillMat} />}
    </group>
  )
}

/**
 * What the glass reflects: softboxes and rim strips, plus four hook-coloured cards so the rims pick
 * up the lines' colours. 'pearl' is a light studio with black flags (clear glass gets dark, defined
 * edges on a light page); 'cobalt' is a dark studio with a cobalt floor bounce.
 */
export function GlassStudio({ mood = 'cobalt', resolution = 512 }) {
  const pearl = mood === 'pearl'
  return (
    <Environment resolution={resolution} frames={1}>
      <color attach="background" args={[pearl ? '#b9c0ca' : '#05060b']} />
      <Lightformer
        form="rect"
        intensity={12}
        scale={[12, 0.7]}
        position={[0, 7, 3]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={12}
        scale={[0.4, 12]}
        position={[-8, 1, 3]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={8}
        scale={[0.3, 12]}
        position={[8, 0, 2]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={4}
        scale={[16, 0.2]}
        position={[0, 2.2, 9]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="circle"
        intensity={14}
        scale={1.2}
        position={[-4, 5, 7]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={6}
        scale={[0.6, 14]}
        position={[-7, 0, -6]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={6}
        scale={[0.6, 14]}
        position={[7, 0, -6]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={5}
        scale={[14, 0.6]}
        position={[0, 6, -6]}
        target={[0, 0, 0]}
      />
      {pearl ? (
        <>
          <Lightformer
            form="rect"
            color="#000000"
            scale={[3, 14]}
            position={[-6, 0, 5]}
            target={[0, 0, 0]}
          />
          <Lightformer
            form="rect"
            color="#000000"
            scale={[3, 14]}
            position={[6, 0, 5]}
            target={[0, 0, 0]}
          />
          <Lightformer
            form="rect"
            color="#000000"
            scale={[18, 3]}
            position={[0, -6, 4]}
            target={[0, 0, 0]}
          />
        </>
      ) : (
        <Lightformer
          form="rect"
          color="#2e4bff"
          intensity={1.2}
          scale={[20, 6]}
          position={[0, -7, 2]}
          target={[0, 0, 0]}
        />
      )}
      {LINES.map((color, i) => (
        <Lightformer
          key={color}
          form="rect"
          color={color}
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

/** A soft round sprite (dust, line heads, glow pools), drawn once per page. */
let dot
export function dotTexture() {
  if (dot) return dot
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.25, 'rgba(255,255,255,0.6)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 128, 128)
  dot = new THREE.CanvasTexture(c)
  dot.colorSpace = THREE.SRGBColorSpace
  return dot
}
