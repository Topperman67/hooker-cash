import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

// Number of reverse proxies in front of a standalone server (QUANTPAD_TRUST_PROXY), so rate limits
// key on the visitor instead of the proxy's own address. Unset or invalid means none: the
// X-Forwarded-For header is then ignored, because any client can send it.
export function trustedProxyHops(env = process.env) {
  const value = String(env.QUANTPAD_TRUST_PROXY ?? '')
    .trim()
    .toLowerCase()
  if (value === 'true') return 1
  const hops = /^\d+$/.test(value) ? Number(value) : 0
  return hops >= 1 && hops <= 10 ? hops : 0
}

// "203.0.113.9", "203.0.113.9:4711", "[2001:db8::1]:4711" or "2001:db8::1" → the bare address.
function bareAddress(entry) {
  const value = entry.trim()
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) return bracketed[1]
  const withPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  return withPort ? withPort[1] : value
}

// The eight 16-bit groups of an IPv6 address (zone index dropped, embedded IPv4 tail converted).
function ipv6Groups(address) {
  let text = address.split('%')[0].toLowerCase()
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const zeros = Array(Math.max(0, 8 - left.length - right.length)).fill('0')
  return [...left, ...zeros, ...right].map((group) => parseInt(group, 16))
}

// Who a request counts as. An IPv6 subscriber is normally given a whole /64 and can rotate through
// it freely, so IPv6 addresses count by their /64 prefix. IPv4 addresses, including IPv4-mapped
// IPv6 ones (::ffff:203.0.113.9, as dual-stack sockets report them), count individually.
export function clientSubject(ip) {
  if (isIP(ip) !== 6) return String(ip)
  const groups = ipv6Groups(ip)
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

// Vercel's managed proxy overwrites X-Forwarded-For, so its first entry is the client. Behind
// `trustProxy` reverse proxies, each proxy appends the address it received the request from, so the
// client is the entry `trustProxy` places from the right; anything further left is client-supplied.
// Otherwise the socket address is used and forwarding headers are ignored.
export function clientKey(req, vercel, trustProxy = 0) {
  const entries = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(bareAddress)
  let forwarded = ''
  if (vercel) forwarded = entries[0]
  else if (trustProxy > 0 && entries.length >= trustProxy) forwarded = entries.at(-trustProxy)
  const ip = isIP(forwarded) ? forwarded : req.socket?.remoteAddress || 'unknown'
  return createHash('sha256').update(clientSubject(ip)).digest('hex').slice(0, 32)
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

export function createLimiter({
  store,
  vercel = false,
  trustProxy = trustedProxyHops(),
  now = Date.now,
}) {
  const local = new Map()
  return async (req, { bucket, limit, cost = 1 }) => {
    const minute = Math.floor(now() / 60000)
    const key = `rate:${bucket}:${clientKey(req, vercel, trustProxy)}:${minute}`
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
export function createWriteGuard({
  store,
  vercel = false,
  trustProxy = trustedProxyHops(),
  now = Date.now,
}) {
  const limit = createLimiter({ store, vercel, trustProxy, now })
  return async (req) => {
    if (!sameOrigin(req))
      throw Object.assign(Error('Open this action from the Quant Pad app.'), { status: 403 })
    await limit(req, { bucket: 'write', limit: 30 })
  }
}
