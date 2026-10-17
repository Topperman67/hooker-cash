import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import { PublicKey } from '@solana/web3.js'
import {
  createApplication,
  fetchMetadataText,
  isPublicAddress,
  isPublicHost,
  resolvePublicAddress,
} from '../../server/application.mjs'
import { loadQuantumClient } from '../../server/keeper.mjs'
import { createFileStore } from '../../server/storage.mjs'

// Self-signed certificate for the fake metadata hosts below (test only, valid until 2126). The
// names never resolve in real DNS, so a successful fetch proves the server connected to the
// address it vetted rather than resolving the name again.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUAcUNnB/FOevH/6tzx8bYLRAmXWMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbWV0YS50ZXN0MCAXDTI2MTAxMDA4MzM1MFoYDzIxMjYwOTE2
MDgzMzUwWjAUMRIwEAYDVQQDDAltZXRhLnRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARoJ6em0COiMpD31QUFcd0Yp7JBjew8W3peGHB1NxPKkPGZFsHq+ruQ
7yWyFO1twvaelKBtxfBB2jjlwLIik/Yfo4GGMIGDMB0GA1UdDgQWBBTxouIo9w9I
Gn2ClpdNu39v6Y1rjzAfBgNVHSMEGDAWgBTxouIo9w9IGn2ClpdNu39v6Y1rjzAP
BgNVHRMBAf8EBTADAQH/MDAGA1UdEQQpMCeCCW1ldGEudGVzdIILKi5tZXRhLnRl
c3SCDXJlZGlyZWN0LnRlc3QwCgYIKoZIzj0EAwIDSAAwRQIgIU8B8Tcl049hI8Qe
vCfX+y0FVHriJMceMwuwY6pHsT4CIQDgp1xKbwenxJ8PO0E7+UYD3U/pVRw4plAM
2jjXmADXfQ==
-----END CERTIFICATE-----
`
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgY1ECO9Sl/9WaTWTH
PtlmRcSgGKCKwj7CnPldS7xNcQChRANCAARoJ6em0COiMpD31QUFcd0Yp7JBjew8
W3peGHB1NxPKkPGZFsHq+ruQ7yWyFO1twvaelKBtxfBB2jjlwLIik/Yf
-----END PRIVATE KEY-----
`
tls.setDefaultCACertificates([...tls.getCACertificates('default'), CERT])

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const MINTS = [
  'So11111111111111111111111111111111111111112',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
// Rate-limit windows are calendar minutes; keep counting tests inside one.
async function inOneMinute() {
  const into = Date.now() % 60000
  if (into > 55000) await sleep(60000 - into + 50)
}

async function boot(options = {}) {
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-serverapp-')),
    store: null,
    quantum: null,
    background: false,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
    resolveMetadataHost: async (host) =>
      ['meta.test', 'redirect.test'].includes(host) ? { address: '127.0.0.1', family: 4 } : null,
    ...options,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (path, body, headers = {}) =>
    fetch(base + path, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            body: typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
          }),
    })
  return {
    app,
    base,
    call,
    close: async () => {
      app.close()
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

// Calls the middleware with a hand-made request, so tests can choose the client address.
function direct(
  app,
  { path, body, ip = '10.0.0.1', method = body === undefined ? 'GET' : 'POST' },
) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: { host: 'qp.test', origin: 'http://qp.test' },
      socket: { remoteAddress: ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status
        this.headersSent = true
      },
      end(data) {
        resolve({ status: this.status, body: JSON.parse(String(data)) })
      },
    }
    app.middleware(req, res).catch(reject)
  })
}

async function metadataServer(routes) {
  const hits = []
  const server = createHttpsServer({ cert: CERT, key: KEY }, (req, res) => {
    res.on('error', () => {})
    hits.push(req.url)
    const route = routes[req.url.split('?')[0]]
    if (!route) {
      res.writeHead(404)
      return res.end()
    }
    route(req, res, hits.filter((h) => h === req.url).length)
  })
  server.on('tlsClientError', () => {})
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    hits,
    url: (path, host = 'meta.test') => `https://${host}:${port}${path}`,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

async function trackedCoin(app, mint, extra = {}) {
  const record = { mint, name: 'Coin', symbol: 'COIN', uri: '', external: true, ...extra }
  await app.store.set(`coin:${mint}`, record)
  const list = (await app.store.get('coins:list')) || []
  await app.store.set('coins:list', [
    { mint, name: record.name, symbol: record.symbol, external: true, image: null },
    ...list.filter((c) => c.mint !== mint),
  ])
  return record
}
const listEntry = async (app, mint) =>
  ((await app.store.get('coins:list')) || []).find((c) => c.mint === mint)

test('isPublicHost rejects trailing-dot names, NAT64, link-local and mapped hosts', () => {
  for (const host of [
    'localhost.',
    'foo.localhost.',
    'metadata.google.internal.',
    'printer.local',
    'router.home.arpa',
    '[64:ff9b::a00:5]',
    '[fe90::1]',
    '[fec0::1]',
    '[fc00::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[2002:a00:1::1]',
    '[2001::1]',
    '[ff02::1]',
    '198.18.0.1',
    '198.19.255.255',
    '100.64.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '192.0.0.8',
  ])
    assert.equal(isPublicHost(host), false, host)
  for (const host of ['ipfs.io.', 'gateway.pinata.cloud', '8.8.8.8', '[2606:4700:4700::1111]'])
    assert.equal(isPublicHost(host), true, host)
  assert.equal(isPublicAddress('fe80::1%1'), false)
  assert.equal(isPublicAddress('not-an-ip'), false)
})

test('resolvePublicAddress vets every resolved address before anything connects', async () => {
  const asked = []
  const lookup = (answers) => async (host, options) => {
    asked.push([host, options])
    return answers
  }
  assert.equal(
    await resolvePublicAddress('10.0.0.5.nip.io', lookup([{ address: '10.0.0.5', family: 4 }])),
    null,
  )
  assert.equal(
    await resolvePublicAddress(
      'mixed.example',
      lookup([
        { address: '93.184.215.14', family: 4 },
        { address: '::1', family: 6 },
      ]),
    ),
    null,
    'one private record is enough to refuse',
  )
  assert.deepEqual(
    await resolvePublicAddress('ipfs.io.', lookup([{ address: '93.184.215.14', family: 4 }])),
    { address: '93.184.215.14', family: 4 },
  )
  assert.equal(asked.at(-1)[0], 'ipfs.io', 'trailing dot stripped')
  assert.equal(asked.at(-1)[1].all, true, 'all addresses are checked')
  const before = asked.length
  assert.equal(await resolvePublicAddress('localhost.', lookup([])), null)
  assert.deepEqual(await resolvePublicAddress('8.8.8.8', lookup([])), {
    address: '8.8.8.8',
    family: 4,
  })
  assert.equal(asked.length, before, 'local names and IP literals need no lookup')
})

test('client errors: ENOENT without paths, generic 500s, 4xx messages and codes', async () => {
  const { app, call, close } = await boot()
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args)
  try {
    for (const path of ['/m/' + '0'.repeat(32), '/media/' + 'a'.repeat(64) + '.png']) {
      const missing = await call(path)
      assert.equal(missing.status, 404)
      assert.deepEqual(await missing.json(), { error: 'Not found.' })
    }

    app.indexer.track = async () => {
      throw Error(
        'failed to get info about account X: Error: 401 Unauthorized: <html>FAKE-SECRET-KEY-123 C:\\Users\\x\\.quantpad-data</html>',
      )
    }
    const upstream = await call('/api/coins/track', { mint: MINTS[0] })
    assert.equal(upstream.status, 500)
    const text = await upstream.text()
    assert.equal(JSON.parse(text).error, 'Something went wrong. Try again.')
    assert.doesNotMatch(text, /FAKE-SECRET|quantpad-data|Unauthorized/)
    assert.ok(logged.some((args) => String(args.at(-1)?.message).includes('FAKE-SECRET')))

    const invalid = await call('/api/media', { data: 'nope' })
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /PNG, JPEG/)
    assert.equal((await call('/api/coins/track', { mint: 'nope' })).status, 400)
    assert.equal((await call('/api/coins/track', 'null')).status, 400)
    assert.equal((await call('/api/coins/track', '{bad json')).status, 400)
    const claims = await call(`/api/quantum/${MINTS[0]}/claims`)
    assert.equal(claims.status, 400)
    assert.equal((await claims.json()).error, 'Provide a wallet address.')

    app.indexer.registerLaunch = async () => {
      throw Object.assign(Error('Launch transaction is not indexed yet.'), {
        status: 409,
        code: 'not_indexed_yet',
      })
    }
    const retry = await call('/api/launches', { signature: 'x'.repeat(64), mint: MINTS[1] })
    assert.equal(retry.status, 409)
    assert.deepEqual(await retry.json(), {
      error: 'Launch transaction is not indexed yet.',
      code: 'not_indexed_yet',
    })
  } finally {
    console.error = originalError
    await close()
  }
})

test('metadata: gzip/brotli bombs and oversized bodies are cut off at 64 KB', async () => {
  // Valid JSON once inflated, so only the size limit can reject it.
  const inflated = Buffer.concat([
    Buffer.from('{"description":"'),
    Buffer.alloc(32 * 1024 * 1024, 0x78),
    Buffer.from('"}'),
  ])
  const bomb = gzipSync(inflated)
  const brotliBomb = brotliCompressSync(inflated, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  })
  assert.ok(bomb.length < 65536 && brotliBomb.length < 65536, 'the compressed bodies are small')
  const meta = await metadataServer({
    '/bomb.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(bomb)
    },
    '/chunked-bomb.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' })
      // Sent in pieces: the size is only known by reading.
      res.write(brotliBomb.subarray(0, 10))
      setTimeout(() => res.end(brotliBomb.subarray(10)), 20)
    },
    '/large.json': (req, res) => {
      const body = JSON.stringify({ description: 'x'.repeat(70000) })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
      res.end(body)
    },
    '/small.json': (req, res) => {
      const body = gzipSync(JSON.stringify({ description: 'fits' }))
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(body)
    },
  })
  const resolveHost = async () => ({ address: '127.0.0.1', family: 4 })
  const { app, call, close } = await boot()
  try {
    for (const path of ['/bomb.json', '/chunked-bomb.json', '/large.json'])
      await assert.rejects(fetchMetadataText(meta.url(path), { resolveHost }), {
        message: 'Metadata is too large.',
        transient: false,
      })
    assert.equal(
      await fetchMetadataText(meta.url('/small.json'), { resolveHost }),
      '{"description":"fits"}',
      'compressed documents under the limit are decoded',
    )

    for (const [mint, path] of [
      [MINTS[0], '/bomb.json'],
      [MINTS[1], '/chunked-bomb.json'],
      [MINTS[2], '/large.json'],
    ]) {
      await trackedCoin(app, mint, { uri: meta.url(path) })
      const started = Date.now()
      const response = await call(`/api/coins/${mint}`)
      assert.equal(response.status, 200, path)
      const { coin } = await response.json()
      assert.ok(Date.now() - started < 4000, `${path} resolved quickly`)
      assert.equal(coin.meta, undefined, path)
      assert.equal(coin.image ?? null, null, path)
      const state = await app.store.get(`coin-meta:${mint}`)
      assert.ok(state.retryAt > Date.now() + 3600_000, `${path} is a definitive failure`)
    }
  } finally {
    await close()
    await meta.close()
  }
})

test('metadata: transient failures retry with backoff instead of caching null', async () => {
  const meta = await metadataServer({
    '/flaky.json': (req, res, n) => {
      if (n === 1) {
        res.writeHead(429)
        return res.end('slow down')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          image: 'https://cdn.example/coin.png',
          description: 'Hello',
          website: 'http://example.com',
          twitter: 'javascript:alert(1)',
        }),
      )
    },
  })
  const { app, call, close } = await boot()
  const mint = MINTS[3]
  try {
    await trackedCoin(app, mint, { uri: meta.url('/flaky.json') })
    const first = (await (await call(`/api/coins/${mint}`)).json()).coin
    assert.equal(first.meta, undefined)
    assert.equal(meta.hits.length, 1)
    const state = await app.store.get(`coin-meta:${mint}`)
    assert.ok(state.retryAt > Date.now() + 30_000 && state.retryAt < Date.now() + 120_000)
    assert.equal((await app.store.get(`coin:${mint}`)).meta, undefined, 'record not nulled')

    await call(`/api/coins/${mint}`)
    assert.equal(meta.hits.length, 1, 'no refetch inside the backoff window')

    await app.store.set(`coin-meta:${mint}`, { ...state, retryAt: Date.now() - 1 })
    const healed = (await (await call(`/api/coins/${mint}`)).json()).coin
    assert.equal(meta.hits.length, 2)
    assert.equal(healed.image, 'https://cdn.example/coin.png')
    assert.equal(healed.meta.description, 'Hello')
    assert.equal(healed.meta.website, 'http://example.com', 'http links are kept')
    assert.equal(healed.meta.twitter, '')
    assert.equal((await listEntry(app, mint)).image, 'https://cdn.example/coin.png')

    await call(`/api/coins/${mint}`)
    assert.equal(meta.hits.length, 2, 'resolved metadata is not fetched again')
  } finally {
    await close()
    await meta.close()
  }
})

test('metadata: concurrent reads share one fetch and a stale indexer write is healed', async () => {
  const meta = await metadataServer({
    '/slow.json': (req, res) =>
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ image: 'https://cdn.example/slow.png', description: 'Slow' }))
      }, 300),
  })
  const { app, call, close } = await boot()
  const mint = MINTS[4]
  try {
    const record = await trackedCoin(app, mint, { uri: meta.url('/slow.json') })
    const coins = await Promise.all(
      Array.from({ length: 6 }, () => call(`/api/coins/${mint}`).then((r) => r.json())),
    )
    assert.equal(meta.hits.length, 1)
    for (const { coin } of coins) assert.equal(coin.image, 'https://cdn.example/slow.png')

    // A sync that read the record before metadata was saved writes its stale copy back.
    await app.store.set(`coin:${mint}`, { ...record, syncedAt: Date.now() })
    const list = await app.store.get('coins:list')
    await app.store.set(
      'coins:list',
      list.map((c) => (c.mint === mint ? { ...c, image: null } : c)),
    )
    const { coin } = await (await call(`/api/coins/${mint}`)).json()
    assert.equal(coin.image, 'https://cdn.example/slow.png')
    assert.equal(coin.meta.description, 'Slow')
    assert.equal(meta.hits.length, 1, 'healed from saved metadata without refetching')
    assert.equal((await app.store.get(`coin:${mint}`)).image, 'https://cdn.example/slow.png')
    assert.equal((await listEntry(app, mint)).image, 'https://cdn.example/slow.png')
    assert.ok((await app.store.get(`coin:${mint}`)).syncedAt, 'indexer fields are kept')
  } finally {
    await close()
    await meta.close()
  }
})

test('metadata: every redirect hop is vetted and private targets are never contacted', async () => {
  let privateHits = 0
  const meta = await metadataServer({
    '/to-private': (req, res) => {
      res.writeHead(302, { location: `https://internal.test:${req.socket.localPort}/secret` })
      res.end()
    },
    '/secret': (req, res) => {
      privateHits++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    },
    '/hop': (req, res) => {
      res.writeHead(301, { location: `https://meta.test:${req.socket.localPort}/ok.json` })
      res.end()
    },
    '/ok.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ image: 'https://cdn.example/ok.png' }))
    },
  })
  const { app, call, close } = await boot()
  try {
    await trackedCoin(app, MINTS[5], { uri: meta.url('/to-private') })
    const refused = (await (await call(`/api/coins/${MINTS[5]}`)).json()).coin
    assert.equal(refused.meta, undefined)
    assert.equal(privateHits, 0)

    await trackedCoin(app, MINTS[6], { uri: meta.url('/hop', 'redirect.test') })
    const followed = (await (await call(`/api/coins/${MINTS[6]}`)).json()).coin
    assert.equal(followed.image, 'https://cdn.example/ok.png')

    await trackedCoin(app, MINTS[7], { uri: 'http://meta.test/plain.json' })
    const plain = (await (await call(`/api/coins/${MINTS[7]}`)).json()).coin
    assert.equal(plain.meta, undefined, 'plain http metadata is refused')
  } finally {
    await close()
    await meta.close()
  }
})

test('own artwork shows on http deployments; issued URIs are recorded for launches', async () => {
  const { app, call, base, close } = await boot()
  try {
    const { url: image } = await (
      await call('/api/media', { data: 'data:image/png;base64,' + PNG.toString('base64') })
    ).json()
    assert.match(image, /^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{64}\.png$/)
    const { uri } = await (
      await call('/api/metadata', {
        name: 'Http Coin',
        symbol: 'HTTP',
        image,
        website: 'http://example.com',
      })
    ).json()
    const issued = await app.store.get(`issued-uri:${sha256(uri).slice(0, 32)}`)
    assert.ok(issued && typeof issued.at === 'number', 'issued uri recorded for provenance')

    const mint = MINTS[0]
    await trackedCoin(app, mint, { uri })
    const { coin } = await (await call(`/api/coins/${mint}`)).json()
    assert.equal(coin.image, '/media/' + image.split('/media/')[1])
    assert.equal(coin.meta.website, 'http://example.com')
    const served = await fetch(base + coin.image)
    assert.equal(served.headers.get('content-type'), 'image/png')

    // Records cached by the old https-only filter heal on the next read.
    await trackedCoin(app, MINTS[1], {
      uri,
      meta: { image: '', description: '', website: '', twitter: '', telegram: '' },
      image: null,
    })
    const legacy = (await (await call(`/api/coins/${MINTS[1]}`)).json()).coin
    assert.equal(legacy.image, coin.image)

    const bad = await call('/api/metadata', { name: 'A', symbol: 'A', image: 'http://' })
    assert.equal(bad.status, 400)
  } finally {
    await close()
  }
})

test('POST /api/launches: own bucket, passes signature and mint, hides cursors', async () => {
  await inOneMinute()
  const { app, call, close } = await boot()
  const calls = []
  app.indexer.registerLaunch = async (signature, options) => {
    calls.push([signature, options])
    return {
      mint: options?.mint || MINTS[0],
      name: 'Launch',
      symbol: 'LNCH',
      uri: '',
      cursor: 'internal-cursor',
      poolCursor: 'internal-pool-cursor',
    }
  }
  try {
    const signature = '5'.repeat(88)
    const both = await call('/api/launches', { signature, mint: MINTS[2] })
    assert.equal(both.status, 201)
    const { coin } = await both.json()
    assert.equal(coin.mint, MINTS[2])
    assert.equal('cursor' in coin, false)
    assert.equal('poolCursor' in coin, false)
    assert.deepEqual(calls[0], [signature, { mint: MINTS[2] }])

    assert.equal((await call('/api/launches', { mint: MINTS[3] })).status, 201)
    assert.deepEqual(calls[1], ['', { mint: MINTS[3] }])
    assert.equal((await call('/api/launches', { signature })).status, 201)
    assert.deepEqual(calls[2], [signature, { mint: undefined }])

    assert.equal((await call('/api/launches', {})).status, 400)
    assert.equal((await call('/api/launches', { mint: 'not-a-mint' })).status, 400)
    assert.equal((await call('/api/launches', { signature: 42 })).status, 400)

    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await call('/api/launches', { signature })).status)
    assert.deepEqual(statuses, [201, 201, 201, 201, 429, 429], 'ten launch requests per minute')
    assert.equal(calls.length, 7)
  } finally {
    await close()
  }
})

test('POST /api/coins/track and GET /api/coins/:mint strip internal cursors', async () => {
  const { app, call, close } = await boot()
  app.indexer.track = (mint) => app.store.get(`coin:${mint}`)
  try {
    await trackedCoin(app, MINTS[4], { cursor: 'sig-a', poolCursor: 'sig-b', price: 1 })
    const tracked = await call('/api/coins/track', { mint: MINTS[4] })
    assert.equal(tracked.status, 201)
    const { coin } = await tracked.json()
    assert.equal(coin.mint, MINTS[4])
    assert.equal(coin.price, 1)
    assert.equal('cursor' in coin, false)
    assert.equal('poolCursor' in coin, false)
    const viewed = (await (await call(`/api/coins/${MINTS[4]}`)).json()).coin
    assert.deepEqual(Object.keys(viewed).sort(), Object.keys(coin).sort())
  } finally {
    await close()
  }
})

test('the indexer sync state (backlog anchors, seq, history and supply stamps) stays internal', async () => {
  await inOneMinute()
  const { app, call, close } = await boot()
  const mint = MINTS[3]
  // The shape syncHeld writes: `gaps` holds signatures, the rest is bookkeeping.
  const internal = {
    cursor: '4sigCursor',
    poolCursor: '4sigPoolCursor',
    gaps: { cursor: '4sigAnchorAboveBacklog' },
    seq: 17,
    historyFrom: { cursor: 1_700_000_000 },
    supplyAt: Date.now(),
  }
  app.indexer.track = (m) => app.store.get(`coin:${m}`)
  app.indexer.registerLaunch = async () => app.store.get(`coin:${mint}`)
  try {
    await trackedCoin(app, mint, { ...internal, behind: true, price: 2, syncedAt: Date.now() })
    const responses = [
      (await (await call(`/api/coins/${mint}`)).json()).coin,
      (await (await call('/api/coins/track', { mint })).json()).coin,
      (await (await call('/api/launches', { mint })).json()).coin,
    ]
    for (const coin of responses) {
      assert.equal(coin.mint, mint)
      assert.equal(coin.price, 2, 'public fields are kept')
      for (const field of Object.keys(internal)) assert.equal(field in coin, false, field)
      assert.doesNotMatch(JSON.stringify(coin), /4sig/)
    }
  } finally {
    await close()
  }
})

test('media quota: per-network daily budget; pins only for metadata, once per blob, capped', async () => {
  await inOneMinute()
  const originalFetch = globalThis.fetch
  let pins = 0
  let pinFails = false
  const pinned = []
  process.env.PINATA_JWT = 'test-jwt'
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://uploads.pinata.cloud/')) {
      if (pinFails) return new Response('down', { status: 500 })
      pins++
      const file = init.body.get('file')
      pinned.push({ name: file.name, type: file.type, text: await file.text() })
      return Response.json({ data: { cid: `bafytest${pins}` } })
    }
    return originalFetch(url, init)
  }
  // A 300 KB byte budget for the first app; the default 16 MB with a 3-pin cap for the second.
  const tight = await boot({ mediaClientLimitBytes: 300 * 1024 })
  const roomy = await boot({ pinClientLimit: 3 })
  let app = tight.app
  const png = () =>
    'data:image/png;base64,' + Buffer.concat([PNG, randomBytes(16)]).toString('base64')
  const upload = (ip, data = png()) => direct(app, { path: '/api/media', body: { data }, ip })
  const publish = (ip, image, name = 'Coin') =>
    direct(app, { path: '/api/metadata', body: { name, symbol: 'COIN', image }, ip })
  try {
    // Byte budget: every write costs at least 128 KB against 300 KB, per /64 for IPv6.
    const a = [
      await upload('2001:db8:1:2::1'),
      await upload('2001:db8:1:2::2'),
      await upload('2001:db8:1:2::3'),
    ]
    assert.deepEqual(
      a.map((r) => r.status),
      [201, 201, 429],
      'fresh addresses inside one /64 share the budget',
    )
    assert.equal(a[2].body.code, 'MEDIA_QUOTA')
    assert.equal((await upload('2001:db8:1:3::1')).status, 201, 'another /64 is unaffected')
    assert.equal((await upload('10.0.0.2')).status, 201, 'another visitor is unaffected')
    assert.equal(pins, 0, 'uploads alone never reach Pinata')
    assert.match(a[0].body.url, /^http:\/\/qp\.test\/media\/[a-f0-9]{64}\.png$/)

    // Metadata pins its artwork and the document once each; a repeat reuses both pins.
    app = roomy.app
    const art = await upload('10.0.0.3')
    const first = await publish('10.0.0.3', art.body.url)
    assert.equal(first.status, 201)
    assert.equal(pins, 2, 'artwork and document')
    assert.deepEqual(
      pinned.map((p) => [p.name, p.type]),
      [
        [art.body.url.split('/media/')[1], 'image/png'],
        [pinned[1].name, 'application/json'],
      ],
    )
    assert.equal(first.body.uri, 'https://ipfs.io/ipfs/bafytest2')
    assert.equal(
      JSON.parse(pinned[1].text).image,
      'https://ipfs.io/ipfs/bafytest1',
      'the pinned document points at the pinned artwork',
    )
    const again = await publish('10.0.0.3', art.body.url)
    assert.equal(again.body.uri, first.body.uri)
    assert.equal(pins, 2, 'no new pins for the same content')

    // A visitor's pins are capped per day (3 here): the next new blob is refused.
    const capped = await publish('10.0.0.3', art.body.url, 'Another')
    assert.equal(capped.status, 201, 'third pin (new document, artwork already pinned)')
    assert.equal(pins, 3)
    const over = await publish('10.0.0.3', art.body.url, 'Yet another')
    assert.equal(over.status, 429)
    assert.equal(over.body.code, 'MEDIA_QUOTA')
    assert.equal(pins, 3)

    pinFails = true
    const art2 = await upload('10.0.0.4')
    const failed = await publish('10.0.0.4', art2.body.url)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.error, 'IPFS pinning failed. Try again shortly.')
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.PINATA_JWT
    await tight.close()
    await roomy.close()
  }
})

// A store with pending media (putMedia's `ttl`, promoteMedia) around the file store, recording
// how the app uses it. `lost` names uploads whose pending copy expired.
function pendingMediaStore() {
  const files = createFileStore(mkdtempSync(join(tmpdir(), 'qp-pending-')))
  const calls = []
  const lost = new Set()
  return {
    calls,
    lost,
    store: {
      ...files,
      async putMedia(name, bytes, limit, { ttl = 0 } = {}) {
        calls.push(['put', name, ttl])
        await files.putMedia(name, bytes, limit)
        return true
      },
      async promoteMedia(name, limit) {
        calls.push(['promote', name, limit])
        return !lost.has(name)
      },
      async getMedia(name) {
        if (lost.has(name)) throw Object.assign(Error('Not found'), { code: 'ENOENT' })
        return files.getMedia(name)
      },
    },
  }
}

test('uploads and metadata stay pending until a launch with that metadata registers (K5)', async () => {
  const pending = pendingMediaStore()
  const { app, close } = await boot({
    store: pending.store,
    pendingMediaMs: 3_600_000,
    mediaLimitBytes: 5_000_000,
    publicUrl: 'http://qp.test',
  })
  const png = () =>
    'data:image/png;base64,' + Buffer.concat([PNG, randomBytes(16)]).toString('base64')
  try {
    const art = await direct(app, { path: '/api/media', body: { data: png() } })
    assert.equal(art.status, 201)
    const name = art.body.url.split('/media/')[1]
    assert.deepEqual(pending.calls, [['put', name, 3_600_000]], 'stored as pending')

    const meta = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Kept', symbol: 'KEPT', image: art.body.url },
    })
    assert.equal(meta.status, 201)
    const id = meta.body.uri.split('/m/')[1]
    assert.deepEqual(
      pending.calls.slice(1),
      [
        ['put', name, 3_600_000],
        ['put', `meta-${id}.json`, 3_600_000],
      ],
      'the artwork stays pending for another period and the document is pending too',
    )
    const doc = JSON.parse(String(await app.store.getMedia(`meta-${id}.json`)))
    assert.equal(doc.image, `http://qp.test/media/${name}`)

    // The indexer registers a launch with this uri as native: both become permanent.
    pending.calls.length = 0
    await app.onNativeLaunch({ mint: MINTS[0], uri: meta.body.uri })
    assert.deepEqual(pending.calls, [
      ['promote', name, 5_000_000],
      ['promote', `meta-${id}.json`, 5_000_000],
    ])

    // The pending copy expired between the upload and the metadata request.
    const late = await direct(app, { path: '/api/media', body: { data: png() } })
    pending.lost.add(late.body.url.split('/media/')[1])
    const refused = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Late', symbol: 'LATE', image: late.body.url },
    })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error, /no longer available/)
  } finally {
    await close()
  }
})

test('file store: an abandoned upload expires and frees the quota, launched artwork stays', async () => {
  const { app, close } = await boot({
    pendingMediaMs: 200,
    mediaLimitBytes: 3000,
    publicUrl: 'http://qp.test',
  })
  const png = () =>
    'data:image/png;base64,' + Buffer.concat([PNG, randomBytes(1000)]).toString('base64')
  const upload = () => direct(app, { path: '/api/media', body: { data: png() } })
  const served = (url) =>
    app.store.getMedia(url.split('/media/')[1]).then(
      () => true,
      (e) => (e.code === 'ENOENT' ? false : Promise.reject(e)),
    )
  try {
    const kept = await upload()
    const meta = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Kept', symbol: 'KEPT', image: kept.body.url },
    })
    assert.equal(meta.status, 201)
    await app.onNativeLaunch({ mint: MINTS[0], uri: meta.body.uri })
    const abandoned = await upload()
    assert.equal(abandoned.status, 201)
    const full = await upload()
    assert.equal(full.status, 507, 'the shared quota is full while the abandoned upload lives')
    assert.equal(full.body.error, 'Media storage is full. Contact the operator.')

    await sleep(300)
    assert.equal((await upload()).status, 201, 'the expired upload gave its bytes back')
    assert.equal(await served(abandoned.body.url), false, 'the abandoned upload is gone')
    assert.equal(await served(kept.body.url), true, 'artwork of a launched coin is kept')
  } finally {
    await close()
  }
})

test('saved metadata waits for the coin lock and keeps what another writer changed', async () => {
  const meta = await metadataServer({
    '/coin.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ image: 'https://cdn.example/coin.png', description: 'Locked' }))
    },
  })
  const { app, call, close } = await boot()
  const mint = MINTS[2]
  try {
    await trackedCoin(app, mint, { uri: meta.url('/coin.json'), seq: 1, cursor: 'sig-1' })
    // An indexer sync holds the coin's lock.
    assert.ok(await app.store.set(`lock:coin:${mint}`, 'sync', { nx: true, ttl: 5000 }))
    const viewing = call(`/api/coins/${mint}`).then((r) => r.json())
    await sleep(300)
    assert.equal(meta.hits.length, 1)
    assert.equal((await app.store.get(`coin:${mint}`)).meta, undefined, 'no unlocked write')
    // ...advances the record and lists a new launch, then lets go.
    await app.store.set(`coin:${mint}`, {
      ...(await app.store.get(`coin:${mint}`)),
      seq: 2,
      cursor: 'sig-2',
    })
    await app.store.set('coins:list', [
      { mint: MINTS[7], name: 'New', symbol: 'NEW', external: false },
      ...(await app.store.get('coins:list')),
    ])
    await app.store.release(`lock:coin:${mint}`, 'sync')

    const { coin } = await viewing
    assert.equal(coin.image, 'https://cdn.example/coin.png')
    const stored = await app.store.get(`coin:${mint}`)
    assert.equal(stored.image, 'https://cdn.example/coin.png')
    assert.equal(stored.meta.description, 'Locked')
    assert.equal(stored.seq, 2, 'the sync state written meanwhile is kept')
    assert.equal(stored.cursor, 'sig-2')
    const listed = await app.store.get('coins:list')
    assert.ok(
      listed.some((c) => c.mint === MINTS[7]),
      'a launch listed meanwhile stays listed',
    )
    assert.equal(listed.find((c) => c.mint === mint).image, 'https://cdn.example/coin.png')
  } finally {
    await close()
    await meta.close()
  }
})

test('/api/rpc relays the upstream answer as received, keeping Retry-After on a 429', async () => {
  let busy = false
  const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (busy) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
        return res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"busy"},"id":1}')
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"jsonrpc":"2.0",  "result":  123, "id":1}')
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const { call, close } = await boot({ rpcUrl: `http://127.0.0.1:${upstream.address().port}` })
  const slot = { jsonrpc: '2.0', id: 1, method: 'getSlot' }
  try {
    const ok = await call('/api/rpc', slot)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), '{"jsonrpc":"2.0",  "result":  123, "id":1}', 'not re-serialised')
    busy = true
    const limited = await call('/api/rpc', slot)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '7')
    assert.equal((await limited.json()).error.code, 429)
    const refused = await call('/api/rpc', { ...slot, method: 'getProgramAccounts' })
    assert.equal(refused.status, 403, 'client mistakes still go through the catch-all')
  } finally {
    await close()
    upstream.closeAllConnections?.()
    await new Promise((r) => upstream.close(r))
  }
})

test('the index pass and the keeper share the serverless time budget', async () => {
  process.env.CRON_SECRET = 'budget-secret'
  // backgroundGapMs: 0, so the passes below run back to back (serverApp-r2 tests the gap).
  const { app, base, close } = await boot({ serverless: true, backgroundGapMs: 0 })
  const calls = []
  const realNow = Date.now
  let offset = 0
  let syncTakes = 12_000
  app.indexer.sync = async (options) => {
    calls.push(['sync', options])
    offset += syncTakes
    return { synced: 0 }
  }
  app.keeper.tick = async (options) => {
    calls.push(['tick', options])
    return { enabled: true, ran: 0 }
  }
  Date.now = () => realNow() + offset
  try {
    const tick = await fetch(base + '/api/keeper/tick', {
      headers: { Authorization: 'Bearer budget-secret' },
    })
    assert.equal(tick.status, 200)
    assert.deepEqual(calls[0], ['sync', { budget: 8, timeMs: 15_000 }])
    const limit = calls[1][1].timeLimitMs
    assert.ok(limit > 27_000 && limit <= 28_000, `keeper gets what is left of 40 s (${limit})`)

    // The tick route just ran the keeper: the background pass after its response indexes but
    // does not run the keeper again.
    app.keeper.enabled = true
    calls.length = 0
    syncTakes = 5_000
    await app.sync({ startedAt: Date.now() })
    assert.deepEqual(calls, [['sync', { budget: 3, timeMs: 15_000 }]])

    // The budget counts from the start of the invocation: a request that used 33 s leaves too
    // little for a pass, so nothing runs after it.
    await app.store.del?.('keeper:throttle')
    await app.store.set('keeper:throttle', 0, { ttl: 1 })
    await new Promise((r) => setTimeout(r, 5))
    calls.length = 0
    await app.sync({ startedAt: Date.now() - 33_000 })
    assert.deepEqual(calls, [])

    // With 25 s left the index pass is capped by what remains, and a pass that leaves under 10 s
    // skips the keeper instead of giving it a budget the function does not have.
    calls.length = 0
    syncTakes = 17_000
    await app.sync({ startedAt: Date.now() - 15_000 })
    assert.deepEqual(calls, [['sync', { budget: 3, timeMs: 15_000 }]])

    // Enough left after the pass: the keeper gets the remainder minus a safety margin.
    calls.length = 0
    syncTakes = 4_000
    await app.sync({ startedAt: Date.now() })
    assert.deepEqual(calls[0], ['sync', { budget: 3, timeMs: 15_000 }])
    const keeperLimit = calls[1]?.[1]?.timeLimitMs
    assert.ok(
      keeperLimit > 32_000 && keeperLimit <= 33_000,
      `keeper gets the rest (${keeperLimit})`,
    )
  } finally {
    Date.now = realNow
    delete process.env.CRON_SECRET
    await close()
  }
})

test('a tick whose index pass or keeper fails still answers 200, with each step’s error', async () => {
  process.env.CRON_SECRET = 'outage-secret'
  const { app, base, close } = await boot({ serverless: true, backgroundGapMs: 0 })
  const storageDown = () =>
    Object.assign(Error('Storage is unavailable right now.'), {
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
    })
  const ran = []
  app.indexer.sync = async () => {
    ran.push('sync')
    throw storageDown()
  }
  app.keeper.tick = async () => {
    ran.push('keeper')
    return { enabled: true, ran: 1 }
  }
  const tick = () =>
    fetch(base + '/api/keeper/tick', { headers: { Authorization: 'Bearer outage-secret' } })
  try {
    // the index pass fails: the keeper still runs, and the tick says what failed
    const first = await tick()
    assert.equal(first.status, 200)
    const body = await first.json()
    assert.equal(body.ok, false)
    assert.deepEqual(body.index, {
      error: 'Storage is unavailable right now.',
      code: 'STORAGE_UNAVAILABLE',
    })
    assert.deepEqual(body.keeper, { enabled: true, ran: 1 })
    assert.ok(body.engine, 'the payout engine reports too')
    assert.deepEqual(ran, ['sync', 'keeper'])

    // both fail: still 200, both errors listed
    app.keeper.tick = async () => {
      throw storageDown()
    }
    const both = await (await tick()).json()
    assert.equal(both.ok, false)
    assert.equal(both.index.code, 'STORAGE_UNAVAILABLE')
    assert.equal(both.keeper.code, 'STORAGE_UNAVAILABLE')

    // nothing fails: ok
    app.indexer.sync = async () => ({ synced: 0 })
    app.keeper.tick = async () => ({ enabled: true, ran: 0 })
    const fine = await (await tick()).json()
    assert.equal(fine.ok, true)
  } finally {
    delete process.env.CRON_SECRET
    await close()
  }
})

test('claims: identical requests share a run, concurrency is capped, a long queue gets 429', async () => {
  await inOneMinute()
  const { app, close } = await boot({ claimsConcurrency: 2, claimsQueue: 2 })
  let active = 0
  let peak = 0
  let runs = 0
  const gates = []
  app.keeper.claims = async (mint, wallet) => {
    runs++
    peak = Math.max(peak, ++active)
    await new Promise((r) => gates.push(r))
    active--
    return [{ index: 1, wallet }]
  }
  const mint = MINTS[6]
  const ask = (wallet, ip) =>
    direct(app, { path: `/api/quantum/${mint}/claims?wallet=${wallet}`, ip })
  try {
    const answers = Promise.all([
      ask(MINTS[0], '10.2.0.1'),
      ask(MINTS[0], '10.2.0.2'),
      ask(MINTS[1], '10.2.0.3'),
      ask(MINTS[2], '10.2.0.4'),
      ask(MINTS[3], '10.2.0.5'),
    ])
    await sleep(50)
    const refused = await ask(MINTS[4], '10.2.0.6')
    assert.equal(refused.status, 429)
    assert.equal(refused.body.code, 'QUANTUM_BUSY')
    for (let released = 0; released < 4; released++) {
      while (!gates.length) await sleep(5)
      assert.ok(active <= 2)
      gates.shift()()
    }
    const results = await answers
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200, 200, 200],
    )
    assert.deepEqual(results[0].body, results[1].body)
    assert.equal(runs, 4, 'the two identical requests shared one run')
    assert.equal(peak, 2)
  } finally {
    await close()
  }
})

test('status names a Quantum client load failure and a degraded serverless indexer', async () => {
  await loadQuantumClient({
    load: async () => {
      throw Object.assign(Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' })
    },
    report: () => {},
  })
  const rpc = process.env.QUANTPAD_RPC_URL
  delete process.env.QUANTPAD_RPC_URL
  const serverless = await boot({ serverless: true })
  const standalone = await boot()
  try {
    const status = await (await serverless.call('/api/status')).json()
    assert.deepEqual(status.quantum, {
      available: false,
      reason: 'client-missing',
      error: 'ERR_MODULE_NOT_FOUND',
    })
    assert.deepEqual(status.indexer, { degraded: true, reason: 'public-rpc' })
    const local = await (await standalone.call('/api/status')).json()
    assert.deepEqual(local.indexer, { degraded: false, reason: null })
  } finally {
    await loadQuantumClient({ load: async () => ({}), report: () => {} })
    if (rpc !== undefined) process.env.QUANTPAD_RPC_URL = rpc
    await serverless.close()
    await standalone.close()
  }
})

test('POST /api/sync: per-mint cooldown, shared runs and one trailing pass', async () => {
  await inOneMinute()
  const { app, call, close } = await boot({ syncCooldownMs: 300 })
  const mint = MINTS[5]
  let syncs = 0
  app.indexer.syncCoin = async (m) => {
    syncs++
    await sleep(50)
    const record = { ...(await app.store.get(`coin:${m}`)), syncedAt: Date.now() }
    await app.store.set(`coin:${m}`, record)
    return record
  }
  let passes = 0
  app.indexer.sync = async () => ({ synced: ++passes })
  try {
    await trackedCoin(app, mint, { syncedAt: Date.now() - 60_000 })
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => call('/api/sync', { mint }).then((r) => r.json())),
    )
    assert.equal(syncs, 1, 'concurrent requests share one sync')
    for (const { coin } of burst) assert.equal(coin.mint, mint)

    const cooled = await (await call('/api/sync', { mint })).json()
    assert.equal(cooled.coin.mint, mint)
    assert.equal(syncs, 1, 'inside the cooldown the stored record is returned')
    await call('/api/sync', { mint })
    await sleep(1000)
    assert.equal(syncs, 2, 'exactly one trailing sync after the cooldown')

    assert.deepEqual(await (await call('/api/sync', { mint: MINTS[6] })).json(), { coin: null })
    assert.equal(syncs, 2, 'untracked mints cost nothing')

    assert.deepEqual(await (await call('/api/sync', {})).json(), { synced: 1 })
    assert.deepEqual(await (await call('/api/sync', {})).json(), { skipped: true })

    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await call('/api/sync', { mint })).status)
    assert.deepEqual(statuses, [202, 202, 202, 429, 429, 429], 'twelve sync requests per minute')
  } finally {
    await close()
  }
})

test('Quantum GETs are rate limited and history reads are shared briefly', async () => {
  await inOneMinute()
  const { app, close } = await boot()
  let epochReads = 0
  app.keeper.epochs = async () => {
    epochReads++
    return [{ index: 1, total: '5', postedAt: 1, holders: 2, closed: false }]
  }
  app.keeper.log = async () => []
  app.keeper.claims = async () => []
  const mint = MINTS[6]
  try {
    const first = await direct(app, { path: `/api/quantum/${mint}` })
    assert.equal(first.status, 200)
    assert.equal(first.body.epochs.length, 1)
    await direct(app, { path: `/api/quantum/${mint}` })
    assert.equal(epochReads, 1)

    const history = []
    for (let i = 0; i < 60; i++)
      history.push((await direct(app, { path: `/api/quantum/${mint}` })).status)
    assert.equal(history.filter((s) => s === 429).length, 2, 'sixty history reads per minute')
    const wallet = MINTS[0]
    const claims = []
    for (let i = 0; i < 31; i++)
      claims.push(
        (await direct(app, { path: `/api/quantum/${mint}/claims?wallet=${wallet}` })).status,
      )
    assert.equal(claims.filter((s) => s === 429).length, 1, 'thirty claim reads per minute')
    const elsewhere = await direct(app, { path: `/api/quantum/${mint}`, ip: '10.9.9.9' })
    assert.equal(elsewhere.status, 200)
  } finally {
    await close()
  }
})

test('status re-reads the Quantum config within 30 s, so a pause reaches the UI', async () => {
  const config = { paused: false, protocolBps: 100, keeper: null }
  let rpcDown = false
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  const { call, close } = await boot({
    quantum: {
      QUANTUM_PROGRAM_ID: new PublicKey(MINTS[7]),
      fetchConfig: async () => ({ ...config }),
    },
    connection: {
      rpcEndpoint: 'http://rpc.invalid',
      getAccountInfo: async () => {
        if (rpcDown) throw Error('rpc down')
        return { executable: true }
      },
    },
  })
  try {
    const status = async () => (await (await call('/api/status')).json()).quantum
    assert.equal((await status()).available, true)
    config.paused = true
    assert.equal((await status()).available, true, 'cached briefly')
    offset += 31_000
    const paused = await status()
    assert.equal(paused.available, false)
    assert.equal(paused.reason, 'paused')

    rpcDown = true
    offset += 31_000
    assert.equal((await status()).reason, 'paused', 'a failed read keeps the last known state')
  } finally {
    Date.now = realNow
    await close()
  }
})
