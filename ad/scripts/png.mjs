// Minimal PNG read/write (8-bit RGB/RGBA, non-interlaced), enough for logo prep.
import { inflateSync, deflateSync } from 'node:zlib'

export function readPng(buf) {
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  const depth = buf[24]
  const type = buf[25]
  if (depth !== 8 || (type !== 2 && type !== 6) || buf[28] !== 0) {
    throw new Error(`png: need 8-bit RGB/RGBA, non-interlaced (got depth ${depth}, type ${type})`)
  }
  const idat = []
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o)
    const id = buf.toString('ascii', o + 4, o + 8)
    if (id === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = type === 6 ? 4 : 3
  const stride = w * bpp
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]
      px[y * stride + x] = (row[x] + pred) & 255
    }
  }
  // always hand back RGBA
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = px[i * bpp]
    rgba[i * 4 + 1] = px[i * bpp + 1]
    rgba[i * 4 + 2] = px[i * bpp + 2]
    rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255
  }
  return { w, h, rgba }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (b) => {
  let c = -1
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (id, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(id, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function writePng({ w, h, rgba }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(h * (w * 4 + 1))
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
