// Cuts the Meteora mark out of its dark circular badge onto transparency:
//   node scripts/key-meteora.mjs <badge.png>   →   public/meteora-mark.png
// The badge interior is one flat colour, so alpha comes from each pixel's distance from it, and
// edge pixels are un-mixed so the orange/purple stays clean against any background.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from './png.mjs'

const src = process.argv[2]
if (!src) throw new Error('usage: node scripts/key-meteora.mjs <badge.png>')
const { w, h, rgba } = readPng(readFileSync(src))
const px = (x, y) => (y * w + x) * 4

// the badge fill, sampled just inside the ring
const bg = Array.from(rgba.subarray(px(50, 120), px(50, 120) + 3))

// the mark: saturated, bright pixels
let x0 = w, x1 = 0, y0 = h, y1 = 0
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const [r, g, b] = rgba.subarray(px(x, y), px(x, y) + 3)
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    if (mx > 120 && mx - mn > 80) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
const pad = 4
x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
const ow = x1 - x0 + 1, oh = y1 - y0 + 1
const out = Buffer.alloc(ow * oh * 4)
for (let y = 0; y < oh; y++)
  for (let x = 0; x < ow; x++) {
    const i = px(x + x0, y + y0)
    const p = [rgba[i], rgba[i + 1], rgba[i + 2]]
    const d = Math.max(...p.map((v, c) => Math.abs(v - bg[c])))
    const a = Math.min(1, Math.max(0, (d - 12) / 138))
    const o = (y * ow + x) * 4
    if (a > 0) {
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(Math.min(255, Math.max(0, bg[c] + (p[c] - bg[c]) / a)))
      out[o + 3] = Math.round(a * 255)
    }
  }
const dest = fileURLToPath(new URL('../public/meteora-mark.png', import.meta.url))
writeFileSync(dest, writePng({ w: ow, h: oh, rgba: out }))
console.log(`meteora-mark.png ${ow}×${oh} (badge fill ${bg.join(',')})`)
