import { AbsoluteFill, Audio, staticFile } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import { WIDTH, HEIGHT } from './timeline.js'
import { World } from './scene/World.jsx'
import { Overlays } from './overlays/Overlays.jsx'
import { useFonts } from './fonts.js'

export function Ad() {
  useFonts()
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <ThreeCanvas
        width={WIDTH}
        height={HEIGHT}
        dpr={1}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true }}
        camera={{ fov: 30, near: 0.1, far: 400, position: [0, 0, 14] }}
      >
        <World />
      </ThreeCanvas>
      <Overlays />
      <Audio src={staticFile('soundtrack.wav')} />
    </AbsoluteFill>
  )
}
