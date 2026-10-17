// The $QUANTP routes (server/application.mjs) with a stub ledger and engine, the keeper tick's
// error reports and alerts, and the payout engine's own RPC connection (server/solana.mjs
// createConnection).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createApplication,
  QUANTP_CACHE,
  QUANTP_COLD_CACHE,
  QUANTP_HEALTH_CACHE,
  QUANTP_LEDGER_CACHE,
  tickError,
} from '../../server/application.mjs'
import { createConnection } from '../../server/solana.mjs'
import { QUANTP } from '../../shared/network.mjs'

const ENGINE = QUANTP.engine.wallet
const HOLDER = '57uMvKGYH1xcrwPSXHjtQFbzApmDGhQi1RVa6pzvXb2u'
const OTHER = '3rkwX6jPuVs5iCBJMEUJu2Ch7qKE7Gm8B5U5qYW8TBK6'
const NOW = 1_792_224_000 // 2026-10-17 08:00 UTC

/**
 * A ledger() value: `payouts` hourly payouts and `burns` hourly burns by the engine's wallet, and
 * `unread` transactions not read yet, `unreadable` of them given up on, the newest of the rest
 * from `unreadAt`.
 */
function ledgerValue({
  payouts = 3,
  burns = 2,
  paidAt = NOW - 600,
  burnedAt = NOW - 590,
  unread = 0,
  unreadable = 0,
  unreadAt = unread > unreadable ? NOW - 60 : null,
} = {}) {
  return {
    mint: QUANTP.mint,
    wallets: { payout: QUANTP.payoutWallet, creator: QUANTP.creator, engine: ENGINE },
    payoutLamports: '1000000',
    payouts: Array.from({ length: payouts }, (_, i) => ({
      timestamp: paidAt - 3600 * i - 1,
      lastTimestamp: paidAt - 3600 * i,
      wallet: ENGINE,
      lamports: '5000000',
      recipients: 30,
      recipient: null,
      transactions: [],
    })),
    burns: Array.from({ length: burns }, (_, i) => ({
      signature: `burn${i}`,
      slot: 1,
      timestamp: burnedAt - 3600 * i,
      wallet: ENGINE,
      method: 'burn',
      amount: '49000000000',
      solSpent: '3300000',
    })),
    totals: {
      paidLamports: String(5_000_000 * payouts),
      payoutTxs: 2 * payouts,
      recipients: 30,
      burnedAmount: String(49_000_000_000 * burns),
      buybackLamports: String(3_300_000 * burns),
      unburned: { lamports: '0', amount: '0' },
      unburnedByWallet: {},
    },
    unread,
    unreadable,
    newestUnreadAt: unreadAt,
    complete: unread === 0,
    since: 1792126586,
    updatedAt: NOW,
    state: unread ? 'partial' : 'ok',
  }
}

/** The engine's status() (as server/quantp-engine.mjs gives it), with `over` merged in. */
const engineStatus = (over = {}) => ({
  configured: true,
  wallet: ENGINE,
  live: true,
  reason: null,
  minHold: '1500000000000',
  next: { release: '8000000', holders: '4800000', buyback: '3200000', paying: 30 },
  holders: [{ wallet: HOLDER, amount: '2000000000000', lamports: '160000', reason: null }],
  ...over,
})

/**
 * The app with stub $QUANTP sources: change `ledger.value`, `engine.value` (an Error throws), and
 * what the ledger's peek() and loading() say (`ledger.peeked`, `ledger.reading`).
 */
async function boot({ now = () => NOW * 1000 } = {}) {
  const ledger = {
    value: ledgerValue(),
    peeked: undefined,
    reading: false,
    asked: [],
    async ledger() {
      if (this.value instanceof Error) throw this.value
      return this.value
    },
    peek() {
      return this.peeked === undefined ? this.value : this.peeked
    },
    loading() {
      return this.reading
    },
    async forWallet(wallet, options) {
      this.asked.push([wallet, options])
      return this.paid
    },
  }
  const engine = {
    value: engineStatus(),
    async status() {
      if (this.value instanceof Error) throw this.value
      return this.value
    },
    async tick() {
      return { ran: false, reason: 'not-due' }
    },
  }
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-routes-')),
    store: null,
    serverless: true,
    quantum: null,
    background: false,
    connection: {},
    priceFeed: async () => ({ usd: 150 }),
    quantpFeed: {
      snapshot: async () => ({ mint: QUANTP.mint, priceSol: 0.0000001 }),
      pools: async () => [],
    },
    quantpLedger: ledger,
    quantpEngine: engine,
    now,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const get = async (path) => {
    const r = await fetch(base + path)
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }
  }
  return {
    app,
    ledger,
    engine,
    base,
    get,
    close: async () => {
      await new Promise((r) => server.close(r))
      app.close()
    },
  }
}

/** Runs `fn` with console.error captured; resolves to what was logged. */
async function quietly(fn) {
  const logged = []
  const error = console.error
  console.error = (...args) => logged.push(args)
  try {
    await fn()
  } finally {
    console.error = error
  }
  return logged
}

test('GET /api/quantp/ledger: the newest 50 payouts and burns, totals over all; ?all=1 for every one', async () => {
  const { ledger, get, close } = await boot()
  ledger.value = ledgerValue({ payouts: 60, burns: 3 })
  try {
    const page = await get('/api/quantp/ledger')
    assert.equal(page.status, 200)
    assert.equal(page.cache, QUANTP_LEDGER_CACHE)
    assert.equal(page.body.payouts.length, 50)
    assert.deepEqual(page.body.payouts[0], ledger.value.payouts[0])
    assert.equal(page.body.burns.length, 3)
    assert.equal(page.body.payoutCount, 60)
    assert.equal(page.body.burnCount, 3)
    assert.equal(page.body.more, true)
    // the totals are the whole history's
    assert.deepEqual(page.body.totals, ledger.value.totals)
    assert.equal(page.body.complete, true)
    const all = await get('/api/quantp/ledger?all=1')
    assert.equal(all.body.payouts.length, 60)
    assert.equal(all.body.more, false)
    assert.equal(all.body.payoutCount, 60)
    // anything else asked for is ignored
    const other = await get('/api/quantp/ledger?all=yes&limit=1000&before=x')
    assert.equal(other.status, 200)
    assert.equal(other.body.payouts.length, 50)
    // a short history fits: nothing more
    ledger.value = ledgerValue({ payouts: 2, burns: 1 })
    assert.equal((await get('/api/quantp/ledger')).body.more, false)
  } finally {
    await close()
  }
})

test('GET /api/quantp/holder: 400 for anything but a wallet address, else what it was paid', async () => {
  const { ledger, engine, get, close } = await boot()
  ledger.paid = {
    lamports: '26204370',
    payouts: 2,
    lastAt: NOW - 3600,
    items: [
      { signature: 'sig2', timestamp: NOW - 3600, lamports: '233072' },
      { signature: 'sig1', timestamp: NOW - 90_000, lamports: '25971298' },
    ],
    complete: true,
    since: 1792126586,
  }
  try {
    const logged = await quietly(async () => {
      for (const wallet of ['', 'not-an-address', 'z'.repeat(44), `${HOLDER}0`]) {
        const bad = await get(`/api/quantp/holder?wallet=${encodeURIComponent(wallet)}`)
        assert.equal(bad.status, 400, wallet)
        assert.equal(bad.body.code, 'invalid_wallet')
      }
      assert.equal((await get('/api/quantp/holder')).status, 400)

      const r = await get(`/api/quantp/holder?wallet=${HOLDER}`)
      assert.equal(r.status, 200)
      assert.equal(r.cache, QUANTP_LEDGER_CACHE)
      assert.deepEqual(r.body, {
        wallet: HOLDER,
        paid: {
          lamports: '26204370',
          payouts: 2,
          lastAt: NOW - 3600,
          items: ledger.paid.items,
        },
        engine: { wallet: HOLDER, amount: '2000000000000', lamports: '160000', reason: null },
        minHold: '1500000000000',
        complete: true,
      })
      assert.deepEqual(ledger.asked.at(-1), [HOLDER, { limit: 50 }])
      // a wallet the engine does not pay next
      assert.deepEqual((await get(`/api/quantp/holder?wallet=${OTHER}`)).body.engine, {
        eligible: false,
      })
      // the engine's status unavailable: its part is unknown, the payouts still answer
      engine.value = Error('fetch failed')
      const unknown = await get(`/api/quantp/holder?wallet=${OTHER}`)
      assert.equal(unknown.status, 200)
      assert.equal(unknown.body.engine, null)
      assert.equal(unknown.body.minHold, null)
      assert.equal(unknown.body.paid.lamports, '26204370')
      // a status without holders (an engine not set up) says nothing either
      engine.value = { configured: false }
      assert.equal((await get(`/api/quantp/holder?wallet=${OTHER}`)).body.engine, null)
    })
    // the address is never logged
    assert.ok(!JSON.stringify(logged.map(String)).includes(HOLDER))
    assert.ok(!JSON.stringify(logged.map(String)).includes(OTHER))
  } finally {
    await close()
  }
})

test('GET /api/quantp: the ledger as cached, never waited for; none yet is cached briefly', async () => {
  const { ledger, get, close } = await boot()
  try {
    // nothing read yet on this instance, and the first read under way
    ledger.peeked = null
    ledger.reading = true
    const cold = await get('/api/quantp')
    assert.equal(cold.status, 200)
    assert.equal(cold.body.payouts, null)
    assert.equal(cold.cache, QUANTP_COLD_CACHE)
    assert.equal(QUANTP_COLD_CACHE, 'public, max-age=0, s-maxage=2, stale-while-revalidate=5')
    // a read that failed is tried again only after a while: null, cached as long as the rest
    ledger.reading = false
    const failed = await get('/api/quantp')
    assert.equal(failed.body.payouts, null)
    assert.equal(failed.cache, QUANTP_CACHE)
    // read: the summary, cached as long as the live figures
    ledger.peeked = ledgerValue({ unread: 4 })
    const warm = await get('/api/quantp')
    assert.equal(warm.cache, QUANTP_CACHE)
    assert.equal(warm.body.mint, QUANTP.mint)
    assert.equal(warm.body.payouts.paidLamports, '15000000')
    assert.equal(warm.body.payouts.complete, false)
    assert.equal(warm.body.payouts.since, 1792126586)
    // a ledger that never answers does not hold it up
    ledger.ledger = () => new Promise(() => {})
    assert.equal((await get('/api/quantp')).status, 200)
  } finally {
    await close()
  }
})

test('GET /api/quantp/engine: a 503 the page can show when the status cannot be read', async () => {
  const { engine, get, close } = await boot()
  try {
    const ok = await get('/api/quantp/engine')
    assert.equal(ok.status, 200)
    assert.equal(ok.cache, QUANTP_LEDGER_CACHE)
    assert.equal(ok.body.wallet, ENGINE)
    engine.value = Error('429 Too Many Requests: {"rpc":"https://rpc.invalid/?api-key=secret"}')
    let down
    const logged = await quietly(async () => (down = await get('/api/quantp/engine')))
    assert.equal(down.status, 503)
    assert.deepEqual(down.body, {
      error: 'The payout engine’s state is unavailable right now.',
      code: 'ENGINE_UNAVAILABLE',
    })
    assert.equal(down.cache, 'no-store')
    assert.equal(logged.length, 1, 'the cause is logged')
    // the engine's own 503 answers the same
    engine.value = Object.assign(Error('The payout engine’s state is unavailable right now.'), {
      status: 503,
      expose: true,
      code: 'ENGINE_UNAVAILABLE',
    })
    assert.equal((await get('/api/quantp/engine')).body.code, 'ENGINE_UNAVAILABLE')
  } finally {
    await close()
  }
})

test('GET /api/quantp/engine/health: 200 while it pays and buys back on time, else 503 and why', async () => {
  const { ledger, engine, get, close } = await boot()
  const health = async () => {
    const r = await get('/api/quantp/engine/health')
    assert.equal(r.cache, QUANTP_HEALTH_CACHE)
    return [r.status, r.body]
  }
  try {
    assert.deepEqual(await health(), [
      200,
      { ok: true, lastPaidAt: NOW - 600, lastBurnAt: NOW - 590 },
    ])
    // switched off, or not set up
    engine.value = engineStatus({ live: false, reason: 'paused' })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'not-live' }])
    engine.value = { configured: false }
    assert.deepEqual(await health(), [503, { ok: false, reason: 'not-live' }])
    // its newest payout over 2 h 15 min old while holders are due one
    engine.value = engineStatus()
    ledger.value = ledgerValue({ paidAt: NOW - 8_200 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'late' }])
    // none due (nothing to pay): not late
    engine.value = engineStatus({ next: { release: '0', holders: '0', buyback: '0', paying: 0 } })
    assert.equal((await health())[0], 200)
    // never paid at all, with holders due
    engine.value = engineStatus()
    ledger.value = ledgerValue({ payouts: 0 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'late' }])
    // payouts on time, but no burn for over 3 h while a buyback is due
    ledger.value = ledgerValue({ burnedAt: NOW - 11_000 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'buyback-failing' }])
    engine.value = engineStatus({ next: { release: '1', holders: '1', buyback: '0', paying: 30 } })
    assert.equal((await health())[0], 200)
    // what cannot be told: no status, no ledger, or a newer transaction still unread
    engine.value = Error('fetch failed')
    assert.deepEqual(await health(), [503, { ok: false, reason: 'unknown' }])
    engine.value = engineStatus()
    ledger.value = Error('unavailable')
    assert.deepEqual(await health(), [503, { ok: false, reason: 'unknown' }])
    ledger.value = ledgerValue({ paidAt: NOW - 9_000, unread: 3 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'unknown' }])
    ledger.value = ledgerValue({ burnedAt: NOW - 11_000, unread: 1, unreadAt: NOW - 10_000 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'unknown' }])
    // only older ones unread (history still being read), or one given up on (dust in a version
    // the node cannot return): late is late
    ledger.value = ledgerValue({ paidAt: NOW - 9_000, unread: 40, unreadAt: NOW - 90_000 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'late' }])
    ledger.value = ledgerValue({ paidAt: NOW - 9_000, unread: 1, unreadable: 1 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'late' }])
    ledger.value = ledgerValue({ burnedAt: NOW - 11_000, unread: 1, unreadable: 1 })
    assert.deepEqual(await health(), [503, { ok: false, reason: 'buyback-failing' }])
    // a newer one unread while all is on time: healthy
    ledger.value = ledgerValue({ unread: 2 })
    assert.equal((await health())[0], 200)
    // another wallet's payouts are not the engine's
    ledger.value = ledgerValue()
    for (const p of ledger.value.payouts) p.wallet = QUANTP.creator
    assert.deepEqual(await health(), [503, { ok: false, reason: 'late' }])
  } finally {
    await close()
  }
})

const SIG =
  '5ZkTqgeDKeMDQ3d4AZpeMmLDPCCV5BrHhpqhgCzKRFr3yTyuFAbBpcosdwVcsSd8hSmJAxG8G6PGfBCjb8mhWBUm'

test('tickError: a step’s message only when written for users or the engine’s own; its signature', async () => {
  const cases = [
    // written for users
    [
      Object.assign(Error('Persistent storage is unavailable. Try again shortly.'), {
        status: 503,
        code: 'STORAGE_UNAVAILABLE',
        expose: true,
      }),
      {
        error: 'Persistent storage is unavailable. Try again shortly.',
        code: 'STORAGE_UNAVAILABLE',
      },
    ],
    // the engine's own: a transaction that failed on-chain, or is not confirmed yet
    [
      Object.assign(Error(`Transaction ${SIG} failed: {"InstructionError":[2,{"Custom":6001}]}`), {
        signature: SIG,
      }),
      {
        error: `Transaction ${SIG} failed: {"InstructionError":[2,{"Custom":6001}]}`,
        code: null,
        signature: SIG,
      },
    ],
    [
      Object.assign(Error(`Transaction ${SIG} is not confirmed yet.`), {
        signature: SIG,
        unknown: true,
      }),
      { error: `Transaction ${SIG} is not confirmed yet.`, code: null, signature: SIG },
    ],
    [
      Error('The $QUANTP supply could not be read.'),
      { error: 'The $QUANTP supply could not be read.', code: null },
    ],
    [
      { message: 'The hourly claim failed: its marker exists', signature: null },
      { error: 'The hourly claim failed: its marker exists', code: null, signature: null },
    ],
    // anything else, a provider's text above all, by its code alone
    [
      Object.assign(Error('failed to get balance: fetch failed'), {
        cause: { code: 'ECONNRESET' },
      }),
      { error: 'RPC or dependency error', code: 'ECONNRESET' },
    ],
    [
      Object.assign(Error('429 Too Many Requests: {"url":"https://rpc.invalid/?api-key=secret"}'), {
        code: -32429,
      }),
      { error: 'RPC or dependency error', code: -32429 },
    ],
    [
      Error('Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found.'),
      { error: 'RPC or dependency error', code: null },
    ],
    // an engine-like message carrying a URL or a key, or an odd code, is not kept either
    [
      Object.assign(Error(`Transaction ${SIG} failed: see https://rpc.invalid/?api-key=secret`), {
        signature: SIG,
      }),
      { error: 'RPC or dependency error', code: null, signature: SIG },
    ],
    [
      Object.assign(Error('claim failed at rpc.invalid?api-key=secret'), {
        code: 'https://rpc.invalid/?api-key=secret',
      }),
      { error: 'RPC or dependency error', code: null },
    ],
    [Error(), { error: 'RPC or dependency error', code: null }],
  ]
  const logged = await quietly(async () => {
    for (const [e, expected] of cases) assert.deepEqual(tickError('engine', e), expected)
  })
  // each logged whole
  assert.equal(logged.length, cases.length)
  assert.deepEqual(
    logged.map(([label, e]) => [label, e]),
    cases.map(([e]) => ['[tick] engine', e]),
  )
})

/** Resolves once `ready()` holds (checked every 10 ms, for at most 2 s). */
async function until(ready) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(ready(), 'in time')
}
// Lets work the tick does after its answer (its alert) finish.
const settled = () => new Promise((r) => setTimeout(r, 50))

/** An HTTP endpoint on localhost recording what is POSTed to it, answering `status`. */
async function webhookServer() {
  const posts = []
  const hook = { status: 204, hold: null, posts }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      posts.push({ type: req.headers['content-type'], body: JSON.parse(body) })
      await hook.hold
      res.writeHead(hook.status)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  hook.url = `http://127.0.0.1:${server.address().port}/hook/secret-token`
  hook.close = () => {
    server.closeAllConnections()
    return new Promise((r) => server.close(r))
  }
  return hook
}

test('the keeper tick: an engine run that failed part way, its alert sent once an hour after the answer', async () => {
  const hook = await webhookServer()
  process.env.CRON_SECRET = 'tick-secret'
  process.env.QUANTP_ALERT_WEBHOOK = hook.url
  const clock = { t: Date.parse('2026-10-17T08:20:00Z') }
  const { app, engine, base, close } = await boot({ now: () => clock.t })
  const sent = { signature: SIG, lamports: '3607526', recipients: 18 }
  engine.tick = async () => ({
    ran: true,
    paying: 30,
    payouts: [sent],
    buyback: null,
    error: 'failed to send transaction: 503 from https://rpc.invalid/?api-key=secret',
    signature: null,
  })
  app.indexer.sync = async () => ({ synced: 0 })
  const FOREIGN = {
    kind: 'foreign-epoch',
    mint: QUANTP.mint,
    index: 7,
    claimStart: 1_792_300_000,
    total: '1000',
    payer: OTHER,
  }
  app.keeper.tick = async () => ({ enabled: true, ran: 1, alerts: [FOREIGN] })
  const tick = () =>
    fetch(base + '/api/keeper/tick', {
      headers: { Authorization: 'Bearer tick-secret', 'User-Agent': 'vercel-cron/1.0' },
    }).then((r) => r.json())
  try {
    // the webhook holds its answer: the tick has answered without waiting for it
    let release
    hook.hold = new Promise((r) => (release = r))
    let body
    const logged = await quietly(async () => {
      body = await tick()
      await until(() => hook.posts.length === 1)
      release()
      await settled()
    })
    // what it sent is kept beside the error, which says nothing of the provider
    assert.deepEqual(body.engine, {
      ran: true,
      paying: 30,
      payouts: [sent],
      buyback: null,
      error: 'RPC or dependency error',
      code: null,
      signature: null,
    })
    assert.equal(body.ok, false)
    assert.deepEqual(body.keeper.alerts, [FOREIGN])
    // logged: the engine's error whole, then the tick in one line
    const line = logged.find(([label]) => label === '[tick]')
    assert.deepEqual(JSON.parse(line[1]), {
      ok: false,
      engine: body.engine,
      keeper: [FOREIGN],
    })
    assert.ok(logged.some(([label, e]) => label === '[tick] engine' && /api-key/.test(e.message)))

    // one line for every reason, with neither the webhook's URL nor any other setting
    const [post] = hook.posts
    assert.equal(post.type, 'application/json')
    assert.equal(post.body.content, post.body.text)
    const text = post.body.text
    assert.ok(!text.includes('\n'))
    assert.match(text, /^Quant Pad keeper tick: payout engine failed: RPC or dependency error; /)
    assert.ok(text.includes(`${QUANTP.mint}#7 before ${new Date(1_792_300_000_000).toISOString()}`))
    for (const secret of ['secret-token', 'tick-secret', 'api-key', '127.0.0.1'])
      assert.ok(!text.includes(secret), secret)

    // within the hour: not again on this instance
    hook.hold = null
    await quietly(tick)
    assert.equal(hook.posts.length, 1)
    // a new reason is sent at once, alone
    engine.tick = async () => ({ ran: true, payouts: [sent], buyback: null, stopped: 'time limit' })
    await quietly(async () => {
      const stopped = await tick()
      assert.equal(stopped.engine.stopped, 'time limit')
      await until(() => hook.posts.length === 2)
    })
    assert.equal(
      hook.posts[1].body.text,
      'Quant Pad keeper tick: payout engine stopped early: time limit',
    )
    // an hour on, again; a webhook that fails is logged by name and tried on the next tick
    clock.t += 3_600_000
    hook.status = 500
    const failing = await quietly(async () => {
      await tick()
      await until(() => hook.posts.length === 3)
      await settled()
    })
    assert.match(hook.posts[2].body.text, /stopped early: time limit; epochs this keeper did not/)
    assert.deepEqual(
      failing.find(([label]) => label === '[tick] alert webhook failed:'),
      ['[tick] alert webhook failed:', 'HTTP 500'],
    )
    hook.status = 204
    await quietly(async () => {
      await tick()
      await until(() => hook.posts.length === 4)
      await settled()
    })

    // a tick with nothing to report sends nothing, and logs nothing
    clock.t += 3_600_000
    engine.tick = async () => ({ ran: false, reason: 'not-due' })
    app.keeper.tick = async () => ({ enabled: true, ran: 0 })
    assert.deepEqual(await quietly(async () => assert.equal((await tick()).ok, true)), [])
    // and without a webhook set, nothing is sent
    delete process.env.QUANTP_ALERT_WEBHOOK
    engine.tick = async () => ({ ran: true, payouts: [], buyback: null, stopped: 'time limit' })
    await quietly(tick)
    assert.equal(hook.posts.length, 4)
  } finally {
    delete process.env.CRON_SECRET
    delete process.env.QUANTP_ALERT_WEBHOOK
    await close()
    await hook.close()
  }
})

/** A JSON-RPC endpoint on localhost answering each call with `answer(n)` (n counts calls). */
async function rpcServer(answer) {
  let calls = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => answer(++calls, res))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls: () => calls,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}

test('the engine’s connection gives up on a call after its timeout, and on a 429 at once', async () => {
  // never answers
  const silent = await rpcServer(() => {})
  try {
    const started = Date.now()
    await assert.rejects(() =>
      createConnection(silent.url, { timeoutMs: 300 }).getSlot('confirmed'),
    )
    assert.ok(Date.now() - started < 3_000, 'aborted at the timeout')
  } finally {
    await silent.close()
  }
  // rate limited: one call, no retries
  const limited = await rpcServer((n, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"},"id":"1"}')
  })
  try {
    const connection = createConnection(limited.url, {
      timeoutMs: 2_000,
      disableRetryOnRateLimit: true,
    })
    await assert.rejects(() => connection.getSlot('confirmed'), /429/)
    assert.equal(limited.calls(), 1)
  } finally {
    await limited.close()
  }
  // an answering node is read as usual, and the default connection sets no timeout
  const fine = await rpcServer((n, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","result":457000000,"id":"1"}')
  })
  try {
    assert.equal(await createConnection(fine.url, { timeoutMs: 2_000 }).getSlot(), 457000000)
    assert.equal(await createConnection(fine.url).getSlot(), 457000000)
  } finally {
    await fine.close()
  }
})
