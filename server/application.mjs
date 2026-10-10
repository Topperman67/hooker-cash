import { resolve } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { createConnection } from './solana.mjs'
import { createIndexer, summarize } from './indexer.mjs'
import { createKeeper, loadQuantumClient, parseKeeperSecret } from './keeper.mjs'
import { createPriceFeed } from './prices.mjs'
import { createRpcProxy } from './rpc-proxy.mjs'
import { configuredStore, createFileStore } from './storage.mjs'
import { createLimiter, createWriteGuard } from './request-limits.mjs'
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
export function isPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    host === 'localhost' ||
    /\.(local|internal|localhost)$/.test(host) ||
    (!host.includes('.') && !host.includes(':'))
  )
    return false
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    )
  }
  if (host.includes(':')) return !/^(::|::1|fc|fd|fe80|::ffff:)/.test(host)
  return true
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
  const limiter = createLimiter({ store: redis, vercel: serverless && process.env.VERCEL === '1' })
  const writeAllowed = createWriteGuard({
    store: redis,
    vercel: serverless && process.env.VERCEL === '1',
  })
  const rpcProxy = createRpcProxy({ rpcUrl, limiter })

  const quantum = options.quantum === undefined ? await loadQuantumClient() : options.quantum
  let programStatus = { checkedAt: 0, deployed: false, config: null }
  async function quantumStatus() {
    if (!quantum?.QUANTUM_PROGRAM_ID) return { available: false, reason: 'client-missing' }
    if (Date.now() - programStatus.checkedAt > 300000) {
      try {
        const info = await connection.getAccountInfo(quantum.QUANTUM_PROGRAM_ID)
        const config = info?.executable
          ? await quantum.fetchConfig(connection).catch(() => null)
          : null
        programStatus = { checkedAt: Date.now(), deployed: !!info?.executable, config }
      } catch {
        programStatus.checkedAt = Date.now() - 240000
      }
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
  // A coin counts as Quantum only when its creator is the well AND its hooks are registered;
  // anyone can name a well as creator, but only the mint keypair can register hooks.
  const isQuantumCreator = async (mint, creator) => {
    try {
      if (!quantum?.wellPda || quantum.wellPda(new PublicKey(mint)).toBase58() !== creator)
        return false
      if (!quantum.verifyQuantumCoin) return true
      const check = await quantum.verifyQuantumCoin(connection, new PublicKey(mint))
      return check.registered && check.creatorIsWell
    } catch {
      return false
    }
  }
  const indexer = createIndexer({ connection, store, isQuantumCreator })
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
    const cid = response?.ok ? (await response.json())?.data?.cid : null
    if (!cid) throw Object.assign(Error('IPFS pinning failed. Try again shortly.'), { status: 502 })
    return `${ipfsGateway}/${cid}`
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
        throw Error('Invalid JSON.')
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
      throw Object.assign(Error('Invalid JSON.'), { status: 400 })
    }
  }

  // Off-chain metadata for display. Our own URIs are read from storage; others are fetched once
  // over https with a size and time limit and cached on the coin record.
  async function resolveMetadata(uri) {
    try {
      const url = new URL(uri)
      const own = url.pathname.match(/^\/m\/([a-f0-9]{32})$/)
      let text
      if (own) text = (await store.getMedia(`meta-${own[1]}.json`)).toString('utf8')
      else {
        // Follow up to three redirects by hand so every hop is checked against private hosts.
        let target = url,
          response
        for (let hop = 0; hop < 4; hop++) {
          if (target.protocol !== 'https:' || !isPublicHost(target.hostname)) return null
          response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
          const location = response.headers.get('location')
          if (response.status < 300 || response.status >= 400 || !location) break
          target = new URL(location, target)
          response = null
        }
        if (!response?.ok) return null
        text = await response.text()
        if (text.length > 65536) return null
      }
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object') return null
      const pick = (v) => (typeof v === 'string' && v.length <= 2048 ? v : '')
      const link = (v) => (/^https:\/\//i.test(pick(v)) ? pick(v) : '')
      return {
        image: link(data.image),
        description: pick(data.description).slice(0, 600),
        website: link(data.website),
        twitter: link(data.twitter),
        telegram: link(data.telegram),
      }
    } catch {
      return null
    }
  }
  async function withMetadata(record) {
    if (!record || record.meta !== undefined || !record.uri) return record
    const meta = await resolveMetadata(record.uri)
    const next = { ...record, meta: meta || null, image: meta?.image || null }
    await store.set(`coin:${record.mint}`, next)
    const list = await indexer.list()
    const i = list.findIndex((c) => c.mint === record.mint)
    if (i >= 0) {
      list[i] = summarize(next)
      await store.set('coins:list', list)
    }
    return next
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

      if (req.method === 'POST' && path === '/api/rpc') {
        const { status: code, body } = await rpcProxy(req, await readJsonBody(req, 1_500_000))
        return json(res, code, body)
      }

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
        const coin = await withMetadata(record)
        const { cursor, poolCursor, ...publicCoin } = coin
        return json(res, 200, { coin: publicCoin })
      }

      const quantumMatch = path.match(
        /^\/api\/quantum\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:\/(claims))?$/,
      )
      if (req.method === 'GET' && quantumMatch) {
        const [, mint, part] = quantumMatch
        if (part === 'claims') {
          const wallet = url.searchParams.get('wallet')
          if (!isAddress(wallet)) throw Error('Provide a wallet address.')
          return json(res, 200, { items: await keeper.claims(mint, wallet) })
        }
        return json(res, 200, { epochs: await keeper.epochs(mint), log: await keeper.log(mint) })
      }

      if (path === '/api/keeper/tick' && (req.method === 'GET' || req.method === 'POST')) {
        const secret = process.env.CRON_SECRET
        const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '')
        const ok =
          secret &&
          supplied.length === secret.length &&
          timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
        if (!ok) return json(res, 401, { error: 'Unauthorized' })
        const [index, keep] = [await indexer.sync({ budget: 8 }), await keeper.tick()]
        return json(res, 200, { index, keeper: keep })
      }

      if (req.method !== 'POST') return json(res, 404, { error: 'Endpoint not found.' })
      await writeAllowed(req)
      if (!storage.ready)
        return json(res, 503, { error: storage.error, code: 'STORAGE_UNCONFIGURED' })

      if (path === '/api/launches') {
        const { signature } = await readJsonBody(req, 2000)
        const coin = await indexer.registerLaunch(String(signature || ''))
        return json(res, 201, { coin: await withMetadata(coin) })
      }
      if (path === '/api/coins/track') {
        const { mint } = await readJsonBody(req, 2000)
        if (hidden.has(mint))
          return json(res, 404, {
            error: 'This coin is not available on Quant Pad.',
            code: 'HIDDEN',
          })
        const coin = await indexer.track(String(mint || ''))
        return json(res, 201, { coin: await withMetadata(coin) })
      }
      if (path === '/api/media') {
        const b = await readJsonBody(req, 2_200_000)
        const m = String(b.data || '').match(
          /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/,
        )
        if (!m) throw Error('Choose a PNG, JPEG, WebP or GIF image.')
        const bytes = Buffer.from(m[2], 'base64')
        if (bytes.length > 1_500_000) throw Error('Choose an image under 1.5 MB.')
        const type = IMAGE_TYPES[m[1]]
        if (!type.ok(bytes)) throw Error('The file does not match its image type.')
        const name = createHash('sha256').update(bytes).digest('hex') + '.' + type.ext
        await store.putMedia(name, bytes, mediaLimit)
        const pinned = await pin(bytes, name, type.mime)
        return json(res, 201, { url: pinned || `${baseUrl(req)}/media/${name}` })
      }
      if (path === '/api/metadata') {
        const b = await readJsonBody(req, 16000)
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
          if (data[key].length > 2048) throw Error('Metadata field is too long.')
        }
        if (
          !data.name ||
          !data.symbol ||
          Buffer.byteLength(data.name) > 32 ||
          Buffer.byteLength(data.symbol) > 10 ||
          data.description.length > 500
        )
          throw Error(
            'Name (32 bytes), ticker (10 bytes) and description (500 characters) must fit pump.fun limits.',
          )
        for (const key of ['image', 'website', 'twitter', 'telegram'])
          if (data[key] && !/^https?:\/\//i.test(data[key]))
            throw Error('Links must use http or https.')
        if (!data.image) throw Error('Upload token artwork before launching.')
        const own = new URL(data.image).pathname.match(
          /^\/media\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/,
        )
        if (own) {
          try {
            await store.getMedia(own[1])
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
            throw Error('Token artwork is no longer available. Upload it again before launching.')
          }
        }
        const document = { ...data, showName: true, createdOn: baseUrl(req) }
        for (const key of ['website', 'twitter', 'telegram'])
          if (!document[key]) delete document[key]
        const bytes = Buffer.from(JSON.stringify(document))
        const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
        await store.putMedia(`meta-${id}.json`, bytes, mediaLimit)
        const uri =
          (await pin(bytes, `${id}.json`, 'application/json')) || `${baseUrl(req)}/m/${id}`
        if (uri.length > 200) throw Error('Metadata URI exceeds the 200 character on-chain limit.')
        return json(res, 201, { uri })
      }
      if (path === '/api/sync') {
        const { mint } = await readJsonBody(req, 2000).catch(() => ({}))
        if (isAddress(mint)) {
          const coin = await indexer.syncCoin(mint)
          return json(res, 202, { coin: coin && summarize(coin) })
        }
        return json(res, 202, await indexer.sync())
      }
      return json(res, 404, { error: 'Endpoint not found.' })
    } catch (e) {
      return json(res, e.code === 'ENOENT' ? 404 : e.status || 400, { error: e.message })
    }
  }

  // Index on every pass; run the keeper at most every two minutes so request-driven serverless
  // deployments stay live without a paid cron schedule.
  async function background() {
    await indexer.sync({ budget: serverless ? 3 : 6 }).catch(() => {})
    if (keeper.enabled && (await store.set('keeper:throttle', 1, { nx: true, ttl: 120000 })))
      await keeper.tick().catch((e) => console.error('[keeper]', e.message))
  }
  let timer = null
  if (!serverless && options.background !== false) {
    timer = setInterval(() => background(), 15000)
    timer.unref()
  }

  return {
    middleware,
    sync: background,
    close: () => timer && clearInterval(timer),
    indexer,
    keeper,
    store,
    connection,
  }
}
