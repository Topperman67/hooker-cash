// Renders frames of the flywheel film to PNG for review, from one bundle and one browser:
//   node scripts/flywheel-stills.mjs [frame ...]      (default: two frames per shot)
// → out/flywheel/stills/f0123.png. --scale=0.5 renders smaller, faster previews.
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable, chromiumOptions } from './browser.mjs'
import { SHOTS, FPS } from '../src/flywheel/timeline.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const scale = Number(args.find((a) => a.startsWith('--scale='))?.slice(8) ?? 1)
let frames = args.filter((a) => /^\d+$/.test(a)).map(Number)
if (!frames.length) {
  frames = Object.values(SHOTS).flatMap(({ from, to }) => [from + (to - from) * 0.3, from + (to - from) * 0.8].map((s) => Math.round(s * FPS)))
}

const dir = path.join(root, 'out/flywheel/stills')
mkdirSync(dir, { recursive: true })
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
const composition = await selectComposition({ serveUrl, id: 'FlywheelFilm', puppeteerInstance: browser, chromiumOptions, inputProps: { audio: false } })

const outputs = []
for (const frame of frames) {
  const t0 = Date.now()
  const output = path.join(dir, `f${String(frame).padStart(4, '0')}.png`)
  await renderStill({
    composition,
    serveUrl,
    frame,
    output,
    scale,
    inputProps: { audio: false },
    puppeteerInstance: browser,
    chromiumOptions,
    timeoutInMilliseconds: 600000,
    onBrowserLog: (l) => {
      if (l.type === 'error' || l.text.startsWith('[fw]')) console.log(`  [browser ${l.type}] ${l.text.slice(0, 400)}`)
    },
  })
  outputs.push(output)
  console.log(`frame ${frame} (${(frame / FPS).toFixed(2)} s) → ${path.relative(root, output)} (${Date.now() - t0} ms)`)
}

await browser.close({ silent: true })
