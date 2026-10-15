// Renders the flywheel film: out/flywheel/quantpad-flywheel.mp4 (1080p30 H.264, AAC 320k) and a
// poster frame. Run `npm run flywheel:audio` first (npm run flywheel does both).
//   CONCURRENCY=3 REMOTION_GL=swangle node scripts/render-flywheel.mjs   (no GPU: render on the CPU)
//   FRAMES=600-659 node scripts/render-flywheel.mjs                      (a test clip)
import { bundle } from '@remotion/bundler'
import { renderMedia, renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable, chromiumOptions } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = path.join(root, 'out/flywheel')
mkdirSync(out, { recursive: true })

const range = process.env.FRAMES?.split('-').map(Number)
const concurrency = Number(process.env.CONCURRENCY || 4)
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
const inputProps = { audio: !range }
const composition = await selectComposition({ serveUrl, id: 'FlywheelFilm', puppeteerInstance: browser, chromiumOptions, inputProps })
const file = range ? `test-${range[0]}-${range[1]}.mp4` : 'quantpad-flywheel.mp4'

const t0 = Date.now()
let last = -1
await renderMedia({
  composition,
  serveUrl,
  inputProps,
  codec: 'h264',
  crf: 17,
  x264Preset: 'slow',
  pixelFormat: 'yuv420p',
  colorSpace: 'bt709',
  audioCodec: 'aac',
  audioBitrate: '320k',
  muted: !!range,
  frameRange: range ?? null,
  concurrency,
  chromiumOptions,
  puppeteerInstance: browser,
  timeoutInMilliseconds: 600000,
  outputLocation: path.join(out, file),
  onProgress: ({ renderedFrames, progress }) => {
    const pct = Math.floor(progress * 100)
    if (pct !== last) {
      last = pct
      const s = (Date.now() - t0) / 1000
      console.log(`${pct}% · ${renderedFrames} frames · ${Math.round(s)} s · ${(s / Math.max(1, renderedFrames)).toFixed(2)} s/frame`)
    }
  },
})
if (!range) {
  await renderStill({ composition, serveUrl, inputProps, frame: 870, output: path.join(out, 'poster.png'), puppeteerInstance: browser, chromiumOptions, timeoutInMilliseconds: 600000 })
}
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s → out/flywheel/${file}`)
await browser.close({ silent: true })
