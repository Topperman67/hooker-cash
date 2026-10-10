// Indexer round 2: launch provenance and the native cap (QP-SEC-9, K5), the onNativeLaunch
// callback that lets the app keep a launch's media (QP-SEC-2), and legacy SPL Token pump.fun coins
// read from their Metaplex metadata (build-defect-4). Runs against an in-memory chain and store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { PUMP_SDK, bondingCurvePda } from '#pump-sdk'
import { network } from '../../shared/network.mjs'
import { createIndexer, issuedUriKey, issuedUriClaimKey, summarize } from '../../server/indexer.mjs'
import { candlesFor } from '../../server/market-math.mjs'
import {
  extractEvents,
  curveFor,
  poolFor,
  readMarket,
  readTokenIdentity,
  metaplexMetadataPda,
  METAPLEX_METADATA,
} from '../../server/solana.mjs'

const PUMP = network.pumpProgram
const DAY_MS = 86_400_000
const NOW = Math.floor(Date.now() / 1000)
const address = () => Keypair.generate().publicKey.toBase58()
const signature = () => bs58.encode(randomBytes(64))
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))

// ---- encoded pump.fun events and accounts --------------------------------------------------------
const TRADE = extractEvents(fixture('pump-trade').tx).find((e) => e.name === 'TradeEvent').event
const CREATE = extractEvents(fixture('pump-create').tx).find((e) => e.name === 'CreateEvent').event
const disc = (name) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
function eventLogs(name, data) {
  const body = PUMP_SDK.offlinePumpProgram.coder.types.encode(
    name[0].toLowerCase() + name.slice(1),
    data,
  )
  return [
    `Program ${PUMP} invoke [1]`,
    `Program data: ${Buffer.concat([disc(name), body]).toString('base64')}`,
    `Program ${PUMP} success`,
  ]
}
const tradeLogs = (mint, { price, timestamp = NOW, lamports = 1e9 }) => {
  const tokens = 1_000_000_000_000_000
  const sol = Math.round(price * 1e9 * (tokens / 1e6))
  return eventLogs('TradeEvent', {
    ...TRADE,
    mint: new PublicKey(mint),
    timestamp: new BN(timestamp),
    virtualSolReserves: new BN(sol),
    virtualQuoteReserves: new BN(sol),
    virtualTokenReserves: new BN(tokens),
    solAmount: new BN(lamports),
    quoteAmount: new BN(lamports),
  })
}
const createLogs = (mint, { creator, user = creator, uri, timestamp = NOW }) =>
  eventLogs('CreateEvent', {
    ...CREATE,
    mint: new PublicKey(mint),
    bondingCurve: bondingCurvePda(new PublicKey(mint)),
    creator: new PublicKey(creator),
    user: new PublicKey(user),
    uri,
    timestamp: new BN(timestamp),
    isMayhemMode: false,
  })

async function curveAccount({ creator, complete = false, price = 3e-8 }) {
  const tokens = complete ? 0 : 1_073_000_000_000_000
  const sol = complete ? 0 : Math.round(price * 1e9 * (tokens / 1e6))
  const data = await PUMP_SDK.offlinePumpProgram.coder.accounts.encode('bondingCurve', {
    virtualTokenReserves: new BN(tokens),
    virtualQuoteReserves: new BN(sol),
    realTokenReserves: new BN(complete ? 0 : 793_100_000_000_000),
    realQuoteReserves: new BN(0),
    tokenTotalSupply: new BN(network.totalSupply),
    complete,
    creator: new PublicKey(creator),
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: PublicKey.default,
    creatorFeeBps: new BN(0),
    canEditCreatorFee: false,
    isHolderReward: false,
    creatorFee: new BN(0),
    protocolFees: new BN(0),
    depth: 0,
    initialVirtualQuoteReserves: new BN(sol),
    postCompleteBaseOut: new BN(0),
    postCompleteQuoteIn: new BN(0),
  })
  return { data, owner: new PublicKey(PUMP), lamports: 1_000_000, executable: false }
}
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
// A Metaplex MetadataV1 account with NUL-padded fixed-size fields, as pump.fun's legacy coins have.
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

// ---- a real legacy coin: 9BB6…pump on mainnet (SPL Token mint, Metaplex metadata, a 150-byte
// curve with no creator recorded, graduated to Raydium so it has no PumpSwap pool) ----------------
const LEGACY = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'
const padded = (base64, length) => {
  const data = Buffer.alloc(length)
  Buffer.from(base64, 'base64').copy(data)
  return data
}
const LEGACY_ACCOUNTS = {
  [LEGACY]: account(
    network.tokenProgram,
    padded('AAAAAAbFwc5jjSVn0mRosF65UdGijcxuEjSCtcZ1FJdw5ivyqh+x4mqNAwAGAQ==', 82),
  ),
  [curveFor(LEGACY)]: account(
    PUMP,
    padded('F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAAQ==', 150),
  ),
  [metaplexMetadataPda(LEGACY).toBase58()]: account(
    METAPLEX_METADATA,
    padded(
      'BAbFwc5jjSVn0mRosF65UdGijcxuEjSCtcZ1FJdw5ivyeXi3FEU80+h66x/Am/Bn+WzS1NabVxOV' +
        'qpvxhq/52j8gAAAARmFydGNvaW4gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKAAAARmFydGNvaW4g' +
        'AMgAAABodHRwczovL2lwZnMuaW8vaXBmcy9RbVlmZTh6VkdIQTFoZWVqNDdBa0JYM05uZXRnMmgy' +
        'a3FqNXl5bXoxeHlLZUhiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf8BAg==',
      607,
    ),
  ),
}
const LEGACY_IDENTITY = {
  name: 'Fartcoin',
  symbol: 'Fartcoin',
  uri: 'https://ipfs.io/ipfs/QmYfe8zVGHA1heej47AkBX3Nnetg2h2kqj5yymz1xyKeHb',
}

// ---- in-memory store and chain ------------------------------------------------------------------
function memoryStore() {
  const data = new Map()
  const live = (k) => {
    const e = data.get(k)
    if (e?.expires && e.expires < Date.now()) data.delete(k)
    return data.get(k)
  }
  return {
    data,
    async get(k) {
      const e = live(k)
      return e ? structuredClone(e.value) : null
    },
    async set(k, v, options = {}) {
      if (options.nx && live(k)) return false
      data.set(k, {
        value: structuredClone(v),
        expires: options.ttl ? Date.now() + options.ttl : 0,
      })
      return true
    },
    async delete(k) {
      data.delete(k)
    },
    async release(k, owner) {
      if (live(k)?.value === owner) data.delete(k)
    },
  }
}
async function idle(store) {
  for (let i = 0; i < 400; i++) {
    if (![...store.data.keys()].some((k) => k.startsWith('lease:') || k.startsWith('lock:'))) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw Error('background sync did not finish')
}

let current = null
const originalFetch = globalThis.fetch
globalThis.fetch = (url, init) =>
  current ? current.fetch(url, init) : Promise.reject(Error('offline'))
test.after(() => {
  globalThis.fetch = originalFetch
})

function fakeChain() {
  const history = new Map()
  const txs = new Map()
  const accounts = new Map()
  let slot = 5000
  const chain = {
    accounts,
    reads: [], // the keys of every getMultipleAccountsInfo call
    add(addresses, { logs = [], blockTime = NOW } = {}) {
      const sig = signature()
      slot++
      txs.set(sig, {
        slot,
        blockTime,
        meta: { err: null, innerInstructions: [], logMessages: logs },
        transaction: { message: { accountKeys: [] } },
      })
      for (const a of addresses) {
        if (!history.has(a)) history.set(a, [])
        history.get(a).unshift({ signature: sig, slot, blockTime, err: null })
      }
      return sig
    },
    connection: {
      rpcEndpoint: 'http://chain.invalid',
      async getSignaturesForAddress(key, { until, before, limit = 1000 } = {}) {
        const all = history.get(key.toBase58()) || []
        let i = 0
        if (before) {
          i = all.findIndex((s) => s.signature === before) + 1
          if (!i) return []
        }
        const out = []
        for (; i < all.length && out.length < Math.min(limit, 1000); i++) {
          if (all[i].signature === until) break
          out.push({ ...all[i] })
        }
        return out
      },
      async getMultipleAccountsInfo(keys) {
        chain.reads.push(keys.map((k) => k.toBase58()))
        return keys.map((k) => accounts.get(k.toBase58()) || null)
      },
      async getAccountInfo(key) {
        return accounts.get(key.toBase58()) || null
      },
    },
    async fetch(url, init) {
      const body = JSON.parse(init.body)
      const answer = (c) => ({ jsonrpc: '2.0', id: c.id, result: txs.get(c.params[0]) || null })
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body))
    },
  }
  current = chain
  return chain
}
const identityReads = (chain, mint) =>
  chain.reads.filter((keys) => keys.includes(metaplexMetadataPda(mint).toBase58())).length

function fakeQuantum(chain) {
  const seed = new PublicKey(network.pumpFeesProgram)
  const pda = (tag, mint) =>
    PublicKey.findProgramAddressSync([Buffer.from(tag), mint.toBuffer()], seed)[0]
  return {
    wellPda: (mint) => pda('well', mint),
    quantumPda: (mint) => pda('quantum', mint),
    decodeQuantum: (data) => JSON.parse(Buffer.from(data).toString()),
    register(mint, launcher) {
      chain.accounts.set(pda('quantum', new PublicKey(mint)).toBase58(), {
        data: Buffer.from(JSON.stringify({ launcher, createdAt: NOW - 30 })),
      })
    },
    well: (mint) => pda('well', new PublicKey(mint)).toBase58(),
  }
}

// A clock the test moves, and an indexer that records its onNativeLaunch calls.
function setup({ fail = 0, ...options } = {}) {
  const chain = fakeChain()
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
// /api/metadata issuing `uri`, and a pump.fun create (with a 1 SOL dev buy) that uses it.
async function launch(
  chain,
  store,
  { mint = address(), uri, creator = address(), timestamp = NOW } = {},
) {
  uri ||= `https://quantpad.test/m/${randomBytes(16).toString('hex')}`
  await store.set(issuedUriKey(uri), { at: Date.now() }, { ttl: DAY_MS })
  const sig = chain.add([curveFor(mint)], {
    logs: [
      ...createLogs(mint, { creator, uri, timestamp }),
      ...tradeLogs(mint, { price: 3e-8, timestamp }),
    ],
    blockTime: timestamp,
  })
  return { mint, uri, sig, creator }
}

// ---- QP-SEC-9 / K5: issued URIs are single-use ------------------------------------------------
test('K5: a native registration consumes its issued URI and announces the launch once', async () => {
  const { chain, store, calls, indexer } = setup()
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
  const { chain, store, calls, indexer } = setup()
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
  const { chain, store, clock, calls, indexer } = setup({ fail: 1 })
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
  const { chain, store, calls, indexer } = setup()
  const quantum = fakeQuantum(chain)
  const launcher = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + '1'.repeat(32)
  quantum.register(mint, launcher)
  chain.accounts.set(curveFor(mint), await curveAccount({ creator: quantum.well(mint) }))
  chain.accounts.set(mint, token2022Mint(mint, { name: 'Q', symbol: 'Q', uri }))
  const tracked = await indexer.track(mint)
  assert.equal(tracked.external, false)
  assert.deepEqual(calls, [{ mint, uri }])
  await idle(store)

  const stale = address()
  quantum.register(stale, launcher)
  chain.accounts.set(curveFor(stale), await curveAccount({ creator: quantum.well(stale) }))
  const record = {
    mint: stale,
    name: 'Stale',
    symbol: 'S',
    uri: 'https://quantpad.test/m/' + '2'.repeat(32),
    creator: quantum.well(stale),
    bondingCurve: curveFor(stale),
    quantum: false,
    external: true,
    source: 'pump.fun',
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
  const { chain, store, indexer } = setup({ maxNative: 1, hidden: new Set([hiddenMint]) })
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
  const { chain, store, clock, indexer } = setup({ maxNative: 7, hidden: [hiddenMint] })
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
  const { chain, store, clock, indexer } = setup({ maxNative: 2 })
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
    chain.add([curveFor(mint)], {
      logs: tradeLogs(mint, { price: 3e-8, timestamp: hourAgo, lamports }),
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
  const { chain, store, clock, indexer } = setup({ launchesPerWallet: 2 })
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
  const { chain, store, indexer } = setup({ launchesPerWallet: 1 })
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
  bondingCurve: curveFor(mint),
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
  const { chain, store, indexer } = setup({ quantum: null })
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
    chain.add([curveFor(mint)], { logs: tradeLogs(mint, { price }) })
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
  const { chain, store, indexer } = setup({ quantum: null })
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
    chain.add([curveFor(mint)], { logs: tradeLogs(mint, { price }) })
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
  const { store, indexer } = setup({ quantum: null })
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

// ---- build-defect-4: legacy SPL Token coins ---------------------------------------------------
test('build-defect-4: a legacy SPL Token coin is tracked with its Metaplex identity', async () => {
  const { chain, store, indexer } = setup({ quantum: null })
  for (const [key, info] of Object.entries(LEGACY_ACCOUNTS)) chain.accounts.set(key, info)
  assert.deepEqual(await readTokenIdentity(chain.connection, LEGACY), {
    ...LEGACY_IDENTITY,
    tokenProgram: network.tokenProgram,
  })
  const market = await readMarket(chain.connection, LEGACY)
  assert.equal(market.curve.complete, true)
  assert.equal(market.curve.creator, null, 'the zero key is not a creator')
  assert.equal(market.poolMissing, true, 'it graduated to Raydium, not PumpSwap')

  // An old curve trade (from before it graduated) is not its price now.
  chain.add([curveFor(LEGACY)], {
    logs: tradeLogs(LEGACY, { price: 4e-7, timestamp: NOW - 400 * 86400 }),
    blockTime: NOW - 400 * 86400,
  })
  const coin = await indexer.track(LEGACY)
  assert.deepEqual([coin.name, coin.symbol, coin.uri], Object.values(LEGACY_IDENTITY))
  assert.deepEqual(
    [coin.creator, coin.tokenProgram, coin.complete, coin.poolMissing, coin.pool, coin.price],
    [null, network.tokenProgram, true, true, null, null],
  )
  await idle(store)
  const synced = await indexer.syncCoin(LEGACY)
  assert.equal(synced.price, null)
  assert.equal(synced.marketCap, null)
  assert.equal(synced.name, 'Fartcoin')
  const [summary] = await indexer.list()
  assert.deepEqual([summary.name, summary.poolMissing], ['Fartcoin', true])
})

test("build-defect-4: records stored as 'Unknown $???' heal on the next sync or track", async () => {
  const { chain, store, indexer } = setup({ quantum: null })
  for (const [key, info] of Object.entries(LEGACY_ACCOUNTS)) chain.accounts.set(key, info)
  // What the old track() stored for this coin.
  const placeholder = {
    mint: LEGACY,
    name: 'Unknown',
    symbol: '???',
    uri: '',
    creator: '11111111111111111111111111111111',
    bondingCurve: curveFor(LEGACY),
    quantum: false,
    external: true,
    source: 'pump.fun',
    complete: true,
    pool: poolFor(LEGACY),
    cursor: null,
    poolCursor: null,
    price: null,
    registeredAt: Date.now(),
  }
  await store.set(`coin:${LEGACY}`, placeholder)
  await store.set('coins:list', [summarize(placeholder)])
  const synced = await indexer.syncCoin(LEGACY)
  assert.deepEqual(
    [synced.name, synced.symbol, synced.uri, synced.creator, synced.pool, synced.poolMissing],
    [...Object.values(LEGACY_IDENTITY), null, null, true],
  )
  assert.equal(synced.identityPending, false)
  assert.equal((await indexer.list())[0].name, 'Fartcoin')

  // track() of a stored placeholder repairs it before answering.
  await store.set(`coin:${LEGACY}`, { ...placeholder, syncedAt: Date.now() })
  const tracked = await indexer.track(LEGACY)
  assert.deepEqual([tracked.name, tracked.creator], ['Fartcoin', null])
  await idle(store)
})

test('build-defect-4: a failed identity read is retried, never stored as the real identity', async () => {
  const { chain, store, indexer } = setup({ quantum: null })
  for (const [key, info] of Object.entries(LEGACY_ACCOUNTS)) chain.accounts.set(key, info)
  const read = chain.connection.getMultipleAccountsInfo
  let throttled = true
  chain.connection.getMultipleAccountsInfo = async (keys) => {
    if (throttled && keys.some((k) => k.equals(metaplexMetadataPda(LEGACY))))
      throw Error('429 Too Many Requests')
    return read(keys)
  }
  await assert.rejects(readTokenIdentity(chain.connection, LEGACY), /429/)
  const coin = await indexer.track(LEGACY)
  assert.deepEqual([coin.name, coin.identityPending], ['Unknown', true])
  await idle(store)
  throttled = false
  const healed = await indexer.syncCoin(LEGACY)
  assert.deepEqual([healed.name, healed.identityPending], ['Fartcoin', false])

  // A mint that is not visible yet (a lagging node) is not "no metadata" either.
  await assert.rejects(readTokenIdentity(chain.connection, address()), { code: 'mint_missing' })
})

test('build-defect-4: Token-2022 metadata is read from the mint; a coin without any settles', async () => {
  const { chain, store, indexer } = setup({ quantum: null })
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
  chain.accounts.set(curveFor(bare), await curveAccount({ creator: address() }))
  const coin = await indexer.track(bare)
  assert.deepEqual([coin.name, coin.symbol, coin.identityPending], ['Unknown', '???', false])
  await idle(store)
  const before = identityReads(chain, bare)
  await indexer.syncCoin(bare)
  await indexer.syncCoin(bare)
  assert.equal(identityReads(chain, bare), before)
})
