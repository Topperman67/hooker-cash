// Renders stills of the ad at the given frames (default: two per shot) into public/review/, then
// lays them out as a contact sheet at out/<name>.png.
//   node scripts/review.mjs [name] [frame ...]
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const [name = 'sheet', ...rest] = process.argv.slice(2)
const frames = rest.length ? rest.map(Number) : [60, 110, 135, 200, 270, 320, 365, 410, 450, 540, 615, 700, 770, 880]

mkdirSync(path.join(root, 'public/review'), { recursive: true })
mkdirSync(path.join(root, 'out'), { recursive: true })

const chromiumOptions = { gl: 'angle' }
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const entryPoint = path.join(root, 'src/index.js')

let serveUrl = await bundle({ entryPoint })
const ad = await selectComposition({ serveUrl, id: 'QuantPadAd', puppeteerInstance: browser, chromiumOptions })
for (const frame of frames) {
  const t0 = Date.now()
  await renderStill({ composition: ad, serveUrl, frame, output: path.join(root, `public/review/f${frame}.png`), puppeteerInstance: browser, chromiumOptions })
  console.log(`frame ${frame} in ${Date.now() - t0} ms`)
}

// the bundle copies public/ when it is built, so bundle again to pick up the new stills
serveUrl = await bundle({ entryPoint })
const inputProps = { frames, title: `Quant Pad ad · ${name}` }
const sheet = await selectComposition({ serveUrl, id: 'Sheet', inputProps, puppeteerInstance: browser, chromiumOptions })
await renderStill({ composition: sheet, serveUrl, inputProps, output: path.join(root, `out/${name}.png`), puppeteerInstance: browser, chromiumOptions })
console.log(`sheet → out/${name}.png`)
await browser.close({ silent: true })
