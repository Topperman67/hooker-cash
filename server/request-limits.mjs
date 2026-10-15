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

const isMappedIpv4 = (groups) =>
  groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
const prefixOf = (groups, bits) =>
  `${groups
    .slice(0, bits / 16)
    .map((group) => group.toString(16))
    .join(':')}::/${bits}`

// Who a request counts as. An IPv6 subscriber is normally given a whole /64 and can rotate through
// it freely, so IPv6 addresses count by their /64 prefix. IPv4 addresses, including IPv4-mapped
// IPv6 ones (::ffff:203.0.113.9, as dual-stack sockets report them), count individually.
export function clientSubject(ip) {
  if (isIP(ip) !== 6) return String(ip)
  const groups = ipv6Groups(ip)
  if (isMappedIpv4(groups))
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
  return prefixOf(groups, 64)
}

// The routed prefix an IPv6 address belongs to, or null for IPv4 (and IPv4-mapped) addresses.
// A host with a routed /56 or /48 (a home connection, a free tunnel broker) holds 256 to 65 536
// separate /64s, so every per-visitor budget is also charged to the /48 as a whole, with a higher
// limit (PREFIX_FACTOR times the per-visitor one).
export function clientPrefix(ip) {
  if (isIP(ip) !== 6) return null
  const groups = ipv6Groups(ip)
  return isMappedIpv4(groups) ? null : prefixOf(groups, 48)
}

// How many /64 visitors' worth of budget one /48 gets together.
export const PREFIX_FACTOR = 8

const hashed = (subject) => createHash('sha256').update(subject).digest('hex').slice(0, 32)

// Vercel's managed proxy overwrites X-Forwarded-For, so its first entry is the client. Behind
// `trustProxy` reverse proxies, each proxy appends the address it received the request from, so the
// client is the entry `trustProxy` places from the right; anything further left is client-supplied.
// Otherwise the socket address is used and forwarding headers are ignored.
export function clientAddress(req, vercel, trustProxy = 0) {
  const entries = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(bareAddress)
  let forwarded = ''
  if (vercel) forwarded = entries[0]
  else if (trustProxy > 0 && entries.length >= trustProxy) forwarded = entries.at(-trustProxy)
  return isIP(forwarded) ? forwarded : req.socket?.remoteAddress || 'unknown'
}

// Opaque per-visitor key (an IPv4 address or an IPv6 /64).
export function clientKey(req, vercel, trustProxy = 0) {
  return hashed(clientSubject(clientAddress(req, vercel, trustProxy)))
}

// Opaque key of the visitor's IPv6 /48, or null for IPv4 visitors. Charge it alongside clientKey,
// with PREFIX_FACTOR times the per-visitor limit.
export function clientPrefixKey(req, vercel, trustProxy = 0) {
  const prefix = clientPrefix(clientAddress(req, vercel, trustProxy))
  return prefix && hashed(prefix)
}

// Whether the visitor reached the site over https: a TLS socket, or (only behind trusted proxies,
// QUANTPAD_TRUST_PROXY) X-Forwarded-Proto. Its first entry is the scheme the visitor used at the
// outermost proxy. A forged "https" over plain http is harmless where this is used (HSTS), because
// browsers ignore Strict-Transport-Security received over an insecure connection.
export function requestIsHttps(req, trustProxy = trustedProxyHops()) {
  if (req.socket?.encrypted) return true
  if (!(trustProxy > 0)) return false
  const proto = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return proto === 'https'
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

// limiter(req, { bucket, limit, cost }) charges `cost` to the visitor's bucket for this minute and
// throws a 429 past `limit`. An IPv6 visitor is also charged to their /48, which may use
// PREFIX_FACTOR times `limit` (or `prefixLimit`) in all, so rotating through the /64s of one routed
// prefix does not multiply the budget. `shared: true` charges one bucket for everyone instead (a
// deployment-wide budget).
//
// Every instance counts in memory. With a shared store (Redis on serverless) it adds its count to
// the store's once it holds `batchShare` of a limit unsent (one command), and the store's total,
// read back with it, carries what the other instances charged. A visitor well under a limit costs
// no storage commands, and one spread over n instances gets past a limit by at most n times that
// share. When the store fails, the limiter goes on with what it counted here (it fails open):
// a storage outage must not also refuse every RPC call and read.
export function createLimiter({
  store,
  vercel = false,
  trustProxy = trustedProxyHops(),
  now = Date.now,
  batchShare = 0.1,
}) {
  const local = new Map()
  let sweptMinute = null
  async function charge(key, minute, cost, limit) {
    let entry = local.get(key)
    if (!entry) local.set(key, (entry = { minute, total: 0, unsent: 0 }))
    entry.unsent += cost
    if (store && entry.unsent >= Math.max(1, Math.floor(limit * batchShare))) {
      const sent = entry.unsent
      entry.unsent = 0
      try {
        entry.total = Math.max(
          entry.total,
          Number(await store.incrementExpiring(key, 120000, sent)),
        )
      } catch {
        entry.unsent += sent
      }
    }
    return entry.total + entry.unsent
  }
  return async (
    req,
    { bucket, limit, cost = 1, prefixLimit = limit * PREFIX_FACTOR, shared = false },
  ) => {
    const minute = Math.floor(now() / 60000)
    if (sweptMinute !== minute) {
      sweptMinute = minute
      for (const [k, v] of local) if (v.minute !== minute) local.delete(k)
    }
    let count, prefixCount
    if (shared) {
      count = await charge(`rate:${bucket}:all:${minute}`, minute, cost, limit)
    } else {
      const ip = clientAddress(req, vercel, trustProxy)
      const prefix = clientPrefix(ip)
      ;[count, prefixCount] = await Promise.all([
        charge(`rate:${bucket}:${hashed(clientSubject(ip))}:${minute}`, minute, cost, limit),
        prefix
          ? charge(`rate:${bucket}:p48:${hashed(prefix)}:${minute}`, minute, cost, prefixLimit)
          : 0,
      ])
    }
    if (count > limit || prefixCount > prefixLimit)
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
