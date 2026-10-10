// Indexer fixes: launch provenance (C2), the tri-state quantum flag (C3), gap-free cursors,
// time-bounded and throttle-tolerant passes, locking, eviction, trade order, prices and market caps.
// Everything runs against an in-memory chain (mainnet getSignaturesForAddress semantics) and store.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { PUMP_SDK, bondingCurvePda } from '#pump-sdk'
import { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk'
import { network, priceFromReserves } from '../../shared/network.mjs'

process.env.QUANTPAD_MAX_LAUNCHES = '3'
const { createIndexer, issuedUriKey, stats, summarize } = await import('../../server/indexer.mjs')
const {
  extractEvents,
  tradesFrom,
  fetchTransactions,
  pendingSignatures,
  readMarket,
  poolFor,
  curveFor,
} = await import('../../server/solana.mjs')
const { candlesFor, compareTrades, capSupply } = await import('../../server/market-math.mjs')

const PUMP = network.pumpProgram
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
// A curve trade at `price` SOL per whole token (virtual reserves 30 SOL-ish / tokens).
const tradeLogs = (mint, { price, timestamp = NOW }) => {
  const tokens = 1_000_000_000_000_000
  const sol = Math.round(price * 1e9 * (tokens / 1e6))
  return eventLogs('TradeEvent', {
    ...TRADE,
    mint: new PublicKey(mint),
    timestamp: new BN(timestamp),
    virtualSolReserves: new BN(sol),
    virtualQuoteReserves: new BN(sol),
    virtualTokenReserves: new BN(tokens),
    solAmount: new BN(1e9),
    quoteAmount: new BN(1e9),
  })
}
const createLogs = (mint, { creator, user = creator, uri, timestamp = NOW, quoteMint }) =>
  eventLogs('CreateEvent', {
    ...CREATE,
    mint: new PublicKey(mint),
    bondingCurve: bondingCurvePda(new PublicKey(mint)),
    creator: new PublicKey(creator),
    user: new PublicKey(user),
    uri,
    timestamp: new BN(timestamp),
    isMayhemMode: false,
    ...(quoteMint ? { quoteMint: new PublicKey(quoteMint) } : {}),
  })

async function curveAccount({
  creator,
  complete = false,
  price = 3e-8,
  mayhem = false,
  quoteMint = PublicKey.default,
}) {
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
    isMayhemMode: mayhem,
    isCashbackCoin: false,
    quoteMint: new PublicKey(quoteMint),
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
function mintAccount(supply) {
  const data = Buffer.alloc(82)
  data.writeBigUInt64LE(BigInt(supply), 36)
  return { data, owner: new PublicKey(network.token2022Program), lamports: 1, executable: false }
}
const tokenAccount = (amount) => {
  const data = Buffer.alloc(165)
  data.writeBigUInt64LE(BigInt(amount), 64)
  return { data, lamports: 1 }
}
async function poolAccounts(mint, { base, quote, virtualQuote = 0n, fees = [0n, 0n] }) {
  const baseVault = Keypair.generate().publicKey
  const quoteVault = Keypair.generate().publicKey
  const data = await PUMP_AMM_SDK.offlineProgram.coder.accounts.encode('pool', {
    poolBump: 255,
    index: 0,
    creator: PublicKey.default,
    baseMint: new PublicKey(mint),
    quoteMint: new PublicKey(network.wsolMint),
    lpMint: PublicKey.default,
    poolBaseTokenAccount: baseVault,
    poolQuoteTokenAccount: quoteVault,
    lpSupply: new BN(0),
    coinCreator: PublicKey.default,
    isMayhemMode: false,
    isCashbackCoin: false,
    virtualQuoteReserves: new BN(virtualQuote.toString()),
    creatorFeeBps: new BN(0),
    canEditCreatorFee: false,
    isHolderReward: false,
    protocolFees: new BN(fees[0].toString()),
    creatorFees: new BN(fees[1].toString()),
  })
  return {
    [poolFor(mint)]: { data, lamports: 1 },
    [baseVault.toBase58()]: tokenAccount(base),
    [quoteVault.toBase58()]: tokenAccount(quote),
  }
}

// ---- in-memory store and chain ------------------------------------------------------------------
function memoryStore({ latency = 0 } = {}) {
  const data = new Map()
  const sets = []
  const pause = () =>
    latency ? new Promise((r) => setTimeout(r, latency / 2 + Math.random() * latency)) : null
  const live = (k) => {
    const e = data.get(k)
    if (e?.expires && e.expires < Date.now()) data.delete(k)
    return data.get(k)
  }
  return {
    data,
    sets,
    async get(k) {
      await pause()
      const e = live(k)
      return e ? structuredClone(e.value) : null
    },
    async set(k, v, options = {}) {
      sets.push([k, options])
      await pause()
      if (options.nx && live(k)) return false
      data.set(k, {
        value: structuredClone(v),
        expires: options.ttl ? Date.now() + options.ttl : 0,
      })
      return true
    },
    async delete(k) {
      await pause()
      data.delete(k)
    },
    async release(k, owner) {
      await pause()
      if (live(k)?.value === owner) data.delete(k)
    },
  }
}
// Waits for fire-and-forget syncs (registerLaunch, track) to let go of their coin leases.
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

function fakeChain(endpoint = 'http://chain.invalid') {
  const history = new Map() // address -> signatures, newest first
  const txs = new Map()
  const accounts = new Map()
  const fetched = []
  let slot = 5000
  const chain = {
    txs,
    accounts,
    fetched,
    listed: [],
    requests: [],
    policy: null, // (body) => Response | undefined
    add(addresses, { logs = [], blockTime = NOW, sameSlot = false, sig = signature() } = {}) {
      if (!sameSlot) slot++
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
      rpcEndpoint: endpoint,
      async getSignaturesForAddress(key, { until, before, limit = 1000 } = {}) {
        chain.listed.push({ address: key.toBase58(), until, before, limit })
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
        return keys.map((k) => accounts.get(k.toBase58()) || null)
      },
      async getAccountInfo(key) {
        return accounts.get(key.toBase58()) || null
      },
    },
    async fetch(url, init) {
      const body = JSON.parse(init.body)
      chain.requests.push(body)
      const override = chain.policy?.(body)
      if (override) return override
      const calls = Array.isArray(body) ? body : [body]
      for (const c of calls) fetched.push(c.params[0])
      const answer = (c) => ({ jsonrpc: '2.0', id: c.id, result: txs.get(c.params[0]) || null })
      return Response.json(Array.isArray(body) ? calls.map(answer) : answer(body))
    },
  }
  current = chain
  return chain
}

// A Quantum client double: `wells` maps mints to their well, and a Quantum account is served by the
// chain at quantumPda(mint) with its launcher.
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

async function syncUntilCaughtUp(indexer, mint, max = 200) {
  for (let n = 0; n < max; n++) {
    const record = await indexer.syncCoin(mint)
    if (!record.behind) return record
  }
  throw Error('sync never caught up')
}

// ---- C2 -----------------------------------------------------------------------------------------
test('C2: a launch is native only with a URI this server issued, with 4xx errors otherwise', async () => {
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  const user = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'a'.repeat(32)
  const sig = chain.add([curveFor(mint)], {
    logs: [...createLogs(mint, { creator: user, uri }), ...tradeLogs(mint, { price: 3e-8 })],
  })

  await assert.rejects(indexer.registerLaunch('not-a-signature'), { status: 400 })
  await assert.rejects(indexer.registerLaunch(''), { status: 400 })
  await assert.rejects(indexer.registerLaunch('', { mint: 'bad' }), { status: 400 })
  await assert.rejects(indexer.registerLaunch(signature()), {
    status: 409,
    code: 'not_indexed_yet',
  })
  // Any other pump.fun coin is not a Quant Pad launch, and nothing is stored for it.
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
  const chain = fakeChain()
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
  const create = chain.add([curveFor(mint)], { logs: createLogs(mint, { creator: user, uri }) })
  let other
  for (let i = 0; i < 1200; i++) other = chain.add([curveFor(mint)])

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
  chain.add([curveFor(deep)], { logs: createLogs(deep, { creator: user, uri }) })
  for (let i = 0; i < 5000; i++) chain.add([curveFor(deep)])
  await assert.rejects(indexer.registerLaunch('', { mint: deep }), {
    status: 400,
    code: 'not_quantpad',
  })
})

test('C2: native registrations are capped', async () => {
  const chain = fakeChain()
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
  const sig = chain.add([curveFor(mint)], { logs: createLogs(mint, { creator: address(), uri }) })
  await assert.rejects(indexer.registerLaunch(sig), { status: 429, code: 'launch_cap' })
})

// ---- C3 -----------------------------------------------------------------------------------------
test('C3: a failed Quantum check is stored as unknown and healed on sync', async () => {
  const chain = fakeChain()
  const store = memoryStore()
  const quantum = fakeQuantum(chain)
  const indexer = createIndexer({ connection: chain.connection, store, quantum })
  const mint = address()
  const launcher = address()
  const uri = 'https://quantpad.test/m/' + 'd'.repeat(32)
  quantum.register(mint, launcher)
  const sig = chain.add([curveFor(mint)], {
    logs: createLogs(mint, { creator: quantum.well(mint), user: launcher, uri }),
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
  const chain = fakeChain()
  const store = memoryStore()
  const quantum = fakeQuantum(chain)
  const indexer = createIndexer({ connection: chain.connection, store, quantum })
  const launcher = address()

  const mint = address()
  quantum.register(mint, launcher)
  chain.accounts.set(curveFor(mint), await curveAccount({ creator: quantum.well(mint) }))
  const tracked = await indexer.track(mint)
  assert.deepEqual(
    [tracked.quantum, tracked.external, tracked.source, tracked.launcher],
    [true, false, 'quantpad', launcher],
  )

  // A record stored with a sticky false flag as an external coin heals on its next sync.
  const stale = address()
  quantum.register(stale, launcher)
  chain.accounts.set(curveFor(stale), await curveAccount({ creator: quantum.well(stale) }))
  const record = {
    mint: stale,
    name: 'Stale',
    creator: quantum.well(stale),
    bondingCurve: curveFor(stale),
    quantum: false,
    external: true,
    source: 'pump.fun',
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
  chain.accounts.set(curveFor(plain), await curveAccount({ creator: address() }))
  assert.equal((await indexer.track(plain)).quantum, false)
  await idle(store)
})

// ---- cursors ------------------------------------------------------------------------------------
test('a backlog deeper than several signature pages is read oldest-first without gaps', async () => {
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = curveFor(mint)
  const cursor = chain.add([curve])
  const expected = []
  for (let i = 0; i < 3500; i++) expected.push(chain.add([curve]))
  await store.set(`coin:${mint}`, {
    mint,
    bondingCurve: curve,
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
  const chain = fakeChain()
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  chain.accounts.set(curveFor(mint), await curveAccount({ creator: address() }))
  for (let i = 0; i < 250; i++)
    chain.add([curveFor(mint)], {
      logs: tradeLogs(mint, { price: 1e-8 * (1 + i / 100), timestamp: NOW - 3600 + i }),
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'e'.repeat(32)
  await store.set(issuedUriKey(uri), { at: Date.now() })
  const created = NOW - 7200
  const sig = chain.add([curveFor(mint)], {
    logs: [...createLogs(mint, { creator: address(), uri, timestamp: created })],
    blockTime: created,
  })
  for (let i = 0; i < 260; i++)
    chain.add([curveFor(mint)], {
      logs: tradeLogs(mint, { price: 1e-8 * (1 + i / 100), timestamp: created + 10 + i }),
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = curveFor(mint)
  // Executed a, then b, then c in one slot; as strings, a sorts last and c first.
  const [a, b, c] = ['z', 'm', 'b'].map((ch) => ch.repeat(88))
  chain.add([curve], { sig: a, logs: tradeLogs(mint, { price: 1e-8 }) })
  chain.add([curve], { sig: b, sameSlot: true, logs: tradeLogs(mint, { price: 2e-8 }) })
  chain.add([curve], { sig: c, sameSlot: true, logs: tradeLogs(mint, { price: 3e-8 }) })
  await store.set(`coin:${mint}`, { mint, bondingCurve: curve, external: false, cursor: null })
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
test('PumpSwap trades are priced from the reserves after the swap', () => {
  const { signature: sig, tx } = fixture('pumpswap-trade')
  const pool = extractEvents(tx)
    .find((e) => e.name === 'SellEvent')
    .event.pool.toBase58()
  const [sell, buy] = tradesFrom(tx, { signature: sig, mint: 'irrelevant', pool })
  // Matches the pool vaults: the sell's result is the buy's starting point, and the buy's result
  // equals the vaults' post-transaction balances in the fixture.
  assert.equal(sell.price, priceFromReserves(7083348246131846n, 1881777864711n))
  assert.equal(buy.price, priceFromReserves(7132953084576368n, 1868723787469n))
  const post = tx.meta.postTokenBalances.map((b) => b.uiTokenAmount.amount)
  assert.ok(post.includes('1868723787469') && post.includes('7132953084576368'))
})

test("tracking a graduated coin prices it from the pool with the mint's real supply", async () => {
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  chain.accounts.set(
    curveFor(mint),
    await curveAccount({ creator: address(), complete: true, mayhem: true }),
  )
  chain.accounts.set(mint, mintAccount(2_000_000_000_000_000n))
  for (const [key, info] of Object.entries(
    await poolAccounts(mint, {
      base: 200_000_000_000_000n,
      quote: 90_500_000_000n, // includes 0.5 SOL of fee buckets that are not liquidity
      fees: [300_000_000n, 200_000_000n],
    }),
  ))
    chain.accounts.set(key, info)
  const coin = await indexer.track(mint)
  const price = priceFromReserves(90_000_000_000n, 200_000_000_000_000n)
  assert.equal(coin.complete, true)
  assert.equal(coin.price, price)
  assert.equal(coin.supply, '2000000000000000')
  assert.ok(Math.abs(coin.marketCap - price * 2e9) < 1e-6, 'a 2B mayhem supply, not 1B')
  await idle(store)

  // Burned supply counts too, and an unknown supply falls back to pump.fun's for the coin type.
  chain.accounts.set(mint, mintAccount(900_000_000_000_000n))
  assert.equal((await readMarket(chain.connection, mint)).supply, '900000000000000')
  assert.equal(capSupply({ mayhem: true }), '2000000000000000')
  assert.equal(capSupply({}), network.totalSupply)
  assert.equal(
    stats([{ price: 1e-6, timestamp: NOW }], NOW, { supply: '900000000000000' }).marketCap,
    900,
  )
})

// ---- throttling and batches ---------------------------------------------------------------------
test('fetchTransactions keeps what it read when throttled and honours the deadline', async () => {
  const chain = fakeChain('http://provider-a.invalid')
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
  const chain = fakeChain('http://provider-b.invalid')
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
  const chain = fakeChain('http://provider-c.invalid')
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = curveFor(mint)
  const sigs = Array.from({ length: 40 }, (_, i) =>
    chain.add([curve], { logs: tradeLogs(mint, { price: 1e-8 * (i + 1) }) }),
  )
  await store.set(`coin:${mint}`, { mint, bondingCurve: curve, external: false, cursor: null })
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mints = [address(), address(), address()]
  const broken = mints[1]
  const listSignatures = chain.connection.getSignaturesForAddress
  chain.connection.getSignaturesForAddress = async (key, options) => {
    if (key.toBase58() === curveFor(broken)) throw Error('429 Too Many Requests')
    return listSignatures(key, options)
  }
  const getMany = chain.connection.getMultipleAccountsInfo
  chain.connection.getMultipleAccountsInfo = async (keys) => {
    if (keys[0].toBase58() === curveFor(broken)) throw Error('429 Too Many Requests')
    return getMany(keys)
  }
  for (const mint of mints) {
    const record = { mint, name: mint, bondingCurve: curveFor(mint), external: false, cursor: null }
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
  const chain = fakeChain()
  const store = memoryStore({ latency: 4 })
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mints = Array.from({ length: 6 }, address)
  for (const mint of mints)
    chain.accounts.set(curveFor(mint), await curveAccount({ creator: address() }))
  await Promise.all(mints.map((mint) => indexer.track(mint)))
  await idle(store)
  assert.deepEqual((await indexer.list()).map((c) => c.mint).sort(), [...mints].sort())

  const mint = mints[0]
  chain.listed.length = 0
  await Promise.all([indexer.syncCoin(mint), indexer.syncCoin(mint), indexer.syncCoin(mint)])
  assert.equal(chain.listed.filter((l) => l.address === curveFor(mint)).length, 1)
})

test('external eviction keeps the coin just tracked and deletes evicted records', async () => {
  const chain = fakeChain()
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
  chain.accounts.set(curveFor(mint), await curveAccount({ creator: address() }))
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

// ---- busy coins ---------------------------------------------------------------------------------
test("a busy coin's 24h figures stay whole after its trade list is cut", async () => {
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  // A native launch with `old` trades, then 4100 trades in the last ~70 minutes: more than the
  // 4000 the trade list keeps.
  async function busy({ created, old = [] }) {
    const mint = address()
    const uri = 'https://quantpad.test/m/' + mint.slice(0, 32)
    await store.set(issuedUriKey(uri), { at: Date.now() })
    const sig = chain.add([curveFor(mint)], {
      logs: createLogs(mint, { creator: address(), uri, timestamp: created }),
      blockTime: created,
    })
    for (const [price, timestamp] of old)
      chain.add([curveFor(mint)], {
        logs: tradeLogs(mint, { price, timestamp }),
        blockTime: timestamp,
      })
    for (let i = 0; i < 4100; i++) {
      const timestamp = NOW - 4100 + i
      chain.add([curveFor(mint)], {
        logs: tradeLogs(mint, { price: 1e-8 * (1 + i / 1000), timestamp }),
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({
    connection: chain.connection,
    store,
    quantum: fakeQuantum(chain),
  })
  const user = address()
  const mint = address()
  const uri = 'https://quantpad.test/m/' + 'f'.repeat(32)
  chain.accounts.set(curveFor(mint), await curveAccount({ creator: user }))
  const create = chain.add([curveFor(mint)], {
    logs: [...createLogs(mint, { creator: user, uri }), ...tradeLogs(mint, { price: 3e-8 })],
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
  const chain = fakeChain()
  const store = memoryStore()
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const mint = address()
  const curve = curveFor(mint)
  chain.add([curve], { logs: tradeLogs(mint, { price: 2e-8 }) })
  await store.set(`coin:${mint}`, {
    mint,
    name: 'M',
    bondingCurve: curve,
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
  const chain = fakeChain()
  const store = memoryStore({ latency: 4 })
  const indexer = createIndexer({ connection: chain.connection, store, quantum: null })
  const [a, b] = [address(), address()]
  for (const mint of [a, b])
    chain.accounts.set(curveFor(mint), await curveAccount({ creator: address() }))
  await indexer.track(a)
  await idle(store)
  const sigs = Array.from({ length: 5 }, (_, i) =>
    chain.add([curveFor(a)], { logs: tradeLogs(a, { price: 1e-8 * (i + 1) }) }),
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
  const chain = fakeChain('http://provider-d.invalid')
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
    message: 'That transaction did not create a pump.fun coin.',
  })
  const failedSig = chain.add([address()])
  chain.txs.get(failedSig).meta.err = { InstructionError: [0, { Custom: 6000 }] }
  await assert.rejects(indexer.registerLaunch(failedSig), {
    status: 400,
    code: 'failed_transaction',
  })
  const usdc = address()
  const quoted = address()
  const quotedSig = chain.add([curveFor(quoted)], {
    logs: createLogs(quoted, { creator: user, uri, quoteMint: usdc }),
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
  await assert.rejects(indexer.track(address()), { status: 404, code: 'not_pump' })
  const other = address()
  chain.accounts.set(curveFor(other), await curveAccount({ creator: user, quoteMint: usdc }))
  await assert.rejects(indexer.track(other), { status: 400, code: 'not_sol_quote' })

  // RPC failures: a status the client retries, and never the provider's message.
  const secret = 'https://rpc.invalid/?api-key=SECRET'
  const exposed = (e, status, code) => {
    assert.deepEqual([e.status, e.code, e.expose], [status, code, true])
    assert.ok(!e.message.includes('SECRET'))
    return true
  }
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
  chain.connection.getSignaturesForAddress = async () => {
    throw Error('fetch failed ' + secret)
  }
  await assert.rejects(indexer.registerLaunch('', { mint: address() }), (e) =>
    exposed(e, 503, 'rpc_unavailable'),
  )
  // /api/sync gets the same when a coin's sync could read nothing.
  const mint = address()
  await store.set(`coin:${mint}`, {
    mint,
    bondingCurve: curveFor(mint),
    external: false,
    cursor: null,
  })
  await assert.rejects(indexer.syncCoin(mint), (e) => exposed(e, 503, 'rpc_unavailable'))
})
