// Renders single-frame compositions (the social stills) to PNG:
//   node scripts/stills.mjs <CompositionId>=<out.png> [...]
// e.g. node scripts/stills.mjs Pinned=../social/quantpad-pinned.png BannerPlate=../social/banner/plate.png
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { browserExecutable } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const jobs = process.argv.slice(2).map((a) => a.split('='))
if (!jobs.length || jobs.some((j) => j.length !== 2)) {
  console.error('usage: node scripts/stills.mjs <CompositionId>=<out.png> [...]')
  process.exit(1)
}

const chromiumOptions = { gl: 'angle' }
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
for (const [id, out] of jobs) {
  const t0 = Date.now()
  const output = path.resolve(out)
  mkdirSync(path.dirname(output), { recursive: true })
  const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, chromiumOptions })
  await renderStill({ composition, serveUrl, output, puppeteerInstance: browser, chromiumOptions, timeoutInMilliseconds: 180000 })
  console.log(`${id} → ${output} (${Date.now() - t0} ms)`)
}
await browser.close({ silent: true })
