import { resolve } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { pipeline } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { createConnection } from './solana.mjs'
import { createIndexer, issuedUriKey, summarize } from './indexer.mjs'
import {
  createKeeper,
  loadQuantumClient,
  parseKeeperSecret,
  quantumClientError,
} from './keeper.mjs'
import { createPriceFeed } from './prices.mjs'
import { createRpcProxy, writeRpcResponse } from './rpc-proxy.mjs'
import { configuredStore, createFileStore } from './storage.mjs'
import * as requestLimits from './request-limits.mjs'
import {
  brand,
  network,
  storageDirectory,
  isAddress,
  DEFAULT_PLATFORM_FEE_BPS,
  MAX_PLATFORM_FEE_BPS,
} from '../shared/network.mjs'

const json = (res, status, data, cache = 'no-store') => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

const { clientKey, createLimiter, createWriteGuard } = requestLimits

// Errors meant for API clients carry a 4xx status; anything else is logged and reported
// generically.
const clientError = (message, status = 400, code) =>
  Object.assign(Error(message), { status, ...(code ? { code } : {}) })
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// Internal bookkeeping that never leaves the server: signature cursors, backlog anchors (`gaps`
// holds signatures too) and the indexer's sync state.
const INTERNAL_COIN_FIELDS = [
  'cursor',
  'poolCursor',
  'gaps',
  'seq',
  'historyFrom',
  'supplyAt',
  'day',
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
  const solUsd = options.priceFeed || createPriceFeed()
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
  // Uploads stay pending until metadata references them, so abandoned uploads expire and give
  // their space back (on stores that support it; others keep every upload).
  const pendingMediaMs = options.pendingMediaMs || 24 * 3600_000
  const vercel = serverless && process.env.VERCEL === '1'
  const trustProxy = requestLimits.trustedProxyHops?.() ?? 0
  const limiter = createLimiter({ store: redis, vercel })
  const writeAllowed = createWriteGuard({ store: redis, vercel })
  const rpcProxy = createRpcProxy({ rpcUrl, limiter })
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
  // client loaded) leaves the flag unknown rather than loading a second copy.
  const indexer = createIndexer({ connection, store, quantum })
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
    const url = await pin(bytes, name, type)
    await store.set(key, url)
    return url
  }

  const DAY_MS = 86_400_000
  // Every media write is charged at least this much, so tiny distinct files cannot be created
  // without bound.
  const MEDIA_MIN_CHARGE = 128 * 1024
  const dailyUsage = new Map()
  async function chargeDaily(req, kind, amount, limit) {
    const day = Math.floor(Date.now() / DAY_MS)
    // clientKey counts an IPv6 visitor by its /64, which one host can rotate through freely.
    const key = `media:${kind}:${clientKey(req, vercel, trustProxy)}:${day}`
    let used
    if (redis && redis.mode !== 'filesystem') {
      // INCR sets the expiry on first use; INCRBY keeps it.
      used = await redis.incrementExpiring(key, 2 * DAY_MS)
      if (amount > 1) used = await redis.increment(key, amount - 1)
    } else {
      for (const [k, v] of dailyUsage) if (v.day !== day) dailyUsage.delete(k)
      used = (dailyUsage.get(key)?.used || 0) + amount
      dailyUsage.set(key, { day, used })
    }
    if (used > limit)
      throw clientError(
        'Daily upload limit reached for this connection. Try again tomorrow.',
        429,
        'MEDIA_QUOTA',
      )
  }
  const chargeMediaQuota = (req, size) =>
    chargeDaily(req, 'client', Math.max(size, MEDIA_MIN_CHARGE), mediaClientLimit)

  // Keeps uploaded artwork that metadata references. Returns its bytes, or null when the upload
  // is gone (never stored, or a pending upload that expired).
  async function keepArtwork(name) {
    let bytes
    try {
      bytes = await store.getMedia(name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return null
    }
    if (typeof store.promoteMedia === 'function') {
      // false: the pending upload expired between the read and the promotion.
      if ((await store.promoteMedia(name, mediaLimit)) === false) return null
    }
    return bytes
  }
  function baseUrl(req) {
    return (
      process.env.QUANTPAD_PUBLIC_URL ||
      (serverless
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host}`
        : '') ||
      `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`
    ).replace(/\/$/, '')
  }
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
  const isOwnMetaUri = (uri) => {
    try {
      return OWN_META.test(new URL(uri).pathname)
    } catch {
      return false
    }
  }
  async function readMetadataDocument(uri) {
    let own = null
    try {
      own = new URL(uri).pathname.match(OWN_META)
    } catch {}
    if (own) {
      try {
        return { text: (await store.getMedia(`meta-${own[1]}.json`)).toString('utf8'), own: true }
      } catch (e) {
        if (e?.code !== 'ENOENT') throw metadataFailure('Storage is unavailable.', true)
        // Not in this deployment's storage: fetch it like any other public URI.
      }
    }
    return { text: await fetchMetadataText(uri, { resolveHost: resolveMetadataHost }), own: false }
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
  async function syncMintOnce(mint, trailing) {
    const record = await indexer.coin(mint)
    if (!record) return null
    const fresh = !trailing && record.syncedAt && Date.now() - record.syncedAt < SYNC_COOLDOWN_MS
    if (fresh || !(await store.set(`sync:coin:${mint}`, 1, { nx: true, ttl: SYNC_COOLDOWN_MS }))) {
      // A blocked trailing sync means another sync started after it was queued; nothing to add.
      if (!trailing) queueTrailingSync(mint)
      return record
    }
    return indexer.syncCoin(mint, serverless ? { deadline: Date.now() + INDEX_MS.timeMs } : {})
  }
  function syncMint(mint, { trailing = false } = {}) {
    let run = coinSyncs.get(mint)
    if (!run) {
      run = syncMintOnce(mint, trailing).finally(() => coinSyncs.delete(mint))
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

  async function status() {
    const [price, q] = await Promise.all([solUsd(), quantumStatus()])
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
      storage,
      solUsd: price.usd,
      ipfs: !!pinataJwt,
      lookupTable: isAddress(process.env.QUANTPAD_LOOKUP_TABLE)
        ? process.env.QUANTPAD_LOOKUP_TABLE
        : null,
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
          'Cache-Control': 'public,max-age=31536000,immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Access-Control-Allow-Origin': '*',
        })
        return res.end(bytes)
      }

      if (req.method === 'GET' && path === '/api/status') return json(res, 200, await status())

      // The proxy's answer goes out as received (no re-serialising of large payloads), with its
      // headers: an upstream 429 keeps its Retry-After (C6).
      if (req.method === 'POST' && path === '/api/rpc')
        return writeRpcResponse(res, await rpcProxy(req, await readJsonBody(req, 1_500_000)))

      if (req.method === 'GET' && path === '/api/market') {
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0))
        const result = await indexer.market({
          hidden,
          q: (url.searchParams.get('q') || '').slice(0, 100),
          sort: url.searchParams.get('sort') || 'newest',
          filter: url.searchParams.get('filter') || 'all',
          launcher: isAddress(url.searchParams.get('launcher'))
            ? url.searchParams.get('launcher')
            : '',
          offset,
        })
        return json(res, 200, result)
      }

      if (req.method === 'GET' && path === '/api/coins') {
        const wanted = new Set(
          (url.searchParams.get('mints') || '').split(',').filter(isAddress).slice(0, 100),
        )
        const items = (await indexer.list()).filter(
          (c) => wanted.has(c.mint) && !hidden.has(c.mint),
        )
        return json(res, 200, { items })
      }

      if (req.method === 'GET' && path === '/api/stats') {
        const coins = (await indexer.list()).filter((c) => !c.external && !hidden.has(c.mint))
        return json(res, 200, {
          coins: coins.length,
          quantum: coins.filter((c) => c.quantum).length,
          graduated: coins.filter((c) => c.complete).length,
          volume24h: coins.reduce((s, c) => s + (c.volume24h || 0), 0),
          trades24h: coins.reduce((s, c) => s + (c.trades24h || 0), 0),
        })
      }

      const coinMatch = path.match(
        /^\/api\/coins\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/(trades|candles))?$/,
      )
      if (req.method === 'GET' && coinMatch) {
        const [, mint, part] = coinMatch
        if (hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        const record = await indexer.coin(mint)
        if (!record)
          return json(res, 404, { error: 'This coin is not tracked yet.', code: 'NOT_TRACKED' })
        if (part === 'candles') {
          const n = Number(url.searchParams.get('interval'))
          const interval = [15, 60, 300, 900, 3600, 14400, 86400].includes(n) ? n : 300
          return json(res, 200, { items: await indexer.candles(mint, interval), interval })
        }
        if (part === 'trades') {
          const side = ['buy', 'sell'].includes(url.searchParams.get('side'))
            ? url.searchParams.get('side')
            : null
          return json(
            res,
            200,
            await indexer.trades(mint, {
              side,
              offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
            }),
          )
        }
        return json(res, 200, { coin: publicCoin(await withMetadata(record)) })
      }

      const quantumMatch = path.match(
        /^\/api\/quantum\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/(claims))?$/,
      )
      if (req.method === 'GET' && quantumMatch) {
        const [, mint, part] = quantumMatch
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

      if (path === '/api/keeper/tick' && (req.method === 'GET' || req.method === 'POST')) {
        const secret = process.env.CRON_SECRET
        const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '')
        const ok =
          secret &&
          supplied.length === secret.length &&
          timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
        if (!ok) return json(res, 401, { error: 'Unauthorized' })
        const started = Date.now()
        const index = await indexer.sync({ budget: 8, ...INDEX_MS })
        const keep = await keeper.tick({ timeLimitMs: keeperBudget(started) })
        // the keeper just ran: the background pass after this response must not run it again
        await store.set('keeper:throttle', 1, { ttl: 120000 }).catch(() => {})
        return json(res, 200, { index, keeper: keep })
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'Endpoint not found.' })
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
        const { mint } = await readJsonObject(req, 2000)
        if (!isAddress(mint)) throw clientError('Enter a valid Solana mint address.')
        if (hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        const coin = await indexer.track(mint)
        return json(res, 201, { coin: publicCoin(await withMetadata(coin)) })
      }
      if (path === '/api/media') {
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
        // Pending until /api/metadata references it (and pinned to IPFS only then).
        await store.putMedia(name, bytes, mediaLimit, { ttl: pendingMediaMs })
        return json(res, 201, { url: `${baseUrl(req)}/media/${name}` })
      }
      if (path === '/api/metadata') {
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
            'Name (32 bytes), ticker (10 bytes) and description (500 characters) must fit pump.fun limits.',
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
        // Documents are under 16 KB, so each one costs the minimum charge.
        await chargeMediaQuota(req, 0)
        const own = new URL(data.image).pathname.match(
          /^\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/,
        )
        if (own) {
          // Our own upload: keep it for good, and point the document at its IPFS pin when
          // pinning is configured, otherwise at this deployment's copy.
          const artwork = await keepArtwork(own[1])
          if (!artwork)
            throw clientError(
              'Token artwork is no longer available. Upload it again before launching.',
            )
          data.image =
            (await pinOnce(req, artwork, own[1], MEDIA_MIME[own[1].split('.').at(-1)])) ||
            `${baseUrl(req)}/media/${own[1]}`
        }
        const document = { ...data, showName: true, createdOn: baseUrl(req) }
        for (const key of ['website', 'twitter', 'telegram'])
          if (!document[key]) delete document[key]
        const bytes = Buffer.from(JSON.stringify(document))
        const id = sha256(bytes).slice(0, 32)
        await store.putMedia(`meta-${id}.json`, bytes, mediaLimit)
        const uri =
          (await pinOnce(req, bytes, `${id}.json`, 'application/json')) || `${baseUrl(req)}/m/${id}`
        if (uri.length > 200)
          throw clientError('Metadata URI exceeds the 200 character on-chain limit.')
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
          const coin = await syncMint(mint)
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
  async function background({ startedAt } = {}) {
    const started = startedAt ?? Date.now()
    const MIN_MS = 10_000
    if (serverless && timeLeft(started) < MIN_MS) return
    const index = serverless
      ? { timeMs: Math.min(INDEX_MS.timeMs, timeLeft(started) - 5_000) }
      : INDEX_MS
    await indexer.sync({ budget: serverless ? 3 : 6, ...index }).catch(() => {})
    if (serverless && timeLeft(started) < MIN_MS) return
    if (keeper.enabled && (await store.set('keeper:throttle', 1, { nx: true, ttl: 120000 })))
      await keeper
        .tick({ timeLimitMs: serverless ? timeLeft(started) - 3_000 : keeperBudget(started) })
        .catch((e) => console.error('[keeper]', e.message))
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
    keeper,
    store,
    connection,
  }
}
