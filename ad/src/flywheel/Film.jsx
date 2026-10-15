// The flywheel film: the 3D machine (scene/), the type over it (Overlays.jsx) and the soundtrack
// (scripts/flywheel-audio.mjs → public/flywheel-soundtrack.wav).
import { useEffect, useState } from 'react'
import { AbsoluteFill, Audio, staticFile, delayRender, continueRender } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import { WIDTH, HEIGHT } from './timeline.js'
import { World } from './scene/World.jsx'
import { Overlays } from './Overlays.jsx'

function useFonts() {
  const [handle] = useState(() => delayRender('Loading brand fonts'))
  useEffect(() => {
    Promise.all(
      ['900 60px "Hubot Sans Variable"', '500 30px "Mona Sans Variable"', '900 30px "Mona Sans Variable"', '500 20px "Martian Mono Variable"'].map((f) =>
        document.fonts.load(f),
      ),
    ).then(() => continueRender(handle))
  }, [handle])
}

/** `audio: false` renders picture only (test clips before the soundtrack exists) */
export function FlywheelFilm({ audio = true }) {
  useFonts()
  return (
    <AbsoluteFill style={{ background: '#04061a' }}>
      <ThreeCanvas
        width={WIDTH}
        height={HEIGHT}
        dpr={1}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: true }}
        camera={{ fov: 30, near: 0.1, far: 400, position: [0, 6, 14] }}
      >
        <World />
      </ThreeCanvas>
      <Overlays />
      {audio && <Audio src={staticFile('flywheel-soundtrack.wav')} />}
    </AbsoluteFill>
  )
}
