// Shared materials, per DESIGN.md: polished silver chrome, cobalt-anodised metal, graphite.
import * as THREE from 'three'

export const chrome = new THREE.MeshPhysicalMaterial({
  color: '#ffffff',
  metalness: 1,
  roughness: 0.035,
})

/** the lockup on pearl is black chrome (DESIGN.md: lockup-light) */
export const blackChrome = new THREE.MeshPhysicalMaterial({
  color: '#3a414c',
  metalness: 1,
  roughness: 0.06,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
})

export const cobalt = new THREE.MeshPhysicalMaterial({
  color: '#3552ff',
  metalness: 1,
  roughness: 0.2,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
})

export const graphite = new THREE.MeshPhysicalMaterial({
  color: '#262b34',
  metalness: 0.55,
  roughness: 0.32,
  clearcoat: 0.8,
  clearcoatRoughness: 0.12,
})

export const darkSlot = new THREE.MeshStandardMaterial({ color: '#05060a', roughness: 0.9 })

/** an unlit, HDR-bright colour for light lines and sparks (bloom picks it up) */
export function glow(hex, intensity = 2.5, extra = {}) {
  const color = new THREE.Color(hex).multiplyScalar(intensity)
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra })
}

// Soft round sprite for dust, embers and line heads, drawn once.
let dot
export function dotTexture() {
  if (dot) return dot
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  r.addColorStop(0, 'rgba(255,255,255,1)')
  r.addColorStop(0.25, 'rgba(255,255,255,0.65)')
  r.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = r
  g.fillRect(0, 0, 64, 64)
  dot = new THREE.CanvasTexture(c)
  dot.colorSpace = THREE.SRGBColorSpace
  return dot
}
