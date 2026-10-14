import { Composition } from 'remotion'
import { Ad } from './Ad.jsx'
import { Sheet } from './Sheet.jsx'
import { FPS, DURATION, WIDTH, HEIGHT } from './timeline.js'

export function Root() {
  return (
    <>
      <Composition id="QuantPadAd" component={Ad} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
      <Composition
        id="Sheet"
        component={Sheet}
        durationInFrames={1}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ frames: [], title: '' }}
        calculateMetadata={({ props }) => ({
          height: 72 + Math.ceil(Math.max(1, props.frames.length) / 4) * 288,
        })}
      />
    </>
  )
}
