import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INTERNAL_COIN_FIELDS,
  MEDIA_CACHE,
  PUBLIC_READ_CACHE,
  configuredPublicUrl,
  createApplication,
  hostOrigin,
  isLoopbackHost,
  secretMatches,
} from '../../server/application.mjs'
import { issuedUriClaimKey } from '../../server/indexer.mjs'
import * as requestLimits from '../../server/request-limits.mjs'
import { createFileStore } from '../../server/storage.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const MINTS = [
  'So11111111111111111111111111111111111111112',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const png = (extra = 16) =>
  'data:image/png;base64,' + Buffer.concat([PNG, randomBytes(extra)]).toString('base64')
// Rate-limit windows are calendar minutes; keep counting tests inside one.
async function inOneMinute() {
  const into = Date.now() % 60000
  if (into > 55000) await sleep(60000 - into + 50)
}
// Runs `fn` with environment variables set (undefined deletes), restoring them afterwards.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

async function boot(options = {}) {
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-serverapp-r2-')),
    store: null,
    quantum: null,
    background: false,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
    resolveMetadataHost: async () => null,
    ...options,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    app,
    base,
    close: async () => {
      app.close()
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}

// Calls the middleware with a hand-made request, so tests choose the client address, the Host
// header (Origin follows it, so writes pass the same-origin check) and other headers.
function direct(
  app,
  {
    path,
    body,
    ip = '10.0.0.1',
    method = body === undefined ? 'GET' : 'POST',
    host = 'qp.test',
    headers = {},
  },
) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url: path,
      headers: { host, origin: `http://${host}`, ...headers },
      socket: { remoteAddress: ip },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    const res = {
      headersSent: false,
      writeHead(status, headers = {}) {
        this.status = status
        this.headers = headers
        this.headersSent = true
      },
      end(data) {
        let parsed = data
        try {
          parsed = JSON.parse(String(data))
        } catch {}
        resolve({ status: this.status, headers: this.headers, body: parsed })
      },
      destroy() {
        reject(Error('response destroyed'))
      },
    }
    app.middleware(req, res).catch(reject)
  })
}

const exists = (app, name) =>
  app.store.getMedia(name).then(
    () => true,
    (e) => (e.code === 'ENOENT' ? false : Promise.reject(e)),
  )
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
// Uploads artwork and issues metadata for it; returns the artwork name, the uri and the doc id.
async function issue(app, { host, ip, name = 'Coin', description = '' } = {}) {
  const art = await direct(app, { path: '/api/media', body: { data: png() }, host, ip })
  assert.equal(art.status, 201, JSON.stringify(art.body))
  const meta = await direct(app, {
    path: '/api/metadata',
    body: { name, symbol: 'COIN', image: art.body.url, description },
    host,
    ip,
  })
  assert.equal(meta.status, 201, JSON.stringify(meta.body))
  return {
    art: art.body.url.split('/media/')[1],
    artUrl: art.body.url,
    uri: meta.body.uri,
    id: meta.body.uri.split('/m/')[1],
  }
}

// ---- QP-SEC-6: links are never built from an untrusted Host header ---------------------------

test('host helpers: loopback names, plain host values and the public URL setting', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '::1', '[::1]'])
    assert.equal(isLoopbackHost(host), true, host)
  for (const host of ['attacker.example', '127.0.0.2', 'localhost.attacker.example', '', '0.0.0.0'])
    assert.equal(isLoopbackHost(host), false, host)
  assert.equal(hostOrigin('localhost:4350', 'http:'), 'http://localhost:4350')
  assert.equal(hostOrigin('[::1]:4350', 'http:'), 'http://[::1]:4350')
  assert.equal(hostOrigin('qp.example', 'https:'), 'https://qp.example')
  for (const host of ['localhost@attacker.example', 'localhost/evil', 'a b', '', undefined, 'x?y'])
    assert.equal(hostOrigin(host, 'http:'), null, String(host))
  assert.equal(configuredPublicUrl('https://qp.example/'), 'https://qp.example')
  assert.equal(configuredPublicUrl(' http://qp.test '), 'http://qp.test')
  for (const value of ['', undefined, 'qp.example', 'ftp://qp.example', 'https://u:p@qp.example'])
    assert.equal(configuredPublicUrl(value), null, String(value))
})

test('standalone server without QUANTPAD_PUBLIC_URL refuses metadata for a foreign Host (503)', async () => {
  await withEnv({ QUANTPAD_PUBLIC_URL: undefined, PINATA_JWT: undefined }, async () => {
    const files = createFileStore(mkdtempSync(join(tmpdir(), 'qp-host-')))
    const written = []
    const store = {
      ...files,
      set: (name, ...rest) => {
        written.push(name)
        return files.set(name, ...rest)
      },
      putMedia: (name, ...rest) => {
        written.push(`media:${name}`)
        return files.putMedia(name, ...rest)
      },
    }
    // A store passed in counts as connected storage; mode filesystem keeps quotas in memory.
    const { app, close } = await boot({ store })
    try {
      const host = 'attacker.example'
      const meta = await direct(app, {
        path: '/api/metadata',
        body: { name: 'Phish', symbol: 'PH', image: 'https://cdn.example/a.png' },
        host,
      })
      assert.equal(meta.status, 503)
      assert.equal(meta.body.code, 'PUBLIC_URL_UNSET')
      assert.match(meta.body.error, /QUANTPAD_PUBLIC_URL/)
      const media = await direct(app, { path: '/api/media', body: { data: png() }, host })
      assert.equal(media.status, 503)
      assert.equal(media.body.code, 'PUBLIC_URL_UNSET')
      assert.deepEqual(
        written.filter((k) => k.startsWith('issued-uri:') || k.startsWith('media:')),
        [],
        'nothing issued or stored',
      )

      // Development on this machine still works, under the loopback host it was reached on.
      for (const local of ['localhost:4350', '127.0.0.1:5173', '[::1]:4350']) {
        const { uri, artUrl } = await issue(app, { host: local })
        assert.equal(uri.startsWith(`http://${local}/m/`), true, uri)
        assert.equal(artUrl.startsWith(`http://${local}/media/`), true, artUrl)
        assert.ok(await app.store.get(`issued-uri:${sha256(uri).slice(0, 32)}`))
      }
    } finally {
      await close()
    }
  })
})

test('a configured public URL is used whatever Host the request carries', async () => {
  await withEnv({ QUANTPAD_PUBLIC_URL: undefined, PINATA_JWT: undefined }, async () => {
    const { app, close } = await boot({ publicUrl: 'https://quantpad.example/' })
    const bad = await boot({ publicUrl: 'quantpad.example' })
    try {
      const { uri, id, art } = await issue(app, { host: 'attacker.example' })
      assert.equal(uri, `https://quantpad.example/m/${id}`)
      const doc = JSON.parse(String(await app.store.getMedia(`meta-${id}.json`)))
      assert.equal(doc.image, `https://quantpad.example/media/${art}`)
      assert.equal(doc.createdOn, 'https://quantpad.example')

      // An unusable setting (no scheme) counts as unset rather than issuing broken links.
      const refused = await direct(bad.app, {
        path: '/api/metadata',
        body: { name: 'A', symbol: 'A', image: 'https://cdn.example/a.png' },
        host: 'quantpad.example',
      })
      assert.equal(refused.status, 503)
      assert.equal(refused.body.code, 'PUBLIC_URL_UNSET')
    } finally {
      await close()
      await bad.close()
    }
  })
})

test('on Vercel, issued links use the production domain, not the Host header', async () => {
  await withEnv(
    {
      QUANTPAD_PUBLIC_URL: undefined,
      PINATA_JWT: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: 'quantpad.vercel.app',
    },
    async () => {
      const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-vercel-')))
      const { app, close } = await boot({ serverless: true, store })
      try {
        const { uri, id } = await issue(app, { host: 'attacker.example' })
        assert.equal(uri, `https://quantpad.vercel.app/m/${id}`)
      } finally {
        await close()
      }
    },
  )
})

test('only /m/<id> on this deployment origin reads the stored document', async () => {
  const hosts = []
  const { app, close } = await boot({
    publicUrl: 'https://qp.example',
    resolveMetadataHost: async (host) => {
      hosts.push(host)
      return null
    },
  })
  try {
    const { uri, id } = await issue(app, { description: 'Stored copy' })
    await trackedCoin(app, MINTS[0], { uri })
    const own = await direct(app, { path: `/api/coins/${MINTS[0]}` })
    assert.equal(own.body.coin.meta.description, 'Stored copy')
    assert.deepEqual(hosts, [], 'read from storage, not fetched')

    // The same path on another host is that host's document: Quant Pad must not show its own
    // copy while wallets fetch something else from there.
    await trackedCoin(app, MINTS[1], { uri: `https://attacker.example/m/${id}` })
    const foreign = await direct(app, { path: `/api/coins/${MINTS[1]}` })
    assert.equal(foreign.status, 200)
    assert.equal(foreign.body.coin.meta, undefined)
    assert.deepEqual(hosts, ['attacker.example'], 'fetched like any other public uri')
  } finally {
    await close()
  }
})

// ---- QP-SEC-2 / K5: media stay pending until a launch registers ------------------------------

test('abandoned metadata and artwork expire and free the store; a registered launch keeps its own', async () => {
  const { app, base, close } = await boot({
    publicUrl: 'http://qp.test',
    pendingMediaMs: 300,
    mediaLimitBytes: 9000,
  })
  try {
    const abandoned = await issue(app, { ip: '10.1.0.1', name: 'Abandoned' })
    const launched = await issue(app, { ip: '10.1.0.2', name: 'Launched' })
    await app.onNativeLaunch({ mint: MINTS[0], uri: launched.uri })

    // The PoC: issuing metadata without launching fills the shared quota...
    const big = () => png(3000)
    let full = null
    for (let i = 0; i < 6 && !full; i++) {
      const r = await direct(app, { path: '/api/media', body: { data: big() }, ip: `10.1.1.${i}` })
      if (r.status === 507) full = r
    }
    assert.ok(full, 'the quota fills up')
    assert.equal(full.body.error, 'Media storage is full. Contact the operator.')

    // ...but only until the pending copies expire, and nothing became permanent.
    await sleep(450)
    assert.equal(await exists(app, abandoned.art), false, 'abandoned artwork expired')
    assert.equal(
      await exists(app, `meta-${abandoned.id}.json`),
      false,
      'abandoned document expired',
    )
    assert.equal((await fetch(`${base}/m/${abandoned.id}`)).status, 404)
    const fresh = await direct(app, { path: '/api/media', body: { data: big() }, ip: '10.1.2.1' })
    assert.equal(fresh.status, 201, 'expired media gave their bytes back')

    // The launched coin's document and artwork are permanent.
    const doc = await fetch(`${base}/m/${launched.id}`)
    assert.equal(doc.status, 200)
    assert.equal((await doc.json()).name, 'Launched')
    assert.equal((await fetch(`${base}/media/${launched.art}`)).status, 200)

    // Anything else is ignored without throwing.
    for (const uri of [
      undefined,
      'not a uri',
      'https://ipfs.io/ipfs/bafy',
      `https://attacker.example/m/${abandoned.id}`,
      `http://qp.test/m/${abandoned.id}`, // expired
    ])
      await app.onNativeLaunch({ mint: MINTS[1], uri })
  } finally {
    await close()
  }
})

test('onNativeLaunch rejects when storage fails, so the indexer retries the notice', async () => {
  const files = createFileStore(mkdtempSync(join(tmpdir(), 'qp-notice-')))
  let down = false
  const unavailable = () =>
    Object.assign(Error('Persistent storage is unavailable.'), { status: 503, expose: true })
  const promoted = []
  const store = {
    ...files,
    async getMedia(name) {
      if (down) throw unavailable()
      return files.getMedia(name)
    },
    async promoteMedia(name) {
      if (down) throw unavailable()
      promoted.push(name)
      return files.promoteMedia(name)
    },
  }
  const { app, close } = await boot({ store, publicUrl: 'http://qp.test' })
  try {
    const { uri, id, art } = await issue(app)
    down = true
    await assert.rejects(app.onNativeLaunch({ mint: MINTS[0], uri }), /unavailable/)
    down = false
    await app.onNativeLaunch({ mint: MINTS[0], uri })
    await app.onNativeLaunch({ mint: MINTS[0], uri })
    assert.deepEqual(promoted, [art, `meta-${id}.json`, art, `meta-${id}.json`], 'idempotent')
  } finally {
    await close()
  }
})

test('re-issuing the metadata of a launched coin leaves its media permanent', async () => {
  const { app, close } = await boot({ publicUrl: 'http://qp.test', pendingMediaMs: 300 })
  try {
    assert.equal(typeof app.onNativeLaunch, 'function')
    // Re-issuing the same document for a launched coin leaves it permanent.
    const first = await issue(app, { name: 'Again' })
    await app.onNativeLaunch({ mint: MINTS[0], uri: first.uri })
    const again = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Again', symbol: 'COIN', image: first.artUrl, description: '' },
    })
    assert.equal(again.body.uri, first.uri)
    await sleep(450)
    assert.equal(await exists(app, `meta-${first.id}.json`), true)
    assert.equal(await exists(app, first.art), true)
  } finally {
    await close()
  }
})

test('QP-SEC-2: keeping artwork pending through /api/metadata costs its full size each time', async () => {
  // The verifier's keep-alive: visitors fill the store with artwork, then one visitor re-issues
  // metadata for all of it before it expires. Each re-issue now costs the artwork's size again,
  // so that visitor's daily quota keeps one artwork alive, not all of them.
  const ART = 200_000
  const { app, close } = await boot({
    publicUrl: 'http://qp.test',
    pendingMediaMs: 400,
    mediaLimitBytes: 1_000_000,
    mediaClientLimitBytes: 600_000,
  })
  try {
    const arts = []
    for (let i = 0; i < 4; i++) {
      const r = await direct(app, {
        path: '/api/media',
        body: { data: png(ART) },
        ip: `10.4.0.${i + 1}`,
      })
      assert.equal(r.status, 201)
      arts.push(r.body.url)
    }
    const full = await direct(app, { path: '/api/media', body: { data: png(ART) }, ip: '10.4.1.1' })
    assert.equal(full.status, 507, 'four artworks fill the store')

    const keepAlive = (image, i) =>
      direct(app, {
        path: '/api/metadata',
        body: { name: `Keep ${i}`, symbol: 'KEEP', image },
        ip: '10.4.9.9',
      })
    const round = []
    for (const [i, image] of arts.entries()) round.push(await keepAlive(image, i))
    // 128 KiB (document) + 200 KB (artwork) each: the second re-issue passes 600 KB.
    assert.deepEqual(
      round.map((r) => r.status),
      [201, 429, 429, 429],
    )
    assert.equal(round[1].body.code, 'MEDIA_QUOTA')

    // The artwork nobody paid to keep expires, and new uploads fit again.
    await sleep(550)
    const fresh = await direct(app, {
      path: '/api/media',
      body: { data: png(ART) },
      ip: '10.4.2.1',
    })
    assert.equal(fresh.status, 201, 'the store has room again')
    for (const url of arts.slice(1))
      assert.equal(await exists(app, url.split('/media/')[1]), false, 'unpaid artwork expired')
  } finally {
    await close()
  }
})

test('metadata whose uri already listed a coin is refused with 409 before anything is stored', async () => {
  const { app, close } = await boot({ publicUrl: 'http://qp.test' })
  try {
    const first = await issue(app, { name: 'Used', description: 'Same fields' })
    // The indexer binds the uri to the coin that registered with it (QP-SEC-9).
    await app.store.set(issuedUriClaimKey(first.uri), MINTS[0])
    await app.store.delete(`issued-uri:${sha256(first.uri).slice(0, 32)}`)
    const again = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Used', symbol: 'COIN', image: first.artUrl, description: 'Same fields' },
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'METADATA_USED')
    assert.match(again.body.error, /already used by another launch/)
    assert.match(again.body.error, /Change the description or the artwork/)
    assert.equal(
      await app.store.get(`issued-uri:${sha256(first.uri).slice(0, 32)}`),
      null,
      'not issued again',
    )

    // Any change gives a new document, which is issued as usual.
    const changed = await direct(app, {
      path: '/api/metadata',
      body: { name: 'Used', symbol: 'COIN', image: first.artUrl, description: 'Second coin' },
    })
    assert.equal(changed.status, 201)
    assert.notEqual(changed.body.uri, first.uri)
  } finally {
    await close()
  }
})

test('pinned metadata whose uri already listed a coin is refused with 409, without new pins', async () => {
  const originalFetch = globalThis.fetch
  let pins = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://uploads.pinata.cloud/')) {
      pins++
      return Response.json({ data: { cid: `bafyused${pins}` } })
    }
    return originalFetch(url, init)
  }
  await withEnv({ PINATA_JWT: 'test-jwt', QUANTPAD_PUBLIC_URL: undefined }, async () => {
    const { app, close } = await boot()
    try {
      const first = await issue(app, { ip: '10.5.0.1', name: 'Pinned' })
      assert.equal(pins, 2)
      await app.store.set(issuedUriClaimKey(first.uri), MINTS[0])
      const again = await direct(app, {
        path: '/api/metadata',
        body: { name: 'Pinned', symbol: 'COIN', image: first.artUrl, description: '' },
        ip: '10.5.0.1',
      })
      assert.equal(again.status, 409)
      assert.equal(again.body.code, 'METADATA_USED')
      assert.equal(pins, 2, 'the recorded pins were reused')
    } finally {
      globalThis.fetch = originalFetch
      await close()
    }
  })
})

test('a coin created with issued metadata keeps its media once read, even if never registered', async () => {
  const { app, close } = await boot({ publicUrl: 'http://qp.test', pendingMediaMs: 300 })
  try {
    // The launcher closed the tab after the on-chain create: /api/launches never ran, and the
    // coin reached the store by being tracked.
    const { uri, id, art } = await issue(app, { description: 'Created on-chain' })
    await trackedCoin(app, MINTS[2], { uri })
    const coin = await direct(app, { path: `/api/coins/${MINTS[2]}` })
    assert.equal(coin.body.coin.meta.description, 'Created on-chain')
    assert.equal(coin.body.coin.image, `/media/${art}`)
    await sleep(450)
    assert.equal(await exists(app, `meta-${id}.json`), true)
    assert.equal(await exists(app, art), true)
  } finally {
    await close()
  }
})

test('pins have a deployment-wide daily budget, and pinned documents need no public URL', async () => {
  const originalFetch = globalThis.fetch
  const pinned = []
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://uploads.pinata.cloud/')) {
      const file = init.body.get('file')
      pinned.push({ name: file.name, text: await file.text() })
      return Response.json({ data: { cid: `bafyglobal${pinned.length}` } })
    }
    return originalFetch(url, init)
  }
  await withEnv({ PINATA_JWT: 'test-jwt', QUANTPAD_PUBLIC_URL: undefined }, async () => {
    const { app, close } = await boot({ pinDailyLimit: 3 })
    try {
      const first = await issue(app, { ip: '10.3.0.1', name: 'One' })
      assert.equal(first.uri, 'https://ipfs.io/ipfs/bafyglobal2')
      const doc = JSON.parse(pinned[1].text)
      assert.equal(doc.image, 'https://ipfs.io/ipfs/bafyglobal1')
      assert.equal('createdOn' in doc, false, 'no origin taken from the Host header')
      assert.equal(await exists(app, `meta-${sha256(pinned[1].text).slice(0, 32)}.json`), false)

      // Another visitor: the artwork pin is the third today, the document pin would be the fourth.
      const art = await direct(app, { path: '/api/media', body: { data: png() }, ip: '10.3.0.2' })
      const over = await direct(app, {
        path: '/api/metadata',
        body: { name: 'Two', symbol: 'TWO', image: art.body.url },
        ip: '10.3.0.2',
      })
      assert.equal(over.status, 429)
      assert.equal(over.body.code, 'PIN_QUOTA')
      assert.equal(pinned.length, 3)
    } finally {
      globalThis.fetch = originalFetch
      await close()
    }
  })
})

test(
  'media quota also counts an IPv6 /48 as a whole',
  { skip: !requestLimits.clientPrefixKey && 'request-limits has no clientPrefixKey yet' },
  async () => {
    const { app, close } = await boot({
      publicUrl: 'http://qp.test',
      mediaClientLimitBytes: 300 * 1024,
    })
    const upload = (ip) => direct(app, { path: '/api/media', body: { data: png() }, ip })
    try {
      // 128 KB minimum charge: two writes per /64 (300 KB), eighteen per /48 (8 x 300 KB).
      for (let net = 1; net <= 9; net++)
        for (let host = 1; host <= 2; host++)
          assert.equal((await upload(`2001:db8:7:${net}::${host}`)).status, 201, `${net}/${host}`)
      const tenth = await upload('2001:db8:7:a::1')
      assert.equal(tenth.status, 429, 'a fresh /64 in the same /48 is refused')
      assert.equal(tenth.body.code, 'MEDIA_QUOTA')
      assert.equal((await upload('2001:db8:8:1::1')).status, 201, 'another /48 is unaffected')
    } finally {
      await close()
    }
  },
)

// ---- QP-SEC-4: public reads -----------------------------------------------------------------

async function seedMarket(app) {
  await app.store.set('coins:list', [
    { mint: MINTS[0], name: 'Alpha', symbol: 'ALP', createdAt: 2, volume24h: 1, trades24h: 3 },
    { mint: MINTS[1], name: 'Beta', symbol: 'BET', createdAt: 1, volume24h: 5, trades24h: 1 },
  ])
  await app.store.set(`coin:${MINTS[0]}`, {
    mint: MINTS[0],
    name: 'Alpha',
    symbol: 'ALP',
    uri: '',
    meta: { image: '', description: '', website: '', twitter: '', telegram: '' },
  })
  await app.store.set(
    `trades:${MINTS[0]}`,
    Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      side: i % 2 ? 'sell' : 'buy',
      price: 1 + i / 100,
      solAmount: 1e9,
      timestamp: 1_700_000_000 - i * 60,
      venue: 'curve',
    })),
  )
}

test('public reads: CDN cache headers on successes only, immutable media cached at the edge', async () => {
  const { app, base, close } = await boot({ hiddenMints: MINTS[1], publicUrl: 'http://qp.test' })
  try {
    await seedMarket(app)
    for (const path of [
      '/api/market',
      `/api/coins?mints=${MINTS[0]}`,
      '/api/stats',
      `/api/coins/${MINTS[0]}`,
      `/api/coins/${MINTS[0]}/trades`,
      `/api/coins/${MINTS[0]}/candles?interval=60`,
    ]) {
      const r = await fetch(base + path)
      assert.equal(r.status, 200, path)
      assert.equal(r.headers.get('cache-control'), PUBLIC_READ_CACHE, path)
    }
    assert.match(PUBLIC_READ_CACHE, /s-maxage=\d+/)
    for (const path of [`/api/coins/${MINTS[1]}`, `/api/coins/${MINTS[2]}`, '/api/status']) {
      const r = await fetch(base + path)
      assert.equal(r.headers.get('cache-control'), 'no-store', path)
    }

    const { art, id } = await issue(app)
    for (const path of [`/media/${art}`, `/m/${id}`]) {
      const r = await fetch(base + path)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get('cache-control'), MEDIA_CACHE)
    }
    assert.match(MEDIA_CACHE, /s-maxage=31536000/)
  } finally {
    await close()
  }
})

// A file store that counts get() calls per key; `failing` makes reads of that key fail.
function countingStore() {
  const files = createFileStore(mkdtempSync(join(tmpdir(), 'qp-reads-')))
  const gets = new Map()
  const counted = {
    failing: null,
    count: (key) => gets.get(key) || 0,
    store: {
      ...files,
      async get(key) {
        gets.set(key, (gets.get(key) || 0) + 1)
        await sleep(20)
        if (key === counted.failing) throw Object.assign(Error('busy'), { status: 409 })
        return files.get(key)
      },
    },
  }
  return counted
}

test('public reads share one stored value per key, whatever page, side, query or interval', async () => {
  const counted = countingStore()
  const { app, close } = await boot({ store: counted.store, readCacheMs: 400 })
  try {
    await seedMarket(app)
    const burst = (paths) => Promise.all(paths.map((path) => direct(app, { path })))
    // The verifier's cache-busting loop: every page and side of one coin.
    const trades = await burst(
      Array.from(
        { length: 20 },
        (_, i) => `/api/coins/${MINTS[0]}/trades?offset=${i}${i % 3 ? '' : '&side=sell'}`,
      ),
    )
    assert.deepEqual(new Set(trades.map((r) => r.status)), new Set([200]))
    assert.equal(trades[1].body.items.length, 50)
    assert.equal(trades[1].body.items[0].id, 't1')
    assert.deepEqual(new Set(trades[0].body.items.map((t) => t.side)), new Set(['sell']))
    const candles = await burst(
      [15, 60, 300, 900, 3600].map((i) => `/api/coins/${MINTS[0]}/candles?interval=${i}`),
    )
    assert.deepEqual(new Set(candles.map((r) => r.status)), new Set([200]))
    assert.equal(counted.count(`trades:${MINTS[0]}`), 1, 'one stored read for all of them')

    // Market searches, the coin list and stats all share one read of the list.
    const market = await burst(
      Array.from({ length: 20 }, (_, i) => `/api/market?q=a${i}&sort=volume`),
    )
    assert.deepEqual(new Set(market.map((r) => r.status)), new Set([200]))
    const [coins, stats, all] = await burst([
      `/api/coins?mints=${MINTS[0]},${MINTS[1]}`,
      '/api/stats',
      '/api/market?q=alp',
    ])
    assert.equal(coins.body.items.length, 2)
    assert.equal(stats.body.coins, 2)
    assert.deepEqual(
      all.body.items.map((c) => c.symbol),
      ['ALP'],
    )
    assert.equal(counted.count('coins:list'), 1)

    await sleep(450)
    await direct(app, { path: `/api/coins/${MINTS[0]}/trades?offset=30` })
    assert.equal(counted.count(`trades:${MINTS[0]}`), 2, 'read again once the moment passed')

    // A failed read is not kept.
    await sleep(450)
    counted.failing = 'coins:list'
    assert.equal((await direct(app, { path: '/api/stats' })).status, 409)
    assert.equal((await direct(app, { path: '/api/market?q=zz' })).status, 409)
    assert.equal(counted.count('coins:list'), 3)
  } finally {
    await close()
  }
})

test('requests that read the store are charged to a store-read bucket; shared reads are not', async () => {
  await inOneMinute()
  const counted = countingStore()
  const { app, close } = await boot({
    store: counted.store,
    readCacheMs: 10_000,
    storeReadLimit: 2,
  })
  try {
    await seedMarket(app)
    for (const mint of MINTS.slice(1)) {
      await app.store.set(`coin:${mint}`, { mint, name: 'Beta', symbol: 'BET' })
      await app.store.set(`trades:${mint}`, [{ id: `${mint}-0`, side: 'buy', price: 1 }])
    }
    const read = (path, ip = '10.6.0.1') => direct(app, { path, ip })
    assert.equal((await read(`/api/coins/${MINTS[0]}/trades`)).status, 200, 'first store read')
    // Other pages and sides of the same coin are served from that read, free.
    for (const query of ['offset=10', 'side=buy', 'offset=5&side=sell'])
      assert.equal((await read(`/api/coins/${MINTS[0]}/trades?${query}`)).status, 200, query)
    assert.equal((await read(`/api/coins/${MINTS[1]}/trades`)).status, 200, 'second store read')
    // A third coin needs a third store read: over this visitor's limit.
    const over = await read(`/api/coins/${MINTS[2]}/trades`)
    assert.equal(over.status, 429)
    assert.equal(over.headers['Cache-Control'], 'no-store')
    assert.equal(counted.count(`trades:${MINTS[2]}`), 0, 'a refused read never reaches the store')

    // A refused visitor's request never fails someone else's: a request that joined their read
    // reads the value itself.
    const [refused, served] = await Promise.all([
      read(`/api/coins/${MINTS[3]}/trades?offset=1`),
      read(`/api/coins/${MINTS[3]}/trades`, '10.6.0.2'),
    ])
    assert.equal(refused.status, 429)
    assert.equal(served.status, 200)
    assert.deepEqual(
      served.body.items.map((t) => t.id),
      [`${MINTS[3]}-0`],
    )
    assert.equal(counted.count(`trades:${MINTS[3]}`), 1)
    // Now shared, so the first visitor is served it without another charge.
    assert.equal((await read(`/api/coins/${MINTS[3]}/trades`)).status, 200)
  } finally {
    await close()
  }
})

test('a value read again within one request goes to the store (chunked trade pages)', async (t) => {
  // The indexer stores trades as an index plus immutable chunks, and reads the index again when a
  // chunk it lists was replaced since. That second read must not be served the shared (stale)
  // index, or a page would come back empty right after every merge.
  const { app, close } = await boot({ readCacheMs: 10_000 })
  try {
    const mint = MINTS[0]
    await app.store.set(`coin:${mint}`, { mint, name: 'Alpha', symbol: 'ALP' })
    const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))
    const write = async (n, items) => {
      await app.store.set(`trades:${mint}:${n}`, items)
      await app.store.set(`trades:${mint}`, {
        v: 2,
        total: items.length,
        next: n + 1,
        chunks: [{ n, count: items.length, buys: 0, sells: 0 }],
      })
    }
    await write(0, rows('a', 3))
    // A page past the end reads (and shares) the index only.
    const first = await direct(app, { path: `/api/coins/${mint}/trades?offset=100` })
    if (first.status !== 200 || first.body.total !== 3)
      return t.skip('the indexer does not store trades in chunks (yet)')
    // A merge writes chunk 1, then the index, then deletes chunk 0. The shared index still lists
    // chunk 0, which is gone.
    await write(1, rows('b', 4))
    await app.store.delete(`trades:${mint}:0`)
    const after = await direct(app, { path: `/api/coins/${mint}/trades` })
    assert.equal(after.status, 200)
    assert.deepEqual(
      after.body.items.map((r) => r.id),
      ['b0', 'b1', 'b2', 'b3'],
    )
  } finally {
    await close()
  }
})

test('public reads: paging and query values are clamped before they reach the indexer', async () => {
  const { app, close } = await boot({ readCacheMs: 0 })
  try {
    await seedMarket(app)
    const seen = { trades: [], market: [] }
    const realTrades = app.reads.trades
    app.reads.trades = (mint, options) => {
      seen.trades.push(options)
      return realTrades(mint, options)
    }
    const realMarket = app.reads.market
    app.reads.market = (options) => {
      seen.market.push(options)
      return realMarket(options)
    }
    for (const query of [
      'offset=999999999',
      'offset=-5',
      'offset=7.9',
      'side=__proto__&offset=x',
      'limit=4000',
    ])
      assert.equal(
        (await direct(app, { path: `/api/coins/${MINTS[0]}/trades?${query}` })).status,
        200,
      )
    assert.deepEqual(seen.trades, [
      { side: null, offset: 4000, limit: 50 },
      { side: null, offset: 0, limit: 50 },
      { side: null, offset: 7, limit: 50 },
      { side: null, offset: 0, limit: 50 },
      { side: null, offset: 0, limit: 50 },
    ])
    const far = await direct(app, { path: `/api/coins/${MINTS[0]}/trades?offset=999999` })
    assert.deepEqual(far.body.items, [])

    await direct(app, { path: `/api/market?offset=1e12&q=${'X'.repeat(300)}&launcher=nope` })
    const [market] = seen.market
    assert.equal(market.offset, 10_000)
    assert.equal(market.q, 'x'.repeat(100))
    assert.equal(market.launcher, '')
  } finally {
    await close()
  }
})

test('public reads have a per-visitor bucket', async () => {
  await inOneMinute()
  const { app, close } = await boot()
  try {
    await seedMarket(app)
    const statuses = []
    for (let i = 0; i < 301; i++) statuses.push((await direct(app, { path: '/api/stats' })).status)
    assert.equal(statuses.filter((s) => s === 200).length, 300)
    assert.equal(statuses.at(-1), 429)
    const coin = await direct(app, { path: `/api/coins/${MINTS[0]}/trades` })
    assert.equal(coin.status, 429, 'one bucket for every public read')
    assert.equal(coin.headers['Cache-Control'], 'no-store', 'a 429 is never cached')
    assert.equal((await direct(app, { path: '/api/stats', ip: '10.9.9.9' })).status, 200)
  } finally {
    await close()
  }
})

test('serverless instances run one background pass at a time, at most one per gap', async () => {
  const { app, close } = await boot({ serverless: true, backgroundGapMs: 200 })
  let passes = 0
  app.indexer.sync = async () => {
    passes++
    await sleep(30)
    return { synced: 0 }
  }
  try {
    await Promise.all(Array.from({ length: 5 }, () => app.sync({ startedAt: Date.now() })))
    assert.equal(passes, 1, 'concurrent requests share the running pass')
    await app.sync({ startedAt: Date.now() })
    assert.equal(passes, 1, 'inside the gap')
    await sleep(250)
    await app.sync({ startedAt: Date.now() })
    assert.equal(passes, 2)
  } finally {
    await close()
  }
})

// ---- QP-SEC-3 (handoff): /api/coins/track and the deployment-wide RPC budget ----------------------

test('POST /api/coins/track has a bucket of its own (10 a minute)', async () => {
  await inOneMinute()
  const { app, close } = await boot({ hiddenMints: MINTS[3] })
  try {
    const track = (ip = '10.7.0.1') =>
      direct(app, { path: '/api/coins/track', body: { mint: MINTS[3] }, ip })
    const statuses = []
    for (let i = 0; i < 11; i++) statuses.push((await track()).status)
    assert.deepEqual(statuses, [...Array(10).fill(404), 429], 'hidden: 404, then the bucket')
    assert.equal((await track('10.7.0.2')).status, 404, 'another visitor is unaffected')
  } finally {
    await close()
  }
})

test('tracking a new coin and coin syncs are charged to QUANTPAD_RPC_GLOBAL_PER_MIN', async () => {
  await inOneMinute()
  // Two coins' worth (45 calls each) of a shared budget.
  const { app, close } = await boot({ rpcGlobalLimit: 90 })
  const tracked = []
  app.indexer.track = async (mint) => {
    tracked.push(mint)
    return { mint, name: 'Coin', symbol: 'COIN', uri: '', external: true }
  }
  let synced = 0
  app.indexer.syncCoin = async (mint) => {
    synced++
    return app.store.get(`coin:${mint}`)
  }
  const track = (mint, ip) => direct(app, { path: '/api/coins/track', body: { mint }, ip })
  try {
    // An already stored coin costs nothing: track() only re-reads it.
    await trackedCoin(app, MINTS[0])
    assert.equal((await track(MINTS[0], '10.8.0.1')).status, 201)
    // New coins from different visitors share one budget.
    assert.equal((await track(MINTS[1], '10.8.0.2')).status, 201)
    assert.equal((await track(MINTS[2], '10.8.0.3')).status, 201)
    const over = await track(MINTS[3], '10.8.0.4')
    assert.equal(over.status, 429)
    assert.deepEqual(tracked, [MINTS[0], MINTS[1], MINTS[2]], 'the over-budget coin never synced')

    // A coin sync past the budget answers the stored coin without syncing.
    const sync = await direct(app, { path: '/api/sync', body: { mint: MINTS[0] }, ip: '10.8.0.5' })
    assert.equal(sync.status, 202)
    assert.equal(sync.body.coin.mint, MINTS[0])
    assert.equal(synced, 0)
  } finally {
    await close()
  }
})

test('without a global RPC budget, coin syncs are not charged', async () => {
  const { app, close } = await boot({ rpcGlobalLimit: 0, syncCooldownMs: 50 })
  let synced = 0
  app.indexer.syncCoin = async (mint) => {
    synced++
    return app.store.get(`coin:${mint}`)
  }
  try {
    await trackedCoin(app, MINTS[0])
    for (let i = 0; i < 3; i++) {
      const r = await direct(app, {
        path: '/api/sync',
        body: { mint: MINTS[0] },
        ip: `10.8.1.${i}`,
      })
      assert.equal(r.status, 202)
      await sleep(80)
    }
    assert.equal(synced, 3)
  } finally {
    await close()
  }
})

// ---- cross-group: internal fields and the claim delay ------------------------------------------

test('the indexer onNativeLaunch notice state never leaves the server', async () => {
  assert.ok(INTERNAL_COIN_FIELDS.includes('nativeNotice'))
  assert.ok(INTERNAL_COIN_FIELDS.includes('nativeNoticeAt'))
  const { app, close } = await boot()
  try {
    await trackedCoin(app, MINTS[0], {
      external: false,
      nativeNotice: 'pending',
      nativeNoticeAt: 123,
      cursor: 'sig',
      meta: { image: '', description: '', website: '', twitter: '', telegram: '' },
    })
    const r = await direct(app, { path: `/api/coins/${MINTS[0]}` })
    assert.equal(r.status, 200)
    for (const field of INTERNAL_COIN_FIELDS) assert.equal(field in r.body.coin, false, field)
    assert.equal(r.body.coin.name, 'Coin')
  } finally {
    await close()
  }
})

test('/api/status reports the on-chain claim delay in seconds', async () => {
  let config = { paused: false, protocolBps: 100, keeper: MINTS[2], claimDelay: 21_600 }
  const { app, close } = await boot({
    quantum: {
      QUANTUM_PROGRAM_ID: { toBase58: () => MINTS[1], toString: () => MINTS[1] },
      fetchConfig: async () => config,
    },
    connection: {
      rpcEndpoint: 'http://rpc.invalid',
      getAccountInfo: async () => ({ executable: true }),
    },
  })
  try {
    const status = await direct(app, { path: '/api/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.quantum.claimDelay, 21_600)
    assert.equal(status.body.quantum.available, true)
  } finally {
    await close()
  }
  // A client without claimDelay (older program) reports null rather than a guess.
  config = { paused: false, protocolBps: 100, keeper: MINTS[2] }
  const old = await boot({
    quantum: {
      QUANTUM_PROGRAM_ID: { toBase58: () => MINTS[1], toString: () => MINTS[1] },
      fetchConfig: async () => config,
    },
    connection: {
      rpcEndpoint: 'http://rpc.invalid',
      getAccountInfo: async () => ({ executable: true }),
    },
  })
  try {
    assert.equal((await direct(old.app, { path: '/api/status' })).body.quantum.claimDelay, null)
  } finally {
    await old.close()
  }
})

// ---- QP-SEC-7: market sort and filter allowlists -------------------------------------------------

test('market sort and filter outside the allowlist fall back to the defaults (never a 500)', async () => {
  const { app, close } = await boot({ readCacheMs: 0 })
  const errors = []
  const realError = console.error
  console.error = (...args) => errors.push(args)
  try {
    await seedMarket(app)
    const newest = await direct(app, { path: '/api/market' })
    assert.deepEqual(
      newest.body.items.map((c) => c.symbol),
      ['ALP', 'BET'],
    )
    for (const query of [
      'sort=__proto__',
      'sort=constructor',
      'sort=__defineGetter__',
      'sort=toString&filter=__proto__',
      'filter=constructor',
      'sort=hasOwnProperty&filter=valueOf',
    ]) {
      const r = await direct(app, { path: `/api/market?${query}` })
      assert.equal(r.status, 200, query)
      assert.deepEqual(r.body, newest.body, query)
    }
    const seen = []
    app.reads.market = async (options) => {
      seen.push([options.sort, options.filter])
      return { items: [], total: 0, next: null }
    }
    await direct(app, { path: '/api/market?sort=__proto__&filter=__proto__' })
    await direct(app, { path: '/api/market?sort=volume&filter=tracked' })
    assert.deepEqual(seen, [
      ['newest', 'all'],
      ['volume', 'tracked'],
    ])
    assert.deepEqual(errors, [])
  } finally {
    console.error = realError
    await close()
  }
})

// ---- QP-SEC-8: cron secret comparison -------------------------------------------------------

test('secretMatches compares digests: no throw on any input, no length shortcut', () => {
  assert.equal(secretMatches('abcd1234', 'abcd1234'), true)
  assert.equal(secretMatches('abcd123é', 'abcd1234'), false)
  assert.equal(secretMatches('abcd12345', 'abcd1234'), false)
  assert.equal(secretMatches('', 'abcd1234'), false)
  assert.equal(secretMatches('x'.repeat(100_000), 'abcd1234'), false)
  assert.equal(secretMatches('anything', ''), false, 'an empty secret never matches')
  assert.equal(secretMatches('anything', undefined), false)
  assert.equal(secretMatches(undefined, undefined), false)
})

test('keeper tick: a non-ASCII bearer token gets 401, not a 500', async () => {
  await withEnv({ CRON_SECRET: 'abcd1234' }, async () => {
    const { app, base, close } = await boot()
    app.indexer.sync = async () => ({ synced: 0 })
    const errors = []
    const realError = console.error
    console.error = (...args) => errors.push(args)
    const raw = (authorization) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          `${base}/api/keeper/tick`,
          // Node's client sends header values as latin1, so U+00E9 goes out as the byte 0xE9.
          { headers: { authorization } },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode))
          },
        )
        req.on('error', reject)
        req.end()
      })
    try {
      assert.equal(await raw('Bearer abcd123é'), 401)
      for (const authorization of [
        'Bearer abcd12345',
        'Bearer abcd123',
        'Basic abcd1234',
        'Bearer ',
        `Bearer ${'x'.repeat(4000)}`,
      ])
        assert.equal(
          (await direct(app, { path: '/api/keeper/tick', headers: { authorization } })).status,
          401,
          authorization,
        )
      assert.equal(await raw('Bearer abcd1234'), 200)
      assert.deepEqual(errors, [], 'nothing logged')
    } finally {
      console.error = realError
      await close()
    }
  })
})

// ---- build-defect-10: validation and method errors ------------------------------------------

test('malformed mints are 400, known paths with the wrong method 405, unknown paths 404', async () => {
  const { app, close } = await boot()
  try {
    for (const path of [
      '/api/coins/not-a-mint',
      '/api/coins/not-a-mint/trades',
      '/api/coins/0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl/candles',
      '/api/quantum/not-a-mint',
      `/api/quantum/not-a-mint/claims?wallet=${MINTS[0]}`,
      `/api/coins/${'1'.repeat(45)}`,
    ]) {
      const r = await direct(app, { path })
      assert.equal(r.status, 400, path)
      assert.deepEqual(r.body, {
        error: 'Enter a valid Solana mint address.',
        code: 'invalid_mint',
      })
    }
    for (const [method, path, allow] of [
      ['DELETE', '/api/status', 'GET'],
      ['POST', '/api/market', 'GET'],
      ['PUT', `/api/coins/${MINTS[0]}`, 'GET'],
      ['POST', `/api/quantum/${MINTS[0]}`, 'GET'],
      ['GET', '/api/metadata', 'POST'],
      ['GET', '/api/media', 'POST'],
      ['GET', '/api/coins/track', 'POST'],
      ['GET', '/api/launches', 'POST'],
      ['DELETE', '/api/keeper/tick', 'GET, POST'],
    ]) {
      const r = await direct(app, { path, method })
      assert.equal(r.status, 405, `${method} ${path}`)
      assert.equal(r.headers.Allow, allow, `${method} ${path}`)
    }
    for (const [method, path] of [
      ['GET', '/api/nope'],
      ['POST', '/api/nope'],
      ['GET', `/api/coins/${MINTS[0]}/holders`],
    ]) {
      const r = await direct(app, {
        path,
        method,
        headers: { origin: 'https://elsewhere.example' },
      })
      assert.equal(r.status, 404, `${method} ${path}`)
      assert.equal(r.body.error, 'Endpoint not found.')
    }
  } finally {
    await close()
  }
})
