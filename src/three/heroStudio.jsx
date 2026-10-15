// What the hero glass reflects. Clear glass reads as glass by what surrounds it: a near-black
// studio keeps its faces clear (glass reflects little face-on) and turns the deep bevels dark and
// defined, while thin softboxes and a ring light draw crisp highlights that trace the outline.
// Four hook-coloured cards let the rims pick up the line colours. Built from Lightformers only (no
// HDR files, nothing fetched).
import { Environment, Lightformer } from '@react-three/drei'
import { LINES } from './kit.jsx'

export default function HeroStudio({ dark }) {
  const o = [0, 0, 0]
  return (
    <Environment resolution={256} frames={1}>
      <color attach="background" args={[dark ? '#020309' : '#07080b']} />
      {/* the ring: one bright line all the way round the bevel */}
      <Lightformer form="ring" intensity={dark ? 3.2 : 2.6} scale={7} position={[0, 0.6, 9]} />
      {/* key: a wide softbox overhead and a round one high left */}
      <Lightformer form="rect" intensity={8} scale={[12, 0.8]} position={[0, 7, 2]} target={o} />
      <Lightformer form="circle" intensity={14} scale={1} position={[-4, 5, 7]} target={o} />
      {/* tall strips either side: long highlights down the flanks */}
      <Lightformer form="rect" intensity={12} scale={[0.35, 12]} position={[-8, 1, 3]} target={o} />
      <Lightformer form="rect" intensity={8} scale={[0.25, 12]} position={[8, 0, 2]} target={o} />
      {/* rims from behind */}
      <Lightformer form="rect" intensity={7} scale={[0.4, 14]} position={[-7, 0, -6]} target={o} />
      <Lightformer form="rect" intensity={7} scale={[0.4, 14]} position={[7, 0, -6]} target={o} />
      <Lightformer form="rect" intensity={6} scale={[14, 0.4]} position={[0, 6, -6]} target={o} />
      {dark ? (
        <Lightformer
          form="rect"
          color="#2e4bff"
          intensity={1.8}
          scale={[20, 6]}
          position={[0, -7, 2]}
          target={o}
        />
      ) : (
        // the pearl floor: a soft bounce from below, so the lower bevels are not all black
        <Lightformer
          form="rect"
          color="#e4e8ee"
          intensity={0.9}
          scale={[20, 4]}
          position={[0, -7, 4]}
          target={o}
        />
      )}
      {LINES.map((color, i) => (
        <Lightformer
          key={color}
          form="rect"
          color={color}
          intensity={dark ? 7 : 5}
          scale={[0.3, 6]}
          position={[5 + i * 0.6, -1 + i * 0.6, 6]}
          rotation={[0, 0, -Math.PI / 4]}
          target={o}
        />
      ))}
    </Environment>
  )
}
