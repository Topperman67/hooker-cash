import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import {
  clientKey,
  clientPrefix,
  clientPrefixKey,
  clientSubject,
  createLimiter,
  createWriteGuard,
  requestIsHttps,
  PREFIX_FACTOR,
} from '../../server/request-limits.mjs'
import { createRpcProxy, globalRpcLimit } from '../../server/rpc-proxy.mjs'
import {
  applySecurityHeaders,
  compressJsonResponses,
  createRequestHandler,
  HSTS,
} from '../../server/start.mjs'

const root = resolve(import.meta.dirname, '../..')
const temporary = []
const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

const viaProxy = (forwarded, remoteAddress = '127.0.0.1', headers = {}) => ({
  headers: { ...headers, ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }) },
  socket: { remoteAddress },
})
const keyOf = (subject) => createHash('sha256').update(subject).digest('hex').slice(0, 32)

// --- QP-SEC-3: one routed IPv6 prefix cannot multiply per-visitor budgets

test('IPv6 visitors also belong to their /48; IPv4 visitors have no prefix', () => {
  assert.equal(clientPrefix('2001:470:abcd:1::1'), '2001:470:abcd::/48')
  for (const ip of ['2001:470:abcd:1::1', '2001:470:abcd:ffff:1:2:3:4', '2001:470:ABCD::9'])
    assert.equal(clientPrefix(ip), '2001:470:abcd::/48', ip)
  assert.notEqual(clientPrefix('2001:470:abce::1'), clientPrefix('2001:470:abcd::1'))
  for (const ip of ['198.51.100.7', '::ffff:198.51.100.7', '0:0:0:0:0:ffff:c633:6407', 'unknown'])
    assert.equal(clientPrefix(ip), null, ip)
  // The per-visitor subject and key are unchanged (/64), so existing buckets carry over.
  assert.equal(clientSubject('2001:470:abcd:1::1'), '2001:470:abcd:1::/64')
  assert.equal(clientKey(viaProxy('2001:470:abcd:1::1'), false, 1), keyOf('2001:470:abcd:1::/64'))
  assert.equal(
    clientPrefixKey(viaProxy('2001:470:abcd:1::1'), false, 1),
    keyOf('2001:470:abcd::/48'),
  )
  assert.equal(clientPrefixKey(viaProxy('198.51.100.7'), false, 1), null)
  // Without a trusted proxy the socket address counts, as for clientKey.
  assert.equal(
    clientPrefixKey(viaProxy('2001:470:abcd:1::1', '2001:db8:9::1')),
    keyOf('2001:db8:9::/48'),
  )
})

test('rotating /64s inside one /48 runs out at PREFIX_FACTOR times the per-visitor limit', async () => {
  assert.equal(PREFIX_FACTOR, 8)
  const limit = createLimiter({ trustProxy: 1 })
  const bucket = { bucket: 'write', limit: 2 }
  // 8 subnets × 2 = 16 requests fit the /48 ...
  for (let subnet = 0; subnet < 8; subnet++)
    for (let i = 0; i < 2; i++) await limit(viaProxy(`2001:470:abcd:${subnet}::${i + 1}`), bucket)
  // ... and a fresh /64 in it no longer gets a fresh budget.
  await assert.rejects(() => limit(viaProxy('2001:470:abcd:99::1'), bucket), { status: 429 })
  // Another /48 and IPv4 visitors are unaffected.
  await limit(viaProxy('2001:470:abce:1::1'), bucket)
  await limit(viaProxy('198.51.100.7'), bucket)
  // One /64 is still held to the per-visitor limit.
  await limit(viaProxy('2001:db8:1:1::1'), bucket)
  await limit(viaProxy('2001:db8:1:1::2'), bucket)
  await assert.rejects(() => limit(viaProxy('2001:db8:1:1::3'), bucket), { status: 429 })
})

test('callers can set the /48 limit, and IPv4 visitors are never charged a prefix', async () => {
  const limit = createLimiter({ trustProxy: 1 })
  await limit(viaProxy('2001:db8:5:1::1'), { bucket: 'b', limit: 5, prefixLimit: 3, cost: 3 })
  await assert.rejects(
    () => limit(viaProxy('2001:db8:5:2::1'), { bucket: 'b', limit: 5, prefixLimit: 3 }),
    { status: 429 },
  )
  for (let i = 1; i <= 5; i++) await limit(viaProxy(`198.51.100.${i}`), { bucket: 'v4', limit: 1 })
})

test('the store-backed limiter keeps the /64 key and adds a separate /48 key', async () => {
  const counts = new Map()
  const store = {
    async incrementExpiring(key, ttl, amount = 1) {
      assert.equal(ttl, 120000)
      counts.set(key, (counts.get(key) || 0) + amount)
      return counts.get(key)
    },
  }
  const minute = Math.floor(1_700_000_000_000 / 60000)
  // batchShare: 0 sends every charge to the store (storage-outage.test.mjs covers batching).
  const limit = createLimiter({
    store,
    trustProxy: 1,
    now: () => 1_700_000_000_000,
    batchShare: 0,
  })
  await limit(viaProxy('2001:470:abcd:1::1'), { bucket: 'rpc', limit: 900, cost: 40 })
  await limit(viaProxy('198.51.100.7'), { bucket: 'rpc', limit: 900, cost: 2 })
  assert.deepEqual(Object.fromEntries(counts), {
    [`rate:rpc:${keyOf('2001:470:abcd:1::/64')}:${minute}`]: 40,
    [`rate:rpc:p48:${keyOf('2001:470:abcd::/48')}:${minute}`]: 40,
    [`rate:rpc:${keyOf('198.51.100.7')}:${minute}`]: 2,
  })
  counts.set(`rate:rpc:p48:${keyOf('2001:470:abcd::/48')}:${minute}`, 7200)
  await assert.rejects(() => limit(viaProxy('2001:470:abcd:2::1'), { bucket: 'rpc', limit: 900 }), {
    status: 429,
  })
})

test('the write guard counts IPv6 prefixes too', async () => {
  const guard = createWriteGuard({ trustProxy: 1 })
  const from = (ip) => viaProxy(ip, '127.0.0.1', { origin: 'https://qp.test', host: 'qp.test' })
  for (let n = 0; n < 30 * PREFIX_FACTOR; n++)
    await guard(from(`2001:470:abcd:${n.toString(16)}::1`))
  await assert.rejects(() => guard(from('2001:470:abcd:ffff::1')), { status: 429 })
  await guard(from('2001:470:beef::1'))
})

const call = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params })
const browser = (ip) =>
  viaProxy(ip, '127.0.0.1', { origin: 'https://quantpad.test', host: 'quantpad.test' })
const keys = (n) => Array.from({ length: n }, (_, i) => `Key${i}`)

test('the RPC proxy charges the /48, and an optional deployment-wide budget', async () => {
  const ok = async () => new Response('{"jsonrpc":"2.0","id":1,"result":[]}')
  // 100-account calls from a new /64 each time: 72 fit the /48 (8 × 900), the 73rd does not.
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: createLimiter({ trustProxy: 1 }),
    request: ok,
    globalLimit: 0,
  })
  for (let n = 0; n < 72; n++)
    await proxy(
      browser(`2001:470:abcd:${n.toString(16)}::1`),
      call('getMultipleAccounts', [keys(100)]),
    )
  await assert.rejects(
    () => proxy(browser('2001:470:abcd:ff00::1'), call('getMultipleAccounts', [keys(100)])),
    { status: 429 },
  )

  assert.equal(globalRpcLimit({}), 0)
  assert.equal(globalRpcLimit({ QUANTPAD_RPC_GLOBAL_PER_MIN: ' 3000 ' }), 3000)
  for (const bad of ['-1', '1.5', 'lots', ''])
    assert.equal(globalRpcLimit({ QUANTPAD_RPC_GLOBAL_PER_MIN: bad }), 0, bad)

  // A fixed minute of its own: store-less shared budgets are one counter per process.
  const shared = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: createLimiter({ trustProxy: 1, now: () => 60_000 * 11 }),
    request: ok,
    globalLimit: 5,
  })
  await shared(browser('198.51.100.1'), [call('getSlot', [], 1), call('getSlot', [], 2)])
  await shared(browser('198.51.100.2'), [call('getSlot', [], 1), call('getSlot', [], 2)])
  await shared(browser('198.51.100.3'), call('getSlot'))
  // Everyone shares the five calls; per-visitor budgets are far from used.
  await assert.rejects(() => shared(browser('198.51.100.4'), call('getSlot')), { status: 429 })
})

test('a shared limiter bucket is one counter for every visitor', async () => {
  const limit = createLimiter({ trustProxy: 1, now: () => 60_000 * 12 })
  await limit(viaProxy('198.51.100.1'), { bucket: 'all', limit: 2, shared: true })
  await limit(viaProxy('2001:db8::1'), { bucket: 'all', limit: 2, shared: true })
  await assert.rejects(
    () => limit(viaProxy('198.51.100.9'), { bucket: 'all', limit: 2, shared: true }),
    { status: 429 },
  )
})

// --- QP-SEC-3 (round 2): the documented track bucket and deployment-wide RPC budget, end to end

// The minute must not roll over in the middle of a test that counts real-time buckets.
async function awayFromMinuteEdge() {
  const left = 60_000 - (Date.now() % 60_000)
  if (left < 5_000) await new Promise((done) => setTimeout(done, left + 50))
}

test('the real API: track has its own bucket, and the RPC budget covers new coins and /api/rpc', async () => {
  const { createApplication } = await import('../../server/application.mjs')
  const hiddenMint = 'So11111111111111111111111111111111111111112'
  const unknownMint = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const boot = async () => {
    const app = await createApplication({
      dataDir: tempDir('qp-r2-track-'),
      store: null,
      quantum: null,
      background: false,
      // A hidden mint is refused right after the track bucket, without any chain reads.
      hiddenMints: hiddenMint,
      rpcUrl: 'http://127.0.0.1:9',
      // Every account is missing and no DBC pool has the mint, so an unknown mint is "not a
      // Meteora coin" and stays unknown.
      connection: {
        rpcEndpoint: 'http://rpc.invalid',
        getAccountInfo: async () => null,
        getMultipleAccountsInfo: async (keys) => keys.map(() => null),
        getProgramAccounts: async () => [],
      },
      priceFeed: async () => ({ usd: 150 }),
    })
    const { server, port } = await listen((req, res) => app.middleware(req, res))
    const host = `127.0.0.1:${port}`
    const post = (path, body) =>
      fetchRaw(port, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://${host}`, Host: host },
        body: JSON.stringify(body),
      })
    return { app, server, post }
  }
  const saved = process.env.QUANTPAD_RPC_GLOBAL_PER_MIN
  const restore = () => {
    if (saved === undefined) delete process.env.QUANTPAD_RPC_GLOBAL_PER_MIN
    else process.env.QUANTPAD_RPC_GLOBAL_PER_MIN = saved
  }

  delete process.env.QUANTPAD_RPC_GLOBAL_PER_MIN
  let booted
  try {
    booted = await boot()
  } finally {
    restore()
  }
  try {
    await awayFromMinuteEdge()
    // DEPLOY.md: "POST /api/coins/track: also 10 per minute" (charged once per request).
    for (let i = 0; i < 10; i++)
      assert.equal((await booted.post('/api/coins/track', { mint: hiddenMint })).status, 404)
    const over = await booted.post('/api/coins/track', { mint: hiddenMint })
    assert.equal(over.status, 429)
    assert.match(JSON.parse(over.body).error, /Too many requests/)
  } finally {
    booted.server.close()
    booted.app.close?.()
  }

  process.env.QUANTPAD_RPC_GLOBAL_PER_MIN = '100'
  try {
    booted = await boot()
  } finally {
    restore()
  }
  try {
    await awayFromMinuteEdge()
    // Hidden or known coins cost the shared budget nothing.
    for (let i = 0; i < 3; i++)
      assert.equal((await booted.post('/api/coins/track', { mint: hiddenMint })).status, 404)
    // Each coin the server does not know counts 45 calls: two fit in 100 ...
    for (let i = 0; i < 2; i++) {
      const r = await booted.post('/api/coins/track', { mint: unknownMint })
      assert.equal(r.status, 404, String(r.body))
      assert.equal(JSON.parse(r.body).code, 'not_meteora')
    }
    // ... the third does not ...
    assert.equal((await booted.post('/api/coins/track', { mint: unknownMint })).status, 429)
    // ... and the browser proxy shares that budget (refused before the upstream is called).
    assert.equal((await booted.post('/api/rpc', call('getSlot'))).status, 429)
  } finally {
    booted.server.close()
    booted.app.close?.()
  }
})

// --- QP-SEC-10 / build-defect-9: HSTS over https, COOP, compressed API JSON

const securityHeaders = JSON.parse(readFileSync(join(root, 'server/security-headers.json'), 'utf8'))

test('security headers include COOP; HSTS is added per request, never statically', () => {
  assert.equal(securityHeaders['Cross-Origin-Opener-Policy'], 'same-origin')
  assert.equal(securityHeaders['Strict-Transport-Security'], undefined)
  assert.equal(HSTS, 'max-age=63072000')
})

test('a request counts as https on a TLS socket, or by X-Forwarded-Proto from a trusted proxy', () => {
  const req = (proto, encrypted = false) => ({
    headers: proto === undefined ? {} : { 'x-forwarded-proto': proto },
    socket: { encrypted },
  })
  assert.equal(requestIsHttps(req(undefined, true), 0), true)
  assert.equal(requestIsHttps(req(undefined), 1), false)
  assert.equal(requestIsHttps(req('https'), 0), false, 'header ignored without a trusted proxy')
  assert.equal(requestIsHttps(req('https'), 1), true)
  assert.equal(requestIsHttps(req('HTTPS'), 1), true)
  assert.equal(requestIsHttps(req('http'), 1), false)
  assert.equal(requestIsHttps(req('https, http'), 2), true, 'the scheme at the outermost proxy')
  assert.equal(requestIsHttps({ headers: {}, socket: undefined }, 1), false)
})

test('applySecurityHeaders sets HSTS only for https visitors', () => {
  const capture = () => {
    const headers = {}
    return { headers, setHeader: (k, v) => (headers[k] = v) }
  }
  let res = capture()
  applySecurityHeaders({ headers: {}, socket: {} }, res, { trustProxy: 0 })
  for (const [name, value] of Object.entries(securityHeaders))
    assert.equal(res.headers[name], value)
  assert.equal(res.headers['Strict-Transport-Security'], undefined)
  res = capture()
  applySecurityHeaders({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, res, {
    trustProxy: 1,
  })
  assert.equal(res.headers['Strict-Transport-Security'], HSTS)
  res = capture()
  applySecurityHeaders({ headers: {}, socket: { encrypted: true } }, res, { trustProxy: 0 })
  assert.equal(res.headers['Strict-Transport-Security'], HSTS)
})

function fetchRaw(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      )
    })
    req.on('error', fail)
    req.end(body)
  })
}

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { server, port: server.address().port }
}

const bigJson = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({ mint: `Mint${i}`, price: i * 1.5 })),
})

test('npm start: security headers on every response, HSTS behind a trusted https proxy', async () => {
  const app = {
    middleware: (req, res, next) =>
      req.url.startsWith('/api/')
        ? (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end('{}'))
        : next(),
  }
  const serveStatic = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!doctype html>')
  }
  const trusted = await listen(createRequestHandler({ app, serveStatic, trustProxy: 1 }))
  const direct = await listen(createRequestHandler({ app, serveStatic, trustProxy: 0 }))
  try {
    for (const path of ['/', '/api/status']) {
      let r = await fetchRaw(trusted.port, path, { headers: { 'X-Forwarded-Proto': 'https' } })
      assert.equal(r.headers['strict-transport-security'], HSTS, path)
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', path)
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/, path)
      r = await fetchRaw(trusted.port, path, { headers: { 'X-Forwarded-Proto': 'http' } })
      assert.equal(r.headers['strict-transport-security'], undefined, path)
      // Clients connecting directly cannot claim https.
      r = await fetchRaw(direct.port, path, { headers: { 'X-Forwarded-Proto': 'https' } })
      assert.equal(r.headers['strict-transport-security'], undefined, path)
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', path)
    }
  } finally {
    trusted.server.close()
    direct.server.close()
  }
})

test('API JSON is compressed with Vary: Accept-Encoding; small, binary and streamed bodies are not', async () => {
  const routes = {
    '/api/big': (res) => {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Retry-After': '3',
      })
      res.end(bigJson)
    },
    '/api/small': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    },
    '/api/buffer': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(Buffer.from(bigJson))
    },
    '/media/a.png': (res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(Buffer.alloc(4096, 1))
    },
    '/api/stream': (res) => {
      res.setHeader('Content-Type', 'application/json')
      res.write(bigJson.slice(0, 2000))
      res.end(bigJson.slice(2000))
    },
    // An error handler answering again after the response was decided is ignored.
    '/api/twice': (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(bigJson)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":"late"}')
    },
  }
  const app = { middleware: (req, res) => routes[req.url](res) }
  const { server, port } = await listen(createRequestHandler({ app, serveStatic: () => {} }))
  try {
    let r = await fetchRaw(port, '/api/big', { headers: { 'Accept-Encoding': 'gzip, br' } })
    assert.equal(r.status, 429)
    assert.equal(r.headers['retry-after'], '3')
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['content-encoding'], 'br')
    assert.equal(r.headers.vary, 'Accept-Encoding')
    assert.equal(Number(r.headers['content-length']), r.body.length)
    assert.ok(r.body.length < bigJson.length / 3)
    assert.equal(brotliDecompressSync(r.body).toString(), bigJson)
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin')

    r = await fetchRaw(port, '/api/big', { headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(r.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(r.body).toString(), bigJson)

    r = await fetchRaw(port, '/api/big')
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.headers.vary, 'Accept-Encoding', 'caches must still key on the encoding')
    assert.equal(r.body.toString(), bigJson)

    r = await fetchRaw(port, '/api/small', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.headers.vary, 'Accept-Encoding')
    assert.equal(r.body.toString(), '{"ok":true}')

    r = await fetchRaw(port, '/api/buffer', { headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(r.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(r.body).toString(), bigJson)

    r = await fetchRaw(port, '/media/a.png', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.headers.vary, undefined)
    assert.equal(r.body.length, 4096)

    r = await fetchRaw(port, '/api/stream', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.body.toString(), bigJson)

    r = await fetchRaw(port, '/api/twice', { headers: { 'Accept-Encoding': 'br' } })
    assert.equal(r.status, 200)
    assert.equal(brotliDecompressSync(r.body).toString(), bigJson)

    r = await fetchRaw(port, '/api/big', { method: 'HEAD', headers: { 'Accept-Encoding': 'br' } })
    assert.equal(r.status, 429)
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.body.length, 0)
  } finally {
    server.close()
  }
})

test('compressJsonResponses leaves the response object as it found it', async () => {
  const own = (res) => ['writeHead', 'write', 'end'].filter((m) => Object.hasOwn(res, m))
  let before, finished
  const { server, port } = await listen((req, res) => {
    before = own(res)
    res.on('finish', () => (finished = own(res)))
    compressJsonResponses(req, res)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(bigJson)
  })
  try {
    const r = await fetchRaw(port, '/api/x', { headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(gunzipSync(r.body).toString(), bigJson)
    assert.deepEqual(before, [])
    assert.deepEqual(finished, [], 'no patched methods left on the response')
  } finally {
    server.close()
  }
})

test('the real API is compressed by npm start (RPC relay of a large response)', async () => {
  const upstreamBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(8000) })
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(upstreamBody)
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const { createApplication } = await import('../../server/application.mjs')
  const app = await createApplication({
    dataDir: tempDir('qp-r2-api-'),
    store: null,
    quantum: null,
    background: false,
    rpcUrl: `http://127.0.0.1:${upstream.address().port}`,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
  })
  const { server, port } = await listen(
    createRequestHandler({ app, serveStatic: (req, res) => res.end(), trustProxy: 0 }),
  )
  try {
    const host = `127.0.0.1:${port}`
    const r = await fetchRaw(port, '/api/rpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://${host}`,
        Host: host,
        'Accept-Encoding': 'br',
      },
      body: JSON.stringify(call('getSlot')),
    })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-encoding'], 'br')
    assert.match(r.headers.vary, /Accept-Encoding/)
    assert.equal(brotliDecompressSync(r.body).toString(), upstreamBody)
    assert.equal(r.headers['strict-transport-security'], undefined, 'plain http')
  } finally {
    server.close()
    upstream.close()
    app.close?.()
  }
})

// --- build-defect-8: missing hashed assets are 404s on Vercel too

test('vercel.json: the SPA rewrite skips /assets/, and the headers match npm start', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  const spa = vercel.rewrites.find((r) => r.destination === '/index.html')
  // Vercel sources are path-to-regexp patterns; this one is a plain regular expression group.
  const matches = (path) => new RegExp(`^${spa.source}$`).test(path)
  for (const path of ['/', '/market', '/coin/SomeMint', '/launch', '/assetsish', '/assets'])
    assert.ok(matches(path), path)
  for (const path of ['/assets/index-Cnc_EOGt.js', '/assets/old-chunk.css', '/api/x', '/m/x'])
    assert.ok(!matches(path), path)
  const global = vercel.headers.find((h) => h.source === '/(.*)')
  assert.deepEqual(
    Object.fromEntries(global.headers.map((h) => [h.key, h.value])),
    securityHeaders,
    'Vercel and npm start send the same security headers',
  )
})

// --- build-defect-11: absolute og:image and og:url

test('the build makes og:image absolute and adds og:url when the public URL is known', async () => {
  const { publicOrigin, absoluteOpenGraph, openGraphUrls } = await import('../../vite.config.js')
  assert.equal(publicOrigin({}), null)
  assert.equal(
    publicOrigin({ QUANTPAD_PUBLIC_URL: 'https://quantpad.test/' }),
    'https://quantpad.test',
  )
  assert.equal(
    publicOrigin({ QUANTPAD_PUBLIC_URL: 'https://a.test', VITE_PUBLIC_URL: 'https://b.test' }),
    'https://b.test',
  )
  assert.equal(
    publicOrigin({ VERCEL_PROJECT_PRODUCTION_URL: 'quantpad.vercel.app' }),
    'https://quantpad.vercel.app',
  )
  assert.equal(
    publicOrigin({ QUANTPAD_PUBLIC_URL: 'https://x.test', VERCEL_PROJECT_PRODUCTION_URL: 'y.app' }),
    'https://x.test',
  )
  // The .env.example placeholder, non-http URLs and junk are ignored.
  assert.equal(publicOrigin({ QUANTPAD_PUBLIC_URL: 'https://your-domain.example' }), null)
  assert.equal(publicOrigin({ QUANTPAD_PUBLIC_URL: 'javascript:alert(1)' }), null)
  assert.equal(publicOrigin({ QUANTPAD_PUBLIC_URL: 'not a url' }), null)
  assert.equal(publicOrigin({ QUANTPAD_PUBLIC_URL: 'https://u:p@x.test' }), null)

  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const built = absoluteOpenGraph(html, 'https://quantpad.test')
  assert.match(
    built,
    /<meta property="og:image" content="https:\/\/quantpad\.test\/og\.png\?v=\d+" \/>/,
  )
  assert.match(built, /<meta property="og:url" content="https:\/\/quantpad\.test\/" \/>/)
  assert.doesNotMatch(built, /content="\/og\.png/)
  assert.equal(absoluteOpenGraph(built, 'https://quantpad.test'), built, 'idempotent')
  assert.match(
    absoluteOpenGraph(html, 'https://q.test/?a="b"&c'),
    /content="https:\/\/q\.test\/\?a=&quot;b&quot;&amp;c\/og\.png\?v=\d+"/,
  )

  // Unknown origin: the page keeps its relative image (a sane fallback) and the build warns.
  const warned = []
  const plugin = openGraphUrls(null)
  assert.equal(plugin.apply, 'build')
  plugin.configResolved({ logger: { warn: (m) => warned.push(m) } })
  assert.equal(plugin.transformIndexHtml(html), html)
  assert.match(warned[0], /QUANTPAD_PUBLIC_URL/)
  assert.equal(openGraphUrls('https://quantpad.test').transformIndexHtml(html), built)
})

test('vite.config.js wires the Open Graph plugin from VITE_PUBLIC_URL at build time', async () => {
  const { loadConfigFromFile } = await import('vite')
  const saved = process.env.VITE_PUBLIC_URL
  process.env.VITE_PUBLIC_URL = 'https://from-env.test'
  let config
  try {
    ;({ config } = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      join(root, 'vite.config.js'),
      root,
      'silent',
    ))
  } finally {
    if (saved === undefined) delete process.env.VITE_PUBLIC_URL
    else process.env.VITE_PUBLIC_URL = saved
  }
  const plugin = config.plugins.flat().find((p) => p?.name === 'quantpad-open-graph')
  const out = plugin.transformIndexHtml(readFileSync(join(root, 'index.html'), 'utf8'))
  assert.match(out, /og:image" content="https:\/\/from-env\.test\/og\.png\?v=\d+"/)
  assert.match(out, /og:url" content="https:\/\/from-env\.test\/"/)
})

// --- fullstack-defect-1, QP-SEC-5 and K1/K2 operator docs

test('DEPLOY.md sizes the keeper, explains its key and documents the authority operations', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
  const deploy = read('docs/DEPLOY.md')
  const env = read('.env.example')
  for (const text of [
    // Realistic keeper SOL: one-time rent per coin (the well's token account on Meteora) and epoch
    // rent held for the claim window.
    "creates the well's token account for the coin at the keeper's expense",
    '2,039,280 lamports, about 0.002 SOL',
    '30-day claim window',
    'up to 0.5 SOL',
    // The key: where it lives, what a leak can do, keeping it small, rotating it.
    '**Production** environment only',
    'What a leaked keeper key can do',
    'Rotating the keeper key',
    'the wallet balance is what a leaked key loses at once',
    // K1 / K2 operator steps.
    '`--claim-delay`',
    '`claim_start`',
    '`cancel_epoch`',
    'buildCancelEpochInstruction',
    '`set_paused`',
    'buildSetPausedInstruction',
    'expectedVersion',
    '`ConfigChanged`',
    // Infrastructure.
    'IPv6 address by its /64 prefix',
    '/48',
    'QUANTPAD_RPC_GLOBAL_PER_MIN',
    'Strict-Transport-Security: max-age=63072000',
    'X-Forwarded-Proto',
    'Cross-Origin-Opener-Policy: same-origin',
    'Vary: Accept-Encoding',
    '`127.0.0.1:5173`',
    'VITE_PUBLIC_URL',
  ])
    assert.ok(deploy.includes(text), `DEPLOY.md: ${text}`)
  assert.doesNotMatch(deploy, /~0\.2 SOL/, 'the old funding advice is gone')
  assert.match(env, /# QUANTPAD_RPC_GLOBAL_PER_MIN=/)
  assert.match(env, /VITE_PUBLIC_URL/)
  assert.match(read('README.md'), /127\.0\.0\.1:5173/)
})

test('DEPLOY.md, .env.example and README.md describe this round of server and program changes', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
  const deploy = read('docs/DEPLOY.md')
  const env = read('.env.example')
  const readme = read('README.md')
  for (const text of [
    // serverApp: no Host-header URIs, the pin budget, pending media, CDN caching, the read limit.
    'PUBLIC_URL_UNSET',
    '`localhost`, `127.0.0.1` or `[::1]`',
    '`QUANTPAD_PIN_DAILY` (default 400)',
    '`code: PIN_QUOTA`',
    'stay pending for 24 hours',
    'once a coin created with that URI is first read',
    'Cache-Control: public, max-age=0, s-maxage=5, stale-while-revalidate=10',
    '`vercel.json` needs nothing for this',
    '300 per minute together',
    // QP-SEC-3: track has its own bucket; new coins and syncs charge the shared RPC budget.
    '| `POST /api/coins/track` | also 10 per minute.',
    'such a request also counts 45 calls against that shared budget',
    'each coin sync that runs counts 45 calls against it',
    "leaving room for the indexer's background passes and the keeper (which it does not cover)",
    // indexer: the native launch cap.
    'Hidden mints (`QUANTPAD_HIDDEN_MINTS`) do not count',
    'up to 10 stale launches are evicted',
    'Each metadata URI this server issues registers one coin',
    // program: owed shares, public burn/fusion limits, what a pause stops.
    'owed to the treasury and held in the coin',
    'never split among the other recipients',
    '`max_burn_lamports / 10`',
    "the coin's migration to DAMM v2",
    'no Meteora instruction at all',
    'Quantum burns and Fusion',
    'Harvests, pulses, claims, epoch closes, epoch cancels and token releases keep working',
    // QP-SEC-5: the only defence against a leaked key's epoch needs someone to look.
    'check for epochs your keeper did not post',
  ])
    assert.ok(deploy.includes(text), `DEPLOY.md: ${text}`)
  for (const stale of [
    'is kept only once token metadata uses it',
    'until you raise it',
    'pulses defer the protocol share',
    'new Quantum registrations stop (see',
    // the pump.fun stack Quant Pad left for Meteora
    'pump.fun',
    'PumpSwap',
    'create_v2',
  ])
    assert.ok(!deploy.includes(stale), `DEPLOY.md still says: ${stale}`)
  for (const stale of ['pump.fun', 'PumpSwap'])
    assert.ok(!readme.includes(stale), `README.md still says: ${stale}`)
  for (const text of [
    'PUBLIC_URL_UNSET',
    '# QUANTPAD_PIN_DAILY=400',
    'PIN_QUOTA',
    'pending for 24 h',
  ])
    assert.ok(env.includes(text), `.env.example: ${text}`)
  assert.match(env, /tracking a coin the server does not know yet and each coin sync/)
  assert.match(env, /hidden mints do not (# )?count/)
  assert.match(env, /evicted, up to 10 at a time/)
  for (const text of ['PUBLIC_URL_UNSET', '`QUANTPAD_PIN_DAILY`', 'PINATA_JWT'])
    assert.ok(readme.includes(text), `README.md: ${text}`)
})

test('DEPLOY.md documents the authority CLI and keeper alerts as the program and keeper ship them', async () => {
  const deploy = readFileSync(join(root, 'docs/DEPLOY.md'), 'utf8').replace(/\r\n/g, '\n')
  const flat = deploy.replace(/\s+/g, ' ')
  assert.ok(!flat.includes('There is no command-line tool'), 'the CLI exists now')
  for (const text of [
    '`scripts/program-ops.mjs` runs them',
    'it is a dry run without `--yes`',
    '`--authority-pubkey <key>`',
    '### Keeper alerts',
    '`foreign-epoch`',
    '`low-balance`',
    '`keeper.alerts`',
    "the new keeper's `foreign-epoch` alerts name them",
  ])
    assert.ok(flat.includes(text), `DEPLOY.md: ${text}`)

  // Every flag DEPLOY.md passes to program-ops.mjs is one the script accepts.
  const { USAGE, parseArgs } = await import('../../scripts/program-ops.mjs')
  // Its code block, and inline code that names it.
  const snippets = [
    ...(deploy.match(/```bash\n[^`]*program-ops\.mjs[^`]*```/g) || []),
    ...(deploy.match(/`[^`\n]*program-ops\.mjs[^`\n]*`/g) || []),
  ]
  assert.ok(snippets.length >= 4, 'DEPLOY.md shows program-ops.mjs in use')
  const flags = new Set(snippets.flatMap((l) => l.match(/--[a-z][a-z-]*/g) || []))
  for (const flag of ['--epochs', '--cancel-epoch', '--pause', '--unpause', '--keeper', '--yes'])
    assert.ok(flags.has(flag), `DEPLOY.md mentions ${flag}`)
  for (const flag of flags) assert.ok(USAGE.includes(flag), `program-ops.mjs accepts ${flag}`)
  const mint = 'So11111111111111111111111111111111111111112'
  assert.equal(parseArgs(['--rpc', 'http://127.0.0.1:8899', '--epochs', mint]).action, 'epochs')
  const cancel = parseArgs([
    '--rpc',
    'http://127.0.0.1:8899',
    '--authority',
    'authority.json',
    '--cancel-epoch',
    mint,
    '3',
  ])
  assert.deepEqual([cancel.action, cancel.mint, cancel.index], ['cancel', mint, 3])

  // The alert text and kinds DEPLOY.md tells operators to watch for are the keeper's.
  const keeper = readFileSync(join(root, 'server/keeper.mjs'), 'utf8')
  assert.ok(keeper.includes('was not posted by this keeper; cancel it with cancel_epoch'))
  assert.ok(flat.includes('`was not posted by this keeper`'))
  for (const kind of ["kind: 'foreign-epoch'", "kind: 'low-balance'"])
    assert.ok(keeper.includes(kind), kind)
  assert.match(keeper, /LOW_BALANCE_PER_COIN = 10_000_000n/, '0.01 SOL per coin')
})
