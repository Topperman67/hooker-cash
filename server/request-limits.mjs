import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export function createWriteGuard({ store, vercel = false, now = Date.now }) {
  const limits = new Map()
  return async (req) => {
    let origin
    try {
      origin = new URL(req.headers.origin)
    } catch {
      /* invalid origin */
    }
    if (
      !origin ||
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.host !== req.headers.host
    )
      throw Object.assign(Error('Open this action from the Hookbrew app.'), { status: 403 })
    // Only Vercel's managed proxy may supply the client IP. Local hosts ignore spoofable headers.
    const forwarded = vercel
      ? String(req.headers['x-forwarded-for'] || '')
          .split(',')[0]
          .trim()
      : ''
    const ip = isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown'
    const minute = Math.floor(now() / 60000)
    const key = `rate:${createHash('sha256').update(ip).digest('hex')}:${minute}`
    let count
    if (store) count = await store.incrementExpiring(key, 120000)
    else {
      for (const [k, v] of limits) if (v.minute !== minute) limits.delete(k)
      count = (limits.get(key)?.count || 0) + 1
      limits.set(key, { minute, count })
    }
    if (count > 30)
      throw Object.assign(Error('Too many requests. Try again shortly.'), { status: 429 })
  }
}
