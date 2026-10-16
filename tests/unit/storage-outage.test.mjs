// Upstash outages and quota: the store says why it failed without leaking Upstash's text, backs
// off, rate limits batch their commands and fail open, /api/status reports storage health, and
// request-driven index passes are spaced deployment-wide.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRedisStore, createFileStore, failureReason } from '../../server/storage.mjs'
import { createLimiter } from '../../server/request-limits.mjs'
import { createRpcProxy } from '../../server/rpc-proxy.mjs'
import { createApplication } from '../../server/application.mjs'

const QUOTA = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500000.'
const quotaResponse = () => new Response(JSON.stringify({ error: QUOTA }), { status: 400 })
const visitor = (ip = '203.0.113.9') => ({
  headers: { origin: 'https://quantpad.test', host: 'quantpad.test' },
  socket: { remoteAddress: ip },
})

test('failure reasons are short codes for each way Upstash fails', () => {
  assert.equal(failureReason({ status: 400, text: QUOTA }), 'quota-requests')
  assert.equal(
    failureReason({ status: 400, text: 'ERR max daily request limit exceeded' }),
    'quota-requests',
  )
  assert.equal(
    failureReason({ status: 400, text: 'ERR max monthly bandwidth limit exceeded' }),
    'quota-bandwidth',
  )
  assert.equal(failureReason({ status: 400, text: 'ERR max database size exceeded' }), 'quota-size')
  assert.equal(failureReason({ status: 401, text: 'Unauthorized' }), 'auth')
  assert.equal(failureReason({ status: 400, text: 'WRONGPASS invalid password' }), 'auth')
  assert.equal(failureReason({ status: 502, text: '<html>' }), 'http-502')
  assert.equal(failureReason({ status: 200, text: 'not json' }), 'bad-response')
  const timeout = Object.assign(Error('timed out'), { name: 'TimeoutError' })
  assert.equal(failureReason({ error: timeout }), 'timeout')
  assert.equal(failureReason({ error: new TypeError('fetch failed') }), 'unreachable')
})

test('a used-up Upstash plan: 503 for callers, a reason code in health and logs', async () => {
  let clock = 1_000_000
  let calls = 0
  let answer = quotaResponse
  const logs = []
  const store = createRedisStore({
    url: 'https://secret-host.upstash.io',
    token: 'secret-token',
    request: async () => {
      calls++
      return answer()
    },
    log: (message) => logs.push(message),
    now: () => clock,
  })
  assert.deepEqual(store.health(), { healthy: null, reason: null, at: 0 })
  await assert.rejects(() => store.get('k'), { status: 503, code: 'STORAGE_UNAVAILABLE' })
  assert.deepEqual(store.health(), { healthy: false, reason: 'quota-requests', at: clock })
  assert.deepEqual(logs, ['[storage] Redis command failed: quota-requests (HTTP 400).'])

  // Refusals come back at once, so they are never short-circuited: at its limit Upstash refuses
  // only some commands, and the others must still be sent.
  for (let n = 0; n < 5; n++)
    await assert.rejects(() => store.get('k'), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(calls, 6)
  assert.equal(logs.length, 1, 'the same cause is logged once a minute')

  // A command that goes through does not make the store look healthy while it still refuses
  // others: health turns only after a minute without failures, and recovery is logged once.
  answer = () => new Response(JSON.stringify({ result: 0 }))
  clock += 1_000
  await store.check()
  assert.deepEqual(store.health(), { healthy: false, reason: 'quota-requests', at: clock })
  assert.equal(logs.length, 1)
  clock += 60_000
  await store.check()
  assert.deepEqual(store.health(), { healthy: true, reason: null, at: clock })
  assert.equal(logs.at(-1), '[storage] Redis is answering again.')
  await store.check()
  assert.equal(logs.length, 2, 'recovery is logged once')
  for (const line of logs) assert.doesNotMatch(line, /secret|Usage|500000/)
})

test('slow failures (timeouts, unreachable) stop commands for a while; refusals do not', async () => {
  let clock = 1_000_000
  let calls = 0
  let fail = () => Promise.reject(Object.assign(Error('timed out'), { name: 'TimeoutError' }))
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () => {
      calls++
      return fail()
    },
    log: () => {},
    now: () => clock,
  })
  await assert.rejects(() => store.get('k'), { code: 'STORAGE_UNAVAILABLE' })
  await assert.rejects(() => store.get('k'), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(calls, 2)
  assert.equal(store.health().reason, 'timeout')
  // Two in a row: the next second fails at once, without a 10 s wait on Upstash.
  await assert.rejects(() => store.get('k'), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(calls, 2, 'no request while backing off')
  clock += 1_001
  fail = async () => new Response(JSON.stringify({ result: JSON.stringify(1) }))
  assert.equal(await store.get('k'), 1)
  assert.equal(calls, 3)
  // A refusal after that is sent and answered every time.
  fail = async () => quotaResponse()
  for (let n = 0; n < 3; n++) await assert.rejects(() => store.get('k'))
  assert.equal(calls, 6)
})

test('incrementExpiring adds any amount in one command', async () => {
  const sent = []
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    prefix: 'p',
    request: async (url, init) => {
      sent.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ result: 40 }))
    },
  })
  assert.equal(await store.incrementExpiring('rate:x', 120000, 40), 40)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'EVAL')
  assert.match(sent[0][1], /INCRBY/)
  assert.deepEqual(sent[0].slice(2), [1, 'p:rate:x', 120000, 40])
  const file = createFileStore(mkdtempSync(join(tmpdir(), 'qp-outage-')))
  assert.equal(await file.incrementExpiring('r', 1000, 5), 5)
  assert.equal(await file.incrementExpiring('r', 1000), 6)
})

test('the limiter batches store charges and adds what other instances charged', async () => {
  const sent = []
  const others = 250 // charged by other instances this minute
  const store = {
    async incrementExpiring(key, ttl, amount) {
      sent.push(amount)
      const total = others + sent.reduce((a, b) => a + b, 0)
      return total
    },
  }
  const limit = createLimiter({ store, now: () => 1_700_000_000_000 })
  const read = () => limit(visitor(), { bucket: 'read', limit: 300 })
  for (let n = 0; n < 29; n++) await read()
  assert.deepEqual(sent, [], 'under a tenth of the limit costs no commands')
  await read()
  assert.deepEqual(sent, [30], 'one command for the batch')
  // 280 counted deployment-wide: 20 more fit, the 21st is refused without asking the store.
  for (let n = 0; n < 20; n++) await read()
  await assert.rejects(read, { status: 429 })
  assert.deepEqual(sent, [30])
})

test('the limiter fails open on storage errors and keeps its own count', async () => {
  let attempts = 0
  const store = {
    async incrementExpiring() {
      attempts++
      throw Object.assign(Error('Persistent storage is unavailable.'), {
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
      })
    },
  }
  const limit = createLimiter({ store, batchShare: 0 })
  for (let n = 0; n < 5; n++) await limit(visitor(), { bucket: 'write', limit: 5 })
  assert.equal(attempts, 5)
  await assert.rejects(() => limit(visitor(), { bucket: 'write', limit: 5 }), { status: 429 })
})

test('/api/rpc keeps answering while Redis refuses every command', async () => {
  let redisCalls = 0
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () => {
      redisCalls++
      return quotaResponse()
    },
    log: () => {},
  })
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: createLimiter({ store, batchShare: 0 }),
    globalLimit: 1000,
    request: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 })),
  })
  const call = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }
  for (let n = 0; n < 3; n++) {
    const answer = await proxy(visitor(), call)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.result, 7)
  }
  assert.ok(redisCalls >= 1, 'the store was asked, and failed')
})

async function bootApp(options) {
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-outage-')),
    quantum: null,
    background: false,
    connection: { rpcEndpoint: 'http://rpc.invalid', getAccountInfo: async () => null },
    priceFeed: async () => ({ usd: 150 }),
    ...options,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { app, base, close: () => new Promise((r) => server.close(r)) }
}

test('/api/status reports whether storage answers, with the reason when it does not', async () => {
  let answer = quotaResponse
  let checks = 0
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    // As Upstash does with a used-up plan: PING still answers, data commands (EXISTS too) do not.
    request: async (url, init) => {
      const [name] = JSON.parse(init.body)
      if (name === 'PING') return new Response(JSON.stringify({ result: 'PONG' }))
      if (name === 'EXISTS') checks++
      return answer()
    },
    log: () => {},
  })
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }))
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const { base, close } = await bootApp({
    store,
    serverless: true,
    rpcUrl: `http://127.0.0.1:${upstream.address().port}`,
  })
  try {
    const down = await (await fetch(base + '/api/status')).json()
    assert.deepEqual(down.storage, {
      mode: 'redis',
      ready: false,
      healthy: false,
      reason: 'quota-requests',
      error: 'Persistent storage is unavailable. Try again shortly.',
    })
    assert.equal(checks, 1)

    // The RPC proxy still answers; reads that need stored data say so.
    const keys = Array.from({ length: 100 }, () => 'So11111111111111111111111111111111111111112')
    const rpc = await fetch(base + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [keys],
      }),
    })
    assert.equal(rpc.status, 200)
    assert.equal((await rpc.json()).result, 'ok')
    const market = await fetch(base + '/api/market')
    assert.equal(market.status, 503)
    assert.equal((await market.json()).code, 'STORAGE_UNAVAILABLE')

    // A failure seen moments ago is reported without another check.
    await (await fetch(base + '/api/status')).json()
    assert.equal(checks, 1)
  } finally {
    await close()
    upstream.closeAllConnections?.()
    await new Promise((r) => upstream.close(r))
  }

  answer = () => new Response(JSON.stringify({ result: 0 }))
  const healthy = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () => answer(),
  })
  const up = await bootApp({ store: healthy, serverless: true })
  try {
    const status = await (await fetch(up.base + '/api/status')).json()
    assert.deepEqual(status.storage, { mode: 'redis', ready: true, healthy: true })
  } finally {
    await up.close()
  }
})

test('request-driven index passes are spaced across instances sharing storage', async () => {
  const shared = createFileStore(mkdtempSync(join(tmpdir(), 'qp-outage-')))
  const instances = await Promise.all([
    bootApp({ store: shared, serverless: true, backgroundGapMs: 0, backgroundSyncMs: 300 }),
    bootApp({ store: shared, serverless: true, backgroundGapMs: 0, backgroundSyncMs: 300 }),
  ])
  let passes = 0
  for (const { app } of instances)
    app.indexer.sync = async () => {
      passes++
      return { synced: 0 }
    }
  try {
    for (const { app } of instances) await app.sync({ startedAt: Date.now() })
    for (const { app } of instances) await app.sync({ startedAt: Date.now() })
    assert.equal(passes, 1, 'one pass per spacing, whichever instance asks')
    await new Promise((r) => setTimeout(r, 350))
    await instances[0].app.sync({ startedAt: Date.now() })
    assert.equal(passes, 2)
  } finally {
    for (const { close } of instances) await close()
  }
})
