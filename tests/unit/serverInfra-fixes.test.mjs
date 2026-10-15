import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import {
  mkdtempSync as makeTempDir,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import {
  clientKey,
  clientSubject,
  createLimiter,
  trustedProxyHops,
} from '../../server/request-limits.mjs'
import {
  createRpcProxy,
  callCost,
  writeRpcResponse,
  MAX_RESPONSE_BYTES,
} from '../../server/rpc-proxy.mjs'
import { createFileStore, createRedisStore, retryBusy } from '../../server/storage.mjs'

const root = resolve(import.meta.dirname, '../..')
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const temporary = []
const mkdtempSync = (prefix) => {
  const dir = makeTempDir(prefix)
  temporary.push(dir)
  return dir
}
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

// --- request-limits: client key behind a reverse proxy (server-ratelimit-shared-bucket-behind-proxy)

const viaProxy = (forwarded, remoteAddress = '127.0.0.1') => ({
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  socket: { remoteAddress },
})
const keyOf = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 32)

test('QUANTPAD_TRUST_PROXY is opt-in and only accepts a small hop count', () => {
  assert.equal(trustedProxyHops({}), 0)
  assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: '' }), 0)
  assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: '0' }), 0)
  assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: '1' }), 1)
  assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: ' 2 ' }), 2)
  assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: 'true' }), 1)
  for (const bad of ['yes', '-1', '1.5', '11', 'false'])
    assert.equal(trustedProxyHops({ QUANTPAD_TRUST_PROXY: bad }), 0, bad)
})

test('client key ignores X-Forwarded-For unless a proxy is trusted', () => {
  // Default (and the old two-argument call): the socket address, whatever the header claims.
  assert.equal(clientKey(viaProxy('198.51.100.7')), keyOf('127.0.0.1'))
  assert.equal(clientKey(viaProxy('198.51.100.7'), false), keyOf('127.0.0.1'))
  // One trusted proxy: the address it appended (rightmost); client-supplied entries are ignored.
  assert.equal(clientKey(viaProxy('198.51.100.7'), false, 1), keyOf('198.51.100.7'))
  assert.equal(clientKey(viaProxy('6.6.6.6, 198.51.100.7'), false, 1), keyOf('198.51.100.7'))
  // Two proxies (CDN, then nginx): second from the right.
  assert.equal(
    clientKey(viaProxy('6.6.6.6, 198.51.100.7, 203.0.113.1'), false, 2),
    keyOf('198.51.100.7'),
  )
  // Ports and brackets are stripped; junk or missing entries fall back to the socket.
  assert.equal(clientKey(viaProxy('198.51.100.7:4711'), false, 1), keyOf('198.51.100.7'))
  assert.equal(clientKey(viaProxy('[2001:db8::7]:4711'), false, 1), keyOf('2001:db8:0:0::/64'))
  assert.equal(clientKey(viaProxy('2001:db8::7'), false, 1), keyOf('2001:db8:0:0::/64'))
  assert.equal(clientKey(viaProxy('not-an-ip'), false, 1), keyOf('127.0.0.1'))
  assert.equal(clientKey(viaProxy(undefined), false, 1), keyOf('127.0.0.1'))
  assert.equal(clientKey(viaProxy('198.51.100.7'), false, 2), keyOf('127.0.0.1'))
  // Vercel keeps using the first entry, which its edge overwrites.
  assert.equal(clientKey(viaProxy('198.51.100.7, 10.0.0.1'), true), keyOf('198.51.100.7'))
})

test('behind a trusted proxy each visitor gets their own rate-limit bucket', async () => {
  const shared = createLimiter({ trustProxy: 0 })
  const perVisitor = createLimiter({ trustProxy: 1 })
  const alice = viaProxy('198.51.100.7'),
    bob = viaProxy('198.51.100.8')
  await shared(alice, { bucket: 'write', limit: 2, cost: 2 })
  await assert.rejects(() => shared(bob, { bucket: 'write', limit: 2 }), { status: 429 })
  await perVisitor(alice, { bucket: 'write', limit: 2, cost: 2 })
  await perVisitor(bob, { bucket: 'write', limit: 2, cost: 2 })
  await assert.rejects(() => perVisitor(alice, { bucket: 'write', limit: 2 }), { status: 429 })
})

test('IPv6 clients count by their /64, IPv4 clients by the full address', () => {
  // IPv4, also when a dual-stack socket reports it IPv4-mapped.
  assert.equal(clientSubject('198.51.100.7'), '198.51.100.7')
  assert.equal(clientSubject('::ffff:198.51.100.7'), '198.51.100.7')
  assert.equal(clientSubject('::FFFF:c633:6407'), '198.51.100.7')
  assert.equal(clientSubject('0:0:0:0:0:ffff:198.51.100.7'), '198.51.100.7')
  // IPv6: every spelling of one /64 gives the same subject.
  for (const ip of [
    '2001:db8:1:2::1',
    '2001:0db8:0001:0002:ffff:ffff:ffff:ffff',
    '2001:DB8:1:2:a:b:c:d',
    '2001:db8:1:2::',
    'fe80::1%eth0',
  ])
    assert.match(clientSubject(ip), /::\/64$/, ip)
  assert.equal(clientSubject('2001:db8:1:2::1'), '2001:db8:1:2::/64')
  assert.equal(clientSubject('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64')
  assert.equal(clientSubject('2001:db8:1:2:a:b:1.2.3.4'), '2001:db8:1:2::/64')
  assert.equal(clientSubject('::1'), '0:0:0:0::/64')
  assert.equal(clientSubject('fe80::1%eth0'), 'fe80:0:0:0::/64')
  assert.notEqual(clientSubject('2001:db8:1:3::1'), clientSubject('2001:db8:1:2::1'))
  // Two IPv4-mapped clients never share the ::ffff:0:0/64 prefix.
  assert.notEqual(clientSubject('::ffff:198.51.100.7'), clientSubject('::ffff:198.51.100.8'))
  assert.equal(clientSubject('unknown'), 'unknown')
  // IPv4 keys are unchanged from before, so existing buckets carry over.
  assert.equal(clientKey(viaProxy(undefined, '198.51.100.7')), keyOf('198.51.100.7'))
  assert.equal(
    clientKey(viaProxy(undefined, '::ffff:198.51.100.7')),
    clientKey(viaProxy(undefined, '198.51.100.7')),
  )
})

test('rotating addresses inside one IPv6 /64 does not give fresh rate-limit buckets', async () => {
  const limit = createLimiter({ trustProxy: 1 })
  await limit(viaProxy('2001:db8:1:2::1'), { bucket: 'write', limit: 2 })
  await limit(viaProxy('2001:db8:1:2:dead:beef:0:1'), { bucket: 'write', limit: 2 })
  await assert.rejects(() => limit(viaProxy('2001:db8:1:2::ffff'), { bucket: 'write', limit: 2 }), {
    status: 429,
  })
  // Another /64 (another subscriber) has its own bucket; so does every IPv4 address.
  await limit(viaProxy('2001:db8:1:3::1'), { bucket: 'write', limit: 2 })
  const direct = createLimiter({})
  await direct(viaProxy(undefined, '::ffff:198.51.100.7'), { bucket: 'w', limit: 1 })
  await direct(viaProxy(undefined, '::ffff:198.51.100.8'), { bucket: 'w', limit: 1 })
  await assert.rejects(
    () => direct(viaProxy(undefined, '198.51.100.7'), { bucket: 'w', limit: 1 }),
    {
      status: 429,
    },
  )
})

test('limiters read QUANTPAD_TRUST_PROXY when no trustProxy option is given', async () => {
  const before = process.env.QUANTPAD_TRUST_PROXY
  process.env.QUANTPAD_TRUST_PROXY = '1'
  try {
    const limit = createLimiter({})
    await limit(viaProxy('198.51.100.7'), { bucket: 'b', limit: 1 })
    await limit(viaProxy('198.51.100.8'), { bucket: 'b', limit: 1 })
  } finally {
    if (before === undefined) delete process.env.QUANTPAD_TRUST_PROXY
    else process.env.QUANTPAD_TRUST_PROXY = before
  }
})

// --- rpc-proxy: upstream status mapping, size cap and weights (C6, server-rpc-proxy-unbounded-response)

const browser = { headers: { origin: 'https://quantpad.test', host: 'quantpad.test' }, socket: {} }
const call = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params })
const proxyWith = (request, options = {}) =>
  createRpcProxy({
    rpcUrl: 'https://rpc.invalid/?api-key=hidden',
    limiter: createLimiter({}),
    request,
    ...options,
  })

test('upstream 429 is answered with 429 and a sane Retry-After', async () => {
  const limited = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    error: { code: 429, message: 'slow down' },
  })
  let result = await proxyWith(
    async () => new Response(limited, { status: 429, headers: { 'Retry-After': '7' } }),
  )(browser, call('getSignatureStatuses'))
  assert.equal(result.status, 429)
  assert.equal(result.headers['Retry-After'], '7')
  assert.equal(result.text, limited)
  assert.equal(result.body.error.code, 429)

  result = await proxyWith(async () => new Response(limited, { status: 429 }))(
    browser,
    call('getSlot'),
  )
  assert.equal(result.headers['Retry-After'], '2', 'default when the provider sends none')
  result = await proxyWith(
    async () => new Response(limited, { status: 429, headers: { 'Retry-After': '3600' } }),
  )(browser, call('getSlot'))
  assert.equal(result.headers['Retry-After'], '60', 'capped')
  const date = new Date(Date.now() + 5000).toUTCString()
  result = await proxyWith(
    async () => new Response(limited, { status: 429, headers: { 'Retry-After': date } }),
  )(browser, call('getSlot'))
  assert.ok(
    Number(result.headers['Retry-After']) >= 1 && Number(result.headers['Retry-After']) <= 6,
  )

  // A non-JSON 429 page is not relayed (it could echo the provider URL).
  result = await proxyWith(
    async () => new Response('rate limited https://rpc.invalid/?api-key=hidden', { status: 429 }),
  )(browser, call('getSlot'))
  assert.equal(result.status, 429)
  assert.doesNotMatch(result.text, /hidden/)
  assert.ok(result.headers['Retry-After'])
})

test('other upstream failures are answered with 502, not thrown', async () => {
  let result = await proxyWith(async () => {
    throw new TypeError('fetch failed https://rpc.invalid/?api-key=hidden')
  })(browser, call('getSlot'))
  assert.equal(result.status, 502)
  assert.doesNotMatch(result.text, /hidden/)

  const upstream = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'x' } })
  result = await proxyWith(async () => new Response(upstream, { status: 503 }))(
    browser,
    call('getSlot'),
  )
  assert.equal(result.status, 502)
  assert.equal(result.text, upstream)

  result = await proxyWith(async () => new Response('{not json', { status: 200 }))(
    browser,
    call('getSlot'),
  )
  assert.equal(result.status, 502)
  assert.deepEqual(Object.keys(result.headers), [])
})

test('successful responses are relayed byte for byte', async () => {
  const upstream =
    '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":12345678901234567890}}'
  const result = await proxyWith(async () => new Response(upstream))(browser, call('getBalance'))
  assert.equal(result.status, 200)
  assert.equal(
    result.text,
    upstream,
    'no parse and re-serialize (which would also lose u64 precision)',
  )
})

test('stops reading oversized upstream responses and answers 502', async () => {
  let pulled = 0,
    cancelled = false
  const endless = new ReadableStream({
    pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x20))
    },
    cancel() {
      cancelled = true
    },
  })
  const limit = 1024 * 1024
  let result = await proxyWith(async () => new Response(endless), { maxResponseBytes: limit })(
    browser,
    call('getAccountInfo'),
  )
  assert.equal(result.status, 502)
  assert.match(result.body.error, /too large/)
  assert.ok(cancelled, 'upstream body cancelled')
  assert.ok(pulled <= limit / (64 * 1024) + 2, `read ${pulled} chunks`)

  // A declared Content-Length over the cap is refused without reading the body.
  result = await proxyWith(
    async () =>
      new Response('{}', { headers: { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } }),
  )(browser, call('getAccountInfo'))
  assert.equal(result.status, 502)
  assert.equal(MAX_RESPONSE_BYTES, 16 * 1024 * 1024)
})

test('rate-limit weight counts accounts and relayed megabytes', async () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => `Key${i}`)
  assert.equal(callCost(call('getSlot')), 1)
  assert.equal(callCost(call('getMultipleAccounts', [keys(40)])), 40)
  assert.equal(callCost(call('getMultipleAccounts', [[]])), 1)
  assert.throws(() => callCost(call('getMultipleAccounts', [keys(101)])), { status: 400 })

  const charged = []
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(2.5 * 1024 * 1024) })
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: async (req, { cost }) => charged.push(cost),
    request: async () => new Response(big),
  })
  await proxy(browser, [call('getMultipleAccounts', [keys(30)], 1), call('getSlot', [], 2)])
  assert.deepEqual(charged, [31, 2], 'accounts up front, then two whole MiB relayed')

  // 100-account batches use up the per-minute budget nine times faster than single calls.
  const limited = proxyWith(async () => new Response('{"jsonrpc":"2.0","id":1,"result":[]}'))
  for (let i = 0; i < 9; i++) await limited(browser, call('getMultipleAccounts', [keys(100)]))
  await assert.rejects(() => limited(browser, call('getMultipleAccounts', [keys(100)])), {
    status: 429,
  })
})

test('client mistakes are 4xx errors', async () => {
  const proxy = proxyWith(async () => assert.fail('must not call upstream'))
  await assert.rejects(() => proxy(browser, []), { status: 400 })
  await assert.rejects(() => proxy(browser, { method: 'getSlot' }), { status: 400 })
  await assert.rejects(() => proxy(browser, call('getProgramAccounts')), { status: 403 })
})

test('writeRpcResponse sends the relayed text with Retry-After', () => {
  const sent = {}
  const res = {
    writeHead: (status, headers) => Object.assign(sent, { status, headers }),
    end: (body) => (sent.body = body),
  }
  writeRpcResponse(res, { status: 429, text: '{"a":1}', headers: { 'Retry-After': '3' } })
  assert.equal(sent.status, 429)
  assert.equal(sent.body, '{"a":1}')
  assert.equal(sent.headers['Retry-After'], '3')
  assert.equal(sent.headers['Content-Type'], 'application/json')
  assert.equal(sent.headers['Cache-Control'], 'no-store')
})

test('POST /api/rpc relays an upstream 429 with its Retry-After to the browser (C6)', async () => {
  let upstreamStatus = 429
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (upstreamStatus === 429) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' })
        res.end('{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Too many requests"}}')
      } else if (upstreamStatus === 500) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('upstream https://provider.invalid/?api-key=secret failed')
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"jsonrpc":"2.0","id":1,"result":42}')
      }
    })
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const { createApplication } = await import('../../server/application.mjs')
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-rpc-route-')),
    store: null,
    quantum: null,
    background: false,
    rpcUrl: `http://127.0.0.1:${upstream.address().port}`,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const host = `127.0.0.1:${server.address().port}`
  const post = () =>
    fetch(`http://${host}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://${host}` },
      body: JSON.stringify(call('getSlot')),
    })
  try {
    let response = await post()
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '7')
    assert.equal((await response.json()).error.code, 429)
    upstreamStatus = 500
    response = await post()
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('retry-after'), null)
    assert.doesNotMatch(await response.text(), /secret|provider\.invalid/)
    upstreamStatus = 200
    response = await post()
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '{"jsonrpc":"2.0","id":1,"result":42}')
  } finally {
    await new Promise((done) => server.close(done))
    await new Promise((done) => upstream.close(done))
    app.close?.()
  }
})

// --- start.mjs: static files (production-07, production-14)

function fetchRaw(port, path, headers = {}) {
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      )
    })
    req.on('error', fail)
    req.end()
  })
}

test('static server: immutable hashed assets, compression, revalidation and 400 for bad escapes', async () => {
  const { createStaticHandler, pickEncoding } = await import('../../server/start.mjs')
  assert.equal(pickEncoding('gzip, deflate, br'), 'br')
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip')
  assert.equal(pickEncoding('identity'), null)
  assert.equal(pickEncoding(undefined), null)
  assert.equal(pickEncoding('*'), 'br')

  const dist = mkdtempSync(join(tmpdir(), 'qp-dist-'))
  mkdirSync(join(dist, 'assets'))
  const script = 'export const quantum = "hooks";\n'.repeat(200)
  writeFileSync(join(dist, 'assets', 'index-Cnc_EOGt.js'), script)
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Quant Pad</title>')
  writeFileSync(join(dist, 'og.png'), Buffer.from([137, 80, 78, 71]))
  const serveStatic = createStaticHandler({ dist })
  const server = createServer((req, res) => serveStatic(req, res))
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  try {
    let r = await fetchRaw(port, '/assets/index-Cnc_EOGt.js', { 'Accept-Encoding': 'gzip, br' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.equal(r.headers['content-encoding'], 'br')
    assert.equal(r.headers['content-type'], 'text/javascript')
    assert.equal(r.headers.vary, 'Accept-Encoding')
    assert.equal(brotliDecompressSync(r.body).toString(), script)
    assert.ok(r.body.length < script.length / 4)
    assert.ok(r.headers.etag)

    r = await fetchRaw(port, '/assets/index-Cnc_EOGt.js', { 'Accept-Encoding': 'gzip' })
    assert.equal(r.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(r.body).toString(), script)

    r = await fetchRaw(port, '/assets/index-Cnc_EOGt.js')
    assert.equal(r.headers['content-encoding'], undefined)
    assert.equal(r.body.toString(), script)

    // The SPA shell revalidates; a matching ETag gets 304.
    r = await fetchRaw(port, '/coin/SomeMintQP')
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-cache')
    assert.match(r.body.toString(), /Quant Pad/)
    const again = await fetchRaw(port, '/market', { 'If-None-Match': r.headers.etag })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)

    r = await fetchRaw(port, '/og.png', { 'Accept-Encoding': 'br' })
    assert.equal(r.headers['cache-control'], 'no-cache')
    assert.equal(r.headers['content-encoding'], undefined, 'binary files are not compressed')

    assert.equal((await fetchRaw(port, '/%E0%A4%A')).status, 400)
    assert.equal((await fetchRaw(port, '/coin/%ZZ')).status, 400)
    assert.equal((await fetchRaw(port, '/assets/missing-abc.js')).status, 404)
    assert.equal((await fetchRaw(port, '/..%2f..%2fpackage.json')).status, 403)
  } finally {
    server.close()
  }
})

// --- storage.mjs: atomic NX and Windows-safe replacement (server-filestore-*)

const leaseFile = (dir, name) =>
  join(dir, 'kv', createHash('sha256').update(name).digest('hex') + '.json')
const strays = (dir) => readdirSync(join(dir, 'kv')).filter((f) => !f.endsWith('.json'))

test('NX set over an expired lease has exactly one winner, also across store instances', async () => {
  for (let trial = 0; trial < 25; trial++) {
    const dir = mkdtempSync(join(tmpdir(), 'qp-nx-'))
    const a = createFileStore(dir),
      b = createFileStore(dir) // a second process sharing the directory
    await a.set('sync:lease', 'stale-owner', { ttl: 1 })
    await pause(3)
    const stores = [a, a, a, a, b, b, b, b]
    const won = await Promise.all(
      stores.map((s, i) => s.set('sync:lease', `owner-${i}`, { nx: true, ttl: 25000 })),
    )
    assert.equal(won.filter(Boolean).length, 1, `trial ${trial}: ${won}`)
    assert.equal(await a.get('sync:lease'), `owner-${won.indexOf(true)}`)
    assert.deepEqual(strays(dir), [], 'no temporary files left behind')
  }
})

test('release removes the owner’s expired lease but never someone else’s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-release-'))
  const store = createFileStore(dir)
  await store.set('keeper:lease', 'owner-1', { nx: true, ttl: 20 })
  await pause(40)
  await store.release('keeper:lease', 'owner-2')
  assert.ok(existsSync(leaseFile(dir, 'keeper:lease')), 'not owner-2’s to release')
  await store.release('keeper:lease', 'owner-1')
  assert.ok(!existsSync(leaseFile(dir, 'keeper:lease')), 'expired lease file removed by its owner')

  await store.set('keeper:lease', 'owner-3', { nx: true, ttl: 60000 })
  await store.release('keeper:lease', 'owner-1')
  assert.equal(await store.get('keeper:lease'), 'owner-3')
  assert.deepEqual(strays(dir), [])
})

test('storage errors written for users are marked expose (C1)', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-incr-')))
  await assert.rejects(() => store.putMedia('a.png', Buffer.from('abcdef'), 5), {
    status: 507,
    expose: true,
  })
  const redis = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () => new Response('down', { status: 500 }),
  })
  await assert.rejects(() => redis.get('k'), {
    status: 503,
    code: 'STORAGE_UNAVAILABLE',
    expose: true,
  })
})

test('concurrent increments are not lost', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-incr-')))
  await Promise.all(Array.from({ length: 40 }, () => store.increment('n', 1)))
  assert.equal(await store.get('n'), 40)
})

test('writes succeed while the same key is read continuously (Windows EPERM)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-busy-'))
  const store = createFileStore(dir)
  const list = Array.from({ length: 400 }, (_, i) => ({ mint: 'M'.repeat(44), i }))
  await store.set('coins:list', list)
  let writing = true,
    reads = 0
  const reader = async () => {
    while (writing) {
      const value = await store.get('coins:list')
      assert.equal(value.length, 400)
      value.push('callers get their own copy')
      reads++
    }
  }
  const readers = [reader(), reader(), reader()]
  try {
    for (let i = 0; i < 60; i++) await store.set('coins:list', list)
  } finally {
    writing = false
  }
  await Promise.all(readers)
  assert.ok(reads > 0)
  assert.deepEqual(strays(dir), [])
})

test('retryBusy retries busy-file errors only, then gives up', async () => {
  let calls = 0
  const busy = (code) => Object.assign(Error(code), { code })
  assert.equal(
    await retryBusy(
      async () => {
        if (++calls < 3) throw busy('EPERM')
        return 'ok'
      },
      { delays: [1, 1, 1] },
    ),
    'ok',
  )
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(
    () => retryBusy(async () => (calls++, Promise.reject(busy('ENOENT'))), { delays: [1, 1] }),
    { code: 'ENOENT' },
  )
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(
    () => retryBusy(async () => (calls++, Promise.reject(busy('EBUSY'))), { delays: [1, 1] }),
    { code: 'EBUSY' },
  )
  assert.equal(calls, 3)
})

// --- storage: media quota (server-media-quota-exhaustion, storage half)

const bytesOf = (text) => Buffer.from(text)
const missing = { code: 'ENOENT' }

test('file store: putMedia says whether the blob is new', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-media-')))
  assert.equal(await store.putMedia('a.png', bytesOf('aaaa'), 100), true)
  assert.equal(await store.putMedia('a.png', bytesOf('aaaa'), 100), false)
  assert.equal(await store.putMedia('p.png', bytesOf('pppp'), 100, { ttl: 60_000 }), true)
  assert.equal(await store.putMedia('p.png', bytesOf('pppp'), 100, { ttl: 60_000 }), false)
  assert.equal((await store.getMedia('p.png')).toString(), 'pppp')
})

test('file store: abandoned pending uploads expire and give their bytes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-media-'))
  const store = createFileStore(dir)
  assert.equal(await store.putMedia('a.png', bytesOf('aaaaaa'), 10, { ttl: 40 }), true)
  assert.equal((await store.getMedia('a.png')).toString(), 'aaaaaa')
  await assert.rejects(() => store.putMedia('b.png', bytesOf('bbbbbb'), 10, { ttl: 40 }), {
    status: 507,
    expose: true,
  })
  await pause(80)
  await assert.rejects(() => store.getMedia('a.png'), missing)
  // The full quota triggers a sweep, which frees the expired upload's bytes.
  assert.equal(await store.putMedia('b.png', bytesOf('bbbbbb'), 10), true)
  assert.deepEqual(readdirSync(join(dir, 'media', 'pending')), [])
  assert.equal(await store.promoteMedia('a.png'), false)
})

test('file store: promoted uploads stay, and count once against the quota', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-media-')))
  await store.putMedia('art.png', bytesOf('artwork'), 10, { ttl: 40 })
  assert.equal(await store.promoteMedia('art.png'), true)
  assert.equal(await store.promoteMedia('art.png'), true)
  await pause(80)
  assert.equal((await store.getMedia('art.png')).toString(), 'artwork')
  assert.equal(await store.putMedia('art.png', bytesOf('artwork'), 10, { ttl: 40 }), false)
  await assert.rejects(() => store.putMedia('x.png', bytesOf('xxxx'), 10), { status: 507 })
  assert.equal(await store.putMedia('y.png', bytesOf('yyy'), 10), true)
  assert.equal(await store.promoteMedia('never.png'), false)
})

test('file store: a repeated pending upload extends it, a permanent put promotes it', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-media-')))
  await store.putMedia('a.png', bytesOf('a'), 100, { ttl: 60 })
  await store.putMedia('b.png', bytesOf('b'), 100, { ttl: 60 })
  await pause(20)
  assert.equal(await store.putMedia('a.png', bytesOf('a'), 100, { ttl: 400 }), false)
  assert.equal(await store.putMedia('b.png', bytesOf('b'), 100), false)
  await pause(100)
  assert.equal((await store.getMedia('a.png')).toString(), 'a')
  assert.equal((await store.getMedia('b.png')).toString(), 'b')
})

test('file store: a restarted server counts live uploads and drops expired ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-media-'))
  const first = createFileStore(dir)
  await first.putMedia('kept.png', bytesOf('kkkk'), 100)
  await first.putMedia('live.png', bytesOf('llll'), 100, { ttl: 60_000 })
  await first.putMedia('gone.png', bytesOf('gggg'), 100, { ttl: 30 })
  await pause(60)
  const second = createFileStore(dir)
  // 4 kept + 4 live = 8 of 12; the expired 4 do not count.
  assert.equal(await second.putMedia('c.png', bytesOf('cccc'), 12), true)
  await assert.rejects(() => second.putMedia('d.png', bytesOf('d'), 12), { status: 507 })
  assert.deepEqual(readdirSync(join(dir, 'media', 'pending')), ['live.png'])
})

test('redis store: media quota counts the stored encoding and passes pending expiry', async () => {
  const calls = []
  let reply = 1
  const redis = createRedisStore({
    url: 'https://redis.test',
    token: 't',
    prefix: 'p',
    request: async (_, init) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ result: reply })
    },
  })
  const bytes = Buffer.alloc(3000, 7)
  const encoded = JSON.stringify(bytes.toString('base64'))
  const before = Date.now()
  assert.equal(await redis.putMedia('a.png', bytes, 10_000, { ttl: 60_000 }), true)
  const args = calls.at(-1)
  assert.equal(args[0], 'EVAL')
  assert.equal(args[2], 4)
  assert.deepEqual(args.slice(3, 7), [
    'p:media:a.png',
    'p:media:bytes',
    'p:media:pending',
    'p:media:pending-size',
  ])
  assert.equal(args[7], encoded)
  assert.equal(args[8], encoded.length)
  assert.ok(args[8] > bytes.length * 1.3)
  assert.equal(args[9], 10_000)
  assert.equal(args[10], 60_000)
  assert.ok(args[11] >= before && args[11] <= Date.now())
  assert.equal(args[12], 'a.png')
  reply = 0
  assert.equal(await redis.putMedia('a.png', bytes, 10_000), false)
  assert.equal(calls.at(-1)[10], 0)
  reply = -1
  await assert.rejects(() => redis.putMedia('b.png', bytes, 10), { status: 507, expose: true })
  reply = 1
  assert.equal(await redis.promoteMedia('a.png'), true)
  assert.equal(calls.at(-1)[2], 4)
  assert.equal(calls.at(-1)[7], 'a.png')
  reply = 0
  assert.equal(await redis.promoteMedia('a.png'), false)
})

// --- packaging (clean-clone-1, clean-clone-2, clean-clone-7, clean-clone-4, clean-clone-6, clean-clone-8)

test("no pump.fun SDK or shim is left: the shared clients import Meteora's SDKs directly", async () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }))
    assert.doesNotMatch(name, /pump-fun/, name)
  assert.equal(pkg.imports?.['#pump-sdk'], undefined)
  for (const file of ['shared/meteora.mjs', 'shared/quantum.mjs', 'server/solana.mjs']) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /pump-sdk|pump-swap-sdk|createRequire/, file)
  }
  const meteora = readFileSync(join(root, 'shared/meteora.mjs'), 'utf8')
  for (const name of ['@meteora-ag/dynamic-bonding-curve-sdk', '@meteora-ag/cp-amm-sdk']) {
    assert.match(meteora, new RegExp(`from '${name}'`))
    assert.ok(pkg.dependencies[name], `${name} is declared`)
  }
  // Both load under Node as the server does.
  const client = await import('../../shared/quantum.mjs')
  assert.equal(typeof client.buildPulseInstructions, 'function')
})

test('package.json declares the Node version and every imported package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.engines?.node, '24.x')
  assert.equal(pkg.dependencies['@noble/hashes'], '^1.8.0')
  assert.equal(lock.packages[''].dependencies['@noble/hashes'], '^1.8.0')
  assert.match(lock.packages['node_modules/@noble/hashes'].version, /^1\./)
  const merkle = readFileSync(join(root, 'shared/merkle.mjs'), 'utf8')
  for (const [, name] of merkle.matchAll(/from '(@[^/']+\/[^/']+|[^.@'][^/']*)/g))
    assert.ok(pkg.dependencies[name] || pkg.devDependencies[name], `${name} is declared`)
  assert.equal(typeof createRequire(import.meta.url).resolve('@noble/hashes/sha2'), 'string')
})

test('.gitattributes checks text out with LF on every platform', () => {
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8')
  assert.match(attributes, /^\* text=auto eol=lf$/m)
  assert.doesNotMatch(attributes, /contracts\/protocol/)
})

test('vercel.json deploys main and caches hashed assets', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
  // production follows main (the pause used while it was being configured is lifted)
  assert.notEqual(vercel.git?.deploymentEnabled?.main, false)
  const assets = vercel.headers.find((h) => h.source === '/assets/(.*)')
  assert.equal(
    assets.headers.find((h) => h.key === 'Cache-Control').value,
    'public, max-age=31536000, immutable',
  )
  const deploy = readFileSync(join(root, 'docs/DEPLOY.md'), 'utf8')
  assert.match(deploy, /deploymentEnabled/)
  assert.match(deploy, /scripts\/init-config\.mjs/)
  assert.match(deploy, /890,880 lamports/)
  assert.match(deploy, /QUANTPAD_TRUST_PROXY/)
})

test('operator docs match the current program, client and server settings', () => {
  const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\s+/g, ' ')
  const deploy = read('docs/DEPLOY.md')
  const env = read('.env.example')
  // Every setting the server reads is documented for operators.
  const settings = new Set()
  for (const file of ['server/application.mjs', 'server/indexer.mjs', 'server/solana.mjs'])
    for (const [name] of read(file).matchAll(/QUANTPAD_[A-Z_]+/g)) settings.add(name)
  for (const name of [
    'QUANTPAD_MEDIA_CLIENT_MB',
    'QUANTPAD_RPC_BATCH',
    'QUANTPAD_SYNC_MS',
    'QUANTPAD_MAX_LAUNCHES',
    'QUANTPAD_INDEX_BATCH',
  ]) {
    assert.ok(settings.has(name), `${name} is no longer read by the server`)
    assert.match(deploy, new RegExp(name), `DEPLOY.md: ${name}`)
    assert.match(env, new RegExp(`# ${name}=`), `.env.example: ${name}`)
  }
  assert.match(env, /# QUANTPAD_TRUST_PROXY=/)
  // Per-visitor limits and metadata fetching rules.
  for (const text of [
    '`POST /api/launches` | also 10 per minute',
    '`POST /api/sync` | also 12 per minute',
    '`GET /api/quantum/:mint` | 60 per minute',
    '`GET /api/quantum/:mint/claims` | 30 per minute',
    'at least 128 KB',
    'IPv6 address by its /64 prefix',
    'only over https',
    '64 KB',
  ])
    assert.ok(deploy.includes(text), `DEPLOY.md: ${text}`)
  // The dev buy is never split from create_v2, and small fees to an empty treasury are left out.
  assert.doesNotMatch(deploy, /window for snipers|split into two transactions/)
  assert.match(deploy, /`QUANTPAD_LOOKUP_TABLE` is required for any launch with a dev buy/)
  assert.match(deploy, /leaves out fee transfers smaller than that/)
  assert.doesNotMatch(deploy, /fails as a whole/)
  // Program handoff: keypair restore, deploy together, keeper rent refund.
  assert.match(deploy, /quantum_hooks-keypair\.json/)
  assert.match(deploy, /QUANTPAD_NEW_PROGRAM_ID=1/)
  assert.match(deploy, /`rent_payer` signer and `fusion` takes `lp_token_program`/)
  assert.match(deploy, /0\.00204 SOL/)
  // The spec describes the instructions as the program now defines them.
  const spec = read('docs/QUANTUM_HOOKS_SPEC.md')
  for (const text of [
    'RESERVED_ACCOUNT_KEYS',
    'InvalidSplitWallet',
    '`rent_payer` (first account, writable signer)',
    '2 039 280 lamports',
    'floor applies to fees only',
    '`rent_refunded`',
    'reserved key or executable',
    '`lp_token_program` (Token-2022)',
    "coin mint's owner",
  ])
    assert.ok(spec.includes(text), `QUANTUM_HOOKS_SPEC.md: ${text}`)
  const constants = read('programs/quantum-hooks/programs/quantum_hooks/src/constants.rs')
  assert.match(constants, /RESERVED_ACCOUNT_KEYS/)
  const events = read('programs/quantum-hooks/programs/quantum_hooks/src/events.rs')
  assert.match(events, /rent_refunded: u64/)
})

test('vite preview mounts the API and the production security headers', async () => {
  const { loadConfigFromFile } = await import('vite')
  const { config } = await loadConfigFromFile(
    { command: 'serve', mode: 'production', isPreview: true },
    join(root, 'vite.config.js'),
    root,
    'silent',
  )
  const plugin = config.plugins.flat().find((p) => p?.name === 'quantpad-api')
  assert.equal(typeof plugin.configurePreviewServer, 'function')

  // No mainnet traffic and no writes to the repository's .quantpad-data.
  const isolated = {
    QUANTPAD_RPC_URL: 'http://127.0.0.1:9',
    QUANTPAD_DATA_DIR: mkdtempSync(join(tmpdir(), 'qp-preview-')),
  }
  const saved = Object.fromEntries(Object.keys(isolated).map((k) => [k, process.env[k]]))
  Object.assign(process.env, isolated)
  const middlewares = []
  let close
  try {
    await plugin.configurePreviewServer({
      middlewares: { use: (fn) => middlewares.push(fn) },
      httpServer: { once: (event, fn) => event === 'close' && (close = fn) },
    })
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
  try {
    const headers = {}
    const res = {
      setHeader: (k, v) => (headers[k] = v),
      writeHead(status, h) {
        this.status = status
        Object.assign(headers, h)
      },
      end(body) {
        this.body = body
        this.done?.()
      },
    }
    const req = { url: '/api/coins', method: 'GET', headers: { host: 'x' }, socket: {} }
    await new Promise((next) => middlewares[0](req, res, next))
    const securityHeaders = JSON.parse(
      readFileSync(join(root, 'server/security-headers.json'), 'utf8'),
    )
    for (const [name, value] of Object.entries(securityHeaders)) assert.equal(headers[name], value)
    await new Promise((done, fail) => {
      res.done = done
      middlewares[1](req, res, () => fail(Error('API did not answer /api/coins')))
    })
    assert.equal(res.status, 200)
    assert.match(headers['Content-Type'], /application\/json/)
  } finally {
    close?.()
  }
})

test('the Vercel entry hides start-up failures from clients (C1)', async () => {
  const { default: handler } = await import('../../api/[[...path]].js')
  // A misconfigured Redis URL makes createApplication throw before any I/O.
  const broken = {
    UPSTASH_REDIS_REST_URL: 'http://redis.invalid/secret-path',
    UPSTASH_REDIS_REST_TOKEN: 'secret-token',
  }
  const saved = Object.fromEntries(Object.keys(broken).map((k) => [k, process.env[k]]))
  const logged = []
  const log = console.error
  Object.assign(process.env, broken)
  console.error = (...args) => logged.push(args)
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(body) {
      this.body = body
    },
  }
  try {
    await handler({ url: '/api/status', method: 'GET', headers: {}, socket: {} }, res)
  } finally {
    console.error = log
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { error: 'Something went wrong. Try again.' })
  assert.equal(logged.length, 1, 'logged server-side')
})
