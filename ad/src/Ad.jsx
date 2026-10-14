import { useEffect, useState } from 'react'
import { AbsoluteFill, Audio, staticFile, delayRender, continueRender } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import { WIDTH, HEIGHT } from './timeline.js'
import { World } from './scene/World.jsx'
import { Overlays } from './overlays/Overlays.jsx'

function useFonts() {
  const [handle] = useState(() => delayRender('Loading brand fonts'))
  useEffect(() => {
    Promise.all(
      [
        '700 60px "Hubot Sans Variable"',
        '500 30px "Mona Sans Variable"',
        '400 20px "Martian Mono Variable"',
      ].map((f) => document.fonts.load(f)),
    ).then(() => continueRender(handle))
  }, [handle])
}

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
