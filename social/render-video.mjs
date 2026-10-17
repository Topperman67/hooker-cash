// Renders an animated social HTML file to a silent MP4 (H.264, yuv420p, for X and phones). The page
// is loaded with ?video and stepped frame by frame through its window.seek(ms), which pauses every
// animation at that moment, so no frame is dropped or rushed. Needs ffmpeg with libx264.
//
//   node social/render-video.mjs <file.html> <seconds> <out.mp4> [--fps 60] [--width 1920]
//
// The page's own size (its html element, 1600×900 for the social images) is shot at the scale
// that makes the video <width> pixels wide.
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args.splice(i, 2)[1]) : fallback
}
const fps = flag('--fps', 60)
const outWidth = flag('--width', 1920)
const [file, seconds, out] = args
if (!file || !(Number(seconds) > 0) || !out) {
  console.error(
    'Usage: node social/render-video.mjs <file.html> <seconds> <out.mp4> [--fps 60] [--width 1920]',
  )
  process.exit(1)
}
const frames = Math.round(Number(seconds) * fps)
mkdirSync(dirname(resolve(out)), { recursive: true })

const browser = await chromium.launch()
try {
  const probe = await browser.newPage()
  await probe.goto(pathToFileURL(resolve(file)).href)
  const size = await probe.evaluate(() => ({
    width: document.documentElement.offsetWidth,
    height: document.documentElement.offsetHeight,
  }))
  await probe.close()
  const scale = outWidth / size.width
  const height = Math.round(size.height * scale)
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: scale })
  await page.goto(`${pathToFileURL(resolve(file)).href}?video`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  if (!(await page.evaluate(() => typeof window.seek === 'function')))
    throw Error(`${file} has no window.seek(ms) to step its animation`)

  const ffmpeg = spawn(
    'ffmpeg',
    [
      ...['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-'],
      ...['-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p'],
      ...['-vf', `scale=${outWidth}:${height}:flags=lanczos`, '-movflags', '+faststart', '-an'],
      resolve(out),
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  )
  const done = once(ffmpeg, 'close')
  for (let i = 0; i < frames; i++) {
    await page.evaluate((ms) => window.seek(ms), (i * 1000) / fps)
    const png = await page.screenshot({ type: 'png' })
    if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain')
    if (i % fps === 0) process.stderr.write(`\r${Math.round((i / frames) * 100)}%`)
  }
  ffmpeg.stdin.end()
  const [code] = await done
  if (code !== 0) throw Error(`ffmpeg exited with ${code}`)
  process.stderr.write('\r')
  console.log(
    JSON.stringify({
      mp4: resolve(out),
      bytes: statSync(resolve(out)).size,
      width: outWidth,
      height,
      fps,
      seconds: Number(seconds),
    }),
  )
} finally {
  await browser.close()
}
