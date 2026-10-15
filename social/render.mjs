// Renders a social-image HTML file to an exact-size PNG with Playwright's Chromium, plus Twitter
// previews: the avatar as the circle Twitter shows (and at 48 px), the banner with the desktop
// avatar overlap and the mobile crop marked.
//
//   node social/render.mjs <file.html> <width> <height> <out.png> [--avatar | --banner | --2x]
//
// --2x lays the page out at half the size (width/2 × height/2 CSS px) and shoots it at device
// scale 2, for big images designed at 1x.
//
// HTML files may load local assets by relative path (../../public/brand/mark.svg, the fonts in
// node_modules/@fontsource-variable/*/files/*.woff2). The page should be exactly width × height.
import { chromium } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import { resolve, dirname, basename, join } from 'node:path'
import { mkdirSync, readFileSync, statSync } from 'node:fs'

const [file, w, h, out, mode] = process.argv.slice(2)
if (!file || !w || !h || !out) {
  console.error('Usage: node social/render.mjs <file.html> <width> <height> <out.png> [--avatar | --banner | --2x]')
  process.exit(1)
}
const scale = mode === '--2x' ? 2 : 1
const width = Number(w) / scale
const height = Number(h) / scale
mkdirSync(dirname(resolve(out)), { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(out), clip: { x: 0, y: 0, width, height } })
  // Previews are built with setContent (about:blank cannot load file: URLs): embed the PNG.
  const png = 'data:image/png;base64,' + readFileSync(resolve(out)).toString('base64')
  const previews = []
  if (mode === '--avatar') {
    // Twitter shows the avatar as a circle: large on the profile, 48 px in the timeline.
    const preview = join(dirname(resolve(out)), basename(out, '.png') + '.preview.png')
    const p = await browser.newPage({ viewport: { width: 760, height: 460 }, deviceScaleFactor: 1 })
    await p.setContent(`<body style="margin:0;display:flex;gap:40px;align-items:center;justify-content:center;height:460px;background:#fff;font:14px sans-serif">
      <figure style="margin:0;text-align:center"><img src="${png}" style="width:400px;height:400px;border-radius:50%;display:block"><figcaption>profile (circle crop)</figcaption></figure>
      <div style="display:flex;flex-direction:column;gap:24px">
        <div style="display:flex;gap:12px;align-items:center"><img src="${png}" style="width:48px;height:48px;border-radius:50%"><b>48 px, light</b></div>
        <div style="display:flex;gap:12px;align-items:center;background:#000;color:#fff;padding:10px"><img src="${png}" style="width:48px;height:48px;border-radius:50%"><b>48 px, dark</b></div>
        <div style="display:flex;gap:12px;align-items:center"><img src="${png}" style="width:32px;height:32px;border-radius:50%"><b>32 px</b></div>
      </div></body>`)
    await p.waitForTimeout(300)
    await p.screenshot({ path: preview })
    previews.push(preview)
  }
  if (mode === '--banner') {
    // Desktop: the 1500×500 banner shows at 600×200 with a 134 px avatar circle overlapping its
    // bottom-left (about x 40–375, y 333–500 at full size). Mobile crops the top and bottom.
    const preview = join(dirname(resolve(out)), basename(out, '.png') + '.preview.png')
    const p = await browser.newPage({ viewport: { width: 1500, height: 760 }, deviceScaleFactor: 1 })
    await p.setContent(`<body style="margin:0;background:#fff;font:22px sans-serif">
      <div style="position:relative;width:1500px;height:500px">
        <img src="${png}" style="width:1500px;height:500px;display:block">
        <div style="position:absolute;left:0;right:0;top:0;height:60px;background:rgba(255,0,0,.25);border-bottom:2px dashed red"></div>
        <div style="position:absolute;left:0;right:0;bottom:0;height:60px;background:rgba(255,0,0,.25);border-top:2px dashed red"></div>
        <div style="position:absolute;left:40px;top:333px;width:335px;height:335px;border-radius:50%;background:#ccc;border:10px solid #fff;box-sizing:border-box"></div>
      </div>
      <p style="margin:190px 0 0 420px">Grey circle = where the avatar covers the banner on desktop. Red bands = cropped on some phones.</p>
      </body>`)
    await p.waitForTimeout(300)
    await p.screenshot({ path: preview })
    previews.push(preview)

    // Phone (the X iOS app, measured from an iPhone screenshot at 589 px wide): the header is
    // 589×235 and the banner fills it like object-fit: cover, so about 125 px (of 1500) goes off
    // each side. The status bar sits over the top, round back/search buttons at y ≈ 120, and the
    // avatar (r ≈ 54) overlaps the bottom left.
    const phone = join(dirname(resolve(out)), basename(out, '.png') + '.phone.png')
    const q = await browser.newPage({ viewport: { width: 589, height: 420 }, deviceScaleFactor: 2 })
    const btn = (x, glyph) =>
      `<div style="position:absolute;left:${x - 26}px;top:94px;width:52px;height:52px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;font:600 26px/52px sans-serif;text-align:center">${glyph}</div>`
    await q.setContent(`<body style="margin:0;background:#000;color:#fff;font-family:-apple-system,'Segoe UI',sans-serif">
      <div style="position:relative;width:589px;height:235px;overflow:hidden">
        <img src="${png}" style="width:100%;height:100%;object-fit:cover;display:block">
        <div style="position:absolute;left:84px;top:26px;font:700 21px sans-serif">12:41</div>
        <div style="position:absolute;right:40px;top:30px;display:flex;gap:9px;align-items:flex-end">
          <i style="width:4px;height:7px;background:#fff"></i><i style="width:4px;height:10px;background:#fff;margin-left:-6px"></i><i style="width:4px;height:13px;background:rgba(255,255,255,.5);margin-left:-6px"></i>
          <i style="width:36px;height:16px;border:2px solid #fff;border-radius:5px;box-sizing:border-box"></i>
        </div>
        ${btn(48, '&#8592;')}${btn(541, '&#9906;')}
      </div>
      <div style="position:absolute;left:12px;top:216px;width:108px;height:108px;border-radius:50%;background:#2E4BFF;border:4px solid #000;box-sizing:border-box"></div>
      <div style="position:absolute;left:14px;top:336px;font:800 30px sans-serif">Quant Pad</div>
      <div style="position:absolute;left:14px;top:376px;font:18px sans-serif;color:#71767b">@llm_family</div>
      </body>`)
    await q.waitForTimeout(300)
    await q.screenshot({ path: phone })
    previews.push(phone)
  }
  console.log(JSON.stringify({ png: resolve(out), bytes: statSync(resolve(out)).size, width: width * scale, height: height * scale, previews }))
} finally {
  await browser.close()
}
