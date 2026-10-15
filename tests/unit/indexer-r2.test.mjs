// Indexer round 2: launch provenance and the native cap (QP-SEC-9, K5), the onNativeLaunch
// callback that lets the app keep a launch's media (QP-SEC-2), and coin identities read from
// Metaplex metadata (Quant Pad's SPL Token coins) or the Token-2022 metadata extension
// (build-defect-4). Runs against an in-memory chain and store, with Meteora DBC transactions and
// accounts, and a real Quant Pad coin's mainnet accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { network } from '../../shared/network.mjs'
import { createIndexer, issuedUriKey, issuedUriClaimKey, summarize } from '../../server/indexer.mjs'
import { candlesFor } from '../../server/market-math.mjs'
import {
  readMarket,
  readTokenIdentity,
  metaplexMetadataPda,
  METAPLEX_METADATA,
} from '../../server/solana.mjs'
import {
  CONFIG,
  MAINNET,
  NOW,
  address,
  coinAccounts,
  createIx,
  dbcPoolFor,
  fakeChain,
  fakeQuantum,
  idle,
  installFetch,
  memoryStore,
  swapIx,
} from './meteora-chain.mjs'

const DAY_MS = 86_400_000
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))
installFetch(test)

// A curve trade that leaves the coin at `price` SOL per whole token (`lamports` in, 1 SOL default).
const tradeIxs = (mint, options) => [swapIx(mint, options)]

const account = (owner, data) => ({
  data: Buffer.from(data),
  owner: new PublicKey(owner),
  lamports: 1,
  executable: false,
})
const borsh = (text, size = Buffer.byteLength(text)) => {
  const bytes = Buffer.alloc(size)
  bytes.write(text)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(size)
  return Buffer.concat([length, bytes])
}
// A Token-2022 mint whose TokenMetadata extension (type 19) holds the coin's identity.
function token2022Mint(mint, { name, symbol, uri }) {
  const metadata = Buffer.concat([
    Buffer.alloc(32), // update authority (none)
    new PublicKey(mint).toBuffer(),
    borsh(name),
    borsh(symbol),
    borsh(uri),
    Buffer.alloc(4), // no additional metadata
  ])
  const tlv = Buffer.alloc(4)
  tlv.writeUInt16LE(19, 0)
  tlv.writeUInt16LE(metadata.length, 2)
  const base = Buffer.alloc(166)
  base[45] = 1 // initialized
  base[165] = 1 // AccountType::Mint
  return account(network.token2022Program, Buffer.concat([base, tlv, metadata]))
}
// A Metaplex MetadataV1 account with NUL-padded fixed-size fields, as DBC's SPL Token coins have.
const metaplexAccount = (mint, { name, symbol, uri }) =>
  account(
    METAPLEX_METADATA,
    Buffer.concat([
      Buffer.from([4]),
      Keypair.generate().publicKey.toBuffer(),
      new PublicKey(mint).toBuffer(),
      borsh(name, 32),
      borsh(symbol, 10),
      borsh(uri, 200),
      Buffer.alloc(40),
    ]),
  )

// ---- a real Quant Pad coin: its mainnet mint (SPL Token), Metaplex metadata and DBC pool on the
// 1% launch config, and its launch transaction (tests/fixtures) ----------------------------------
const LAUNCH = fixture('dbc-create')
const REAL = 'CVmkkge8UBWfCpJJHB2GZ5CzrpHppaoJgs2Rn45r6sQP'
const REAL_POOL = 'FHbTvBB7jRmY7FgQunGAji9NjcvrAcsXfyjokGiiXy2P'
const REAL_CREATOR = 'HrmZXCF6yZN6QhB7AmqPwFeqHEGGgXM7YKf3KwoJFGLx'
const REAL_ACCOUNTS = Object.fromEntries(
  [REAL, metaplexMetadataPda(REAL).toBase58(), REAL_POOL].map((k) => [k, MAINNET[k]]),
)
const REAL_IDENTITY = {
  name: 'test1',
  symbol: 'TEST',
  uri: 'https://quant-pad.vercel.app/m/ec9a330326c26291842f8269919cb5e4',
}

const identityReads = (chain, mint) =>
  chain.reads.filter((keys) => keys.includes(metaplexMetadataPda(mint).toBase58())).length

// A clock the test moves, and an indexer that records its onNativeLaunch calls.
async function setup({ fail = 0, ...options } = {}) {
  const chain = await fakeChain()
  const store = memoryStore()
  const clock = { at: Date.now() }
  const calls = []
  let failures = fail
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: options.quantum === undefined ? fakeQuantum(chain) : options.quantum,
    now: () => clock.at,
    onNativeLaunch: async (launch) => {
      calls.push(launch)
      if (failures-- > 0) throw Error('media store unavailable')
    },
    ...options,
  })
  return { chain, store, clock, calls, indexer }
}
// /api/metadata issuing `uri`, and a DBC launch (with a 1 SOL dev buy) that uses it.
async function launch(
  chain,
  store,
  { mint = address(), uri, creator = address(), timestamp = NOW } = {},
) {
  uri ||= `https://quantpad.test/m/${randomBytes(16).toString('hex')}`
  await store.set(issuedUriKey(uri), { at: Date.now() }, { ttl: DAY_MS })
  await chain.setAccounts(coinAccounts(mint, { creator }))
  const sig = chain.add([dbcPoolFor(mint)], {
    ixs: [
      createIx(mint, { creator, uri, activationPoint: timestamp }),
      swapIx(mint, { price: 3e-8, timestamp, payer: creator }),
    ],
    blockTime: timestamp,
  })
  return { mint, uri, sig, creator }
}

// ---- QP-SEC-9 / K5: issued URIs are single-use ------------------------------------------------
test('K5: a native registration consumes its issued URI and announces the launch once', async () => {
  const { chain, store, calls, indexer } = await setup()
  const { mint, uri, sig } = await launch(chain, store)

  const coin = await indexer.registerLaunch(sig)
  assert.equal(coin.provenance, 'issued-uri')
  assert.deepEqual(calls, [{ mint, uri }])
  assert.equal(await store.get(issuedUriKey(uri)), null, 'the issued-uri record is consumed')
  assert.equal(await store.get(issuedUriClaimKey(uri)), mint, 'the URI is bound to this coin')
  await idle(store)
  assert.equal((await indexer.coin(mint)).nativeNotice, 'done')

  // Registering the same coin again (by signature or by mint) stays idempotent.
  assert.equal((await indexer.registerLaunch(sig)).mint, mint)
  assert.equal((await indexer.registerLaunch('', { mint })).mint, mint)
  await idle(store)
  assert.equal(calls.length, 1, 'announced once')

  // /api/metadata issuing the same document again does not let a second coin use it.
  await store.set(issuedUriKey(uri), { at: Date.now() }, { ttl: DAY_MS })
  const copy = await launch(chain, store, { uri })
  await assert.rejects(indexer.registerLaunch(copy.sig), { status: 400, code: 'not_quantpad' })
  assert.equal(await indexer.coin(copy.mint), null)
  assert.deepEqual(
    (await indexer.list()).map((c) => c.mint),
    [mint],
  )
  assert.equal(calls.length, 1)
})

test('K5: concurrent registrations of one coin list and announce it once', async () => {
  const { chain, store, calls, indexer } = await setup()
  const { mint, sig } = await launch(chain, store)
  const results = await Promise.all([
    indexer.registerLaunch(sig),
    indexer.registerLaunch('', { mint }),
    indexer.registerLaunch(sig),
  ])
  assert.deepEqual(
    results.map((r) => r.mint),
    [mint, mint, mint],
  )
  await idle(store)
  assert.equal(calls.length, 1)
  assert.equal((await indexer.list()).length, 1)

  // Two coins racing for one issued URI: exactly one is listed.
  const uri = 'https://quantpad.test/m/' + 'f'.repeat(32)
  const a = await launch(chain, store, { uri })
  const b = await launch(chain, store, { uri })
  const raced = await Promise.allSettled([
    indexer.registerLaunch(a.sig),
    indexer.registerLaunch(b.sig),
  ])
  assert.deepEqual(raced.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(raced.find((r) => r.status === 'rejected').reason.code, 'not_quantpad')
  await idle(store)
  assert.equal(calls.length, 2)
})

test('K5: a failed onNativeLaunch is retried by a later sync, then never again', async () => {
  const { chain, store, clock, calls, indexer } = await setup({ fail: 1 })
  const { mint, uri, sig } = await launch(chain, store)
  const coin = await indexer.registerLaunch(sig) // the registration itself still succeeds
  assert.equal(coin.external, false)
  assert.equal(calls.length, 1)
  await idle(store) // the registration's own sync does not retry straight away
  assert.equal(calls.length, 1)
  assert.equal((await indexer.coin(mint)).nativeNotice, 'pending')

  clock.at += 61_000
  await indexer.syncCoin(mint)
  assert.deepEqual(calls, [
    { mint, uri },
    { mint, uri },
  ])
  assert.equal((await indexer.coin(mint)).nativeNotice, 'done')
  clock.at += 3_600_000
  await indexer.syncCoin(mint)
  assert.equal(calls.length, 2)
})

test('K5: tracked Quantum coins are announced, including ones upgraded by a sync', async () => {
  const { chain, store, calls, indexer } = await setup()
  const quantum = fakeQuantum(chain)
  const launcher = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + '1'.repeat(32)
  quantum.register(mint, launcher)
  await chain.setAccounts(coinAccounts(mint, { creator: quantum.well(mint) }))
  chain.accounts.set(mint, account(network.tokenProgram, Buffer.alloc(82)))
  chain.accounts.set(
    metaplexMetadataPda(mint).toBase58(),
    metaplexAccount(mint, { name: 'Q', symbol: 'Q', uri }),
  )
  const tracked = await indexer.track(mint)
  assert.equal(tracked.external, false)
  assert.deepEqual(calls, [{ mint, uri }])
  await idle(store)

  const stale = address()
  quantum.register(stale, launcher)
  await chain.setAccounts(coinAccounts(stale, { creator: quantum.well(stale) }))
  const record = {
    mint: stale,
    name: 'Stale',
    symbol: 'S',
    uri: 'https://quantpad.test/m/' + '2'.repeat(32),
    creator: quantum.well(stale),
    dbcPool: dbcPoolFor(stale),
    quantum: false,
    external: true,
    source: 'meteora',
    cursor: null,
  }
  await store.set(`coin:${stale}`, record)
  await store.set('coins:list', [summarize(record), ...(await indexer.list())])
  const synced = await indexer.syncCoin(stale)
  assert.equal(synced.external, false)
  assert.deepEqual(calls.at(-1), { mint: stale, uri: record.uri })
  assert.equal(calls.length, 2)
  await indexer.syncCoin(stale)
  assert.equal(calls.length, 2)
})

// ---- QP-SEC-9 / K5: the native cap ------------------------------------------------------------
test('K5: hidden mints do not count against the native cap', async () => {
  const hiddenMint = address()
  const { chain, store, indexer } = await setup({ maxNative: 1, hidden: new Set([hiddenMint]) })
  await store.set('coins:list', [summarize({ mint: hiddenMint, name: 'H', external: false })])
  const { mint, sig } = await launch(chain, store)
  assert.equal((await indexer.registerLaunch(sig)).mint, mint)
  await idle(store)
  const other = await launch(chain, store)
  await assert.rejects(indexer.registerLaunch(other.sig), { status: 429, code: 'launch_cap' })
  assert.ok(await store.get(issuedUriKey(other.uri)), 'a refused launch keeps its issued URI')
})

test('QP-SEC-9: at the cap, launches whose trading stopped make room; active ones stay', async () => {
  const hiddenMint = address()
  const { chain, store, clock, indexer } = await setup({ maxNative: 7, hidden: [hiddenMint] })
  const at = clock.at
  const old = at - 8 * DAY_MS
  const oldSecs = Math.floor(old / 1000)
  const hourAgo = Math.floor(at / 1000) - 3600
  const coins = {
    untraded: { lastTradeAt: null },
    devBuyOnly: { lastTradeAt: oldSecs + 5, volume7d: 0 },
    // What the first fix kept for good: one dust buy after the launch minute.
    tradedOnce: { lastTradeAt: oldSecs + 3600, volume7d: 0 },
    // A dust buy every few days keeps a recent trade, but not 1 SOL of weekly volume.
    dusted: { lastTradeAt: hourAgo, volume7d: 0.001 },
    // Registered again yesterday after an eviction: its age counts from its create.
    reRegistered: { registeredAt: at - DAY_MS, lastTradeAt: null },
    active: { lastTradeAt: hourAgo, volume7d: 5 },
    // Synced before volume7d existed: its recent trade keeps it until a sync measures it.
    unmeasured: { lastTradeAt: hourAgo },
    quantum: { lastTradeAt: null, quantum: true },
    recent: {
      registeredAt: at - 2 * DAY_MS,
      createdAt: Math.floor((at - 2 * DAY_MS) / 1000),
      lastTradeAt: null,
    },
    stillReading: { lastTradeAt: null, behind: true },
    hidden: { lastTradeAt: null },
    // Not verified either way yet: it may be a Quantum coin the keeper serves.
    unverified: { lastTradeAt: null, quantum: null },
  }
  const mints = {}
  const items = []
  for (const [label, fields] of Object.entries(coins)) {
    const mint = label === 'hidden' ? hiddenMint : address()
    mints[label] = mint
    const record = {
      mint,
      name: label,
      external: false,
      quantum: false,
      behind: false,
      registeredAt: old,
      createdAt: oldSecs,
      ...fields,
    }
    await store.set(`coin:${mint}`, record)
    await store.set(`trades:${mint}`, [{ id: 'x:0' }])
    // The listed summary of the coin still reading its history looks stale; its record does not.
    items.push(summarize({ ...record, behind: undefined }))
  }
  await store.set('coins:list', items)

  const fresh = await launch(chain, store)
  assert.equal((await indexer.registerLaunch(fresh.sig)).external, false)
  await idle(store)
  const listed = (await indexer.list()).map((c) => c.mint)
  for (const label of ['untraded', 'devBuyOnly', 'tradedOnce', 'dusted', 'reRegistered']) {
    assert.ok(!listed.includes(mints[label]), `${label} is evicted`)
    assert.equal(await store.get(`coin:${mints[label]}`), null)
    assert.equal(await store.get(`trades:${mints[label]}`), null)
  }
  for (const label of [
    'active',
    'unmeasured',
    'quantum',
    'recent',
    'stillReading',
    'hidden',
    'unverified',
  ])
    assert.ok(listed.includes(mints[label]), `${label} stays`)
  assert.ok(listed.includes(fresh.mint))

  // Nothing stale left: the next launch is refused rather than evicting a live one.
  const next = await launch(chain, store)
  await assert.rejects(indexer.registerLaunch(next.sig), { status: 429, code: 'launch_cap' })
  assert.equal((await indexer.list()).length, listed.length)

  // A week later the fresh launch, never traded after its dev buy, makes room in turn.
  clock.at += 8 * DAY_MS
  const later = await launch(chain, store, { timestamp: Math.floor(clock.at / 1000) })
  assert.equal((await indexer.registerLaunch(later.sig)).mint, later.mint)
  await idle(store)
  assert.ok(!(await indexer.list()).some((c) => c.mint === fresh.mint))
})

test('QP-SEC-9: a dust buy a week on does not keep a junk launch listed', async () => {
  const { chain, store, clock, indexer } = await setup({ maxNative: 2 })
  const junk = await launch(chain, store)
  const kept = await launch(chain, store)
  for (const { sig } of [junk, kept]) await indexer.registerLaunch(sig)
  await idle(store)
  const registered = await indexer.coin(junk.mint)
  assert.equal(registered.volume7d, 1, 'the 1 SOL dev buy')
  assert.equal((await indexer.list()).find((c) => c.mint === junk.mint).volume7d, 1)

  // Eight days on, the junk launch gets a 1000-lamport buy an hour ago; the other one trades 2 SOL.
  clock.at += 8 * DAY_MS
  const hourAgo = Math.floor(clock.at / 1000) - 3600
  for (const [mint, lamports] of [
    [junk.mint, 1000],
    [kept.mint, 2e9],
  ])
    chain.add([dbcPoolFor(mint)], {
      ixs: tradeIxs(mint, { price: 3e-8, timestamp: hourAgo, lamports }),
      blockTime: hourAgo,
    })
  const dusted = await indexer.syncCoin(junk.mint)
  assert.equal(dusted.lastTradeAt, hourAgo)
  assert.ok(dusted.volume7d < 0.001)
  assert.equal((await indexer.syncCoin(kept.mint)).volume7d, 2)

  const real = await launch(chain, store, { timestamp: Math.floor(clock.at / 1000) })
  assert.equal((await indexer.registerLaunch(real.sig)).mint, real.mint)
  await idle(store)
  assert.deepEqual((await indexer.list()).map((c) => c.mint).sort(), [kept.mint, real.mint].sort())
  assert.deepEqual(
    [...store.data.keys()].filter((k) => k.includes(junk.mint)),
    [],
    'the record, its trade chunks and candles are gone',
  )

  // Its URI stays bound to it, but registering it again cannot push out a live launch (and its
  // age counts from its create, so it would be the first to go again).
  assert.equal(await store.get(issuedUriClaimKey(junk.uri)), junk.mint)
  await assert.rejects(indexer.registerLaunch(junk.sig), { status: 429, code: 'launch_cap' })
  assert.equal((await indexer.list()).length, 2)
})

test('QP-SEC-9: one wallet lists at most launchesPerWallet launches a day', async () => {
  const { chain, store, clock, indexer } = await setup({ launchesPerWallet: 2 })
  const creator = address()
  const [a, b, c] = [
    await launch(chain, store, { creator }),
    await launch(chain, store, { creator }),
    await launch(chain, store, { creator }),
  ]
  // Concurrent registrations of one coin, and registering it again, take one slot.
  await Promise.all([
    indexer.registerLaunch(a.sig),
    indexer.registerLaunch(a.sig),
    indexer.registerLaunch('', { mint: a.mint }),
  ])
  await indexer.registerLaunch(a.sig)
  assert.equal((await indexer.registerLaunch(b.sig)).mint, b.mint)
  await assert.rejects(indexer.registerLaunch(c.sig), { status: 429, code: 'launch_cap' })
  assert.equal(await indexer.coin(c.mint), null)
  // Another wallet is not held back.
  const other = await launch(chain, store)
  assert.equal((await indexer.registerLaunch(other.sig)).external, false)
  await idle(store)

  // The next day the refused coin registers, although its issued-uri record has expired: the
  // URI stayed bound to it.
  clock.at += DAY_MS
  await store.delete(issuedUriKey(c.uri))
  assert.equal(await store.get(issuedUriClaimKey(c.uri)), c.mint)
  assert.equal((await indexer.registerLaunch(c.sig)).mint, c.mint)
  await idle(store)
  assert.equal((await indexer.list()).length, 4)
})

test('QP-SEC-9: a registration that fails to store its record gives the wallet its slot back', async () => {
  const { chain, store, indexer } = await setup({ launchesPerWallet: 1 })
  const { mint, sig } = await launch(chain, store)
  const { set } = store
  let failing = true
  store.set = (k, v, o) => {
    if (failing && k === `coin:${mint}`) {
      failing = false
      return Promise.reject(Error('store unavailable'))
    }
    return set(k, v, o)
  }
  await assert.rejects(indexer.registerLaunch(sig), /store unavailable/)
  assert.equal((await indexer.registerLaunch(sig)).mint, mint)
  await idle(store)
  assert.equal((await indexer.trades(mint)).total, 1, 'the dev buy, once')
})

// ---- QP-SEC-4: pageable trade storage -----------------------------------------------------------
// `count` stored trades, newest first, older than anything the fake chain adds (slots 100+).
const synthetic = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}:0`,
    signature: `s${i}`,
    slot: 100 + i,
    seq: 0,
    index: 0,
    side: i % 3 ? 'buy' : 'sell',
    price: 1e-8 * (1 + (i % 50) / 10),
    solAmount: String(1e7 * (1 + (i % 7))),
    timestamp: NOW - 400_000 + i * 97,
    venue: 'curve',
  })).reverse()
const nativeRecord = (mint) => ({
  mint,
  name: 'Synthetic',
  symbol: 'SYN',
  uri: 'https://quantpad.test/m/syn',
  creator: address(),
  dbcPool: dbcPoolFor(mint),
  decimals: 6,
  external: false,
  quantum: false,
  source: 'quantpad',
  cursor: null,
  poolCursor: null,
  complete: false,
  registeredAt: Date.now(),
  createdAt: NOW - 400_000,
})
// Records the keys a store reads and writes.
function spy(store) {
  const io = { reads: [], writes: [] }
  const { get, set } = store
  store.get = (k) => (io.reads.push(k), get(k))
  store.set = (k, v, o) => (io.writes.push(k), set(k, v, o))
  io.reset = () => {
    io.reads.length = 0
    io.writes.length = 0
  }
  io.chunkReads = () => io.reads.filter((k) => /^trades:\w+:\d+$/.test(k))
  return io
}
const expectedPage = (rows, { side, offset = 0, limit = 50 } = {}) => {
  const matching = rows.filter((t) => !side || t.side === side)
  return {
    items: matching.slice(offset, offset + limit),
    total: matching.length,
    next: offset + limit < matching.length ? offset + limit : null,
  }
}

test('QP-SEC-4: trades are kept in chunks; a page reads only the chunks it covers', async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  const mint = address()
  const legacy = synthetic(1234)
  await store.set(`coin:${mint}`, nativeRecord(mint))
  await store.set(`trades:${mint}`, legacy) // the old single-value form
  assert.deepEqual(await indexer.trades(mint, { offset: 10 }), expectedPage(legacy, { offset: 10 }))
  assert.deepEqual(await indexer.candles(mint, 60), candlesFor(legacy, 60))

  // The coin's next sync rewrites it in chunks, full ones oldest and a partial one newest.
  await indexer.syncCoin(mint)
  const head = await store.get(`trades:${mint}`)
  assert.deepEqual([head.v, head.total, head.next], [2, 1234, 3])
  assert.deepEqual(
    head.chunks.map((c) => [c.n, c.count, c.buys + c.sells]),
    [
      [2, 234, 234],
      [1, 500, 500],
      [0, 500, 500],
    ],
  )

  const io = spy(store)
  for (const [options, reads] of [
    [{}, 1],
    [{ offset: 300 }, 1],
    [{ offset: 200 }, 2], // spans the newest two chunks
    [{ offset: 1200 }, 1],
    [{ offset: 1234 }, 0],
    [{ offset: 99999 }, 0],
    [{ side: 'sell', offset: 100 }],
    [{ side: 'buy', offset: 790, limit: 20 }],
    [{ side: 'sell', offset: 400 }],
  ]) {
    io.reset()
    assert.deepEqual(await indexer.trades(mint, options), expectedPage(legacy, options))
    if (reads === undefined) assert.ok(io.chunkReads().length <= 2, JSON.stringify(options))
    else assert.equal(io.chunkReads().length, reads, JSON.stringify(options))
  }

  // Candles come from the stored 15-second buckets alone, identical to building them from trades.
  for (const interval of [15, 60, 300, 900, 3600, 14400, 86400]) {
    io.reset()
    assert.deepEqual(await indexer.candles(mint, interval), candlesFor(legacy, interval))
    assert.deepEqual(io.reads, [`trades:${mint}:candles`])
  }
  assert.deepEqual(await indexer.candles(mint, 7), candlesFor(legacy, 7))

  // New trades: the partial newest chunk is written again with them; the full ones stay.
  const stale = await store.get(`trades:${mint}`)
  for (const price of [5e-8, 6e-8, 7e-8])
    chain.add([dbcPoolFor(mint)], { ixs: tradeIxs(mint, { price }) })
  io.reset()
  await indexer.syncCoin(mint)
  const after = await store.get(`trades:${mint}`)
  assert.deepEqual(
    after.chunks.map((c) => [c.n, c.count]),
    [
      [3, 237],
      [1, 500],
      [0, 500],
    ],
  )
  assert.deepEqual(
    io.writes.filter((k) => k.startsWith('trades:')).sort(),
    [`trades:${mint}`, `trades:${mint}:3`, `trades:${mint}:candles`].sort(),
  )
  assert.equal(await store.get(`trades:${mint}:2`), null, 'the replaced chunk is deleted')
  const latest = await indexer.trades(mint, { limit: 5 })
  assert.equal(latest.total, 1237)
  assert.deepEqual(
    latest.items.slice(3).map((t) => t.id),
    legacy.slice(0, 2).map((t) => t.id),
  )

  // A reader holding the index from before that merge finds its chunk gone and reads it again.
  let once = true
  const read = store.get
  store.get = (k) => {
    if (once && k === `trades:${mint}`) {
      once = false
      return Promise.resolve(structuredClone(stale))
    }
    return read(k)
  }
  assert.deepEqual(await indexer.trades(mint, { limit: 5 }), latest)
  assert.equal(once, false)
})

test('QP-SEC-4: at the cap the oldest chunk is trimmed in the index, not written again', async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  const mint = address()
  const legacy = synthetic(4000)
  await store.set(`coin:${mint}`, nativeRecord(mint))
  await store.set(`trades:${mint}`, legacy)
  await indexer.syncCoin(mint)
  assert.deepEqual(
    (await store.get(`trades:${mint}`)).chunks.map((c) => c.n),
    [7, 6, 5, 4, 3, 2, 1, 0],
  )
  for (const price of [5e-8, 6e-8, 7e-8])
    chain.add([dbcPoolFor(mint)], { ixs: tradeIxs(mint, { price }) })
  const io = spy(store)
  const record = await indexer.syncCoin(mint)
  const head = await store.get(`trades:${mint}`)
  assert.equal(head.total, 4000)
  assert.deepEqual(head.chunks.at(0), { n: 8, count: 3, buys: 3, sells: 0 })
  assert.deepEqual(head.chunks.at(-1).count, 497)
  assert.deepEqual(
    io.writes.filter((k) => k.startsWith('trades:')).sort(),
    [`trades:${mint}`, `trades:${mint}:8`, `trades:${mint}:candles`].sort(),
  )
  assert.ok(record.price > 6.9e-8, 'derived from the merged list')

  // The oldest page reads only the oldest chunk.
  io.reset()
  const oldest = await indexer.trades(mint, { offset: 3990 })
  assert.deepEqual(
    oldest.items.map((t) => t.id),
    legacy.slice(3987, 3997).map((t) => t.id),
  )
  assert.deepEqual(io.chunkReads(), [`trades:${mint}:0`])
  const merged = [...(await indexer.trades(mint, { limit: 3 })).items, ...legacy.slice(0, 3997)]
  assert.deepEqual(await indexer.candles(mint, 300), candlesFor(merged, 300))
})

// ---- QP-SEC-7: market() defaults -------------------------------------------------------------
test('QP-SEC-7: market() treats unknown sorts and filters as the defaults', async () => {
  const { store, indexer } = await setup({ quantum: null })
  const coin = (name, extra) => summarize({ mint: address(), name, symbol: name, ...extra })
  await store.set('coins:list', [
    coin('OLD', { createdAt: 1, volume24h: 9 }),
    coin('NEW', { createdAt: 2, volume24h: 1 }),
    coin('EXT', { createdAt: 3, external: true }),
  ])
  const names = async (options) => (await indexer.market(options)).items.map((c) => c.name)
  assert.deepEqual(await names({ sort: 'volume' }), ['OLD', 'NEW'])
  for (const sort of ['constructor', '__proto__', 'toString', 'bogus', undefined])
    assert.deepEqual(await names({ sort }), ['NEW', 'OLD'], String(sort))
  for (const filter of ['constructor', '__proto__', 'hasOwnProperty', 'bogus', ''])
    assert.deepEqual(await names({ filter }), ['NEW', 'OLD'], `never external: ${filter}`)
  assert.deepEqual(await names({ filter: 'tracked' }), ['EXT'])
})

// ---- build-defect-4: coin identities ------------------------------------------------------------
test('build-defect-4: a real Quant Pad coin is tracked with its Metaplex identity and live curve', async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  await chain.setAccounts(REAL_ACCOUNTS)
  assert.deepEqual(await readTokenIdentity(chain.connection, REAL), {
    ...REAL_IDENTITY,
    tokenProgram: network.tokenProgram,
  })
  const market = await readMarket(chain.connection, REAL, { launchConfigs: [CONFIG] })
  assert.deepEqual(
    [market.curve.dbcPool, market.curve.dbcConfig, market.curve.creator, market.curve.quoteMint],
    [REAL_POOL, CONFIG, REAL_CREATOR, network.wsolMint],
  )
  assert.deepEqual(
    [market.curve.complete, market.curve.migrated, market.pool],
    [false, false, null],
  )
  assert.equal(market.curve.decimals, 6)
  assert.equal(market.curve.migrationThreshold, '85000000000')
  assert.ok(
    Math.abs(market.curve.progress - (Number(market.curve.quoteReserve) / 85e9) * 100) < 1e-9,
  )
  assert.ok(market.curve.price > 0 && market.curve.price < 1e-6)
  assert.equal(market.supply, network.totalSupply, 'a fixed 1B supply')

  // Its launch is on chain: tracking reads the identity, the sync the dev buy.
  chain.add([REAL_POOL], { tx: LAUNCH.tx, sig: LAUNCH.signature })
  const coin = await indexer.track(REAL)
  assert.deepEqual([coin.name, coin.symbol, coin.uri], Object.values(REAL_IDENTITY))
  assert.deepEqual(
    [coin.creator, coin.tokenProgram, coin.dbcPool, coin.complete, coin.migrated, coin.external],
    [REAL_CREATOR, network.tokenProgram, REAL_POOL, false, false, true],
  )
  assert.equal(coin.price, market.curve.price)
  await idle(store)
  const synced = await indexer.syncCoin(REAL)
  assert.equal(
    synced.price,
    market.curve.price,
    'the live curve, over the dev buy it moved on from',
  )
  assert.equal(synced.decimals, 6)
  const [devBuy] = (await indexer.trades(REAL)).items
  assert.deepEqual(
    [devBuy.signature, devBuy.side, devBuy.solAmount, devBuy.trader],
    [LAUNCH.signature, 'buy', '100000000', REAL_CREATOR],
  )
  const [summary] = await indexer.list()
  assert.deepEqual([summary.name, summary.migrated], ['test1', false])
})

test("build-defect-4: records stored as 'Unknown $???' heal on the next sync or track", async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  await chain.setAccounts(REAL_ACCOUNTS)
  // A record whose identity read failed when it was stored, before its DBC pool was known.
  const placeholder = {
    mint: REAL,
    name: 'Unknown',
    symbol: '???',
    uri: '',
    creator: '11111111111111111111111111111111',
    quantum: false,
    external: true,
    source: 'meteora',
    complete: false,
    cursor: null,
    poolCursor: null,
    price: null,
    registeredAt: Date.now(),
  }
  await store.set(`coin:${REAL}`, placeholder)
  await store.set('coins:list', [summarize(placeholder)])
  const synced = await indexer.syncCoin(REAL)
  assert.deepEqual(
    [synced.name, synced.symbol, synced.uri, synced.creator, synced.dbcPool, synced.dbcConfig],
    [...Object.values(REAL_IDENTITY), REAL_CREATOR, REAL_POOL, CONFIG],
  )
  assert.equal(synced.identityPending, false)
  assert.equal(synced.decimals, 6)
  assert.ok(synced.price > 0)
  assert.equal((await indexer.list())[0].name, 'test1')

  // track() of a stored placeholder repairs it before answering.
  await store.set(`coin:${REAL}`, { ...placeholder, syncedAt: Date.now() })
  const tracked = await indexer.track(REAL)
  assert.deepEqual([tracked.name, tracked.symbol], ['test1', 'TEST'])
  assert.equal(tracked.creator, null, 'the system program is no creator; the next sync reads it')
  await idle(store)
})

test('build-defect-4: a failed identity read is retried, never stored as the real identity', async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  await chain.setAccounts(REAL_ACCOUNTS)
  const read = chain.connection.getMultipleAccountsInfo
  let throttled = true
  chain.connection.getMultipleAccountsInfo = async (keys) => {
    if (throttled && keys.some((k) => k.equals(metaplexMetadataPda(REAL))))
      throw Error('429 Too Many Requests')
    return read(keys)
  }
  await assert.rejects(readTokenIdentity(chain.connection, REAL), /429/)
  const coin = await indexer.track(REAL)
  assert.deepEqual([coin.name, coin.identityPending], ['Unknown', true])
  await idle(store)
  throttled = false
  const healed = await indexer.syncCoin(REAL)
  assert.deepEqual([healed.name, healed.identityPending], ['test1', false])

  // A mint that is not visible yet (a lagging node) is not "no metadata" either.
  await assert.rejects(readTokenIdentity(chain.connection, address()), { code: 'mint_missing' })
})

test('build-defect-4: Token-2022 metadata is read from the mint; a coin without any settles', async () => {
  const { chain, store, indexer } = await setup({ quantum: null })
  const mint = address()
  chain.accounts.set(
    mint,
    token2022Mint(mint, { name: 'Quant', symbol: 'QNT', uri: 'https://quantpad.test/m/x' }),
  )
  // The Token-2022 extension wins over a Metaplex account.
  chain.accounts.set(
    metaplexMetadataPda(mint).toBase58(),
    metaplexAccount(mint, { name: 'Other', symbol: 'O', uri: 'https://other.invalid' }),
  )
  assert.deepEqual(await readTokenIdentity(chain.connection, mint), {
    name: 'Quant',
    symbol: 'QNT',
    uri: 'https://quantpad.test/m/x',
    tokenProgram: network.token2022Program,
  })
  // A Metaplex account for another mint is ignored.
  const legacy = address()
  chain.accounts.set(legacy, account(network.tokenProgram, Buffer.alloc(82)))
  chain.accounts.set(
    metaplexMetadataPda(legacy).toBase58(),
    metaplexAccount(address(), { name: 'Wrong', symbol: 'W', uri: '' }),
  )
  assert.equal(await readTokenIdentity(chain.connection, legacy), null)

  // No metadata anywhere: the placeholder is final and later syncs do not read it again.
  const bare = address()
  chain.accounts.set(bare, account(network.token2022Program, Buffer.alloc(82)))
  await chain.setAccounts(coinAccounts(bare, { creator: address() }))
  const coin = await indexer.track(bare)
  assert.deepEqual([coin.name, coin.symbol, coin.identityPending], ['Unknown', '???', false])
  await idle(store)
  const before = identityReads(chain, bare)
  await indexer.syncCoin(bare)
  await indexer.syncCoin(bare)
  assert.equal(identityReads(chain, bare), before)
})
