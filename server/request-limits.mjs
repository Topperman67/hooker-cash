import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

// Only Vercel's managed proxy may supply the client IP. Local hosts ignore spoofable headers.
export function clientKey(req, vercel) {
  const forwarded = vercel
    ? String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim()
    : ''
  const ip = isIP(forwarded) ? forwarded : req.socket?.remoteAddress || 'unknown'
  return createHash('sha256').update(ip).digest('hex').slice(0, 32)
}

export function sameOrigin(req) {
  let origin
  try {
    origin = new URL(req.headers.origin)
  } catch {
    return false
  }
  return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host
}

export function createLimiter({ store, vercel = false, now = Date.now }) {
  const local = new Map()
  return async (req, { bucket, limit, cost = 1 }) => {
    const minute = Math.floor(now() / 60000)
    const key = `rate:${bucket}:${clientKey(req, vercel)}:${minute}`
    let count
    if (store) {
      count = await store.incrementExpiring(key, 120000)
      if (cost > 1) count = await store.increment(key, cost - 1)
    } else {
      for (const [k, v] of local) if (v.minute !== minute) local.delete(k)
      count = (local.get(key)?.count || 0) + cost
      local.set(key, { minute, count })
    }
    if (count > limit)
      throw Object.assign(Error('Too many requests. Try again shortly.'), { status: 429 })
  }
}

// Writes must come from the app's own pages and are limited per visitor.
export function createWriteGuard({ store, vercel = false, now = Date.now }) {
  const limit = createLimiter({ store, vercel, now })
  return async (req) => {
    if (!sameOrigin(req))
      throw Object.assign(Error('Open this action from the Quant Pad app.'), { status: 403 })
    await limit(req, { bucket: 'write', limit: 30 })
  }
}
