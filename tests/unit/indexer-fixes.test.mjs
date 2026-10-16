// Indexer fixes: launch provenance (C2), the tri-state quantum flag (C3), gap-free cursors,
// time-bounded and throttle-tolerant passes, locking, eviction, trade order, prices and market caps.
// Everything runs against an in-memory chain (mainnet getSignaturesForAddress semantics) and store,
// with Meteora DBC / DAMM v2 transactions and accounts encoded by the programs' own IDLs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { network, priceFromSqrtPrice } from '../../shared/network.mjs'
import {
  NOW,
  WSOL,
  address,
  signature,
  coinAccounts,
  createIx,
  dammPoolAccount,
  dammPoolFor,
  dbcConfigAccount,
  dbcPoolAccount,
  dbcPoolFor,
  fakeChain,
  fakeQuantum,
  idle,
  installFetch,
  memoryStore,
  mintAccount,
  swapIx,
  transferCreatorIx,
} from './meteora-chain.mjs'

process.env.QUANTPAD_MAX_LAUNCHES = '3'
const { createIndexer, issuedUriKey, stats, summarize } = await import('../../server/indexer.mjs')
const { extractEvents, tradesFrom, fetchTransactions, pendingSignatures, readMarket } =
  await import('../../server/solana.mjs')
const { candlesFor, compareTrades, capSupply } = await import('../../server/market-math.mjs')

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))
installFetch(test)

// A launch: the DBC create by `launcher`, handed to `creator` (a Quantum coin's well) when that is
// someone else.
const launchIxs = (mint, { creator, launcher = creator, ...rest }) => [
  createIx(mint, { creator: launcher, ...rest }),
  ...(launcher === creator
    ? []
    : [transferCreatorIx(mint, { creator: launcher, newCreator: creator })]),
]
// A curve trade that leaves the coin at `price` SOL per whole token (1 SOL in).
const tradeIxs = (mint, options) => [swapIx(mint, options)]

async function syncUntilCaughtUp(indexer, mint, max = 200) {
  for (let n = 0; n < max; n++) {
    const record = await indexer.syncCoin(mint)
    if (!record.behind) return record
  }
  throw Error('sync never caught up')
}

// ---- C2 -----------------------------------------------------------------------------------------
test('C2: a launch is native only with a URI this server issued, with 4xx errors otherwise', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  const user = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'a'.repeat(32)
  const sig = chain.add([dbcPoolFor(mint)], {
    ixs: [...launchIxs(mint, { creator: user, uri }), ...tradeIxs(mint, { price: 3e-8 })],
  })

  await assert.rejects(indexer.registerLaunch('not-a-signature'), { status: 400 })
  await assert.rejects(indexer.registerLaunch(''), { status: 400 })
  await assert.rejects(indexer.registerLaunch('', { mint: 'bad' }), { status: 400 })
  await assert.rejects(indexer.registerLaunch(signature()), {
    status: 409,
    code: 'not_indexed_yet',
  })
  // Any other Meteora coin is not a Quant Pad launch, and nothing is stored for it.
  await assert.rejects(indexer.registerLaunch(sig), { status: 400, code: 'not_quantpad' })
  assert.equal(await indexer.coin(mint), null)
  assert.deepEqual(await indexer.list(), [])

  await store.set(issuedUriKey(uri), { at: Date.now() }, { ttl: 86_400_000 })
  const coin = await indexer.registerLaunch(sig, { mint })
  assert.equal(coin.external, false)
  assert.equal(coin.provenance, 'issued-uri')
  assert.equal(coin.launcher, user)
  assert.equal(coin.quantum, false)
  assert.ok(coin.price > 0)
  await idle(store)
  assert.deepEqual(
    (await indexer.list()).map((c) => [c.mint, c.external]),
    [[mint, false]],
  )
  assert.equal((await indexer.registerLaunch(sig)).mint, mint, 'registering again is idempotent')
})

test("C2: registration by mint finds the create as the curve's first transaction", async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  const user = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'b'.repeat(32)
  await store.set(issuedUriKey(uri), { at: Date.now() })
  await chain.setAccounts(coinAccounts(mint, { creator: user }))
  const create = chain.add([dbcPoolFor(mint)], { ixs: launchIxs(mint, { creator: user, uri }) })
  let other
  for (let i = 0; i < 1200; i++) other = chain.add([dbcPoolFor(mint)])

  // A signature that is not the create (or no signature) falls back to the mint's first transaction.
  const coin = await indexer.registerLaunch(other, { mint })
  assert.equal(coin.signature, create)
  assert.equal(coin.external, false)
  await idle(store)
  assert.equal((await indexer.registerLaunch('', { mint })).signature, create)

  const fresh = address()
  await assert.rejects(indexer.registerLaunch('', { mint: fresh }), {
    status: 409,
    code: 'not_indexed_yet',
  })
  const deep = address()
  await chain.setAccounts(coinAccounts(deep, { creator: user }))
  chain.add([dbcPoolFor(deep)], { ixs: launchIxs(deep, { creator: user, uri }) })
  for (let i = 0; i < 5000; i++) chain.add([dbcPoolFor(deep)])
  await assert.rejects(indexer.registerLaunch('', { mint: deep }), {
    status: 400,
    code: 'not_quantpad',
  })
})

test('C2: native registrations are capped', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  await store.set(
    'coins:list',
    [1, 2, 3].map((n) => summarize({ mint: address(), name: `N${n}`, external: false })),
  )
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'c'.repeat(32)
  await store.set(issuedUriKey(uri), { at: Date.now() })
  const sig = chain.add([dbcPoolFor(mint)], { ixs: launchIxs(mint, { creator: address(), uri }) })
  await assert.rejects(indexer.registerLaunch(sig), { status: 429, code: 'launch_cap' })
})

// ---- C3 -----------------------------------------------------------------------------------------
test('C3: a failed Quantum check is stored as unknown and healed on sync', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const quantum = fakeQuantum(chain)
  const indexer = createIndexer({ connection: chain.connection, store, quantum })
  const mint = address()
  const launcher = address()
  const uri = 'https://quantpad.test/m/' + 'd'.repeat(32)
  quantum.register(mint, launcher)
  const sig = chain.add([dbcPoolFor(mint)], {
    ixs: launchIxs(mint, { creator: quantum.well(mint), launcher, uri }),
  })
  // The Quantum account read fails twice (a 503, then a node behind the create's slot).
  const reads = []
  const getAccountInfo = chain.connection.getAccountInfo
  chain.connection.getAccountInfo = async (key, options) => {
    reads.push(options)
    if (reads.length <= 2) throw Error('503 Service Unavailable')
    return getAccountInfo(key, options)
  }

  await assert.rejects(indexer.registerLaunch(sig), { status: 409, code: 'not_indexed_yet' })
  assert.equal(reads[0].minContextSlot, chain.txs.get(sig).slot)
  await store.set(issuedUriKey(uri), { at: Date.now() })
  const coin = await indexer.registerLaunch(sig)
  assert.equal(coin.quantum, null, 'unknown, not false')
  assert.equal(summarize(coin).quantum, null)

  await idle(store) // the registration's own sync re-verifies
  const healed = await indexer.coin(mint)
  assert.equal(healed.quantum, true)
  assert.equal(healed.launcher, launcher)
  assert.equal((await indexer.list())[0].quantum, true)
})

test('C3: track and sync upgrade verified Quantum coins to native launches', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const quantum = fakeQuantum(chain)
  const indexer = createIndexer({ connection: chain.connection, store, quantum })
  const launcher = address()

  const mint = address()
  quantum.register(mint, launcher)
  await chain.setAccounts(coinAccounts(mint, { creator: quantum.well(mint) }))
  const tracked = await indexer.track(mint)
  assert.deepEqual(
    [tracked.quantum, tracked.external, tracked.source, tracked.launcher],
    [true, false, 'quantpad', launcher],
  )

  // A record stored with a sticky false flag as an external coin heals on its next sync.
  const stale = address()
  quantum.register(stale, launcher)
  await chain.setAccounts(coinAccounts(stale, { creator: quantum.well(stale) }))
  const record = {
    mint: stale,
    name: 'Stale',
    creator: quantum.well(stale),
    dbcPool: dbcPoolFor(stale),
    quantum: false,
    external: true,
    source: 'meteora',
    cursor: null,
  }
  await store.set(`coin:${stale}`, record)
  await store.set('coins:list', [summarize(record), ...(await indexer.list())])
  await idle(store)
  const synced = await indexer.syncCoin(stale)
  assert.deepEqual([synced.quantum, synced.external, synced.launcher], [true, false, launcher])
  assert.equal((await indexer.list()).find((c) => c.mint === stale).external, false)

  // A coin whose creator is not its well is settled as not Quantum without an RPC read.
  const plain = address()
  await chain.setAccounts(coinAccounts(plain, { creator: address() }))
  assert.equal((await indexer.track(plain)).quantum, false)
  await idle(store)
})

// ---- cursors ------------------------------------------------------------------------------------
test('a backlog deeper than several signature pages is read oldest-first without gaps', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = dbcPoolFor(mint)
  const cursor = chain.add([curve])
  const expected = []
  for (let i = 0; i < 3500; i++) expected.push(chain.add([curve]))
  await store.set(`coin:${mint}`, {
    mint,
    dbcPool: curve,
    decimals: 6,
    external: false,
    cursor,
    createdAt: NOW,
  })
  let record
  for (let n = 0; n < 300; n++) {
    record = await indexer.syncCoin(mint)
    // More activity arrives while the backlog drains.
    if (n === 20) for (let i = 0; i < 50; i++) expected.push(chain.add([curve]))
    if (!record.behind) break
  }
  assert.equal(record.behind, false)
  assert.deepEqual(chain.fetched, expected, 'every signature, once, in execution order')
  assert.equal(record.cursor, expected.at(-1))
})

test('pendingSignatures pages back from a saved anchor instead of restarting at the tip', async () => {
  const chain = await fakeChain()
  const curve = address()
  const cursor = chain.add([curve])
  const sigs = []
  for (let i = 0; i < 2500; i++) sigs.push(chain.add([curve]))
  const first = await pendingSignatures(chain.connection, curve, { cursor, pages: 2 })
  assert.equal(first.reached, false)
  assert.deepEqual(first.window, [])
  chain.listed.length = 0
  const second = await pendingSignatures(chain.connection, curve, { cursor, anchor: first.anchor })
  assert.equal(chain.listed[0].before, first.anchor)
  assert.equal(second.reached, true)
  assert.deepEqual(
    second.window.map((s) => s.signature),
    sigs.slice(0, 500),
  )
})

// ---- tracked coins' history ---------------------------------------------------------------------
test('a tracked coin with a truncated history reports partial stats and no made-up age', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  await chain.setAccounts(coinAccounts(mint, { creator: address() }))
  for (let i = 0; i < 250; i++)
    chain.add([dbcPoolFor(mint)], {
      ixs: tradeIxs(mint, { price: 1e-8 * (1 + i / 100), timestamp: NOW - 3600 + i }),
      blockTime: NOW - 3600 + i,
    })
  await indexer.track(mint)
  await idle(store)
  const record = await syncUntilCaughtUp(indexer, mint)
  assert.equal(record.createdAt, null, 'not the oldest indexed trade')
  // 250 trades in the last hour, of which the first read saw 200: no 24h figures until the
  // indexed history reaches back a day.
  assert.equal((await indexer.trades(mint)).total, 200)
  assert.equal(record.trades24h, null)
  assert.equal(record.volume24h, null)
  assert.equal(record.buys24h, null)
  assert.equal(record.statsPartial, true)
  assert.equal(record.change24h, null)
  const [summary] = await indexer.list()
  assert.deepEqual([summary.statsPartial, summary.volume24h, summary.trades24h], [true, null, null])
})

test('a native coin indexed from its create has complete stats and its real age', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'e'.repeat(32)
  await store.set(issuedUriKey(uri), { at: Date.now() })
  const created = NOW - 7200
  const sig = chain.add([dbcPoolFor(mint)], {
    ixs: [...launchIxs(mint, { creator: address(), uri, timestamp: created })],
    blockTime: created,
  })
  for (let i = 0; i < 260; i++)
    chain.add([dbcPoolFor(mint)], {
      ixs: tradeIxs(mint, { price: 1e-8 * (1 + i / 100), timestamp: created + 10 + i }),
      blockTime: created + 10 + i,
    })
  await indexer.registerLaunch(sig)
  await idle(store)
  const record = await syncUntilCaughtUp(indexer, mint)
  assert.equal(record.createdAt, created)
  assert.equal(record.trades24h, 260)
  assert.equal(record.statsPartial, false)
  assert.ok(Math.abs(record.change24h - 259) < 1e-3, 'measured from the first trade')
})

test('24h change is unknown when the indexed history does not reach back a day', () => {
  const trades = [
    { id: 'b:0', slot: 2, timestamp: NOW - 60, price: 2, solAmount: '1000000000' },
    { id: 'a:0', slot: 1, timestamp: NOW - 120, price: 1, solAmount: '1000000000' },
  ]
  assert.equal(stats(trades, NOW).change24h, 100, 'complete history: since the first trade')
  const partial = stats(trades, NOW, { coveredFrom: NOW - 3600 })
  assert.equal(partial.change24h, null)
  assert.equal(partial.statsPartial, true)
  assert.deepEqual([partial.volume24h, partial.trades24h], [null, null], 'unknown, not counted')
  assert.equal(stats(trades, NOW, { coveredFrom: null }).volume24h, null)
  // A tracked coin's history that reaches back past the window counts it all.
  const old = stats(trades, NOW, { coveredFrom: NOW - 2 * 86400 })
  assert.deepEqual([old.volume24h, old.trades24h, old.statsPartial], [2, 2, false])
  // A backlog of unread transactions keeps the figures as a lower bound, flagged.
  const behind = stats(trades, NOW, { behind: true })
  assert.deepEqual([behind.trades24h, behind.statsPartial], [2, true])
  const unsynced = summarize({ mint: 'x' })
  assert.deepEqual(
    [unsynced.volume24h, unsynced.trades24h, unsynced.statsPartial],
    [null, null, true],
    'never synced: unknown, and flagged so',
  )
})

// ---- trade order --------------------------------------------------------------------------------
test('trades in one slot keep their execution order, not signature order', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = dbcPoolFor(mint)
  // Executed a, then b, then c in one slot; as strings, a sorts last and c first.
  const [a, b, c] = ['z', 'm', 'b'].map((ch) => ch.repeat(88))
  chain.add([curve], { sig: a, ixs: tradeIxs(mint, { price: 1e-8 }) })
  chain.add([curve], { sig: b, sameSlot: true, ixs: tradeIxs(mint, { price: 2e-8 }) })
  chain.add([curve], { sig: c, sameSlot: true, ixs: tradeIxs(mint, { price: 3e-8 }) })
  await store.set(`coin:${mint}`, {
    mint,
    dbcPool: curve,
    decimals: 6,
    external: false,
    cursor: null,
  })
  const record = await indexer.syncCoin(mint)
  assert.ok(Math.abs(record.price - 3e-8) < 1e-15)
  const { items } = await indexer.trades(mint)
  assert.deepEqual(
    items.map((t) => t.signature),
    [c, b, a],
  )
  const candles = await indexer.candles(mint, 60)
  assert.ok(Math.abs(candles.at(-1).close - 3e-8) < 1e-15)
  assert.ok(Math.abs(candles.at(-1).open - 1e-8) < 1e-15)
  // Event indexes compare as numbers.
  const x = { id: 's:9', slot: 1, index: 9 }
  const y = { id: 's:10', slot: 1, index: 10 }
  assert.ok(compareTrades(x, y) < 0)
  assert.equal(candlesFor([], 60).length, 0)
})

// ---- prices and market caps ---------------------------------------------------------------------
test('DAMM v2 trades are priced from the sqrt price the swap left', () => {
  const { signature: sig, tx } = fixture('damm-swap')
  const swap = extractEvents(tx).find((e) => e.name === 'EvtSwap2')
  const pool = swap.event.pool.toBase58()
  const [trade] = tradesFrom(tx, { signature: sig, mint: 'irrelevant', dbcPool: null, pool })
  assert.equal(trade.price, priceFromSqrtPrice(swap.event.swapResult.nextSqrtPrice))
  // It agrees with the amounts swapped, within the pool's fee and the swap's price impact.
  const r = swap.event.swapResult
  const [lamports, tokens] =
    trade.side === 'buy'
      ? [r.excludedFeeInputAmount, r.outputAmount]
      : [r.outputAmount, r.excludedFeeInputAmount]
  const average = Number(lamports) / 1e9 / (Number(tokens) / 1e6)
  assert.ok(Math.abs(trade.price / average - 1) < 0.05, `${trade.price} vs ${average}`)
})

test("tracking a migrated coin prices it from its DAMM v2 pool with the mint's real supply", async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  await chain.setAccounts(
    coinAccounts(mint, {
      creator: address(),
      price: 4e-7, // the curve's last price
      migrated: true,
      poolPrice: 6e-7,
      supply: 2_000_000_000_000_000n,
    }),
  )
  const coin = await indexer.track(mint)
  assert.deepEqual([coin.complete, coin.migrated, coin.pool], [true, true, dammPoolFor(mint)])
  assert.ok(Math.abs(coin.price - 6e-7) < 1e-18, 'the pool, not the curve')
  assert.equal(coin.supply, '2000000000000000')
  assert.ok(Math.abs(coin.marketCap - 6e-7 * 2e9) < 1e-6, 'its 2B supply, not 1B')
  assert.equal(coin.progress, 100)
  await idle(store)

  // A full curve Meteora has not migrated yet keeps its last curve price and reads 100%.
  const full = address()
  await chain.setAccounts(coinAccounts(full, { creator: address(), price: 4e-7, complete: true }))
  const waiting = await indexer.track(full)
  assert.deepEqual([waiting.complete, waiting.migrated, waiting.pool], [true, false, null])
  assert.ok(Math.abs(waiting.price - 4e-7) < 1e-18)
  assert.equal(waiting.progress, 100)
  await idle(store)

  // Burned supply counts too, and an unknown supply falls back to Quant Pad's 1B.
  chain.accounts.set(mint, mintAccount(900_000_000_000_000n))
  assert.equal((await readMarket(chain.connection, mint)).supply, '900000000000000')
  assert.equal(capSupply({}), network.totalSupply)
  assert.equal(
    stats([{ price: 1e-6, timestamp: NOW }], NOW, { supply: '900000000000000' }).marketCap,
    900,
  )
})

// ---- throttling and batches ---------------------------------------------------------------------
test('fetchTransactions keeps what it read when throttled and honours the deadline', async () => {
  const chain = await fakeChain('http://provider-a.invalid')
  const sigs = Array.from({ length: 40 }, () => chain.add([address()]))
  let served = 0
  chain.policy = () =>
    ++served > 2
      ? new Response('{"error":"Too many requests"}', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      : undefined
  const started = Date.now()
  const result = await fetchTransactions(chain.connection, sigs, { deadline: Date.now() + 2000 })
  assert.ok(Date.now() - started < 1500, 'a Retry-After past the deadline stops at once')
  assert.equal(result.partial, true)
  assert.equal(result.error.code, 'rpc_rate_limited')
  assert.deepEqual(
    result.map((r) => r.signature),
    sigs.slice(0, 20),
  )
  await assert.rejects(fetchTransactions(chain.connection, sigs, { deadline: Date.now() + 500 }), {
    status: 429,
    code: 'rpc_rate_limited',
  })
})

test('fetchTransactions falls back to single requests when a provider refuses batches', async () => {
  const chain = await fakeChain('http://provider-b.invalid')
  const sigs = Array.from({ length: 5 }, () => chain.add([address()]))
  chain.policy = (body) =>
    Array.isArray(body) && body.length > 1
      ? Response.json(
          {
            jsonrpc: '2.0',
            error: {
              code: -32600,
              message: "Maximum number of 'getTransaction' calls in a batch request is 1",
            },
            id: null,
          },
          { status: 400 },
        )
      : undefined
  const result = await fetchTransactions(chain.connection, sigs)
  assert.deepEqual(
    result.map((r) => r.signature),
    sigs,
  )
  assert.ok(result.every((r) => r.tx))
  chain.requests.length = 0
  await fetchTransactions(chain.connection, sigs.slice(0, 3))
  assert.equal(chain.requests.length, 3, 'the endpoint stays on single requests')
  assert.ok(chain.requests.every((b) => !Array.isArray(b)))
})

test('a throttled sync saves the progress it made and resumes from it', async () => {
  const chain = await fakeChain('http://provider-c.invalid')
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = dbcPoolFor(mint)
  const sigs = Array.from({ length: 40 }, (_, i) =>
    chain.add([curve], { ixs: tradeIxs(mint, { price: 1e-8 * (i + 1) }) }),
  )
  await store.set(`coin:${mint}`, {
    mint,
    dbcPool: curve,
    decimals: 6,
    external: false,
    cursor: null,
  })
  let served = 0
  chain.policy = () => (++served > 2 ? new Response('', { status: 429 }) : undefined)
  const record = await indexer.syncCoin(mint, { deadline: Date.now() + 300 })
  assert.equal(record.cursor, sigs[19])
  assert.equal((await indexer.trades(mint)).total, 20)
  assert.equal(record.behind, true)
  chain.policy = null
  // server/application.mjs holds `sync:coin:<mint>` as its cooldown while it calls syncCoin.
  await store.set(`sync:coin:${mint}`, 1, { nx: true, ttl: 10_000 })
  const next = await indexer.syncCoin(mint)
  assert.equal(next.cursor, sigs[39])
  assert.equal((await indexer.trades(mint)).total, 40)
})

// ---- passes, leases and locks -------------------------------------------------------------------
test('sync passes are leased past their time budget, rotate per coin and count only successes', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mints = [address(), address(), address()]
  const broken = mints[1]
  const listSignatures = chain.connection.getSignaturesForAddress
  chain.connection.getSignaturesForAddress = async (key, options) => {
    if (key.toBase58() === dbcPoolFor(broken)) throw Error('429 Too Many Requests')
    return listSignatures(key, options)
  }
  const getMany = chain.connection.getMultipleAccountsInfo
  chain.connection.getMultipleAccountsInfo = async (keys) => {
    if (keys[0].toBase58() === dbcPoolFor(broken)) throw Error('429 Too Many Requests')
    return getMany(keys)
  }
  for (const mint of mints) {
    const record = { mint, name: mint, dbcPool: dbcPoolFor(mint), external: false, cursor: null }
    await store.set(`coin:${mint}`, record)
  }
  await store.set(
    'coins:list',
    mints.map((mint) => summarize({ mint, external: false })),
  )
  const [first, second] = await Promise.all([
    indexer.sync({ budget: 3, timeMs: 5000 }),
    indexer.sync({ budget: 3, timeMs: 5000 }),
  ])
  assert.deepEqual(first, { synced: 2, failed: 1 })
  assert.deepEqual(second, { skipped: true })
  const lease = store.sets.find(([k]) => k === 'sync:lease')[1]
  assert.ok(lease.nx && lease.ttl > 5000 + 30_000, 'the lease outlives the pass')
  assert.deepEqual(
    store.sets.filter(([k]) => k === 'sync:cursor').length,
    3,
    'the rotation is saved after every coin',
  )
  assert.deepEqual(await indexer.sync({ budget: 3, timeMs: 0 }), { synced: 0, failed: 0 })
})

test('concurrent writers keep every coin in coins:list and one sync per coin', async () => {
  const chain = await fakeChain()
  const store = memoryStore({ latency: 4 })
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mints = Array.from({ length: 6 }, address)
  for (const mint of mints) await chain.setAccounts(coinAccounts(mint, { creator: address() }))
  await Promise.all(mints.map((mint) => indexer.track(mint)))
  await idle(store)
  assert.deepEqual((await indexer.list()).map((c) => c.mint).sort(), [...mints].sort())

  const mint = mints[0]
  chain.listed.length = 0
  await Promise.all([indexer.syncCoin(mint), indexer.syncCoin(mint), indexer.syncCoin(mint)])
  assert.equal(chain.listed.filter((l) => l.address === dbcPoolFor(mint)).length, 1)
})

test('external eviction keeps the coin just tracked and deletes evicted records', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  chain.connection.getSignaturesForAddress = async () => {
    throw Error('429 Too Many Requests') // the new coin's first sync fails
  }
  const old = Array.from({ length: 400 }, address)
  await store.set(
    'coins:list',
    old.map((mint, i) => summarize({ mint, external: true, syncedAt: 1000 + i })),
  )
  for (const mint of old.slice(0, 2)) {
    await store.set(`coin:${mint}`, { mint, external: true })
    await store.set(`trades:${mint}`, [{ id: 'x:0' }])
  }
  const mint = address()
  await chain.setAccounts(coinAccounts(mint, { creator: address() }))
  await indexer.track(mint)
  await idle(store)
  const listed = (await indexer.list()).map((c) => c.mint)
  assert.ok(listed.includes(mint), 'the coin just tracked stays')
  assert.equal(listed.length, 400)
  assert.ok(!listed.includes(old[0]))
  assert.equal(await store.get(`coin:${old[0]}`), null)
  assert.equal(await store.get(`trades:${old[0]}`), null)
  assert.ok(await store.get(`coin:${old[1]}`), 'only evicted coins are deleted')

  // A stored coin that dropped out of the list is listed again when it is tracked again.
  await store.set(
    'coins:list',
    (await indexer.list()).filter((c) => c.mint !== mint),
  )
  await indexer.track(mint)
  await idle(store)
  assert.ok((await indexer.list()).some((c) => c.mint === mint))
})

test('listed mints are shown in the main lists, tracked by the pass and kept at the cap', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const [shown, opened, hidden, plain, missing] = Array.from({ length: 5 }, address)
  for (const mint of [shown, opened, hidden, plain])
    await chain.setAccounts(coinAccounts(mint, { creator: address() }))
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: null,
    listed: [shown, opened, hidden, missing, 'not-a-mint'],
    hidden: [hidden],
  })
  await indexer.track(opened)
  await indexer.track(plain)
  await idle(store)
  let tracks = 0
  const getMany = chain.connection.getMultipleAccountsInfo
  chain.connection.getMultipleAccountsInfo = async (keys) => {
    if (keys.some((k) => k.toBase58() === missing)) tracks++
    return getMany(keys)
  }

  // The pass tracks the listed coin nobody opened, skips the hidden one, and gives up on a mint
  // that is not a Meteora coin.
  await indexer.sync({ budget: 0, timeMs: 5000 })
  await idle(store)
  const mints = (q) => indexer.market(q).then((r) => r.items.map((c) => c.mint).sort())
  assert.deepEqual(await mints({}), [shown, opened].sort())
  assert.deepEqual(await mints({ filter: 'tracked' }), [shown, opened, plain].sort())
  assert.ok(
    (await indexer.list()).every((c) => c.external),
    'listed coins stay external',
  )
  assert.ok(!(await indexer.list()).some((c) => c.mint === hidden))
  assert.ok(tracks > 0)
  const before = tracks
  await indexer.sync({ budget: 0, timeMs: 5000 })
  assert.equal(tracks, before, 'an untrackable mint is not retried')

  // At the external cap, unlisted coins make room and listed coins stay.
  const old = Array.from({ length: 400 }, address)
  await store.set('coins:list', [
    ...(await indexer.list()),
    ...old.map((mint, i) => summarize({ mint, external: true, syncedAt: 1000 + i })),
  ])
  const next = address()
  await chain.setAccounts(coinAccounts(next, { creator: address() }))
  await indexer.track(next)
  await idle(store)
  const kept = (await indexer.list()).map((c) => c.mint)
  assert.ok(kept.includes(shown) && kept.includes(opened))
  assert.equal(kept.filter((m) => m !== shown && m !== opened).length, 400)
})

// ---- busy coins ---------------------------------------------------------------------------------
test("a busy coin's 24h figures stay whole after its trade list is cut", async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  // A native launch with `old` trades, then 4100 trades in the last ~70 minutes: more than the
  // 4000 the trade list keeps.
  async function busy({ created, old = [] }) {
    const mint = address()
    const uri = 'https://quantpad.test/m/' + mint.slice(0, 32)
    await store.set(issuedUriKey(uri), { at: Date.now() })
    const sig = chain.add([dbcPoolFor(mint)], {
      ixs: launchIxs(mint, { creator: address(), uri, timestamp: created }),
      blockTime: created,
    })
    for (const [price, timestamp] of old)
      chain.add([dbcPoolFor(mint)], {
        ixs: tradeIxs(mint, { price, timestamp }),
        blockTime: timestamp,
      })
    for (let i = 0; i < 4100; i++) {
      const timestamp = NOW - 4100 + i
      chain.add([dbcPoolFor(mint)], {
        ixs: tradeIxs(mint, { price: 1e-8 * (1 + i / 1000), timestamp }),
        blockTime: timestamp,
      })
    }
    await indexer.registerLaunch(sig)
    await idle(store)
    const record = await syncUntilCaughtUp(indexer, mint, 400)
    assert.equal((await indexer.trades(mint)).total, 4000, 'the list is cut')
    assert.equal(record.trades24h, 4100, 'every trade of the day counts')
    assert.ok(Math.abs(record.volume24h - 4100) < 1e-6)
    assert.equal(record.buys24h + record.sells24h, 4100)
    assert.equal(record.statsPartial, false)
    assert.ok(record.day.b.length <= 98, 'a day of 15-minute buckets')
    return record
  }

  // Launched within the day: the change is measured from its first trade.
  const young = await busy({ created: NOW - 5000 })
  assert.ok(Math.abs(young.change24h - 409.9) < 1e-3, String(young.change24h))
  // Older: from the last trade before the window, which the list no longer holds.
  const older = await busy({
    created: NOW - 30 * 3600,
    old: [
      [2e-8, NOW - 26 * 3600],
      [5e-9, NOW - 25 * 3600],
    ],
  })
  const latest = 1e-8 * (1 + 4099 / 1000)
  assert.ok(Math.abs(older.change24h - (latest / 5e-9 - 1) * 100) < 1e-3, String(older.change24h))
  assert.equal(older.createdAt, NOW - 30 * 3600)
})

// ---- registration upgrades and metadata ---------------------------------------------------------
test('registering by mint upgrades a tracked coin to a native launch and keeps its metadata', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  const user = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'f'.repeat(32)
  await chain.setAccounts(coinAccounts(mint, { creator: user }))
  const create = chain.add([dbcPoolFor(mint)], {
    ixs: [...launchIxs(mint, { creator: user, uri }), ...tradeIxs(mint, { price: 3e-8 })],
  })
  assert.equal((await indexer.track(mint)).external, true)
  await idle(store)
  const meta = { name: 'Meta', image: 'https://img.test/a.png' }
  await indexer.updateCoin(mint, (c) => c && { ...c, meta, image: meta.image })
  assert.equal((await indexer.list())[0].image, meta.image)

  // Not provably a Quant Pad launch yet: it stays a tracked coin.
  await assert.rejects(indexer.registerLaunch('', { mint }), { status: 400, code: 'not_quantpad' })
  assert.equal((await indexer.coin(mint)).external, true)

  await store.set(issuedUriKey(uri), { at: Date.now() })
  const coin = await indexer.registerLaunch('', { mint })
  assert.deepEqual(
    [coin.external, coin.source, coin.provenance, coin.launcher, coin.signature],
    [false, 'quantpad', 'issued-uri', user, create],
  )
  assert.deepEqual([coin.meta, coin.image], [meta, meta.image])
  await idle(store)
  const listed = await indexer.list()
  assert.equal(listed.length, 1)
  assert.deepEqual(
    [listed[0].external, listed[0].launcher, listed[0].image],
    [false, user, meta.image],
  )
  assert.equal((await indexer.market()).total, 1, 'listed among Quant Pad launches')
})

test('metadata saved while a sync reads the chain stays on the record and in the list', async () => {
  const chain = await fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = dbcPoolFor(mint)
  chain.add([curve], { ixs: tradeIxs(mint, { price: 2e-8 }) })
  await store.set(`coin:${mint}`, {
    mint,
    name: 'M',
    dbcPool: curve,
    decimals: 6,
    external: false,
    cursor: null,
  })
  await store.set('coins:list', [summarize({ mint, name: 'M', external: false })])
  let release
  const gate = new Promise((r) => (release = r))
  const listSignatures = chain.connection.getSignaturesForAddress
  chain.connection.getSignaturesForAddress = async (...args) => {
    await gate
    return listSignatures(...args)
  }
  const syncing = indexer.syncCoin(mint)
  await new Promise((r) => setTimeout(r, 20))
  // An unlocked write from outside the indexer while the sync waits on the RPC.
  const meta = { name: 'M', image: 'https://img.test/m.png' }
  await store.set(`coin:${mint}`, { ...(await store.get(`coin:${mint}`)), meta, image: meta.image })
  release()
  const record = await syncing
  assert.ok(record.price > 0)
  assert.deepEqual([record.meta, record.image], [meta, meta.image])
  assert.equal((await indexer.coin(mint)).image, meta.image)
  const [summary] = await indexer.list()
  assert.equal(summary.image, meta.image, 'the list keeps the image')
  assert.ok(summary.price > 0)

  // updateCoin lists the stored record even when it changes nothing, and an unchanged summary is
  // not written again.
  await store.set('coins:list', [{ ...summary, image: null }])
  store.sets.length = 0
  await indexer.updateCoin(mint, (c) => c && c.image !== meta.image && { ...c, image: meta.image })
  assert.equal((await indexer.list())[0].image, meta.image)
  assert.ok(!store.sets.some(([k]) => k === `coin:${mint}`), 'the record was already current')
  store.sets.length = 0
  await indexer.updateCoin(mint, () => null)
  assert.ok(!store.sets.some(([k]) => k === 'coins:list'), 'nothing to write')
})

// The verifier's race: a metadata write (server/application.mjs, through updateCoin) landing
// while a sync advances one coin and another coin is tracked.
test('a metadata update racing a sync and another track loses neither', async () => {
  const chain = await fakeChain()
  const store = memoryStore({ latency: 4 })
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const [a, b] = [address(), address()]
  for (const mint of [a, b]) await chain.setAccounts(coinAccounts(mint, { creator: address() }))
  await indexer.track(a)
  await idle(store)
  const sigs = Array.from({ length: 5 }, (_, i) =>
    chain.add([dbcPoolFor(a)], { ixs: tradeIxs(a, { price: 1e-8 * (i + 1) }) }),
  )
  const meta = { name: 'A', image: 'https://img.test/a.png' }
  for (let round = 0; round < 3; round++) {
    await Promise.all([
      indexer.updateCoin(a, (c) => c && { ...c, meta: { ...meta, round }, image: meta.image }),
      indexer.syncCoin(a),
      round === 0 ? indexer.track(b) : indexer.syncCoin(b),
    ])
    await idle(store)
  }
  const record = await indexer.coin(a)
  assert.equal(record.cursor, sigs.at(-1), 'the cursor never rolls back')
  assert.equal(record.seq, 5)
  assert.deepEqual([record.meta, record.image], [{ ...meta, round: 2 }, meta.image])
  assert.equal((await indexer.trades(a)).total, 5)
  const listed = await indexer.list()
  assert.deepEqual(listed.map((c) => c.mint).sort(), [a, b].sort())
  assert.equal(listed.find((c) => c.mint === a).image, meta.image)
})

// ---- C1 -----------------------------------------------------------------------------------------
test('C1: route errors carry a 4xx status, and RPC failures a retryable one without details', async () => {
  const chain = await fakeChain('http://provider-d.invalid')
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const user = address()
  const uri = 'https://quantpad.test/m/' + '0'.repeat(32)
  await store.set(issuedUriKey(uri), { at: Date.now() })

  // /api/launches sends a signature, a mint, or both.
  await assert.rejects(indexer.registerLaunch('', {}), { status: 400, code: 'invalid_signature' })
  await assert.rejects(indexer.registerLaunch(undefined, { mint: undefined }), { status: 400 })
  await assert.rejects(indexer.registerLaunch(signature(), { mint: 'nope' }), {
    status: 400,
    code: 'invalid_mint',
    message: 'Enter a valid Solana mint address.',
  })
  const plain = chain.add([address()])
  await assert.rejects(indexer.registerLaunch(plain), {
    status: 400,
    code: 'not_create',
    message: 'That transaction did not create a Meteora coin.',
  })
  const failedSig = chain.add([address()])
  chain.txs.get(failedSig).meta.err = { InstructionError: [0, { Custom: 6000 }] }
  await assert.rejects(indexer.registerLaunch(failedSig), {
    status: 400,
    code: 'failed_transaction',
  })
  const usdc = address()
  const quoted = address()
  // A USDC-quoted coin (its config quotes USDC): refused by signature and by mint.
  const usdcConfig = address()
  chain.accounts.set(usdcConfig, await dbcConfigAccount({ quoteMint: usdc }))
  await chain.setAccounts(coinAccounts(quoted, { creator: user, config: usdcConfig }))
  const quotedSig = chain.add([dbcPoolFor(quoted, usdcConfig)], {
    ixs: launchIxs(quoted, { creator: user, uri, quoteMint: usdc, config: usdcConfig }),
  })
  for (const call of [
    () => indexer.registerLaunch(quotedSig),
    () => indexer.registerLaunch('', { mint: quoted }),
  ])
    await assert.rejects(call(), {
      status: 400,
      code: 'not_sol_quote',
      message: 'Quant Pad tracks SOL-quoted coins only.',
    })

  // /api/coins/track.
  await assert.rejects(indexer.track('nope'), {
    status: 400,
    message: 'Enter a valid Solana mint address.',
  })
  await assert.rejects(indexer.track(address()), { status: 404, code: 'not_meteora' })
  const other = address()
  await chain.setAccounts(coinAccounts(other, { creator: user, config: usdcConfig }))
  await assert.rejects(indexer.track(other), { status: 400, code: 'not_sol_quote' })

  // RPC failures: a status the client retries, and never the provider's message.
  const secret = 'https://rpc.invalid/?api-key=SECRET'
  const exposed = (e, status, code) => {
    assert.deepEqual([e.status, e.code, e.expose], [status, code, true])
    assert.ok(!e.message.includes('SECRET'))
    return true
  }
  // Registration by mint finds the pool, then cannot list its history.
  const unlisted = address()
  await chain.setAccounts(coinAccounts(unlisted, { creator: user }))
  const listSignatures = chain.connection.getSignaturesForAddress
  chain.connection.getSignaturesForAddress = async () => {
    throw Error('fetch failed ' + secret)
  }
  await assert.rejects(indexer.registerLaunch('', { mint: unlisted }), (e) =>
    exposed(e, 503, 'rpc_unavailable'),
  )
  chain.connection.getSignaturesForAddress = listSignatures
  chain.connection.getMultipleAccountsInfo = async () => {
    throw Error(`failed to get info about account: fetch failed ${secret}`)
  }
  await assert.rejects(indexer.track(address()), (e) => exposed(e, 503, 'rpc_unavailable'))
  chain.connection.getMultipleAccountsInfo = async () => {
    throw Error('429 Too Many Requests')
  }
  await assert.rejects(indexer.track(address()), (e) => exposed(e, 429, 'rpc_rate_limited'))
  chain.policy = () => new Response('upstream exploded ' + secret, { status: 500 })
  await assert.rejects(indexer.registerLaunch(signature()), (e) =>
    exposed(e, 503, 'rpc_unavailable'),
  )
  chain.connection.getMultipleAccountsInfo = async () => {
    throw Error(`fetch failed ${secret}`)
  }
  await assert.rejects(indexer.registerLaunch('', { mint: address() }), (e) =>
    exposed(e, 503, 'rpc_unavailable'),
  )
  // /api/sync gets the same when a coin's sync could read nothing.
  chain.connection.getSignaturesForAddress = async () => {
    throw Error('fetch failed ' + secret)
  }
  const mint = address()
  await store.set(`coin:${mint}`, {
    mint,
    dbcPool: dbcPoolFor(mint),
    decimals: 6,
    external: false,
    cursor: null,
  })
  await assert.rejects(indexer.syncCoin(mint), (e) => exposed(e, 503, 'rpc_unavailable'))
  // So does one that does not know its coin's decimals yet and cannot read them.
  const unread = address()
  await store.set(`coin:${unread}`, {
    mint: unread,
    dbcPool: dbcPoolFor(unread),
    external: false,
    cursor: null,
  })
  await assert.rejects(indexer.syncCoin(unread), (e) => exposed(e, 503, 'rpc_unavailable'))
})
