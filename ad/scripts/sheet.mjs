// Contact sheet from the encoded video (so it shows what viewers get, not the live scene):
//   node scripts/sheet.mjs [video] [out name] [frame ...]
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderStill, selectComposition, openBrowser } from '@remotion/renderer'
import { FPS } from '../src/timeline.js'
import { browserExecutable } from './browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const [video = 'out/quantpad-ad-30s.mp4', name = 'contact-sheet', ...rest] = process.argv.slice(2)
// one frame from the heart of each shot, plus the key beats
const frames = rest.length ? rest.map(Number) : [75, 128, 190, 268, 316, 362, 412, 460, 545, 625, 668, 720, 768, 885]

mkdirSync(path.join(root, 'public/review'), { recursive: true })
const ffmpeg = path.join(root, 'node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe')
for (const f of frames) {
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', (f / FPS + 0.001).toFixed(3), '-i', path.join(root, video), '-frames:v', '1', path.join(root, `public/review/f${f}.png`)])
}

const chromiumOptions = { gl: 'angle' }
const browser = await openBrowser('chrome', { browserExecutable, chromiumOptions })
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.js') })
const inputProps = { frames, title: `Quant Pad ad · ${path.basename(video)}` }
const sheet = await selectComposition({ serveUrl, id: 'Sheet', inputProps, puppeteerInstance: browser, chromiumOptions })
await renderStill({ composition: sheet, serveUrl, inputProps, output: path.join(root, `out/${name}.png`), puppeteerInstance: browser, chromiumOptions })
console.log(`→ out/${name}.png`)
await browser.close({ silent: true })
