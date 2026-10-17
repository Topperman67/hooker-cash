import { Composition } from 'remotion'
import { Ad } from './Ad.jsx'
import { Sheet } from './Sheet.jsx'
import { Avatar, Banner, AVATAR, BANNER } from './social/Stills.jsx'
import { Pinned, PinnedPearl, BannerPlate, PINNED, BANNER_PLATE } from './social/Glass.jsx'
import { Flywheel, FLYWHEEL } from './social/Flywheel.jsx'
import { FPS, DURATION, WIDTH, HEIGHT } from './timeline.js'
import { Engine } from './engine/Engine.jsx'
import * as ENGINE from './engine/timeline.js'
import { Receipts } from './receipts/Receipts.jsx'
import * as RECEIPTS from './receipts/timeline.js'

export function Root() {
  return (
    <>
      <Composition id="QuantPadAd" component={Ad} durationInFrames={DURATION} fps={FPS} width={WIDTH} height={HEIGHT} />
      {/* the $QUANTP payout engine explainer (see src/engine/Engine.jsx) */}
      <Composition
        id="PayoutEngine"
        component={Engine}
        durationInFrames={ENGINE.DURATION}
        fps={ENGINE.FPS}
        width={ENGINE.WIDTH}
        height={ENGINE.HEIGHT}
      />
      {/* the payout engine's first day as a printed log, square for the feed (see src/receipts/) */}
      <Composition
        id="Receipts"
        component={Receipts}
        durationInFrames={RECEIPTS.DURATION}
        fps={RECEIPTS.FPS}
        width={RECEIPTS.WIDTH}
        height={RECEIPTS.HEIGHT}
      />
      {/* Twitter/X profile stills, rendered at 2x (see src/social/Stills.jsx) */}
      <Composition id="Avatar" component={Avatar} durationInFrames={1} fps={FPS} width={AVATAR.width} height={AVATAR.height} />
      <Composition id="Banner" component={Banner} durationInFrames={1} fps={FPS} width={BANNER.width} height={BANNER.height} />
      {/* liquid-glass pinned post and banner background (see src/social/Glass.jsx) */}
      <Composition id="Pinned" component={Pinned} durationInFrames={1} fps={FPS} width={PINNED.width} height={PINNED.height} />
      <Composition id="PinnedPearl" component={PinnedPearl} durationInFrames={1} fps={FPS} width={PINNED.width} height={PINNED.height} />
      <Composition id="Flywheel" component={Flywheel} durationInFrames={1} fps={FPS} width={FLYWHEEL.width} height={FLYWHEEL.height} />
      <Composition id="BannerPlate" component={BannerPlate} durationInFrames={1} fps={FPS} width={BANNER_PLATE.width} height={BANNER_PLATE.height} />
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
