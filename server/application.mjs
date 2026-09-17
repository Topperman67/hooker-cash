import { readFile, writeFile, mkdir, link, unlink, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import {
  createPublicClient,
  http,
  getAddress,
  encodeDeployData,
  getCreate2Address,
  keccak256,
} from 'viem'
import { treasury as configuredTreasury, arcInfrastructure } from './settings.mjs'
import { createIndexer } from './indexer.mjs'
import { candlesFor } from './market-math.mjs'
import { configuredStore } from './storage.mjs'
import abi from '../src/generated/protocol.json' with { type: 'json' }

const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
export async function createApplication(options = {}) {
  const treasury = options.treasury || configuredTreasury
  let activating = false
  const dataDir = resolve(options.dataDir || process.env.HOOKBREW_DATA_DIR || '.hookbrew-data')
  const deploymentFile = resolve(dataDir, 'deployment.json')
  const store = options.store || configuredStore()
  const serverless = options.serverless === true
  const storage = {
    mode: store ? 'redis' : serverless ? 'unconfigured' : 'filesystem',
    ready: !!store || !serverless,
    ...(!store && serverless
      ? {
          error:
            'Persistent storage is not connected. Connect an Upstash Redis database to this Vercel project before activating or launching. Your saved deployment receipts can be reused; no redeployment is needed.',
        }
      : {}),
  }
  const mediaLimit =
    options.mediaLimitBytes || Number(process.env.HOOKBREW_MEDIA_LIMIT_MB || 256) * 1024 * 1024
  let mediaBytes = 0,
    mediaQueue = Promise.resolve()
  try {
    for (const name of await readdir(resolve(dataDir, 'media')))
      mediaBytes += (await stat(resolve(dataDir, 'media', name))).size
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  let config = null,
    indexer = null,
    timer = null
  const infrastructure = { ...arcInfrastructure, ...options.infrastructure }
  const client =
    options.client ||
    createPublicClient({
      transport: http(process.env.HOOKBREW_RPC_URL || infrastructure.rpcUrl, {
        timeout: 15000,
        retryCount: 1,
      }),
    })
  const limits = new Map()
  async function activateLocal(next) {
    const nextIndexer = createIndexer({ client, config: next, abi, dataDir, store })
    await nextIndexer.load()
    config = next
    indexer = nextIndexer
    if (timer) clearInterval(timer)
    if (!serverless) {
      indexer.sync()
      timer = setInterval(() => indexer.sync(), 10000)
      timer.unref()
    }
  }
  async function storedDeployment() {
    if (!storage.ready) return null
    if (store) return store.get('deployment')
    try {
      return JSON.parse(await readFile(deploymentFile, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  async function refreshDeployment() {
    const saved = await storedDeployment()
    if (!saved) {
      if (config)
        throw Error(
          'The active deployment record is unavailable. Restore persistent storage before continuing.',
        )
      return
    }
    if (saved.chainId !== infrastructure.chainId || !same(saved.treasury, treasury))
      throw Error('Stored deployment differs from configured chain/treasury')
    if (JSON.stringify(saved) !== JSON.stringify(config)) await activateLocal(saved)
  }
  // Read on each request: warm instances must observe activation by another instance.
  async function saveDeployment(value) {
    if (store) return store.set('deployment', value, { nx: true })
    await mkdir(dataDir, { recursive: true })
    const temporary = `${deploymentFile}.${randomBytes(12).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(value, null, 2))
    try {
      await link(temporary, deploymentFile)
      return true
    } catch (e) {
      if (e.code === 'EEXIST') return false
      throw e
    } finally {
      await unlink(temporary)
    }
  }
  async function saveChallenge(nonce, value) {
    if (store) return store.set(`challenge:${nonce}`, value, { ttl: 300000 })
    await mkdir(resolve(dataDir, 'challenges'), { recursive: true })
    // Expired authorizations are never accepted, and old files are pruned here.
    for (const name of await readdir(resolve(dataDir, 'challenges'))) {
      const file = resolve(dataDir, 'challenges', name)
      try {
        if ((await stat(file)).mtimeMs < Date.now() - 300000) await unlink(file)
      } catch {}
    }
    await writeFile(resolve(dataDir, 'challenges', nonce), JSON.stringify(value))
  }
  async function getChallenge(nonce) {
    if (!/^[a-f0-9]{40}$/.test(nonce || '')) return null
    if (store) return store.get(`challenge:${nonce}`)
    try {
      return JSON.parse(await readFile(resolve(dataDir, 'challenges', nonce), 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw e
    }
  }
  function existingDeployment(res, supplied) {
    if (!config) return false
    const matches =
      same(supplied.factoryTx, config.factoryTx) && same(supplied.routerTx, config.routerTx)
    json(res, matches ? 200 : 409, {
      deployment: config,
      alreadyActive: true,
      ...(!matches
        ? {
            error:
              'A different Hookbrew deployment is already active. Continue with the active venue; no additional deployment is needed.',
          }
        : {}),
    })
    return true
  }
  async function body(req, max = 2200000) {
    // Vercel may provide an already-parsed body instead of a readable stream.
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
    let chunks = [],
      size = 0
    for await (const c of req) {
      size += c.length
      if (size > max) throw Object.assign(Error('Upload exceeds 2 MB.'), { status: 413 })
      chunks.push(c)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      throw Object.assign(Error('Invalid JSON.'), { status: 400 })
    }
  }
  function writeAllowed(req) {
    const origin = req.headers.origin
    if (!origin || new URL(origin).host !== req.headers.host)
      throw Object.assign(Error('Open this action from the Hookbrew app.'), { status: 403 })
    const ip = req.socket.remoteAddress || 'unknown',
      now = Date.now(),
      record = limits.get(ip) || { time: now, count: 0 }
    if (now - record.time > 60000) {
      record.time = now
      record.count = 0
    }
    if (++record.count > 30)
      throw Object.assign(Error('Too many requests. Try again shortly.'), { status: 429 })
    limits.set(ip, record)
  }
  function baseUrl(req) {
    return (
      process.env.HOOKBREW_PUBLIC_URL ||
      (serverless
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || req.headers.host}`
        : '') ||
      `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`
    ).replace(/\/$/, '')
  }
  async function media(name, bytes) {
    if (store) return store.putMedia(name, bytes, mediaLimit)
    const operation = mediaQueue.then(async () => {
      const file = resolve(dataDir, 'media', name)
      try {
        await stat(file)
        return
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      if (mediaBytes + bytes.length > mediaLimit)
        throw Object.assign(Error('Media storage is full. Contact the venue operator.'), {
          status: 507,
        })
      await mkdir(resolve(dataDir, 'media'), { recursive: true })
      await writeFile(file, bytes, { flag: 'wx' })
      mediaBytes += bytes.length
    })
    mediaQueue = operation.catch(() => {})
    return operation
  }
  async function readMedia(name) {
    if (!store) return readFile(resolve(dataDir, 'media', name))
    const value = await store.get(`media:${name}`)
    if (value === null) throw Object.assign(Error('Not found'), { code: 'ENOENT' })
    return Buffer.from(value, 'base64')
  }
  async function tokenMetadata(token) {
    try {
      const url = new URL(token.metadataURI)
      if (!/^\/media\/meta-[a-f0-9]{64}\.json$/.test(url.pathname)) return null
      const metadata = JSON.parse(
        (await readMedia(url.pathname.split('/').at(-1))).toString('utf8'),
      )
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null
    } catch {
      return null
    }
  }
  async function middleware(req, res, next = () => json(res, 404, { error: 'Not found' })) {
    const url = new URL(req.url, 'http://hookbrew.local'),
      path = url.pathname
    if (!path.startsWith('/api/') && !path.startsWith('/media/')) return next()
    try {
      if (path.startsWith('/media/')) {
        const name = path.slice(7)
        if (!/^(?:meta-)?[a-f0-9]{64}\.(?:png|jpg|webp|json)$/.test(name))
          return json(res, 404, { error: 'Not found' })
        const bytes = await readMedia(name)
        const ext = name.split('.').at(-1)
        res.writeHead(200, {
          'Content-Type': {
            png: 'image/png',
            jpg: 'image/jpeg',
            webp: 'image/webp',
            json: 'application/json',
          }[ext],
          'Cache-Control': 'public,max-age=31536000,immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Access-Control-Allow-Origin': '*',
        })
        return res.end(bytes)
      }
      try {
        await refreshDeployment()
        if (store) await indexer?.load(true)
      } catch (e) {
        throw Object.assign(e, { status: 503 })
      }
      if (req.method === 'GET' && path === '/api/status')
        return json(res, 200, {
          deployment: config,
          treasury,
          infrastructure,
          storage,
          index: indexer?.status() || null,
        })
      if (req.method === 'GET' && path === '/api/market') {
        const q = (url.searchParams.get('q') || '').toLowerCase().slice(0, 100),
          sort = url.searchParams.get('sort') || 'newest',
          fee = Number(url.searchParams.get('fee') || 0)
        let tokens = (indexer?.tokens() || []).filter(
          (t) =>
            (!q ||
              [t.name, t.symbol, t.address, t.creator].some((s) => s.toLowerCase().includes(q))) &&
            (!fee || t.fee === fee),
        )
        tokens.sort((a, b) =>
          sort === 'volume'
            ? b.volume24h - a.volume24h
            : sort === 'mcap'
              ? (b.marketCap || 0) - (a.marketCap || 0)
              : b.createdAt - a.createdAt,
        )
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0)),
          limit = 24
        return json(res, 200, {
          items: await Promise.all(
            tokens.slice(offset, offset + limit).map(async (token) => ({
              ...token,
              metadata: await tokenMetadata(token),
            })),
          ),
          total: tokens.length,
          next: offset + limit < tokens.length ? offset + limit : null,
          deployment: !!config,
          index: indexer?.status() || null,
        })
      }
      const match = path.match(/^\/api\/tokens\/(0x[\da-fA-F]{40})(?:\/(trades|candles))?$/)
      if (req.method === 'GET' && match) {
        const token = indexer?.token(match[1])
        if (!token)
          return json(res, 404, {
            error: config
              ? 'This token is not indexed in this Hookbrew deployment yet.'
              : 'Hookbrew contracts have not been deployed yet.',
          })
        const trades = indexer.trades(match[1])
        if (match[2] === 'candles') {
          const n = Number(url.searchParams.get('interval'))
          const interval = [60, 300, 900, 3600, 14400, 86400].includes(n) ? n : 300
          return json(res, 200, {
            items: candlesFor(trades, interval),
            interval,
            index: indexer.status(),
          })
        }
        if (match[2] === 'trades') {
          const side = url.searchParams.get('side'),
            rows = side ? trades.filter((t) => t.side === side) : trades,
            offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
          return json(res, 200, {
            items: rows.slice(offset, offset + 50),
            total: rows.length,
            next: offset + 50 < rows.length ? offset + 50 : null,
            index: indexer.status(),
          })
        }
        const metadata = await tokenMetadata(token)
        return json(res, 200, {
          token: { ...token, metadata },
          deployment: config,
          index: indexer.status(),
        })
      }
      if (req.method === 'POST') writeAllowed(req)
      if (req.method === 'POST' && !storage.ready)
        return json(res, 503, { error: storage.error, code: 'STORAGE_UNCONFIGURED' })
      if (req.method === 'POST' && path === '/api/media') {
        const b = await body(req),
          m = String(b.data || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
        if (!m) throw Error('Choose a PNG, JPEG or WebP image.')
        const bytes = Buffer.from(m[2], 'base64')
        if (bytes.length > 1500000) throw Error('Choose an image under 1.5 MB.')
        const valid =
          m[1] === 'png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : m[1] === 'jpeg'
              ? bytes[0] === 255 && bytes[1] === 216
              : bytes.subarray(0, 4).toString() === 'RIFF' &&
                bytes.subarray(8, 12).toString() === 'WEBP'
        if (!valid) throw Error('The file does not match its image type.')
        const name =
          createHash('sha256').update(bytes).digest('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1])
        await media(name, bytes)
        return json(res, 201, { url: baseUrl(req) + '/media/' + name })
      }
      if (req.method === 'POST' && path === '/api/metadata') {
        const b = await body(req, 16000),
          data = {}
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
          Buffer.byteLength(data.symbol) > 12 ||
          data.description.length > 280
        )
          throw Error(
            'Name (32 bytes), symbol (12 bytes) and description (280 characters) must fit the token limits.',
          )
        for (const key of ['image', 'website', 'twitter', 'telegram'])
          if (data[key] && !/^https?:\/\//i.test(data[key]))
            throw Error('Links must use http or https.')
        if (data.image) {
          const uploaded = new URL(data.image).pathname.match(
            /^\/media\/([a-f0-9]{64}\.(?:png|jpg|webp))$/,
          )
          if (uploaded) {
            try {
              await readMedia(uploaded[1])
            } catch (error) {
              if (error.code !== 'ENOENT') throw error
              throw Error('Token artwork is no longer available. Upload it again before launching.')
            }
          }
        }
        const bytes = Buffer.from(JSON.stringify(data)),
          name = 'meta-' + createHash('sha256').update(bytes).digest('hex') + '.json'
        await media(name, bytes)
        return json(res, 201, { uri: baseUrl(req) + '/media/' + name })
      }
      if (req.method === 'POST' && path === '/api/deployment/challenge') {
        const supplied = await body(req, 2000)
        if (existingDeployment(res, supplied)) return
        if (
          !/^0x[0-9a-f]{64}$/i.test(supplied.factoryTx) ||
          !/^0x[0-9a-f]{64}$/i.test(supplied.routerTx)
        )
          throw Error('Both deployment transaction hashes are required.')
        const nonce = randomBytes(20).toString('hex'),
          expires = Date.now() + 300000
        const message = `Activate Hookbrew deployment\nHost: ${req.headers.host}\nChain: ${infrastructure.chainId}\nTreasury: ${getAddress(treasury)}\nFactory transaction: ${supplied.factoryTx}\nRouter transaction: ${supplied.routerTx}\nNonce: ${nonce}\nExpires: ${expires}`
        await saveChallenge(nonce, {
          message,
          expires,
          host: req.headers.host,
          factoryTx: supplied.factoryTx,
          routerTx: supplied.routerTx,
        })
        return json(res, 200, { nonce, message })
      }
      if (req.method === 'POST' && path === '/api/deployment/activate') {
        const b = await body(req, 12000)
        if (existingDeployment(res, b)) return
        if (activating)
          throw Object.assign(
            Error('Activation is in progress. Check deployment status in a moment.'),
            { status: 409 },
          )
        activating = true
        try {
          const challenge = await getChallenge(b.nonce)
          if (!challenge || challenge.expires < Date.now())
            throw Error('Deployment authorization expired.')
          if (challenge.host !== req.headers.host)
            throw Error('Authorization belongs to a different host.')
          if (!same(b.factoryTx, challenge.factoryTx) || !same(b.routerTx, challenge.routerTx))
            throw Error('Authorization is for different deployment transactions.')
          if (
            !(await client.verifyMessage({
              address: getAddress(treasury),
              message: challenge.message,
              signature: b.signature,
            }))
          )
            throw Error('The treasury wallet must authorize activation.')
          if ((await client.getChainId()) !== infrastructure.chainId)
            throw Error('Deployment RPC chain mismatch.')
          const factoryArtifact = JSON.parse(
              await readFile(resolve(projectRoot, 'public/protocol/HookbrewFactory.json'), 'utf8'),
            ),
            routerArtifact = JSON.parse(
              await readFile(resolve(projectRoot, 'public/protocol/HookbrewRouter.json'), 'utf8'),
            )
          const [ft, fr, rt, rr] = await Promise.all([
            client.getTransaction({ hash: b.factoryTx }),
            client.getTransactionReceipt({ hash: b.factoryTx }),
            client.getTransaction({ hash: b.routerTx }),
            client.getTransactionReceipt({ hash: b.routerTx }),
          ])
          const data = encodeDeployData({
            abi: factoryArtifact.abi,
            bytecode: factoryArtifact.bytecode,
            args: [
              infrastructure.poolManager,
              infrastructure.quote,
              getAddress(treasury),
              10n ** 18n,
            ],
          })
          if (
            fr.status !== 'success' ||
            !same(ft.to, infrastructure.create2) ||
            ft.input.slice(66) !== data.slice(2)
          )
            throw Error(
              'Factory transaction does not deploy the current Hookbrew build and treasury.',
            )
          const salt = ft.input.slice(0, 66),
            factory = getCreate2Address({
              from: infrastructure.create2,
              salt,
              bytecodeHash: keccak256(data),
            })
          const routerData = encodeDeployData({
            abi: routerArtifact.abi,
            bytecode: routerArtifact.bytecode,
            args: [factory],
          })
          if (
            rr.status !== 'success' ||
            rt.to !== null ||
            rt.input !== routerData ||
            !rr.contractAddress
          )
            throw Error('Router transaction does not match this Hookbrew factory.')
          const head = await client.getBlockNumber()
          if (head < fr.blockNumber + 1n || head < rr.blockNumber + 1n)
            throw Error('Wait for two deployment confirmations.')
          const vesting = await client.readContract({
            address: factory,
            abi: abi.HookbrewFactory,
            functionName: 'vesting',
          })
          const [fc, rc] = await Promise.all([
            client.getCode({ address: factory }),
            client.getCode({ address: rr.contractAddress }),
          ])
          if (!fc || !rc) throw Error('Deployment code unavailable.')
          const nextConfig = {
            ...infrastructure,
            abiVersion: 'hookbrew-v1',
            factory,
            router: rr.contractAddress,
            vesting,
            treasury: getAddress(treasury),
            factoryCodeHash: keccak256(fc),
            routerCodeHash: keccak256(rc),
            startBlock: Number(fr.blockNumber),
            factoryTx: b.factoryTx,
            routerTx: b.routerTx,
            sourceReference: 'contracts/protocol @ Hookbrew v1',
            activatedAt: new Date().toISOString(),
          }
          const saved = await saveDeployment(nextConfig)
          await refreshDeployment()
          if (!saved) {
            existingDeployment(res, b)
            return
          }
          return json(res, 201, { deployment: config })
        } finally {
          activating = false
        }
      }
      if (req.method === 'POST' && path === '/api/sync') {
        if (serverless) await indexer?.sync()
        else indexer?.sync()
        return json(res, 202, { index: indexer?.status() || null })
      }
      return json(res, 404, { error: 'Endpoint not found.' })
    } catch (e) {
      return json(res, e.code === 'ENOENT' ? 404 : e.status || 400, {
        error: e.shortMessage || e.message,
      })
    }
  }
  return {
    middleware,
    sync: () => indexer?.sync(),
    close: () => timer && clearInterval(timer),
    client,
    get deployment() {
      return config
    },
    get indexer() {
      return indexer
    },
  }
}
