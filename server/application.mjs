import { resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { pipeline } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import bs58 from 'bs58'
import { createConnection } from './solana.mjs'
import { createIndexer, issuedUriClaimKey, issuedUriKey, summarize } from './indexer.mjs'
import {
  createKeeper,
  loadQuantumClient,
  parseKeeperSecret,
  quantumClientError,
} from './keeper.mjs'
import { createPriceFeed } from './prices.mjs'
import { createGeckoFeed, createQuantpFeed, createQuantpLedger, ledgerSummary } from './quantp.mjs'
import { createQuantpEngine } from './quantp-engine.mjs'
import { createRpcProxy, globalRpcLimit, writeRpcResponse } from './rpc-proxy.mjs'
import { configuredStore, createFileStore } from './storage.mjs'
import * as requestLimits from './request-limits.mjs'
import {
  brand,
  network,
  storageDirectory,
  isAddress,
  launchTiers,
  QUANTP,
  DEFAULT_PLATFORM_FEE_BPS,
  MAX_PLATFORM_FEE_BPS,
} from '../shared/network.mjs'

const json = (res, status, data, cache = 'no-store', headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

// Public market data is the same for every visitor. Shared caches (Vercel's CDN) may serve a
// successful answer for a few seconds, so a burst of identical requests never reaches the function;
// browsers always revalidate. Errors stay `no-store`, so a "not tracked yet" is never replayed
// after the coin is tracked.
export const PUBLIC_READ_CACHE = 'public, max-age=0, s-maxage=5, stale-while-revalidate=10'
// Media names are content hashes, so a blob never changes. Without s-maxage Vercel's CDN does not
// cache function responses, and every view would read the store again.
export const MEDIA_CACHE = 'public, max-age=31536000, s-maxage=31536000, immutable'
// $QUANTP's live figures change every few seconds but cost RPC and DexScreener calls: the CDN
// answers for 10 s and revalidates in the background for 50 more.
export const QUANTP_CACHE = 'public, max-age=0, s-maxage=10, stale-while-revalidate=50'
// The same figures from an instance still reading the payouts and burns (`payouts` null): held
// only briefly, so the next answer, with them, follows within seconds.
export const QUANTP_COLD_CACHE = 'public, max-age=0, s-maxage=2, stale-while-revalidate=5'
// Its chart and trades from GeckoTerminal (30 calls a minute per IP) are held a little longer.
export const QUANTP_MARKET_CACHE = 'public, max-age=0, s-maxage=15, stale-while-revalidate=45'
// Its payouts and burns (the ledger, read from the team wallets' histories) and the payout
// engine's status change about every hour, when the engine runs: the CDN answers for a minute and
// revalidates in the background for 5 more, so a run shows on the site within minutes.
export const QUANTP_LEDGER_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
// The engine's health check, which an uptime monitor polls: a minute, and never served stale.
export const QUANTP_HEALTH_CACHE = 'public, max-age=0, s-maxage=60'
// Payout and burn rows /api/quantp/ledger lists unless asked for all (?all=1).
const LEDGER_ROWS = 50

const { clientKey, createLimiter, createWriteGuard } = requestLimits

// A whole number of milliseconds from the environment (0 allowed), else `fallback`.
const envMs = (name, fallback) => {
  const value = String(process.env[name] ?? '').trim()
  return /^\d+$/.test(value) ? Number(value) : fallback
}

// Errors meant for API clients carry a 4xx status; anything else is logged and reported
// generically.
const clientError = (message, status = 400, code) =>
  Object.assign(Error(message), { status, ...(code ? { code } : {}) })
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const digest = (value) => createHash('sha256').update(String(value)).digest()

// Secret comparison in constant time whatever the input: both sides are hashed to 32 bytes first,
// so neither the secret's length nor a multi-byte character in the supplied value matters.
export function secretMatches(supplied, secret) {
  return !!secret && timingSafeEqual(digest(supplied ?? ''), digest(secret))
}

// Routes and the methods they answer, so a known path called with another method gets a 405 with
// Allow instead of a 404 (or a write check). Mint routes validate the mint themselves.
const POST_ROUTES = new Set([
  '/api/rpc',
  '/api/launches',
  '/api/coins/track',
  '/api/media',
  '/api/metadata',
  '/api/sync',
])
const GET_ROUTES = new Set([
  '/api/status',
  '/api/market',
  '/api/coins',
  '/api/stats',
  '/api/quantp',
  '/api/quantp/candles',
  '/api/quantp/trades',
  '/api/quantp/ledger',
  '/api/quantp/holder',
  '/api/quantp/engine',
  '/api/quantp/engine/health',
])
const COIN_ROUTE = /^\/api\/coins\/([^/]+)(?:\/(trades|candles))?$/
const QUANTUM_ROUTE = /^\/api\/quantum\/([^/]+)(?:\/(claims))?$/
function allowedMethods(path) {
  if (POST_ROUTES.has(path)) return ['POST']
  if (path === '/api/keeper/tick') return ['GET', 'POST']
  if (GET_ROUTES.has(path) || COIN_ROUTE.test(path) || QUANTUM_ROUTE.test(path)) return ['GET']
  return null
}

// /api/market only accepts these; anything else (including inherited names such as __proto__)
// falls back to the default instead of reaching the indexer.
const MARKET_SORTS = { newest: true, trending: true, volume: true, mcap: true, progress: true }
const MARKET_FILTERS = { all: true, quantum: true, graduated: true, tracked: true }
const oneOf = (allowed, value, fallback) =>
  typeof value === 'string' && Object.hasOwn(allowed, value) ? value : fallback
// Integer query parameter clamped to [0, max]; anything unreadable is 0.
const clampedInt = (value, max) => Math.max(0, Math.min(max, Math.floor(Number(value) || 0)))
const MAX_MARKET_OFFSET = 10_000
// The indexer keeps at most 4000 trades per coin; a later page is always empty.
const MAX_TRADE_OFFSET = 4_000
// Trades per /trades page (the response size is fixed whatever the request asks).
const TRADE_PAGE = 50
// Candle intervals the chart asks for, in seconds; anything else gets 5 minutes.
const CANDLE_INTERVALS = [15, 60, 300, 900, 3600, 14400, 86400]
const candleInterval = (value) => {
  const n = Number(value)
  return CANDLE_INTERVALS.includes(n) ? n : 300
}
// Resolves like `promise`, or rejects after `ms`.
function within(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

// A wallet address: base58 of exactly 32 bytes.
function isWallet(value) {
  if (!isAddress(value)) return false
  try {
    return bs58.decode(value).length === 32
  } catch {
    return false
  }
}

// The payout engine is late when holders are due a payout and its newest one is older than this
// (two hourly runs missed, and a quarter of an hour), and its buybacks are failing when one is due
// and its newest burn is older than 3 h (seconds).
const LATE_SECS = 8_100
const BUYBACK_LATE_SECS = 10_800

/**
 * The payout engine's health, for an uptime monitor, from its status and the ledger (each null
 * when unavailable) at `nowSecs`: { ok: true, lastPaidAt, lastBurnAt } (its wallet's newest payout
 * and burn, in seconds, or null), or { ok: false, reason }. Reasons: 'not-live' (switched off or
 * not set up), 'late' (holders are due a payout and none went out for LATE_SECS),
 * 'buyback-failing' (a buyback is due and nothing was burned for BUYBACK_LATE_SECS) and 'unknown'
 * (no status or ledger, or the ledger has a newer transaction still to read).
 */
export function engineHealth(status, ledger, nowSecs) {
  if (!status || !ledger) return { ok: false, reason: 'unknown' }
  if (!status.configured || !status.live) return { ok: false, reason: 'not-live' }
  const newest = (times) => (times.length ? Math.max(...times) : null)
  const ours = (rows) => (rows || []).filter((r) => r.wallet === status.wallet)
  const lastPaidAt = newest(
    ours(ledger.payouts).map((p) => p.lastTimestamp ?? p.transactions?.at(-1)?.timestamp ?? 0),
  )
  const lastBurnAt = newest(ours(ledger.burns).map((b) => b.timestamp ?? 0))
  let buyback = 0n
  try {
    buyback = BigInt(status.next?.buyback ?? 0)
  } catch {}
  const late = Number(status.next?.paying) > 0 && !(lastPaidAt > nowSecs - LATE_SECS)
  const failing = buyback > 0n && !(lastBurnAt > nowSecs - BUYBACK_LATE_SECS)
  // The ledger reads newest first: a transaction newer than the last payout (or burn) that it has
  // not read yet may be the run that is missing. One it gave up reading (`unreadable`: dust anyone
  // can send, in a version the node cannot return) is left out, so it cannot hide a late run.
  const unreadAfter = (t) => ledger.newestUnreadAt > (t ?? 0)
  if ((late && unreadAfter(lastPaidAt)) || (failing && unreadAfter(lastBurnAt)))
    return { ok: false, reason: 'unknown' }
  if (late) return { ok: false, reason: 'late' }
  if (failing) return { ok: false, reason: 'buyback-failing' }
  return { ok: true, lastPaidAt, lastBurnAt }
}

// The payout engine's own messages, which say what happened on-chain and echo no provider: a
// transaction that failed (with its on-chain error) or is not confirmed yet, the supply it could
// not read, and its hourly claim failing.
const ENGINE_MESSAGES = [
  /^Transaction [1-9A-HJ-NP-Za-km-z]{32,88} failed\b/,
  /\bis not confirmed yet\.?$/,
  /^The \$QUANTP supply could not be read\b/,
  /\bclaim failed\b/i,
]
// What a URL, or a key in a query string, looks like: never kept, whatever else matches.
const URL_LIKE = /:\/\/|[?&][\w-]+=/

/**
 * A keeper tick step's error as the tick reports it: its response reaches public run logs (the
 * GitHub backup prints it), and RPC, storage and fetch errors can carry provider bodies, URLs or
 * keys. { error, code, signature }: the message only when written for users (`expose`) or one of
 * the engine's own (ENGINE_MESSAGES), else 'RPC or dependency error'; the error's code (or its
 * cause's), or null; the transaction it concerns, when it names one. The whole error is logged.
 */
export function tickError(step, e) {
  console.error(`[tick] ${step}`, e)
  const message = String(e?.message ?? e ?? '')
  const shown =
    e?.expose === true ||
    (ENGINE_MESSAGES.some((pattern) => pattern.test(message)) && !URL_LIKE.test(message))
  const code = e?.code ?? e?.cause?.code
  return {
    error: shown ? message : 'RPC or dependency error',
    code:
      Number.isInteger(code) || (typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code))
        ? code
        : null,
    ...(e?.signature !== undefined ? { signature: e.signature } : {}),
  }
}

// Vercel Cron runs the payout engine. Other callers of the tick (the GitHub backup, every 5 min
// from minute 2) leave it the first quarter of each hour, so they run it only in hours Vercel
// missed, never racing its run.
const BACKUP_WINDOW_MINUTES = 15
const fromVercelCron = (req) =>
  String(req.headers['user-agent'] || '')
    .toLowerCase()
    .startsWith('vercel-cron')
// An alert reason is sent at most once in this long per instance (ms).
const ALERT_COOLDOWN_MS = 3_600_000

// Internal bookkeeping that never leaves the server: signature cursors, backlog anchors (`gaps`
// holds signatures too), the indexer's sync state and its onNativeLaunch notice state (K5).
export const INTERNAL_COIN_FIELDS = [
  'cursor',
  'poolCursor',
  'gaps',
  'seq',
  'historyFrom',
  'supplyAt',
  'day',
  'nativeNotice',
  'nativeNoticeAt',
]
function publicCoin(record) {
  if (!record) return record
  const coin = { ...record }
  for (const field of INTERNAL_COIN_FIELDS) delete coin[field]
  return coin
}

const IMAGE_TYPES = {
  png: {
    ext: 'png',
    mime: 'image/png',
    ok: (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  jpeg: { ext: 'jpg', mime: 'image/jpeg', ok: (b) => b[0] === 255 && b[1] === 216 },
  webp: {
    ext: 'webp',
    mime: 'image/webp',
    ok: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  },
  gif: { ext: 'gif', mime: 'image/gif', ok: (b) => b.subarray(0, 4).toString() === 'GIF8' },
}
const MEDIA_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
}

// Coin metadata URIs are attacker-controlled; never let them point the server at its own network.
// IPv4: everything except private, loopback, link-local, CGNAT, benchmarking, documentation,
// multicast and reserved space. IPv6: global unicast (2000::/3) only, which already excludes
// loopback, IPv4-mapped, NAT64, ULA, link-local and multicast; inside it, Teredo and 6to4 can
// tunnel to any IPv4 address and the rest is documentation space.
const NON_PUBLIC = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
])
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
])
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6')
const GLOBAL_UNICAST_V6 = new BlockList()
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address) {
  const family = isIP(String(address || ''))
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4')
  if (family === 6)
    return (
      !address.includes('%') &&
      GLOBAL_UNICAST_V6.check(address, 'ipv6') &&
      !NON_PUBLIC.check(address, 'ipv6')
    )
  return false
}

// `localhost.` and `localhost` are the same name to DNS, so trailing dots are dropped first.
const normalizeHost = (hostname) =>
  String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '')

// Development hosts whose Host header the standalone server may use for links it issues: they
// resolve to the visitor's own machine, so nobody else can serve content under them.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
export const isLoopbackHost = (hostname) => LOOPBACK_HOSTS.has(normalizeHost(hostname))

// A Host header value (host[:port]) as an origin with `protocol`, or null when it is anything else
// (userinfo, a path, whitespace...).
export function hostOrigin(host, protocol) {
  if (typeof host !== 'string' || !host || /[\s/\\?#@]/.test(host)) return null
  try {
    return new URL(`${protocol}//${host}`).origin
  } catch {
    return null
  }
}

// QUANTPAD_PUBLIC_URL without a trailing slash, or null when unset or not a plain http(s) address.
export function configuredPublicUrl(value) {
  const raw = String(value || '')
    .trim()
    .replace(/\/+$/, '')
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? raw
      : null
  } catch {
    return null
  }
}

// Literal check only: names are vetted again after DNS resolution by resolvePublicAddress.
export function isPublicHost(hostname) {
  const host = normalizeHost(hostname)
  if (isIP(host)) return isPublicAddress(host)
  return (
    !!host &&
    host !== 'localhost' &&
    host.includes('.') &&
    !/\.(local|internal|localhost|home\.arpa)$/.test(host)
  )
}

// Resolves a host and returns one address to connect to, or null when the name is local or ANY of
// its addresses is not public (a name can mix public and private records).
export async function resolvePublicAddress(hostname, lookup = dnsLookup) {
  const host = normalizeHost(hostname)
  if (!isPublicHost(host)) return null
  if (isIP(host)) return { address: host, family: isIP(host) }
  const addresses = await lookup(host, { all: true, verbatim: true })
  if (!addresses?.length || !addresses.every((a) => isPublicAddress(a.address))) return null
  return { address: addresses[0].address, family: addresses[0].family }
}

const METADATA_MAX_BYTES = 65536
const METADATA_TIMEOUT_MS = 5000
const DECODERS = {
  gzip: createGunzip,
  'x-gzip': createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
}
// `transient` failures (network, timeouts, 408/425/429/5xx) are retried with backoff; the rest
// (not https, private host, too large, not JSON, other 4xx) are retried rarely.
const metadataFailure = (message, transient) => Object.assign(Error(message), { transient })

// One GET over https to an address that was vetted before connecting, so DNS cannot rebind the
// name to a private network in between. Certificates are still checked against the hostname.
// The body is streamed and abandoned as soon as the raw or decoded size passes the limit, so a
// small compressed response can never inflate into memory.
async function getPinned(url, target, request = httpsRequest) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  const host = normalizeHost(url.hostname)
  let tooLarge = false
  try {
    const res = await new Promise((ok, fail) => {
      const req = request(
        {
          host: target.address,
          family: target.family,
          port: Number(url.port) || 443,
          path: url.pathname + url.search,
          method: 'GET',
          servername: isIP(host) ? undefined : host,
          headers: {
            host: (isIP(host) === 6 ? `[${host}]` : host) + (url.port ? `:${url.port}` : ''),
            accept: 'application/json',
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': 'QuantPad-metadata/1',
          },
          agent: false,
          signal: controller.signal,
        },
        ok,
      )
      req.on('error', fail)
      req.end()
    })
    res.on('error', () => {})
    const status = res.statusCode
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy()
      return { location: String(res.headers.location) }
    }
    if (status < 200 || status >= 300) {
      res.destroy()
      throw metadataFailure(
        `Metadata host answered ${status}.`,
        status === 408 || status === 425 || status === 429 || status >= 500,
      )
    }
    if (Number(res.headers['content-length']) > METADATA_MAX_BYTES) {
      res.destroy()
      throw metadataFailure('Metadata is too large.', false)
    }
    const encoding = String(res.headers['content-encoding'] || 'identity')
      .trim()
      .toLowerCase()
    const decoder = encoding === 'identity' ? null : DECODERS[encoding]?.()
    if (decoder === undefined) {
      res.destroy()
      throw metadataFailure('Unsupported metadata encoding.', false)
    }
    let raw = 0
    res.on('data', (chunk) => {
      raw += chunk.length
      if (raw > METADATA_MAX_BYTES && !tooLarge) {
        tooLarge = true
        controller.abort()
      }
    })
    const source = decoder ? pipeline(res, decoder, () => {}) : res
    const chunks = []
    let size = 0
    for await (const chunk of source) {
      size += chunk.length
      if (size > METADATA_MAX_BYTES) {
        tooLarge = true
        controller.abort()
        break
      }
      chunks.push(chunk)
    }
    if (tooLarge) throw metadataFailure('Metadata is too large.', false)
    return { text: Buffer.concat(chunks).toString('utf8') }
  } catch (e) {
    if (tooLarge) throw metadataFailure('Metadata is too large.', false)
    if (typeof e?.transient === 'boolean') throw e
    // zlib rejects corrupt bodies; anything else (resets, DNS, timeouts) may succeed later.
    throw metadataFailure('Metadata request failed.', !/^(Z_|ERR_BROTLI)/.test(String(e?.code)))
  } finally {
    clearTimeout(timer)
  }
}

// Fetches a public https metadata document, following up to three redirects by hand so every hop
// is resolved and vetted before the server connects to it.
export async function fetchMetadataText(uri, { resolveHost = resolvePublicAddress, request } = {}) {
  let target
  try {
    target = new URL(uri)
  } catch {
    throw metadataFailure('Invalid metadata URI.', false)
  }
  for (let hop = 0; hop < 4; hop++) {
    if (target.protocol !== 'https:')
      throw metadataFailure('Metadata must be served over https.', false)
    let address
    try {
      address = await resolveHost(target.hostname)
    } catch {
      throw metadataFailure('Metadata host did not resolve.', true)
    }
    if (!address) throw metadataFailure('Metadata host is not public.', false)
    const result = await getPinned(target, address, request)
    if (result.text !== undefined) return result.text
    try {
      target = new URL(result.location, target)
    } catch {
      throw metadataFailure('Invalid metadata redirect.', false)
    }
  }
  throw metadataFailure('Too many metadata redirects.', false)
}

export function platformSettings(env = process.env) {
  const treasury = isAddress(env.QUANTPAD_TREASURY) ? env.QUANTPAD_TREASURY : null
  const requested = Number(env.QUANTPAD_FEE_BPS ?? DEFAULT_PLATFORM_FEE_BPS)
  const feeBps =
    treasury && Number.isInteger(requested)
      ? Math.max(0, Math.min(MAX_PLATFORM_FEE_BPS, requested))
      : 0
  return { treasury, feeBps }
}

export async function createApplication(options = {}) {
  const serverless = options.serverless === true
  const dataDir = resolve(
    options.dataDir || process.env.QUANTPAD_DATA_DIR || '.quantpad-data',
    storageDirectory,
  )
  const redis = options.store === undefined ? configuredStore() : options.store
  const store = redis || createFileStore(dataDir)
  const storage = {
    mode: store.mode || 'custom',
    ready: !!redis || !serverless,
    ...(!redis && serverless
      ? {
          error:
            'Persistent storage is not connected. Connect an Upstash Redis database to this deployment.',
        }
      : {}),
  }
  // /api/status reports whether storage answers, not only whether it is configured. A Redis store
  // tracks how its last command went; when none ran on this instance for STORAGE_CHECK_MS, the
  // status read sends one check command (shared by concurrent status reads).
  const STORAGE_CHECK_MS = 30_000
  let storageCheck = null
  async function storageStatus() {
    if (!storage.ready || typeof store.health !== 'function') return storage
    let health = store.health()
    if (!(Date.now() - health.at < STORAGE_CHECK_MS) && typeof store.check === 'function') {
      storageCheck ||= store
        .check()
        .catch(() => {})
        .finally(() => (storageCheck = null))
      await storageCheck
      health = store.health()
    }
    if (health.healthy !== false) return { ...storage, healthy: true }
    return {
      ...storage,
      ready: false,
      healthy: false,
      reason: health.reason,
      error: 'Persistent storage is unavailable. Try again shortly.',
    }
  }
  const customRpc = !!(options.rpcUrl || process.env.QUANTPAD_RPC_URL)
  const rpcUrl = options.rpcUrl || process.env.QUANTPAD_RPC_URL || network.publicRpcUrl
  const connection = options.connection || createConnection(rpcUrl)
  const platform = options.platform || platformSettings()
  // Operator moderation: listed mints never appear in Quant Pad's own lists (they stay on-chain).
  const hidden = new Set(
    String(options.hiddenMints ?? process.env.QUANTPAD_HIDDEN_MINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(isAddress),
  )
  // Operator showcase: coins launched outside Quant Pad's launch flow (test launches, say) that its
  // own lists and stats show anyway. A hidden mint stays hidden.
  const listed = new Set(
    String(options.listedMints ?? process.env.QUANTPAD_LISTED_MINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((mint) => isAddress(mint) && !hidden.has(mint)),
  )
  // /api/stats also counts $QUANTP, Quant Pad's own token (an external coin to the indexer).
  const statsListed = new Set([...listed, ...(hidden.has(QUANTP.mint) ? [] : [QUANTP.mint])])
  const solUsd = options.priceFeed || createPriceFeed()
  // The clock of the payout engine's routes (its health check, the keeper tick's schedule and its
  // alerts' cooldown).
  const clock = options.now || (() => Date.now())
  // $QUANTP's figures, chart and trades read without the store (server/quantp.mjs), so its page
  // keeps working while Redis is down.
  const quantpRequest = options.quantpFetch ? { request: options.quantpFetch } : {}
  const quantp = options.quantpFeed || createQuantpFeed({ connection, solUsd, ...quantpRequest })
  const gecko = options.geckoFeed || createGeckoFeed(quantpRequest)
  const quantpLedger = options.quantpLedger || createQuantpLedger({ connection })
  // The $QUANTP payout engine (server/quantp-engine.mjs): it sends only with QUANTP_ENGINE_SECRET
  // set to the wallet pinned in QUANTP.engine.wallet, from the keeper tick, once an hour. It has a
  // connection of its own: each call is given up after 8 s and a 429 fails at once, so one slow or
  // rate-limited call cannot use up the run's 25 s deadline.
  const quantpEngine =
    options.quantpEngine ||
    createQuantpEngine({
      connection: options.connection
        ? connection
        : createConnection(rpcUrl, { timeoutMs: 8_000, disableRetryOnRateLimit: true }),
      store,
      feed: quantp,
      ledger: quantpLedger,
      secret: process.env.QUANTP_ENGINE_SECRET,
      paused: process.env.QUANTP_ENGINE_PAUSED === '1',
    })
  const mediaLimit =
    options.mediaLimitBytes || Number(process.env.QUANTPAD_MEDIA_LIMIT_MB || 256) * 1024 * 1024
  // One visitor may use only a slice of the shared media quota per day. Every write is charged at
  // least MEDIA_MIN_CHARGE so tiny distinct files cannot be created (and pinned) without bound.
  const mediaClientLimit =
    options.mediaClientLimitBytes ||
    Number(process.env.QUANTPAD_MEDIA_CLIENT_MB || 16) * 1024 * 1024
  // Each IPFS pin is a file on the operator's Pinata plan: a launch needs two (artwork and
  // metadata), so a visitor gets a dozen launches' worth a day.
  const pinClientLimit =
    options.pinClientLimit || Number(process.env.QUANTPAD_PIN_CLIENT_DAILY || 24)
  // Pins are files on the operator's Pinata plan and are made before any coin exists on-chain, so
  // the whole deployment also has a daily pin budget: abuse pauses pinning for the day instead of
  // using up the plan.
  const pinDailyLimit = options.pinDailyLimit || Number(process.env.QUANTPAD_PIN_DAILY || 400)
  // Uploads, and the metadata documents that reference them, stay pending until a launch with that
  // metadata registers (K5), so media bytes are only kept for good once someone paid for an
  // on-chain create; everything else expires and gives its space back (on stores that support it;
  // others keep every upload). Keeping a pending artwork for another period through /api/metadata
  // costs its full size again, so keeping bytes stored never costs less than uploading them.
  const pendingMediaMs = options.pendingMediaMs || 24 * 3600_000
  // Public reads (market, lists, trades, candles) share one store read per key for this long.
  const READ_CACHE_MS = options.readCacheMs ?? 2_000
  // Deployment-wide RPC budget (QUANTPAD_RPC_GLOBAL_PER_MIN, calls per minute; 0 means none). The
  // proxy charges it per call; tracking a new coin and a coin sync are charged here, by estimate.
  const RPC_GLOBAL_LIMIT = options.rpcGlobalLimit ?? globalRpcLimit()
  // About what tracking a new coin (market, identity, Quantum check and its first history page)
  // or one coin sync costs in RPC calls.
  const COIN_RPC_COST = 45
  // POST /api/coins/track requests per visitor and minute.
  const TRACK_LIMIT = options.trackLimit || 10
  // Every serverless request schedules a background pass; one instance starts at most one per gap.
  const BACKGROUND_GAP_MS = options.backgroundGapMs ?? (serverless ? 5_000 : 0)
  // With shared storage, request-driven passes are also spaced deployment-wide: at most one per
  // BACKGROUND_SYNC_MS (QUANTPAD_BACKGROUND_SYNC_MS, default a minute; 0 turns the spacing off).
  // An index pass costs about 15 storage commands per coin, so passes every few seconds on every
  // busy instance used up an Upstash plan's monthly commands in hours. The keeper cron indexes on
  // its own schedule, and a trade made in the app syncs its coin at once (/api/sync).
  const BACKGROUND_SYNC_MS =
    options.backgroundSyncMs ??
    (serverless && redis ? envMs('QUANTPAD_BACKGROUND_SYNC_MS', 60_000) : 0)
  const vercel = serverless && process.env.VERCEL === '1'
  const trustProxy = requestLimits.trustedProxyHops?.() ?? 0
  const limiter = createLimiter({ store: redis, vercel })
  const writeAllowed = createWriteGuard({ store: redis, vercel })
  const rpcProxy = createRpcProxy({ rpcUrl, limiter, globalLimit: RPC_GLOBAL_LIMIT })
  // Serverless functions are stopped at 60 s (vercel.json maxDuration), counting the request
  // that started the work, so an index pass (15 s unless QUANTPAD_SYNC_MS says otherwise) and
  // the keeper share one budget below that.
  const WORK_MS = serverless ? 40_000 : 180_000
  const INDEX_MS = serverless ? { timeMs: Number(process.env.QUANTPAD_SYNC_MS) || 15_000 } : {}
  const keeperBudget = (started) => Math.max(5_000, WORK_MS - (Date.now() - started))
  // Time left in this invocation's budget, counted from when the request arrived.
  const timeLeft = (started) => WORK_MS - (Date.now() - started)

  const quantum = options.quantum === undefined ? await loadQuantumClient() : options.quantum
  // Shorter than the app's 60 s status refresh, so a paused config disables Quantum launches in
  // the UI within about a minute. Failed reads keep the last known state and retry soon.
  const STATUS_TTL_MS = 30_000
  let programStatus = { checkedAt: 0, deployed: false, config: null }
  let statusRefresh = null
  async function refreshProgramStatus() {
    try {
      const info = await connection.getAccountInfo(quantum.QUANTUM_PROGRAM_ID)
      const config = info?.executable ? await quantum.fetchConfig(connection) : null
      programStatus = { checkedAt: Date.now(), deployed: !!info?.executable, config }
    } catch {
      programStatus = { ...programStatus, checkedAt: Date.now() - STATUS_TTL_MS + 10_000 }
    }
  }
  async function quantumStatus() {
    if (!quantum?.QUANTUM_PROGRAM_ID)
      return {
        available: false,
        reason: 'client-missing',
        ...(quantumClientError ? { error: quantumClientError } : {}),
      }
    if (Date.now() - programStatus.checkedAt > STATUS_TTL_MS) {
      statusRefresh ||= refreshProgramStatus().finally(() => (statusRefresh = null))
      await statusRefresh
    }
    const { deployed, config } = programStatus
    return {
      available: deployed && !!config && !config.paused,
      programId: quantum.QUANTUM_PROGRAM_ID.toBase58(),
      deployed,
      configured: !!config,
      paused: !!config?.paused,
      protocolBps: config?.protocolBps ?? null,
      keeper: config?.keeper ?? null,
      // Seconds between an entanglement epoch being posted and its claims opening (K1).
      claimDelay: config?.claimDelay == null ? null : Number(config.claimDelay),
      reason: !deployed
        ? 'not-deployed'
        : !config
          ? 'not-configured'
          : config.paused
            ? 'paused'
            : null,
    }
  }
  // The indexer verifies Quantum coins (C3) with the same client as the rest of the app; null (no
  // client loaded) leaves the flag unknown rather than loading a second copy. A launch it registers
  // as native makes that launch's metadata and artwork permanent (K5); keepLaunchMedia is hoisted.
  const indexer = createIndexer({
    connection,
    store,
    quantum,
    onNativeLaunch: (launch) => keepLaunchMedia(launch),
    // The same moderation list as the routes (QUANTPAD_HIDDEN_MINTS or options.hiddenMints).
    hidden,
    listed,
  })
  let keeperKey = null
  try {
    keeperKey = options.keeperKey || parseKeeperSecret(process.env.QUANTPAD_KEEPER_SECRET)
  } catch {
    console.error(
      'QUANTPAD_KEEPER_SECRET is not a valid Solana secret key; the keeper is disabled.',
    )
  }
  const keeper = createKeeper({
    connection,
    store,
    indexer,
    quantum,
    keeper: keeperKey,
    log: (m) => console.log('[keeper]', m),
    timeLimitMs: WORK_MS,
  })

  // ---- media / metadata -------------------------------------------------------------------
  const pinataJwt = process.env.PINATA_JWT
  const ipfsGateway = (process.env.QUANTPAD_IPFS_GATEWAY || 'https://ipfs.io/ipfs').replace(
    /\/$/,
    '',
  )
  async function pin(bytes, name, type) {
    if (!pinataJwt) return null
    const form = new FormData()
    form.append('file', new Blob([bytes], { type }), name)
    form.append('network', 'public')
    const response = await fetch('https://uploads.pinata.cloud/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pinataJwt}` },
      body: form,
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    const cid = response?.ok ? (await response.json().catch(() => null))?.data?.cid : null
    if (!cid)
      throw Object.assign(Error('IPFS pinning failed. Try again shortly.'), {
        status: 502,
        expose: true,
      })
    return `${ipfsGateway}/${cid}`
  }
  // Content-addressed names pin to the same CID, so a blob is pinned once: a repeated request
  // reuses the recorded pin instead of creating another file on the Pinata plan. Only metadata
  // pins (its artwork and the document), so abandoned uploads never reach Pinata.
  async function pinOnce(req, bytes, name, type) {
    if (!pinataJwt) return null
    const key = `pin:${name}`
    const known = await store.get(key)
    if (typeof known === 'string') return known
    await chargeDaily(req, 'pins', 1, pinClientLimit)
    if ((await countDaily(`media:pins:all:${today()}`, 1)) > pinDailyLimit)
      throw clientError(
        "Quant Pad has reached today's limit for new token metadata. Try again tomorrow.",
        429,
        'PIN_QUOTA',
      )
    const url = await pin(bytes, name, type)
    await store.set(key, url)
    return url
  }

  const DAY_MS = 86_400_000
  const today = () => Math.floor(Date.now() / DAY_MS)
  // Every media write is charged at least this much, so tiny distinct files cannot be created
  // without bound.
  const MEDIA_MIN_CHARGE = 128 * 1024
  const dailyUsage = new Map()
  // Adds `amount` to a counter that lives for the day and returns its new value.
  async function countDaily(key, amount) {
    if (redis && redis.mode !== 'filesystem') {
      // One command: the expiry is set on first use and kept after.
      return redis.incrementExpiring(key, 2 * DAY_MS, amount)
    }
    const day = today()
    for (const [k, v] of dailyUsage) if (v.day !== day) dailyUsage.delete(k)
    const used = (dailyUsage.get(key)?.used || 0) + amount
    dailyUsage.set(key, { day, used })
    return used
  }
  async function chargeDaily(req, kind, amount, limit) {
    const day = today()
    // clientKey counts an IPv6 visitor by its /64, which one host can rotate through freely, so an
    // IPv6 visitor is also charged to its /48, which gets PREFIX_FACTOR visitors' worth together.
    const prefix = requestLimits.clientPrefixKey?.(req, vercel, trustProxy)
    const factor = requestLimits.PREFIX_FACTOR ?? 8
    const [used, prefixUsed] = await Promise.all([
      countDaily(`media:${kind}:${clientKey(req, vercel, trustProxy)}:${day}`, amount),
      prefix ? countDaily(`media:${kind}:p48:${prefix}:${day}`, amount) : 0,
    ])
    if (used > limit || prefixUsed > limit * factor)
      throw clientError(
        'Daily upload limit reached for this connection. Try again tomorrow.',
        429,
        'MEDIA_QUOTA',
      )
  }
  const chargeMediaQuota = (req, size) =>
    chargeDaily(req, 'client', Math.max(size, MEDIA_MIN_CHARGE), mediaClientLimit)

  // An uploaded artwork's bytes, or null when the upload is gone (never stored, or a pending upload
  // that expired).
  async function readArtwork(name) {
    try {
      return await store.getMedia(name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
  }

  // K5: a launch registered with a metadata document this deployment issued makes the document
  // and the artwork it references permanent. Until then both are pending and expire like abandoned
  // uploads, so permanent media bytes always belong to a coin someone paid to create on-chain.
  // Idempotent. The document was written here, so a /media/<name> in it is this deployment's.
  async function keepIssuedMedia(id, document) {
    if (typeof store.promoteMedia !== 'function') return
    const artwork = typeof document?.image === 'string' && document.image.match(OWN_MEDIA)
    if (artwork) await store.promoteMedia(artwork[1], mediaLimit)
    await store.promoteMedia(`meta-${id}.json`, mediaLimit)
  }
  // The indexer's onNativeLaunch callback. Throws only when storage fails, so the indexer retries
  // the notice later; a uri that is not this deployment's, or a document that already expired,
  // leaves nothing to keep.
  async function keepLaunchMedia({ uri } = {}) {
    const id = ownMetaId(uri)
    if (!id) return
    let document
    try {
      document = JSON.parse((await store.getMedia(`meta-${id}.json`)).toString('utf8').trimStart())
    } catch (e) {
      if (e?.code === 'ENOENT' || e instanceof SyntaxError) return
      throw e
    }
    await keepIssuedMedia(id, document)
  }

  // Where links this deployment issues (metadata URIs, artwork) point. Never built from the Host
  // header of a standalone server, which any client chooses: QUANTPAD_PUBLIC_URL, or on Vercel the
  // project's production domain (Vercel only routes its own domains to the function). A
  // standalone server without QUANTPAD_PUBLIC_URL issues links only while it is reached on a
  // loopback host (development); otherwise this is null.
  const publicUrlSetting = () =>
    configuredPublicUrl(options.publicUrl ?? process.env.QUANTPAD_PUBLIC_URL)
  const requestProtocol = (req) =>
    (requestLimits.requestIsHttps?.(req, trustProxy) ?? !!req.socket?.encrypted)
      ? 'https:'
      : 'http:'
  function publicBase(req) {
    const configured = publicUrlSetting()
    if (configured) return configured
    if (serverless)
      return hostOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host, 'https:')
    const origin = hostOrigin(req.headers.host, requestProtocol(req))
    return origin && isLoopbackHost(new URL(origin).hostname) ? origin : null
  }
  // Whether a URL is on an origin this deployment issues links under (see publicBase).
  function isOwnOrigin(url) {
    const configured = publicUrlSetting()
    if (configured) return url.origin === new URL(configured).origin
    if (serverless) {
      const production = process.env.VERCEL_PROJECT_PRODUCTION_URL
      return !!production && url.origin === hostOrigin(production, 'https:')
    }
    return isLoopbackHost(url.hostname)
  }
  const publicUrlUnset = () =>
    Object.assign(
      Error(
        "Launches are not set up on this server: set QUANTPAD_PUBLIC_URL to the site's public https address (or PINATA_JWT to pin metadata to IPFS).",
      ),
      { status: 503, code: 'PUBLIC_URL_UNSET', expose: true },
    )
  async function readJsonBody(req, max) {
    if (req.body !== undefined) {
      const text =
        typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body)
            ? req.body.toString()
            : JSON.stringify(req.body)
      if (Buffer.byteLength(text) > max)
        throw Object.assign(Error('Request body is too large.'), { status: 413 })
      try {
        return JSON.parse(text)
      } catch {
        throw clientError('Invalid JSON.')
      }
    }
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > max) throw Object.assign(Error('Request body is too large.'), { status: 413 })
      chunks.push(c)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      throw clientError('Invalid JSON.')
    }
  }
  async function readJsonObject(req, max) {
    const body = await readJsonBody(req, max)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw clientError('Send a JSON object.')
    return body
  }

  // Off-chain metadata for display. Our own URIs are read from storage; others are fetched over
  // https from vetted public addresses with a size and time limit.
  const resolveMetadataHost = options.resolveMetadataHost || resolvePublicAddress
  const OWN_META = /^\/m\/([a-f0-9]{32})$/
  const OWN_MEDIA = /^https?:\/\/[^/?#]+\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/
  // The id of a metadata document this deployment issued: /m/<id> on its own origin. The same path
  // on any other host is someone else's document, whatever this deployment has stored under it.
  function ownMetaId(uri) {
    let url
    try {
      url = new URL(String(uri))
    } catch {
      return null
    }
    const own = url.pathname.match(OWN_META)
    return own && isOwnOrigin(url) ? own[1] : null
  }
  const isOwnMetaUri = (uri) => !!ownMetaId(uri)
  async function readMetadataDocument(uri) {
    const id = ownMetaId(uri)
    if (id) {
      try {
        return { text: (await store.getMedia(`meta-${id}.json`)).toString('utf8'), own: id }
      } catch (e) {
        if (e?.code !== 'ENOENT') throw metadataFailure('Storage is unavailable.', true)
        // Not in this deployment's storage: fetch it like any other public URI.
      }
    }
    return { text: await fetchMetadataText(uri, { resolveHost: resolveMetadataHost }), own: null }
  }
  // Returns { ok: true, meta } or { ok: false, transient }.
  async function resolveMetadata(uri) {
    let document
    try {
      document = await readMetadataDocument(uri)
    } catch (e) {
      return { ok: false, transient: e?.transient !== false }
    }
    let data = null
    try {
      // trimStart also drops a byte-order mark, which JSON.parse rejects.
      data = JSON.parse(document.text.trimStart())
    } catch {}
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return { ok: false, transient: false }
    // A coin exists on-chain with this deployment's metadata (records only come from the chain),
    // so its media are kept even when the launch never registered here (a closed tab after the
    // create): the coin would otherwise lose its metadata once the pending copies expire.
    // Best effort: the coin's metadata is shown either way, and for a native launch the indexer's
    // onNativeLaunch notice (retried until it succeeds) keeps the media too.
    if (document.own)
      await keepIssuedMedia(document.own, data).catch((e) =>
        console.error('[media]', `meta-${document.own}.json`, e?.message || e),
      )
    const pick = (v) => (typeof v === 'string' && v.length <= 2048 ? v : '')
    // Links render as anchors (http or https); remote images must be https for the page's CSP.
    const web = (v) => (/^https?:\/\/\S+$/i.test(pick(v)) ? pick(v) : '')
    // Our own artwork is served from this origin, so it is stored as a same-origin path that
    // works on http deployments too.
    const ownMedia = document.own && pick(data.image).match(OWN_MEDIA)
    return {
      ok: true,
      meta: {
        image: ownMedia
          ? `/media/${ownMedia[1]}`
          : /^https:\/\/\S+$/i.test(pick(data.image))
            ? pick(data.image)
            : '',
        description: pick(data.description).slice(0, 600),
        website: web(data.website),
        twitter: web(data.twitter),
        telegram: web(data.telegram),
      },
    }
  }

  // Metadata state lives in its own key (`coin-meta:<mint>`) as well as on the coin record:
  // the record copy serves reads and the market list, the separate key survives a concurrent
  // indexer write of a stale record and records when a failed fetch may be retried.
  const META_RETRY_FAILED_MS = 24 * 3600_000
  const metaBackoff = (attempts) => Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 9))
  const hasMeta = (r) => !!r?.meta && typeof r.meta === 'object'
  const sameMeta = (r, state) =>
    hasMeta(r) &&
    (r.image || null) === (state.image || null) &&
    JSON.stringify(r.meta) === JSON.stringify(state.meta)
  const metaRuns = new Map()
  function needsMetadata(record) {
    if (!record?.mint || !record.uri) return false
    if (!hasMeta(record)) return true
    // Own coins resolved before own artwork was accepted over http kept an empty image.
    return !record.image && !record.meta.image && isOwnMetaUri(record.uri)
  }
  // Through the indexer's locked update: the coin is re-read under its lock (so a concurrent
  // sync's cursor, seq or Quantum upgrade is never rolled back) and its listed summary, image
  // included, is refreshed under the list lock (so a launch listed meanwhile is never dropped).
  async function saveMetadata(record, state) {
    if (sameMeta(record, state)) return
    await indexer.updateCoin(record.mint, (latest) =>
      !latest || sameMeta(latest, state)
        ? latest
        : { ...latest, meta: state.meta, image: state.image },
    )
  }
  async function refreshMetadata(record) {
    const key = `coin-meta:${record.mint}`
    let state = await store.get(key)
    if (!state?.meta && !(state?.retryAt > Date.now())) {
      // One fetch per coin across instances; others keep serving what is stored.
      const lease = `coin-meta:lease:${record.mint}`
      const owner = randomBytes(8).toString('hex')
      if (!(await store.set(lease, owner, { nx: true, ttl: 30_000 }))) return state
      try {
        const result = await resolveMetadata(record.uri)
        const attempts = (state?.attempts || 0) + 1
        state = result.ok
          ? { meta: result.meta, image: result.meta.image || null, at: Date.now() }
          : {
              meta: null,
              image: null,
              attempts,
              retryAt:
                Date.now() + (result.transient ? metaBackoff(attempts - 1) : META_RETRY_FAILED_MS),
            }
        await store.set(key, state)
      } finally {
        await store.release(lease, owner).catch(() => {})
      }
    }
    // Failures never touch the record, so metadata it already shows is kept. A busy lock only
    // delays the write (the next read retries it); this response still carries the metadata.
    if (state?.meta)
      await saveMetadata(record, state).catch((e) =>
        console.error('[metadata]', record.mint, e?.message || e),
      )
    return state
  }
  async function withMetadata(record) {
    if (!needsMetadata(record)) return record
    let run = metaRuns.get(record.mint)
    if (!run) {
      run = refreshMetadata(record).finally(() => metaRuns.delete(record.mint))
      metaRuns.set(record.mint, run)
    }
    // Metadata is decoration: a storage hiccup here must not fail the coin request itself.
    const state = await run.catch(() => null)
    return state?.meta ? { ...record, meta: state.meta, image: state.image } : record
  }

  // ---- deployment-wide RPC budget -----------------------------------------------------------
  // Charges `cost` calls to the budget all visitors share (QUANTPAD_RPC_GLOBAL_PER_MIN, the same
  // bucket as the RPC proxy) when one is set; past it, throws the limiter's 429.
  async function chargeRpcBudget(req, cost) {
    if (RPC_GLOBAL_LIMIT > 0)
      await limiter(req ?? { headers: {}, socket: {} }, {
        bucket: 'rpc-all',
        limit: RPC_GLOBAL_LIMIT,
        cost,
        shared: true,
      })
  }
  // The same for work that can wait: false instead of a 429 once the budget is spent.
  async function withinRpcBudget(req, cost) {
    try {
      await chargeRpcBudget(req, cost)
      return true
    } catch (e) {
      if (e?.status === 429) return false
      throw e
    }
  }

  // ---- manual sync -------------------------------------------------------------------------
  // A coin sync costs up to ~90 RPC calls, so each mint syncs at most once per cooldown however
  // many requests ask; a request inside the cooldown gets the stored record and one trailing
  // sync is queued for when it ends, so a trade that just landed is still picked up.
  const SYNC_COOLDOWN_MS = options.syncCooldownMs || 10_000
  const coinSyncs = new Map()
  const trailingSyncs = new Map()
  function queueTrailingSync(mint) {
    if (trailingSyncs.has(mint) || trailingSyncs.size >= 200) return
    const timer = setTimeout(() => {
      trailingSyncs.delete(mint)
      syncMint(mint, { trailing: true }).catch(() => {})
    }, SYNC_COOLDOWN_MS + 500)
    timer.unref?.()
    trailingSyncs.set(mint, timer)
  }
  async function syncMintOnce(mint, trailing, req) {
    const record = await indexer.coin(mint)
    if (!record) return null
    const fresh = !trailing && record.syncedAt && Date.now() - record.syncedAt < SYNC_COOLDOWN_MS
    if (fresh || !(await store.set(`sync:coin:${mint}`, 1, { nx: true, ttl: SYNC_COOLDOWN_MS }))) {
      // A blocked trailing sync means another sync started after it was queued; nothing to add.
      if (!trailing) queueTrailingSync(mint)
      return record
    }
    // The sync's RPC calls count against the deployment-wide budget. Past it, the stored record
    // is answered and a later sync (or the background pass) picks the coin up.
    if (!(await withinRpcBudget(req, COIN_RPC_COST))) {
      if (!trailing) queueTrailingSync(mint)
      return record
    }
    return indexer.syncCoin(mint, serverless ? { deadline: Date.now() + INDEX_MS.timeMs } : {})
  }
  function syncMint(mint, { trailing = false, req = null } = {}) {
    let run = coinSyncs.get(mint)
    if (!run) {
      run = syncMintOnce(mint, trailing, req).finally(() => coinSyncs.delete(mint))
      coinSyncs.set(mint, run)
    }
    return run
  }

  // Quantum history is polled by every viewer of a coin; share one read per mint for a few seconds.
  const HISTORY_TTL_MS = 10_000
  const histories = new Map()
  function quantumHistory(mint) {
    const now = Date.now()
    const hit = histories.get(mint)
    if (hit && hit.expires > now) return hit.value
    for (const [k, v] of histories) if (v.expires <= now) histories.delete(k)
    if (histories.size >= 500) histories.delete(histories.keys().next().value)
    const value = Promise.all([keeper.epochs(mint), keeper.log(mint)]).then(([epochs, log]) => ({
      epochs,
      log,
    }))
    histories.set(mint, { expires: now + HISTORY_TTL_MS, value })
    value.catch(() => {
      if (histories.get(mint)?.value === value) histories.delete(mint)
    })
    return value
  }

  // Each claims read costs one store read per open epoch plus an RPC read (proofs are stored at
  // post time). Identical requests share one run, at most CLAIMS_CONCURRENCY run at once per
  // instance and a bounded number wait; beyond that the request gets a retryable 429 rather than
  // fanning out without bound. Results are not cached: the app re-reads claims right after a
  // claim lands.
  const CLAIMS_CONCURRENCY = options.claimsConcurrency || 8
  const CLAIMS_QUEUE = options.claimsQueue ?? 64
  const claimRuns = new Map()
  const claimWaiters = []
  let claimsActive = 0
  async function claimSlot() {
    if (claimsActive < CLAIMS_CONCURRENCY) return void claimsActive++
    if (claimWaiters.length >= CLAIMS_QUEUE)
      throw clientError('Claims are busy right now. Try again in a moment.', 429, 'QUANTUM_BUSY')
    await new Promise((ok) => claimWaiters.push(ok))
  }
  function releaseClaimSlot() {
    const next = claimWaiters.shift()
    if (next) next()
    else claimsActive--
  }
  function quantumClaims(mint, wallet) {
    const id = `${mint}:${wallet}`
    let run = claimRuns.get(id)
    if (!run) {
      run = (async () => {
        await claimSlot()
        try {
          return await keeper.claims(mint, wallet)
        } finally {
          releaseClaimSlot()
        }
      })().finally(() => claimRuns.delete(id))
      claimRuns.set(id, run)
    }
    return run
  }

  // ---- public reads ------------------------------------------------------------------------
  // The market, list, stats, trades and candles routes read large stored values (coins:list holds
  // every summary; a coin's trades are up to 4000, about 2 MB as JSON). They run on `reads`, a
  // read-only indexer over a view of the store that shares each stored value: one store read per
  // key and instance, kept for READ_CACHE_MS after it settles, whatever the request asks of it
  // (any offset, side, sort, filter or search). Shared values are never changed: the indexer's
  // read paths filter, sort and slice copies. A key read again within one request is being
  // re-checked (the indexer reads a coin's trade index again when a chunk it listed was replaced
  // meanwhile), so that read goes to the store and refreshes the shared value.
  // A request that has to go to the store is first charged to its visitor's store-read bucket
  // (STORE_READ_LIMIT a minute, once per request), so cycling through coins or waiting out the
  // cache costs a unit per request; a request served entirely from shared reads costs nothing
  // more. The store is read only once the charge passed, so a visitor over the limit causes no
  // store read, and their refusal is theirs alone: requests that joined their read start (and
  // pay for) it themselves. At most READ_CACHE_MAX values are held, each for a few seconds.
  const READ_CACHE_MAX = options.readCacheMax || 32
  const STORE_READ_LIMIT = options.storeReadLimit || 60
  const sharedValues = new Map()
  let sharedSweptAt = 0
  const readContext = new AsyncLocalStorage()
  function freshValue(key) {
    const hit = sharedValues.get(key)
    return hit && hit.expires > Date.now() ? hit : null
  }
  function startValue(key, charge) {
    const now = Date.now()
    if (now - sharedSweptAt >= READ_CACHE_MS || sharedValues.size >= READ_CACHE_MAX) {
      sharedSweptAt = now
      for (const [k, v] of sharedValues) if (v.expires <= now) sharedValues.delete(k)
      while (sharedValues.size >= READ_CACHE_MAX)
        sharedValues.delete(sharedValues.keys().next().value)
    }
    const entry = { expires: Infinity, refused: false, value: null }
    entry.value = Promise.resolve()
      .then(() => charge?.())
      .then(
        () => store.get(key),
        (error) => {
          entry.refused = true
          throw error
        },
      )
      .then(
        (value) => {
          entry.expires = Date.now() + READ_CACHE_MS
          return value
        },
        (error) => {
          if (sharedValues.get(key) === entry) sharedValues.delete(key)
          throw error
        },
      )
    sharedValues.set(key, entry)
    return entry
  }
  async function sharedGet(key) {
    const request = readContext.getStore()
    // The request's one charge, shared by all its store reads (some run in parallel).
    const pay = () => request && (request.paid ??= Promise.resolve().then(request.charge))
    if (!(READ_CACHE_MS > 0)) {
      await pay()
      return store.get(key)
    }
    const again = !!request?.seen.has(key)
    request?.seen.add(key)
    const shared = !again && freshValue(key)
    if (!shared) return startValue(key, pay).value
    try {
      return await shared.value
    } catch (error) {
      if (!shared.refused) throw error
      // The visitor who started that read was over their limit: read it for this request.
      request?.seen.delete(key)
      return sharedGet(key)
    }
  }
  const reads = createIndexer({
    connection,
    store: Object.create(store, { get: { value: sharedGet } }),
    quantum: null,
    hidden,
    listed,
  })
  // Runs `read` (calls on `reads`) for one request, charging its visitor if it reads the store.
  const publicRead = (req, read) =>
    readContext.run(
      {
        charge: () => limiter(req, { bucket: 'read-store', limit: STORE_READ_LIMIT }),
        paid: null,
        seen: new Set(),
      },
      read,
    )
  // Every public read also counts against one generous per-visitor bucket: the app polls a
  // handful of these every 8 to 30 seconds, so only a script reaches it.
  const READ_LIMIT = options.readLimit || 300
  const limitRead = (req) => limiter(req, { bucket: 'read', limit: READ_LIMIT })
  const invalidMint = () => clientError('Enter a valid Solana mint address.', 400, 'invalid_mint')

  // $QUANTP's chart or trades from the indexer, when the store answers and holds the coin's whole
  // history (from its first transaction on each venue, nothing left to read) with something in
  // it; null otherwise, and the caller asks GeckoTerminal. Bounded in time so a slow store never
  // holds up the fallback.
  async function indexedQuantp(req, read) {
    try {
      const record = await within(indexer.coin(QUANTP.mint), 2_500)
      const from = (field) => record?.historyFrom?.[field] ?? (record?.external ? null : 0)
      if (!record || record.behind || from('cursor') !== 0) return null
      if (record.migrated && from('poolCursor') !== 0) return null
      const result = await within(publicRead(req, read), 4_000)
      return result?.items?.length ? result : null
    } catch {
      return null
    }
  }

  // The payout engine's status, or a 503 the page can show whatever made it unavailable (logged
  // unless it was written for users).
  const engineStatus = () =>
    quantpEngine.status().catch((e) => {
      if (e?.expose !== true) console.error('[quantp-engine] status', e)
      throw Object.assign(Error('The payout engine’s state is unavailable right now.'), {
        status: 503,
        expose: true,
        code: 'ENGINE_UNAVAILABLE',
      })
    })

  // The keeper tick's payout engine step: its run, when its hour is up, within `deadline`. In the
  // first quarter of each UTC hour only Vercel Cron runs it (BACKUP_WINDOW_MINUTES). A run that
  // fails part way reports its error (through tickError) beside what it sent.
  async function engineStep(req, deadline) {
    if (!fromVercelCron(req) && new Date(clock()).getUTCMinutes() < BACKUP_WINDOW_MINUTES)
      return { ran: false, reason: 'backup-window' }
    let run
    try {
      run = await quantpEngine.tick({ deadline })
    } catch (e) {
      return { ran: false, ...tickError('engine', e) }
    }
    if (!run?.error) return run
    const { error: message, code, signature } = run
    return { ...run, ...tickError('engine', { message, code, signature }) }
  }

  // The keeper tick's alerts to QUANTP_ALERT_WEBHOOK (a Discord, Slack or Telegram webhook URL):
  // one line when the payout engine failed or stopped part way, or the keeper found an epoch it
  // did not post (cancel it before its claimStart). Each reason is sent at most once an hour per
  // instance. The line holds only the tick's own report (its errors already sanitized), never
  // the environment; a webhook that fails is logged by the error's name alone, since fetch puts
  // the URL in its messages.
  const alertedAt = new Map() // reason -> when it was last sent (ms)
  async function alert({ engine, keeper: keep }) {
    const webhook = String(process.env.QUANTP_ALERT_WEBHOOK || '').trim()
    if (!webhook) return
    const foreign = (Array.isArray(keep?.alerts) ? keep.alerts : []).filter(
      (a) => a?.kind === 'foreign-epoch',
    )
    const before = (secs) => {
      const at = new Date(Number(secs) * 1000)
      return Number.isNaN(at.getTime()) ? '' : ` before ${at.toISOString()}`
    }
    const reasons = [
      engine?.error && [
        'engine-error',
        `payout engine failed: ${engine.error}${engine.signature ? ` (${engine.signature})` : ''}`,
      ],
      engine?.stopped && ['engine-stopped', `payout engine stopped early: ${engine.stopped}`],
      foreign.length && [
        'foreign-epoch',
        `epochs this keeper did not post, cancel each with cancel_epoch: ${foreign
          .map((a) => `${a.mint}#${a.index}${before(a.claimStart)}`)
          .join(', ')}`,
      ],
    ].filter((r) => r && !(clock() - (alertedAt.get(r[0]) ?? -Infinity) < ALERT_COOLDOWN_MS))
    if (!reasons.length) return
    for (const [reason] of reasons) alertedAt.set(reason, clock())
    const text = `${brand.name} keeper tick: ${reasons.map(([, line]) => line).join('; ')}`
      .replace(/\s+/g, ' ')
      .slice(0, 1_900)
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Discord reads `content`, Slack and Telegram `text`
        body: JSON.stringify({ content: text, text }),
        signal: AbortSignal.timeout(3_000),
      })
      r.body?.cancel().catch(() => {})
      if (!r.ok) throw Object.assign(Error(), { name: `HTTP ${r.status}` })
    } catch (e) {
      // not sent: the next tick tries again
      for (const [reason] of reasons) alertedAt.delete(reason)
      console.error('[tick] alert webhook failed:', String(e?.name || 'Error'))
    }
  }

  async function status() {
    const [price, q, storageNow] = await Promise.all([solUsd(), quantumStatus(), storageStatus()])
    return {
      brand,
      network: { cluster: network.cluster, explorerUrl: network.explorerUrl },
      rpc: '/api/rpc',
      platform,
      quantum: q,
      keeper: { enabled: keeper.enabled, address: keeper.keeper },
      // The public RPC rate-limits hard: a serverless deployment without its own provider
      // indexes slowly or not at all.
      indexer:
        serverless && !customRpc
          ? { degraded: true, reason: 'public-rpc' }
          : { degraded: false, reason: null },
      storage: storageNow,
      solUsd: price.usd,
      ipfs: !!pinataJwt,
      lookupTable: isAddress(process.env.QUANTPAD_LOOKUP_TABLE)
        ? process.env.QUANTPAD_LOOKUP_TABLE
        : null,
      // The Meteora DBC config new launches use: the first of QUANTPAD_DBC_CONFIG, else the
      // Standard launch's (the first trading-tax tier, shared/network.mjs launchTiers).
      dbcConfig:
        String(process.env.QUANTPAD_DBC_CONFIG || '')
          .split(',')
          .map((s) => s.trim())
          .find(isAddress) ||
        launchTiers[0]?.config ||
        null,
    }
  }

  async function middleware(req, res, next = () => json(res, 404, { error: 'Not found' })) {
    const url = new URL(req.url, 'http://quantpad.local'),
      path = url.pathname
    if (!path.startsWith('/api/') && !path.startsWith('/media/') && !path.startsWith('/m/'))
      return next()
    try {
      // Token metadata URIs live on-chain and count against the launch transaction size, so they
      // use a short content-addressed path: /m/<first 128 bits of the JSON's sha256>.
      const shortMeta = path.match(/^\/m\/([a-f0-9]{32})$/)
      if (path.startsWith('/media/') || shortMeta) {
        const name = shortMeta ? `meta-${shortMeta[1]}.json` : path.slice(7)
        if (!/^(?:meta-[a-f0-9]{32}\.json|[a-f0-9]{64}\.(?:png|jpg|webp|gif))$/.test(name))
          return json(res, 404, { error: 'Not found' })
        const bytes = await store.getMedia(name)
        res.writeHead(200, {
          'Content-Type': MEDIA_MIME[name.split('.').at(-1)],
          'Cache-Control': MEDIA_CACHE,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Access-Control-Allow-Origin': '*',
        })
        return res.end(bytes)
      }

      const allowed = allowedMethods(path)
      if (!allowed) return json(res, 404, { error: 'Endpoint not found.' })
      if (!allowed.includes(req.method))
        return json(res, 405, { error: 'Method not allowed.' }, 'no-store', {
          Allow: allowed.join(', '),
        })

      if (req.method === 'GET' && path === '/api/status') return json(res, 200, await status())

      // The proxy's answer goes out as received (no re-serialising of large payloads), with its
      // headers: an upstream 429 keeps its Retry-After (C6).
      if (req.method === 'POST' && path === '/api/rpc')
        return writeRpcResponse(res, await rpcProxy(req, await readJsonBody(req, 1_500_000)))

      if (req.method === 'GET' && path === '/api/market') {
        await limitRead(req)
        const launcher = url.searchParams.get('launcher')
        const query = {
          q: (url.searchParams.get('q') || '').slice(0, 100).toLowerCase().trim(),
          sort: oneOf(MARKET_SORTS, url.searchParams.get('sort'), 'newest'),
          filter: oneOf(MARKET_FILTERS, url.searchParams.get('filter'), 'all'),
          launcher: isAddress(launcher) ? launcher : '',
          offset: clampedInt(url.searchParams.get('offset'), MAX_MARKET_OFFSET),
        }
        const result = await publicRead(req, () => reads.market({ hidden, ...query }))
        return json(res, 200, result, PUBLIC_READ_CACHE)
      }

      if (req.method === 'GET' && path === '/api/coins') {
        await limitRead(req)
        const wanted = new Set(
          (url.searchParams.get('mints') || '').split(',').filter(isAddress).slice(0, 100),
        )
        const items = (await publicRead(req, () => reads.list())).filter(
          (c) => wanted.has(c.mint) && !hidden.has(c.mint),
        )
        return json(res, 200, { items }, PUBLIC_READ_CACHE)
      }

      if (req.method === 'GET' && path === '/api/stats') {
        await limitRead(req)
        const coins = (await publicRead(req, () => reads.list())).filter(
          (c) => (!c.external || statsListed.has(c.mint)) && !hidden.has(c.mint),
        )
        const stats = {
          coins: coins.length,
          quantum: coins.filter((c) => c.quantum).length,
          graduated: coins.filter((c) => c.complete).length,
          volume24h: coins.reduce((s, c) => s + (c.volume24h || 0), 0),
          trades24h: coins.reduce((s, c) => s + (c.trades24h || 0), 0),
        }
        return json(res, 200, stats, PUBLIC_READ_CACHE)
      }

      // $QUANTP: no store reads (the limiter fails open while Redis is down).
      if (req.method === 'GET' && path === '/api/quantp') {
        await limitRead(req)
        // With what was really paid and burned: the ledger as cached on this instance, never
        // waited for. Asking starts a refresh when one is due, and asking again once the live
        // figures are in gets whatever it finished meanwhile. An instance still reading them for
        // the first time answers `payouts: null`, which the CDN holds only briefly; one whose read
        // failed (retried only after a while) answers null, held as long as the live figures.
        quantpLedger.peek()
        const snapshot = await quantp.snapshot()
        const payouts = ledgerSummary(quantpLedger.peek())
        const cache = payouts || !quantpLedger.loading?.() ? QUANTP_CACHE : QUANTP_COLD_CACHE
        return json(res, 200, { ...snapshot, payouts }, cache)
      }
      if (req.method === 'GET' && path === '/api/quantp/candles') {
        await limitRead(req)
        const interval = candleInterval(url.searchParams.get('interval'))
        const indexed = await indexedQuantp(req, async () => ({
          items: await reads.candles(QUANTP.mint, interval),
        }))
        if (indexed)
          return json(res, 200, { ...indexed, interval, source: 'indexer' }, PUBLIC_READ_CACHE)
        const items = await gecko.candles(await quantp.pools(), interval)
        return json(res, 200, { items, interval, source: 'geckoterminal' }, QUANTP_MARKET_CACHE)
      }
      if (req.method === 'GET' && path === '/api/quantp/trades') {
        await limitRead(req)
        const side = oneOf({ buy: true, sell: true }, url.searchParams.get('side'), null)
        const offset = clampedInt(url.searchParams.get('offset'), MAX_TRADE_OFFSET)
        const indexed = await indexedQuantp(req, () =>
          reads.trades(QUANTP.mint, { side, offset, limit: TRADE_PAGE }),
        )
        if (indexed) return json(res, 200, { ...indexed, source: 'indexer' }, PUBLIC_READ_CACHE)
        const rows = (await gecko.trades(await quantp.pools())).filter(
          (t) => !side || t.side === side,
        )
        const page = {
          items: rows.slice(offset, offset + TRADE_PAGE),
          total: rows.length,
          next: offset + TRADE_PAGE < rows.length ? offset + TRADE_PAGE : null,
          source: 'geckoterminal',
        }
        return json(res, 200, page, QUANTP_MARKET_CACHE)
      }
      if (req.method === 'GET' && path === '/api/quantp/engine') {
        await limitRead(req)
        return json(res, 200, await engineStatus(), QUANTP_LEDGER_CACHE)
      }
      // What an uptime monitor checks: 200 while the engine pays out and buys back on time, else
      // a 503 saying why (engineHealth).
      if (req.method === 'GET' && path === '/api/quantp/engine/health') {
        await limitRead(req)
        const [status, ledger] = await Promise.all([
          quantpEngine.status().catch(() => null),
          quantpLedger.ledger().catch(() => null),
        ])
        const health = engineHealth(status, ledger, Math.floor(clock() / 1000))
        return json(res, health.ok ? 200 : 503, health, QUANTP_HEALTH_CACHE)
      }
      // The newest LEDGER_ROWS payouts and burns, with the totals and counts over all of them;
      // ?all=1 lists every one. Other parameters are ignored.
      if (req.method === 'GET' && path === '/api/quantp/ledger') {
        await limitRead(req)
        const ledger = await quantpLedger.ledger()
        const all = url.searchParams.get('all') === '1'
        const rows = (list) => (all ? list : list.slice(0, LEDGER_ROWS))
        const body = {
          ...ledger,
          payouts: rows(ledger.payouts),
          burns: rows(ledger.burns),
          payoutCount: ledger.payouts.length,
          burnCount: ledger.burns.length,
          more: !all && Math.max(ledger.payouts.length, ledger.burns.length) > LEDGER_ROWS,
        }
        return json(res, 200, body, QUANTP_LEDGER_CACHE)
      }
      // What one wallet was paid (its newest LEDGER_ROWS payouts listed), and its row in the
      // engine's holders for the next run: { eligible: false } when it has none, null when the
      // engine's status is unavailable. The address is never logged.
      if (req.method === 'GET' && path === '/api/quantp/holder') {
        await limitRead(req)
        const wallet = url.searchParams.get('wallet')
        if (!isWallet(wallet))
          throw clientError('Enter a valid Solana wallet address.', 400, 'invalid_wallet')
        const [paid, status] = await Promise.all([
          quantpLedger.forWallet(wallet, { limit: LEDGER_ROWS }),
          quantpEngine.status().catch(() => null),
        ])
        const holders = Array.isArray(status?.holders) ? status.holders : null
        const body = {
          wallet,
          paid: {
            lamports: paid.lamports,
            payouts: paid.payouts,
            lastAt: paid.lastAt,
            items: paid.items,
          },
          engine: holders
            ? (holders.find((h) => h?.wallet === wallet) ?? { eligible: false })
            : null,
          minHold: status?.minHold ?? null,
          complete: paid.complete,
        }
        return json(res, 200, body, QUANTP_LEDGER_CACHE)
      }

      // POST /api/coins/track is a POST route; every other /api/coins/<x> is a coin read.
      const coinMatch = req.method === 'GET' && path.match(COIN_ROUTE)
      if (coinMatch) {
        await limitRead(req)
        const [, mint, part] = coinMatch
        if (!isAddress(mint)) throw invalidMint()
        if (hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        const record = await indexer.coin(mint)
        if (!record)
          return json(res, 404, { error: 'This coin is not tracked yet.', code: 'NOT_TRACKED' })
        if (part === 'candles') {
          const interval = candleInterval(url.searchParams.get('interval'))
          const items = await publicRead(req, () => reads.candles(mint, interval))
          return json(res, 200, { items, interval }, PUBLIC_READ_CACHE)
        }
        if (part === 'trades') {
          const side = oneOf({ buy: true, sell: true }, url.searchParams.get('side'), null)
          const offset = clampedInt(url.searchParams.get('offset'), MAX_TRADE_OFFSET)
          // Pages are TRADE_PAGE trades: every page (and side) of a coin shares one stored read.
          const page = await publicRead(req, () =>
            reads.trades(mint, { side, offset, limit: TRADE_PAGE }),
          )
          return json(res, 200, page, PUBLIC_READ_CACHE)
        }
        return json(res, 200, { coin: publicCoin(await withMetadata(record)) }, PUBLIC_READ_CACHE)
      }

      const quantumMatch = req.method === 'GET' && path.match(QUANTUM_ROUTE)
      if (quantumMatch) {
        const [, mint, part] = quantumMatch
        if (!isAddress(mint)) throw invalidMint()
        if (part === 'claims') {
          // Claims may rebuild merkle proofs per open epoch; the app polls this once a minute.
          await limiter(req, { bucket: 'quantum-claims', limit: 30 })
          const wallet = url.searchParams.get('wallet')
          if (!isAddress(wallet)) throw clientError('Provide a wallet address.')
          return json(res, 200, { items: await quantumClaims(mint, wallet) })
        }
        await limiter(req, { bucket: 'quantum', limit: 60 })
        return json(res, 200, await quantumHistory(mint))
      }

      if (path === '/api/keeper/tick') {
        // Vercel Cron and the GitHub Actions schedule (.github/workflows/keeper-cron.yml) both
        // send `Authorization: Bearer <CRON_SECRET>`. A secret pasted with a trailing newline
        // still matches.
        const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '')
        if (!secretMatches(supplied, String(process.env.CRON_SECRET || '').trim()))
          return json(res, 401, { error: 'Unauthorized' })
        const started = Date.now()
        // Each step reports its own failure in the response instead of failing the tick, so one
        // that cannot run (the index pass and the keeper need the store, which can refuse every
        // command) never stops the others. `ok` is false when any step failed. Every error is
        // reported through tickError, which logs it whole.
        const step = (name, promise) => promise.catch((e) => tickError(name, e))
        // The payout engine first, when its hour is up (a store read otherwise), within 25 s: the
        // index pass and the keeper then share what is left of the budget.
        const engine = await engineStep(req, started + 25_000)
        const index = await step('index', indexer.sync({ budget: 8, ...INDEX_MS }))
        const keep = await step('keeper', keeper.tick({ timeLimitMs: keeperBudget(started) }))
        // the keeper just ran: the background pass after this response must not run it again
        await store.set('keeper:throttle', 1, { ttl: 120000 }).catch(() => {})
        const ok = ![engine, index, keep].some((r) => r?.error)
        if (!ok || engine?.error || engine?.stopped)
          console.error(
            '[tick]',
            JSON.stringify({
              ok,
              engine,
              index: index?.error,
              keeper: keep?.error ?? keep?.alerts,
            }),
          )
        const body = { ok, index, keeper: keep, engine }
        json(res, 200, body)
        // after the answer, so the scheduler never waits on the webhook
        return alert(body)
      }

      // Only the POST routes are left (allowedMethods above).
      await writeAllowed(req)
      if (!storage.ready)
        return json(res, 503, { error: storage.error, code: 'STORAGE_UNCONFIGURED' })

      if (path === '/api/launches') {
        // Registration reads the chain (and may page a curve's history): a tighter bucket.
        await limiter(req, { bucket: 'launch', limit: 10 })
        const body = await readJsonObject(req, 2000)
        const signature = body.signature ?? ''
        const mint = body.mint ?? ''
        if (typeof signature !== 'string')
          throw clientError('Provide the launch transaction signature.')
        if (mint !== '' && !isAddress(mint)) throw clientError('Enter a valid Solana mint address.')
        if (!signature && !mint) throw clientError('Provide the launch transaction signature.')
        if (mint && hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        const coin = await indexer.registerLaunch(signature, { mint: mint || undefined })
        return json(res, 201, { coin: publicCoin(await withMetadata(coin)) })
      }
      if (path === '/api/coins/track') {
        // Tracking a new coin reads its market, identity and history from the chain (about
        // COIN_RPC_COST calls): a tight bucket of its own, and the deployment-wide RPC budget.
        await limiter(req, { bucket: 'track', limit: TRACK_LIMIT })
        const { mint } = await readJsonObject(req, 2000)
        if (!isAddress(mint)) throw clientError('Enter a valid Solana mint address.')
        if (hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        if (RPC_GLOBAL_LIMIT > 0 && !(await indexer.coin(mint)))
          await chargeRpcBudget(req, COIN_RPC_COST)
        const coin = await indexer.track(mint)
        return json(res, 201, { coin: publicCoin(await withMetadata(coin)) })
      }
      if (path === '/api/media') {
        // Uploads only serve launches, which need a public address for their metadata.
        const base = publicBase(req)
        if (!base && !pinataJwt) throw publicUrlUnset()
        const b = await readJsonObject(req, 2_200_000)
        const m = String(b.data || '').match(
          /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/,
        )
        if (!m) throw clientError('Choose a PNG, JPEG, WebP or GIF image.')
        const bytes = Buffer.from(m[2], 'base64')
        if (bytes.length > 1_500_000) throw clientError('Choose an image under 1.5 MB.')
        const type = IMAGE_TYPES[m[1]]
        if (!type.ok(bytes)) throw clientError('The file does not match its image type.')
        const name = sha256(bytes) + '.' + type.ext
        await chargeMediaQuota(req, bytes.length)
        // Pending until a launch with metadata that references it registers (K5), and pinned to
        // IPFS only once metadata references it. With pinning and no public address the link is
        // only this visitor's handle for /api/metadata (which reads its path), never published.
        await store.putMedia(name, bytes, mediaLimit, { ttl: pendingMediaMs })
        const origin = base || hostOrigin(req.headers.host, requestProtocol(req)) || ''
        return json(res, 201, { url: `${origin}/media/${name}` })
      }
      if (path === '/api/metadata') {
        // Metadata URIs are written on-chain: never under a host the request chose (QP-SEC-6).
        const base = publicBase(req)
        if (!base && !pinataJwt) throw publicUrlUnset()
        const b = await readJsonObject(req, 16000)
        const data = {}
        for (const key of [
          'name',
          'symbol',
          'description',
          'image',
          'website',
          'twitter',
          'telegram',
        ]) {
          data[key] = String(b[key] || '').trim()
          if (data[key].length > 2048) throw clientError('Metadata field is too long.')
        }
        if (
          !data.name ||
          !data.symbol ||
          Buffer.byteLength(data.name) > 32 ||
          Buffer.byteLength(data.symbol) > 10 ||
          data.description.length > 500
        )
          throw clientError(
            'Name (32 bytes), ticker (10 bytes) and description (500 characters) must fit Meteora token limits.',
          )
        const isWebLink = (v) => {
          try {
            return /^https?:\/\//i.test(v) && ['http:', 'https:'].includes(new URL(v).protocol)
          } catch {
            return false
          }
        }
        for (const key of ['image', 'website', 'twitter', 'telegram'])
          if (data[key] && !isWebLink(data[key]))
            throw clientError('Links must be full http or https addresses.')
        if (!data.image) throw clientError('Upload token artwork before launching.')
        const ownArt =
          new URL(data.image).pathname.match(
            /^\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/,
          )?.[1] ?? null
        const artworkGone = () =>
          clientError('Token artwork is no longer available. Upload it again before launching.')
        // The document is content-addressed: the same fields give the same uri.
        const documentBytes = () => {
          const document = { ...data, showName: true, ...(base ? { createdOn: base } : {}) }
          for (const key of ['website', 'twitter', 'telegram'])
            if (!document[key]) delete document[key]
          const bytes = Buffer.from(JSON.stringify(document))
          return { bytes, id: sha256(bytes).slice(0, 32) }
        }
        const checkUri = async (uri) => {
          if (uri.length > 200)
            throw clientError('Metadata URI exceeds the 200 character on-chain limit.')
          // The indexer binds an issued uri to the first coin that registers with it and lists
          // no other coin with it, so a second launch with the same metadata would pay for its
          // create and then be refused. Say so before anything is created.
          if (await store.get(issuedUriClaimKey(uri)))
            throw clientError(
              'This token metadata was already used by another launch. Change the description or the artwork to launch a new coin.',
              409,
              'METADATA_USED',
            )
        }
        let uri
        if (pinataJwt) {
          // The document and our own artwork are pinned to IPFS (each blob once); nothing is
          // stored here. Documents are under 16 KB, so the request costs the minimum charge.
          await chargeMediaQuota(req, 0)
          if (ownArt) {
            const artwork = await readArtwork(ownArt)
            if (!artwork) throw artworkGone()
            data.image = await pinOnce(req, artwork, ownArt, MEDIA_MIME[ownArt.split('.').at(-1)])
          }
          const { bytes, id } = documentBytes()
          uri = await pinOnce(req, bytes, `${id}.json`, 'application/json')
          await checkUri(uri)
        } else {
          // This deployment serves the document and our own artwork, both pending until a launch
          // with this uri registers (K5): abandoned ones expire like uploads.
          if (ownArt) data.image = `${base}/media/${ownArt}`
          const { bytes, id } = documentBytes()
          uri = `${base}/m/${id}`
          await checkUri(uri)
          // The document costs the minimum charge. Keeping the artwork for another pending period
          // costs its full size again, like uploading it again (QP-SEC-2), so re-issuing metadata
          // never keeps bytes stored for less than they cost.
          await chargeMediaQuota(req, 0)
          const artwork = ownArt ? await readArtwork(ownArt) : null
          if (ownArt && !artwork) throw artworkGone()
          if (artwork) await chargeDaily(req, 'client', artwork.length, mediaClientLimit)
          // A permanent artwork is left as it is; one that expired since the read is stored again.
          if (artwork) await store.putMedia(ownArt, artwork, mediaLimit, { ttl: pendingMediaMs })
          await store.putMedia(`meta-${id}.json`, bytes, mediaLimit, { ttl: pendingMediaMs })
        }
        // Launch provenance: /api/launches only lists a coin as a Quant Pad launch when its
        // on-chain uri was issued here (or it is a verified Quantum coin).
        await store.set(issuedUriKey(uri), { at: Date.now() }, { ttl: DAY_MS })
        return json(res, 201, { uri })
      }
      if (path === '/api/sync') {
        await limiter(req, { bucket: 'sync', limit: 12 })
        const body = await readJsonBody(req, 2000).catch(() => null)
        const mint = body?.mint
        if (isAddress(mint)) {
          const coin = await syncMint(mint, { req })
          return json(res, 202, { coin: coin && summarize(coin) })
        }
        // A full pass is shared by every visitor: at most one manual pass per cooldown.
        if (!(await store.set('sync:manual', 1, { nx: true, ttl: SYNC_COOLDOWN_MS })))
          return json(res, 202, { skipped: true })
        return json(res, 202, await indexer.sync({ ...INDEX_MS }))
      }
      return json(res, 404, { error: 'Endpoint not found.' })
    } catch (e) {
      if (res.headersSent) return res.destroy?.()
      // Missing files and media: never echo the store's error (file stores include paths).
      if (e?.code === 'ENOENT') return json(res, 404, { error: 'Not found.' })
      const status = Number(e?.status)
      const code = typeof e?.code === 'string' ? { code: e.code } : {}
      if (Number.isInteger(status) && status >= 400 && status < 500)
        return json(res, status, { error: String(e.message || 'Request failed.'), ...code })
      // Server-side errors are shown only when deliberately written for users.
      if (e?.expose === true && Number.isInteger(status) && status >= 500 && status < 600)
        return json(res, status, { error: String(e.message), ...code })
      // RPC and storage errors can carry provider bodies, URLs, keys or file paths: log only.
      console.error('[api]', req.method, path, e)
      return json(res, 500, { error: 'Something went wrong. Try again.' })
    }
  }

  // Index on every pass; run the keeper at most every two minutes so request-driven serverless
  // deployments stay live without a paid cron schedule. The keeper gets what is left of the
  // time budget after the index pass, so it is never stopped mid-run with its lease held.
  // On serverless the budget counts from the start of the invocation (startedAt), which includes
  // the request this pass runs after, so a slow request leaves less (or nothing) for the pass.
  // Every serverless request schedules a pass, and even a pass that finds the index lease taken
  // costs store commands, so one instance runs one pass at a time and starts at most one per
  // BACKGROUND_GAP_MS; the index lease already keeps instances from duplicating work.
  // The deployment-wide spacing is one SET NX per attempt; an instance that finds it taken waits
  // half the spacing before asking again.
  let backgroundRunning = false
  let backgroundNext = 0
  async function background({ startedAt } = {}) {
    const started = startedAt ?? Date.now()
    const MIN_MS = 10_000
    if (serverless && timeLeft(started) < MIN_MS) return
    if (backgroundRunning || Date.now() < backgroundNext) return
    backgroundRunning = true
    backgroundNext = Date.now() + BACKGROUND_GAP_MS
    try {
      if (BACKGROUND_SYNC_MS > 0) {
        const due = await store
          .set('sync:background', 1, { nx: true, ttl: BACKGROUND_SYNC_MS })
          .catch(() => false)
        if (!due) {
          backgroundNext = Date.now() + Math.max(BACKGROUND_GAP_MS, BACKGROUND_SYNC_MS / 2)
          return
        }
      }
      const index = serverless
        ? { timeMs: Math.min(INDEX_MS.timeMs, timeLeft(started) - 5_000) }
        : INDEX_MS
      await indexer.sync({ budget: serverless ? 3 : 6, ...index }).catch(() => {})
      if (serverless && timeLeft(started) < MIN_MS) return
      if (
        keeper.enabled &&
        (await store.set('keeper:throttle', 1, { nx: true, ttl: 120000 }).catch(() => false))
      )
        await keeper
          .tick({ timeLimitMs: serverless ? timeLeft(started) - 3_000 : keeperBudget(started) })
          .catch((e) => console.error('[keeper]', e.message))
    } finally {
      backgroundRunning = false
    }
  }
  let timer = null
  if (!serverless && options.background !== false) {
    timer = setInterval(() => background(), 15000)
    timer.unref()
  }

  return {
    middleware,
    sync: background,
    close: () => {
      if (timer) clearInterval(timer)
      for (const pending of trailingSyncs.values()) clearTimeout(pending)
      trailingSyncs.clear()
    },
    indexer,
    // The read-only indexer the public GET routes use (shared store reads).
    reads,
    keeper,
    store,
    connection,
    // The callback the indexer calls for each launch it registers native (K5).
    onNativeLaunch: keepLaunchMedia,
  }
}
