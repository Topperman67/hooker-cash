// Renders the finished ad: out/quantpad-ad-30s.mp4 (1080p30 H.264, AAC 320k) and a poster frame.
import { bundle } from '@remotion/bundler'
import { renderMedia, renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(path.join(root, 'out'), { recursive: true })

const chromiumOptions = { gl: 'angle' }
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
const composition = await selectComposition({ serveUrl, id: 'QuantPadAd', puppeteerInstance: browser, chromiumOptions })

const t0 = Date.now()
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
  outputLocation: path.join(root, 'out/quantpad-ad-30s.mp4'),
  onProgress: ({ progress }) => {
    const pct = Math.floor(progress * 10) * 10
    if (pct !== last) {
      last = pct
      console.log(`${pct}% (${Math.round((Date.now() - t0) / 1000)} s)`)
    }
  },
})
await renderStill({
  composition,
  serveUrl,
  frame: 880,
  output: path.join(root, 'out/poster.png'),
  puppeteerInstance: browser,
  chromiumOptions,
})
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s → out/quantpad-ad-30s.mp4, out/poster.png`)
await browser.close({ silent: true })
