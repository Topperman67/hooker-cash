// What the flywheel's glass and chrome reflect: wide soft boxes (so curved edges catch long clean
// highlights rather than dashes), rims from behind and a cobalt floor bounce. No coloured cards:
// the glass brings its own colour, and chrome stays neutral. Rendered once into a cube map.
import { memo } from 'react'
import { Environment, Lightformer } from '@react-three/drei'

export const FlywheelStudio = memo(function FlywheelStudio() {
  return (
    <Environment resolution={512} frames={1}>
      <color attach="background" args={['#04061a']} />
      {/* key: a big soft box above and in front */}
      <Lightformer form="rect" intensity={3.8} scale={[14, 5]} position={[0, 8, 5]} target={[0, 0, 0]} />
      {/* wide side strips for long highlights down the rims */}
      <Lightformer form="rect" intensity={4} scale={[2.2, 12]} position={[-9, 2, 2]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={3} scale={[2.2, 12]} position={[9, 2, -1]} target={[0, 0, 0]} />
      {/* rims from behind */}
      <Lightformer form="rect" intensity={3} scale={[16, 1.6]} position={[0, 4, -9]} target={[0, 0, 0]} />
      {/* a low horizon band in front, for the near faces */}
      <Lightformer form="rect" intensity={1.6} scale={[20, 1.2]} position={[0, 1, 10]} target={[0, 0, 0]} />
      {/* cobalt floor bounce */}
      <Lightformer form="rect" color="#2e4bff" intensity={2.2} scale={[24, 8]} position={[0, -7, 0]} target={[0, 0, 0]} />
    </Environment>
  )
})
