import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication, platformSettings } from '../../server/application.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

async function boot(options = {}) {
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-app-')),
    store: null,
    quantum: null,
    background: false,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
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
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
          }),
    })
  return { app, base, call, close: () => new Promise((r) => server.close(r)) }
}

test('status reports platform, quantum and storage configuration', async () => {
  const { call, close } = await boot({ platform: { treasury: null, feeBps: 0 } })
  try {
    const status = await (await call('/api/status')).json()
    assert.equal(status.brand.name, 'Quant Pad')
    assert.equal(status.rpc, '/api/rpc')
    assert.equal(status.solUsd, 150)
    assert.deepEqual(status.platform, { treasury: null, feeBps: 0 })
    assert.equal(status.quantum.available, false)
    assert.equal(status.storage.ready, true)
  } finally {
    await close()
  }
})

test('platform fee only applies with a valid treasury and is capped', () => {
  assert.deepEqual(platformSettings({ QUANTPAD_FEE_BPS: '100' }), { treasury: null, feeBps: 0 })
  const treasury = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
  assert.deepEqual(platformSettings({ QUANTPAD_TREASURY: treasury }), { treasury, feeBps: 50 })
  assert.deepEqual(platformSettings({ QUANTPAD_TREASURY: treasury, QUANTPAD_FEE_BPS: '5000' }), {
    treasury,
    feeBps: 200,
  })
})

test('artwork upload, short metadata URI and media serving', async () => {
  const { call, base, close } = await boot()
  try {
    const upload = await call('/api/media', {
      data: 'data:image/png;base64,' + PNG.toString('base64'),
    })
    assert.equal(upload.status, 201)
    const { url } = await upload.json()
    assert.match(url, /\/media\/[a-f0-9]{64}\.png$/)
    const image = await fetch(url)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)

    const bad = await call('/api/media', {
      data: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64'),
    })
    assert.equal(bad.status, 400)

    const meta = await call('/api/metadata', {
      name: 'Quantum Cats',
      symbol: 'QCAT',
      description: 'Entangled felines',
      image: url,
      twitter: 'https://x.com/quantumcats',
    })
    assert.equal(meta.status, 201)
    const { uri } = await meta.json()
    assert.equal(uri, `${base}/m/${uri.split('/').at(-1)}`)
    assert.match(uri, /\/m\/[a-f0-9]{32}$/)
    assert.ok(uri.length <= 200)
    const doc = await (await fetch(uri)).json()
    assert.deepEqual(
      {
        name: doc.name,
        symbol: doc.symbol,
        image: doc.image,
        showName: doc.showName,
        twitter: doc.twitter,
      },
      {
        name: 'Quantum Cats',
        symbol: 'QCAT',
        image: url,
        showName: true,
        twitter: 'https://x.com/quantumcats',
      },
    )
    assert.equal('website' in doc, false, 'empty links are omitted')

    const long = await call('/api/metadata', { name: 'x'.repeat(33), symbol: 'X', image: url })
    assert.equal(long.status, 400)
    const noArt = await call('/api/metadata', { name: 'A', symbol: 'A' })
    assert.match((await noArt.json()).error, /artwork/)
  } finally {
    await close()
  }
})

test('writes require same-origin requests', async () => {
  const { call, close } = await boot()
  try {
    const response = await call('/api/sync', {}, { Origin: 'https://evil.test' })
    assert.equal(response.status, 403)
  } finally {
    await close()
  }
})

test('market, coin lookups, hidden mints and unknown coins', async () => {
  const hiddenMint = 'So11111111111111111111111111111111111111112'
  const { app, call, close } = await boot({ hiddenMints: hiddenMint })
  try {
    await app.store.set('coins:list', [
      { mint: hiddenMint, name: 'Hidden', symbol: 'HID', createdAt: 2 },
      {
        mint: 'SysvarRent111111111111111111111111111111111',
        name: 'Visible',
        symbol: 'VIS',
        createdAt: 1,
      },
    ])
    const market = await (await call('/api/market')).json()
    assert.deepEqual(
      market.items.map((c) => c.symbol),
      ['VIS'],
    )
    const hidden = await call(`/api/coins/${hiddenMint}`)
    assert.equal(hidden.status, 404)
    assert.equal((await hidden.json()).code, 'HIDDEN')
    const unknown = await call('/api/coins/Unknown11111111111111111111111111111111111')
    assert.equal((await unknown.json()).code, 'NOT_TRACKED')
    const batch = await (
      await call(`/api/coins?mints=${hiddenMint},SysvarRent111111111111111111111111111111111`)
    ).json()
    assert.deepEqual(
      batch.items.map((c) => c.symbol),
      ['VIS'],
    )
    const stats = await (await call('/api/stats')).json()
    assert.equal(stats.coins, 1)
  } finally {
    await close()
  }
})

test('keeper tick requires the cron secret', async () => {
  process.env.CRON_SECRET = 'cron-test-secret'
  const { base, close } = await boot()
  try {
    assert.equal((await fetch(base + '/api/keeper/tick')).status, 401)
    const ok = await fetch(base + '/api/keeper/tick', {
      headers: { Authorization: 'Bearer cron-test-secret' },
    })
    assert.equal(ok.status, 200)
    assert.deepEqual((await ok.json()).keeper, { enabled: false })
  } finally {
    delete process.env.CRON_SECRET
    await close()
  }
})

test('metadata fetching refuses private and local hosts', async () => {
  const { isPublicHost } = await import('../../server/application.mjs')
  for (const host of [
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.5',
    '172.20.0.1',
    '169.254.169.254',
    'metadata.internal',
    '[::1]',
    'fd00::1',
    'intranet',
  ])
    assert.equal(isPublicHost(host), false, host)
  for (const host of ['ipfs.io', 'gateway.pinata.cloud', '8.8.8.8', 'metadata.j7tracker.io'])
    assert.equal(isPublicHost(host), true, host)
})
