// Renders the payout engine film: out/quantp-payout-engine.mp4 (1080p30 H.264, AAC 320k) and a
// poster frame. With frame numbers, renders just those stills to out/engine/ for review:
//   node scripts/render-engine.mjs            the film and the poster
//   node scripts/render-engine.mjs 45 210     out/engine/f45.png, out/engine/f210.png
import { bundle } from '@remotion/bundler'
import { renderMedia, renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const frames = process.argv.slice(2).map(Number)
const POSTER = 1050 // the end card, settled
mkdirSync(path.join(root, 'out/engine'), { recursive: true })

const chromiumOptions = { gl: 'angle' }
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
const composition = await selectComposition({ serveUrl, id: 'PayoutEngine', puppeteerInstance: browser, chromiumOptions })
const still = (frame, output) => renderStill({ composition, serveUrl, frame, output, puppeteerInstance: browser, chromiumOptions })

const t0 = Date.now()
if (frames.length) {
  for (const f of frames) {
    const t = Date.now()
    await still(f, path.join(root, `out/engine/f${f}.png`))
    console.log(`frame ${f} in ${Date.now() - t} ms`)
  }
} else {
  let last = -1
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: 16,
    x264Preset: 'slow',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    audioCodec: 'aac',
    audioBitrate: '320k',
    concurrency: 4,
    chromiumOptions,
    puppeteerInstance: browser,
    outputLocation: path.join(root, 'out/quantp-payout-engine.mp4'),
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 10) * 10
      if (pct !== last) {
        last = pct
        console.log(`${pct}% (${Math.round((Date.now() - t0) / 1000)} s)`)
      }
    },
  })
  await still(POSTER, path.join(root, 'out/quantp-payout-engine-poster.png'))
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s → out/quantp-payout-engine.mp4, out/quantp-payout-engine-poster.png`)
}
await browser.close({ silent: true })
