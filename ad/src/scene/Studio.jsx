// The photo studio the chrome reflects, rendered once into a cube map (look.js turns its
// intensity and rotation per frame). It is laid out like the mark's chrome gradient: bright
// softbox above, a dark horizon band, a lighter floor below. The four light lines are a tight
// group of hairline strips at 45°, so they reflect as four crisp, separate lines.
import { memo } from 'react'
import { Environment, Lightformer } from '@react-three/drei'
import { HOOKS } from '../timeline.js'

export const Studio = memo(function Studio() {
  return (
    <Environment resolution={1024} frames={1}>
      <color attach="background" args={['#3a414c']} />
      {/* behind the camera, in narrow bands so a flat face reflects the mark's chrome gradient:
          bright sky, a dark horizon, a lighter floor */}
      <Lightformer form="rect" intensity={2.6} scale={[30, 3.2]} position={[0, 1.5, 9]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={1.4} scale={[30, 4]} position={[0, 5.2, 8]} target={[0, 0, 0]} />
      <Lightformer form="rect" color="#000000" intensity={1} scale={[30, 0.6]} position={[0, -0.55, 8.8]} target={[0, 0, 0]} />
      <Lightformer form="rect" color="#cfd5de" intensity={1.5} scale={[30, 2.6]} position={[0, -2.2, 9]} target={[0, 0, 0]} />
      {/* overhead and side strip softboxes for the bevels and inner walls */}
      <Lightformer form="rect" intensity={2.6} scale={[10, 8]} position={[0, 8, -1]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={3.2} scale={[1.4, 14]} position={[-7, 0.5, 1.5]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={2.6} scale={[1.0, 14]} position={[7, 0.5, 0.5]} target={[0, 0, 0]} />
      {/* rim from behind */}
      <Lightformer form="rect" intensity={1.8} scale={[16, 1.2]} position={[0, 2.5, -8]} target={[0, 0, 0]} />
      {/* the four light lines */}
      {HOOKS.map((h, i) => (
        <Lightformer
          key={h.key}
          form="rect"
          color={h.color}
          intensity={7}
          scale={[0.07, 24]}
          position={[-2.6 + i * 0.24, 0, 8.4]}
          rotation={[0, 0, Math.PI / 4]}
        />
      ))}
    </Environment>
  )
})
