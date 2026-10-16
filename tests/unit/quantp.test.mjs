// $QUANTP's store-free feed (server/quantp.mjs) and its routes: the snapshot maths on the bonding
// curve and after graduation to DAMM v2, sources failing on their own, the caches, the
// GeckoTerminal fallback for the chart and trades, and GET /api/quantp* while Redis refuses every
// command. Accounts are mainnet snapshots of the pool, its config, the mint and the DAMM v2 pool
// taken just after the curve graduated; the curve state is the same pool re-encoded before it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { POOL_TOKEN_A_MINT_OFFSET } from '@meteora-ag/cp-amm-sdk'
import {
  cachedSource,
  createGeckoFeed,
  createQuantpFeed,
  dexFigures,
  dexPairs,
  geckoCandles,
  geckoTrades,
  mergeCandles,
} from '../../server/quantp.mjs'
import { createRedisStore } from '../../server/storage.mjs'
import { createApplication, QUANTP_CACHE } from '../../server/application.mjs'
import {
  DAMM_POOL_AUTHORITY,
  DBC_POOL_AUTHORITY,
  dbcCoder,
  decodeDbcPool,
} from '../../shared/meteora.mjs'
import { QUANTP, network, priceFromSqrtPrice } from '../../shared/network.mjs'

const DAMM_POOL = 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw'
const POOL_MIGRATED = Buffer.from(
  '7du4Fyq9qSMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1L//ODinAbNVOgpEAlvh3xMczE5MhP7Cgr1nvmkPVoQgS8BvtFPCaOQZAkw3qGuKnYL0DjeP5FHtvEVfZ9Q+v2In97IBSCFZZklx2vJkkHWqBrrETiMckGVFX/1EkRaCXTZLIhKA9rcWoUSHTvbhzLuQx+y/DBUUNRFoymbVr5I/1ptwo6FSpIyi44+Q4WsIcWWKPXf6HsYSYHeohwTyBX/4KEat8QAA4mGT4w0AAAAAAAAAAAAAADiSyAIAAAAAAAAAAAAAAAAVlWMMAAAAADu16exTDswDAAAAAAAAAAAFhdFqAAAAAAEBAAADAAAAAAAAAAAAAABrw8EbAAAAAAAAAAAAAAAAY9DjewAAAABnm9FqAAAAAAAAAAAAAAAATjuAbwAAAAAAAAEAAAAAABQAAAAAAAAATo7yvHsAAACwC/gGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'base64',
)
const CONFIG = Buffer.from(
  'KNzC+ynHe/0Gm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAQP9iGGhFqFWGj5S6+sk6ADB33YBO5S+wszJVMFqJ7jOIEvAb7RTwmjkGQJMN6hrip2C9A43j+RR7bxFX2fUPr8ALTEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQYAAQAKAFoABgFaAQIAAAAAAAAAAMGHnV7RmwIAxWGT4w0AAAANVt4JrfEAADu16exTDswDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAACAxqR+jQMAAAD0AQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACLJG04mfRmAQAAAAAAAAAAO7Xp7FMOzAMAAAAAAAAAABPMVpM4y5IOZW5FocwFAACbV2lOqRpchLHE/v8AAAAA+Dcz1/X5Gh/2mwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADrXQRt8GD3lgOjIB1NwkMukHXli62JxVlmIA62JeIq3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64',
)
const MINT = Buffer.from(
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGIn97IBSCFZZklx2vJkkHWqBrrETiMckGVFX/1EkRaCDgBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABiJ/eyAUghWWZJcdryZJB1qga6xE4jHJBlRV/9RJEWggkAAABRdWFudCBQYWQGAAAAUVVBTlRQaQAAAGh0dHBzOi8vd3d3LnRyeW1pZGFzLmZ1bi9tZWRpYS9tZXRhL2M4ZDY2OTgyMGY1ZjI4NmU3ZTBlMDc1ZWUyMThhMmJmOGI5NjFiZGNjNTdlOTQ1ZjU0ZmE0ZWZjNmQwMDUzNjguanNvbgAAAAA=',
  'base64',
)
const DAMM = Buffer.from(
  '8ZptBBGxbbyA8PoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7tensUw7MAwAAAAAAAAAAYif3sgFIIVlmSXHa8mSQdaoGusROIxyQZUVf/USRFoIGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAfdADFl+KbCeOTeOcvLfyVaaXEA0MClTdT4rHLlVLlKMQYSh6/B+6RPx43oLoSsFLy2cxAIxA0nzhGd+ORIzJAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv3ouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEsCrQIAAAAAAAAAAAAAAAAAAAAAAAAAAFA7AQABAAAAAAAAAAAAAACbV2lOqRpchLHE/v8AAAAAsBG0s6GXzAMAAAAAAAAAAGib0WoAAAAAAQABAAEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKivW7q/QIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAA+CbQKAAAAAAAAAAAAAAAAAAAAAAAAAABLAq0CAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAA2mNoH3KGvMgGcZ4sK1CiAVckO/yWaLEVILxThD7c2wiXLSZAD/EAAPX8aZcNAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
)

// The same pool before graduation: 52.74 of the 59.65 SOL threshold, on the curve.
const CURVE_SQRT = '253621498328041795'
const CURVE_RESERVE = '52743486006'
async function curvePool() {
  const raw = dbcCoder.accounts.decode('transferHookPool', POOL_MIGRATED)
  raw.poolState.migrationProgress = 0
  raw.poolState.isMigrated = 0
  raw.poolState.quoteReserve = new BN(CURVE_RESERVE)
  raw.poolState.sqrtPrice = new BN(CURVE_SQRT)
  return dbcCoder.accounts.encode('transferHookPool', raw)
}
const POOL_CURVE = await curvePool()

const account = (owner, data) => ({
  owner: new PublicKey(owner),
  data,
  lamports: 1,
  executable: false,
})
const DBC = network.dbcProgram
const DAMM_PROGRAM = network.dammV2Program

// A web3.js Connection stand-in serving `accounts` (address → account) and counting calls.
function fakeConnection(accounts, { holders = [], dammSearch = [] } = {}) {
  const calls = { gma: 0, info: 0, gpa: [], keys: [] }
  return {
    calls,
    fail: false,
    async getMultipleAccountsInfo(keys) {
      calls.gma++
      calls.keys.push(keys.map((k) => k.toBase58()))
      if (this.fail) throw Error('429 Too Many Requests')
      return keys.map((k) => accounts[k.toBase58()] ?? null)
    },
    async getAccountInfo(key) {
      calls.info++
      if (this.fail) throw Error('429 Too Many Requests')
      return accounts[key.toBase58()] ?? null
    },
    async getProgramAccounts(program, options) {
      calls.gpa.push({ program: program.toBase58(), options })
      if (this.fail) throw Error('429 Too Many Requests')
      return program.toBase58() === network.token2022Program ? holders : dammSearch
    },
  }
}
const chainAccounts = ({ migrated = false, damm = true } = {}) => ({
  [QUANTP.pool]: account(DBC, migrated ? POOL_MIGRATED : POOL_CURVE),
  [QUANTP.config]: account(DBC, CONFIG),
  [QUANTP.mint]: account(network.token2022Program, MINT),
  ...(damm ? { [DAMM_POOL]: account(DAMM_PROGRAM, DAMM) } : {}),
})

// Token accounts as the holder scan reads them: owner (32 bytes) then amount (u64 LE).
const holding = (owner, amount) => {
  const data = Buffer.alloc(40)
  new PublicKey(owner).toBuffer().copy(data, 0)
  data.writeBigUInt64LE(BigInt(amount), 32)
  return { pubkey: PublicKey.unique(), account: { data } }
}
const WALLET_A = 'He1bV7axBhCFhLAoJpZFYVwq6qKr2rkvUXTK2mQkwpZV'
const WALLET_B = 'Ht6bERjESG3TgqMT4ceJEJLZsmTkmR1Z1WZFtQvddZFZ'
const HOLDERS = [
  holding(WALLET_A, 5_000_000),
  holding(WALLET_A, 1), // a second account of the same wallet
  holding(WALLET_B, 9),
  holding(PublicKey.unique().toBase58(), 0), // emptied
  holding(DBC_POOL_AUTHORITY.toBase58(), 10n ** 14n), // the curve's vault
  holding(DAMM_POOL_AUTHORITY.toBase58(), 10n ** 14n), // the DAMM v2 pool's vault
  holding('1nc1nerator11111111111111111111111111111111', 2_000_000), // burned by transfer
]

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const pair = (over = {}) => ({
  chainId: 'solana',
  dexId: 'meteoradbc',
  pairAddress: QUANTP.pool,
  baseToken: { address: QUANTP.mint, symbol: 'QUANTP' },
  quoteToken: { address: network.wsolMint, symbol: 'SOL' },
  priceNative: '0.0000002',
  priceUsd: '0.0000199',
  priceChange: { h24: 529 },
  volume: { h24: 12000 },
  txns: { h24: { buys: 118, sells: 59 } },
  pairCreatedAt: QUANTP.launchedAt * 1000,
  ...over,
})
const DEX_CURVE = { pairs: [pair()] }
const DEX_GRADUATED = {
  pairs: [
    pair({ priceNative: '0.0000002159', priceChange: { h24: 618 }, volume: { h24: 13492.99 } }),
    pair({
      dexId: 'meteora',
      pairAddress: DAMM_POOL,
      priceNative: '0.0000002198',
      priceUsd: '0.0000232',
      priceChange: { h24: -0.24 },
      volume: { h24: 109.58 },
      txns: { h24: { buys: 3, sells: 2 } },
      pairCreatedAt: 1792121704000,
    }),
    // another chain's or another quote's pair is never counted
    pair({ chainId: 'base', volume: { h24: 1e9 } }),
    pair({ quoteToken: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } }),
  ],
}

function fakeFetch(routes) {
  const calls = []
  const request = async (url) => {
    calls.push(url)
    for (const [pattern, answer] of routes) if (url.includes(pattern)) return answer(url)
    throw Error(`unexpected fetch ${url}`)
  }
  return { request, calls }
}

function feedWith({ migrated = false, dex = DEX_CURVE, usd = 105, clock, holders = HOLDERS } = {}) {
  const connection = fakeConnection(chainAccounts({ migrated }), { holders })
  const dexFetch = fakeFetch([['dexscreener', () => json(dex)]])
  const now = clock ? () => clock.t : Date.now
  const feed = createQuantpFeed({
    connection,
    request: dexFetch.request,
    solUsd: async () => ({ usd }),
    now,
  })
  return { feed, connection, dexFetch }
}

const lamportsToSol = (v) => Number(v) / 1e9

test('on the bonding curve: price, progress, the 2% fee and the fees earned come from the pool', async () => {
  const { feed } = feedWith()
  const s = await feed.snapshot()
  const price = priceFromSqrtPrice(CURVE_SQRT, 6)
  assert.equal(s.mint, QUANTP.mint)
  assert.equal(s.symbol, 'QUANTP')
  assert.equal(s.decimals, 6)
  assert.equal(s.priceSol, price)
  assert.equal(s.marketCapSol, price * 1e9)
  // DexScreener's USD price while it is fresh and agrees with the pool, its change as a fraction
  assert.equal(s.priceUsd, 0.0000199)
  assert.equal(s.marketCapUsd, 0.0000199 * 1e9)
  assert.equal(s.change24h, 5.29)
  assert.equal(s.volume24hUsd, 12000)
  assert.deepEqual(s.txns24h, { buys: 118, sells: 59 })
  assert.equal(s.curveProgress, 52743486006 / 59652661701)
  assert.equal(s.migrated, false)
  assert.equal(s.dammPool, null)
  assert.equal(s.feeBps, 200)
  assert.equal(s.postGradFeeBps, 500)
  assert.equal(s.supply, '1000000000000000')
  // supply is whole, so only the incinerator's 2 QUANTP count as burned
  assert.equal(s.burned, '2000000')
  // two wallets hold any: vaults, emptied accounts and the incinerator are not holders
  assert.equal(s.holders, 2)
  assert.equal(s.launchedAt, 1792115973)
  assert.deepEqual(s.sources, { chain: 'ok', dex: 'ok' })
  assert.ok(s.updatedAt > 0)
  // all of DBC's trading and protocol fees; the creator gets 90% of the trading fee, split 60/40
  const trading = lamportsToSol(2078527587)
  const protocol = lamportsToSol(465683307)
  assert.ok(Math.abs(s.fees.lifetimeSol - (trading + protocol)) < 1e-12)
  assert.ok(Math.abs(s.fees.creatorLifetimeSol - trading * 0.9) < 1e-12)
  assert.ok(Math.abs(s.fees.holdersSol - trading * 0.9 * 0.6) < 1e-12)
  assert.ok(Math.abs(s.fees.buybackSol - trading * 0.9 * 0.4) < 1e-12)
  // amounts cross JSON as integer strings
  assert.equal(typeof s.supply, 'string')
  assert.equal(typeof s.burned, 'string')
})

test('after graduation: the verified DAMM v2 pool prices it, the fee is 5% and its LP fees count', async () => {
  const { feed, connection } = feedWith({ migrated: true, dex: DEX_GRADUATED })
  const s = await feed.snapshot()
  assert.equal(s.migrated, true)
  assert.equal(s.dammPool, DAMM_POOL)
  assert.equal(s.curveProgress, 1)
  assert.equal(s.feeBps, 500)
  assert.equal(s.priceSol, priceFromSqrtPrice('273760398123209136', 6))
  // the DAMM v2 pair's price; volume and trades across both pairs (other chains/quotes ignored)
  assert.equal(s.priceUsd, 0.0000232)
  assert.ok(Math.abs(s.volume24hUsd - (13492.99 + 109.58)) < 1e-9)
  assert.deepEqual(s.txns24h, { buys: 121, sells: 61 })
  // the change runs from the curve pair's price a day ago, not from the new pool's first trade
  const dayAgo = 0.0000002159 / (1 + 6.18)
  assert.ok(Math.abs(s.change24h - (0.0000002198 / dayAgo - 1)) < 1e-9)
  // DBC's fees, plus the DAMM pool's LP and protocol fees; the creator holds 90% of the
  // migrated liquidity, which is (all but one unit of) the pool's
  const dbcTrading = lamportsToSol(2078527587)
  const lp = lamportsToSol(179571006)
  const lifetime = dbcTrading + lamportsToSol(465683307) + lp + lamportsToSol(44892747)
  assert.ok(Math.abs(s.fees.lifetimeSol - lifetime) < 1e-9)
  const creator = dbcTrading * 0.9 + lp * 0.9
  assert.ok(Math.abs(s.fees.creatorLifetimeSol - creator) < 1e-9)
  assert.ok(Math.abs(s.fees.holdersSol - creator * 0.6) < 1e-9)
  assert.ok(Math.abs(s.fees.buybackSol - creator * 0.4) < 1e-9)
  // the predicted pool was read once to verify it, then joins the one getMultipleAccounts
  await feed.snapshot()
  assert.equal(connection.calls.info, 1)
  assert.deepEqual(await feed.pools(), [
    { address: QUANTP.pool, venue: 'curve', done: true },
    { address: DAMM_POOL, venue: 'pool', done: false },
  ])
})

test('a migrated pool is found by search when the derived address is not it, and checked', async () => {
  const elsewhere = PublicKey.unique()
  const wrongMint = Buffer.from(DAMM)
  PublicKey.unique().toBuffer().copy(wrongMint, POOL_TOKEN_A_MINT_OFFSET)
  const accounts = chainAccounts({ migrated: true, damm: false })
  const connection = fakeConnection(accounts, {
    holders: HOLDERS,
    dammSearch: [
      { pubkey: PublicKey.unique(), account: account(DAMM_PROGRAM, wrongMint) },
      { pubkey: elsewhere, account: account(DAMM_PROGRAM, DAMM) },
    ],
  })
  accounts[elsewhere.toBase58()] = account(DAMM_PROGRAM, DAMM)
  const feed = createQuantpFeed({
    connection,
    request: fakeFetch([['dexscreener', () => json(DEX_GRADUATED)]]).request,
  })
  const s = await feed.snapshot()
  assert.equal(s.dammPool, elsewhere.toBase58())
  const search = connection.calls.gpa.find((c) => c.program === DAMM_PROGRAM)
  assert.deepEqual(
    search.options.filters.map((f) => f.memcmp.bytes),
    [QUANTP.mint, network.wsolMint],
  )
})

test('migrated with no DAMM v2 pool found yet: still migrated, priced from DexScreener', async () => {
  const connection = fakeConnection(chainAccounts({ migrated: true, damm: false }))
  const feed = createQuantpFeed({
    connection,
    request: fakeFetch([['dexscreener', () => json(DEX_GRADUATED)]]).request,
  })
  const s = await feed.snapshot()
  assert.equal(s.migrated, true)
  assert.equal(s.dammPool, null)
  assert.equal(s.priceSol, 0.0000002198) // the pair that is not the curve's
  assert.equal(s.feeBps, 500)
})

test('each source fails on its own: DexScreener down, chain stale, then both gone', async () => {
  const clock = { t: 1_000_000 }
  const connection = fakeConnection(chainAccounts(), { holders: HOLDERS })
  let dexUp = false
  const feed = createQuantpFeed({
    connection,
    request: async () => (dexUp ? json(DEX_CURVE) : json({ error: 'busy' }, 429)),
    solUsd: async () => ({ usd: 100 }),
    now: () => clock.t,
  })
  // DexScreener down: USD from SOL × SOL/USD, its own fields null
  let s = await feed.snapshot()
  const price = priceFromSqrtPrice(CURVE_SQRT, 6)
  assert.deepEqual(s.sources, { chain: 'ok', dex: 'down' })
  assert.equal(s.priceUsd, price * 100)
  assert.equal(s.marketCapUsd, price * 100 * 1e9)
  assert.equal(s.change24h, null)
  assert.equal(s.volume24hUsd, null)
  assert.equal(s.txns24h, null)

  // the chain fails after a good read: its last values stay, marked stale
  dexUp = true
  connection.fail = true
  clock.t += 20_000
  s = await feed.snapshot()
  assert.deepEqual(s.sources, { chain: 'stale', dex: 'ok' })
  assert.equal(s.priceSol, price)
  assert.equal(s.curveProgress, 52743486006 / 59652661701)

  // a fresh instance with neither source answering: 503, so clients keep their last figures
  const cold = createQuantpFeed({
    connection: fakeConnection({}),
    request: async () => {
      throw TypeError('fetch failed')
    },
  })
  await assert.rejects(() => cold.snapshot(), { status: 503, code: 'QUANTP_UNAVAILABLE' })
})

test('DexScreener lagging the pool by more than 3%: USD follows the pool at SOL/USD', async () => {
  const lagging = { pairs: [pair({ priceUsd: '0.0000150' })] }
  const { feed } = feedWith({ dex: lagging })
  const s = await feed.snapshot()
  const price = priceFromSqrtPrice(CURVE_SQRT, 6)
  assert.equal(s.priceUsd, price * 105)
  assert.equal(s.marketCapUsd, price * 105 * 1e9)
  // its other figures still count
  assert.equal(s.volume24hUsd, 12000)
  assert.equal(s.change24h, 5.29)
})

test('caches: one chain read per 15 s, one DexScreener read per 30 s, holders per 10 min', async () => {
  const clock = { t: 5_000_000 }
  const { feed, connection, dexFetch } = feedWith({ clock })
  // concurrent readers share one fetch per source
  await Promise.all([feed.snapshot(), feed.snapshot(), feed.snapshot()])
  assert.equal(connection.calls.gma, 1)
  assert.equal(dexFetch.calls.length, 1)
  assert.equal(connection.calls.gpa.length, 1)
  // the config is read with the first pool read only (DBC configs never change)
  assert.deepEqual(connection.calls.keys[0], [QUANTP.pool, QUANTP.mint, QUANTP.config])
  clock.t += 14_000
  await feed.snapshot()
  assert.equal(connection.calls.gma, 1)
  clock.t += 2_000
  await feed.snapshot()
  assert.equal(connection.calls.gma, 2)
  assert.deepEqual(connection.calls.keys[1], [QUANTP.pool, QUANTP.mint])
  assert.equal(dexFetch.calls.length, 1)
  clock.t += 15_000
  await feed.snapshot()
  assert.equal(dexFetch.calls.length, 2)
  assert.equal(connection.calls.gpa.length, 1)
  clock.t += 600_000
  await feed.snapshot()
  assert.equal(connection.calls.gpa.length, 2)
  const [scan] = connection.calls.gpa
  assert.equal(scan.program, network.token2022Program)
  assert.deepEqual(scan.options.dataSlice, { offset: 32, length: 40 })
  assert.deepEqual(scan.options.filters, [{ memcmp: { offset: 0, bytes: QUANTP.mint } }])
})

test('cachedSource keeps the last value through failures and waits out its retry delay', async () => {
  const clock = { t: 0 }
  let calls = 0
  let fail = false
  const read = cachedSource(
    async () => {
      calls++
      if (fail) throw Error('down')
      return calls
    },
    { ttl: 1000, retry: 5000, now: () => clock.t },
  )
  assert.deepEqual(await read(), { value: 1, at: 0, state: 'ok' })
  fail = true
  clock.t = 1500
  assert.deepEqual(await read(), { value: 1, at: 0, state: 'stale' })
  clock.t = 3000
  await read()
  assert.equal(calls, 2, 'no retry within 5 s of a failure')
  fail = false
  clock.t = 7000
  assert.deepEqual(await read(), { value: 3, at: 7000, state: 'ok' })
  // a load slower than `wait` answers with what is cached and finishes for the next reader
  let release
  const slow = cachedSource(() => new Promise((r) => (release = r)), {
    ttl: 1000,
    wait: 10,
    now: () => clock.t,
  })
  assert.deepEqual(await slow(), { value: null, at: null, state: 'down' })
  release('late')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal((await slow()).value, 'late')
})

test('dexPairs and dexFigures: one pair, several, none', () => {
  const one = dexPairs(DEX_CURVE)
  assert.deepEqual(dexFigures(one, QUANTP.pool), {
    priceUsd: 0.0000199,
    priceNative: 0.0000002,
    change24h: 5.29,
    volume24hUsd: 12000,
    txns24h: { buys: 118, sells: 59 },
  })
  assert.equal(dexPairs(DEX_GRADUATED).length, 2)
  assert.equal(dexFigures([], QUANTP.pool), null)
  assert.equal(dexPairs({ pairs: null }).length, 0)
  // a DAMM pair over a day old keeps its own 24h change
  const old = dexPairs({
    pairs: [
      pair({ priceChange: { h24: 10 } }),
      pair({ pairAddress: DAMM_POOL, priceChange: { h24: -5 }, pairCreatedAt: 1 }),
    ],
  })
  assert.equal(dexFigures(old, DAMM_POOL, 1792200000000).change24h, -0.05)
})

// ---- GeckoTerminal ----------------------------------------------------------------------------

const OHLCV = (rows) => ({ data: { attributes: { ohlcv_list: rows } } })
const gtTrade = (over) => ({
  id: `solana_457482957_${over.tx_hash}_${over.index ?? 9}_1792120385`,
  type: 'trade',
  attributes: {
    block_number: 457482957,
    block_timestamp: '2026-10-16T03:12:52Z',
    tx_from_address: WALLET_A,
    price_from_in_currency_token: '1.0',
    price_to_in_currency_token: '1.0',
    ...over,
  },
})
const GT_TRADES = {
  data: [
    gtTrade({
      tx_hash: 'buyTx',
      index: 9,
      kind: 'buy',
      from_token_address: network.wsolMint,
      to_token_address: QUANTP.mint,
      from_token_amount: '0.042589317',
      to_token_amount: '221429.874721',
      price_to_in_currency_token: '0.000000188490961540709',
    }),
    gtTrade({
      tx_hash: 'sellTx',
      index: 4,
      block_timestamp: '2026-10-16T03:12:42Z',
      block_number: 457482912,
      kind: 'sell',
      from_token_address: QUANTP.mint,
      to_token_address: network.wsolMint,
      from_token_amount: '201126.30732',
      to_token_amount: '0.037150656',
      price_from_in_currency_token: '0.000000188482717676935',
    }),
    // a pair this page does not show
    gtTrade({ tx_hash: 'other', from_token_address: 'x', to_token_address: 'y' }),
  ],
}

test('GeckoTerminal OHLCV and trades map to the chart and trades table shapes', () => {
  assert.deepEqual(
    geckoCandles(
      OHLCV([
        [1792120200, 1.7e-7, 1.9e-7, 1.6e-7, 1.8e-7, 3.08],
        [1792119900, 1.6e-7, 1.7e-7, 1.6e-7, 1.7e-7, 1.98],
        [1792119600, 0, 0, 0, 0, 1], // unpriced
      ]),
    ),
    [
      { time: 1792119900, open: 1.6e-7, high: 1.7e-7, low: 1.6e-7, close: 1.7e-7, volume: 1.98 },
      { time: 1792120200, open: 1.7e-7, high: 1.9e-7, low: 1.6e-7, close: 1.8e-7, volume: 3.08 },
    ],
  )
  assert.deepEqual(geckoCandles({}), [])
  const [buy, sell, ...rest] = geckoTrades(GT_TRADES, { venue: 'curve' })
  assert.equal(rest.length, 0)
  assert.deepEqual(buy, {
    id: 'buyTx:9',
    signature: 'buyTx',
    slot: 457482957,
    index: 9,
    timestamp: Date.parse('2026-10-16T03:12:52Z') / 1000,
    venue: 'curve',
    side: 'buy',
    trader: WALLET_A,
    solAmount: '42589317',
    tokenAmount: '221429874721',
    price: 0.000000188490961540709,
  })
  assert.equal(sell.side, 'sell')
  assert.equal(sell.solAmount, '37150656')
  assert.equal(sell.tokenAmount, '201126307320')
  assert.equal(sell.price, 0.000000188482717676935)
})

test('candles of the curve and the DAMM v2 pool merge into one series', () => {
  const curve = [
    { time: 60, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 120, open: 2, high: 3, low: 2, close: 3, volume: 2 },
  ]
  const pool = [
    { time: 120, open: 3.1, high: 4, low: 1.5, close: 3.5, volume: 0.5 },
    { time: 180, open: 3.5, high: 3.6, low: 3.4, close: 3.6, volume: 1 },
  ]
  assert.deepEqual(mergeCandles([curve, pool]), [
    curve[0],
    { time: 120, open: 2, high: 4, low: 1.5, close: 3.5, volume: 2.5 },
    pool[1],
  ])
})

test('the GeckoTerminal feed caches, keeps to its call budget, and builds 15 s candles from trades', async () => {
  const clock = { t: 10_000_000 }
  const gt = fakeFetch([
    ['/trades', () => json(GT_TRADES)],
    ['/ohlcv/', () => json(OHLCV([[1792120200, 1.7e-7, 1.9e-7, 1.6e-7, 1.8e-7, 3.08]]))],
  ])
  const gecko = createGeckoFeed({ request: gt.request, now: () => clock.t, perMinute: 3 })
  const curveOnly = [{ address: QUANTP.pool, venue: 'curve', done: false }]
  assert.equal((await gecko.candles(curveOnly, 60)).length, 1)
  assert.match(
    gt.calls[0],
    /pools\/85TSwj[^/]+\/ohlcv\/minute\?aggregate=1&limit=1000&currency=token&token=7cAJ/,
  )
  await gecko.candles(curveOnly, 60)
  assert.equal(gt.calls.length, 1, 'cached')
  const fifteen = await gecko.candles(curveOnly, 15)
  assert.equal(gt.calls.length, 2)
  assert.match(gt.calls[1], /\/trades$/)
  const bucket = (iso) => Math.floor(Date.parse(iso) / 15_000) * 15
  assert.deepEqual(
    fifteen.map((c) => c.time),
    [bucket('2026-10-16T03:12:42Z'), bucket('2026-10-16T03:12:52Z')],
  )
  assert.equal((await gecko.trades(curveOnly)).length, 2)
  assert.equal(gt.calls.length, 2, 'the trades are cached too')
  await gecko.candles(curveOnly, 3600)
  assert.match(gt.calls[2], /ohlcv\/hour\?aggregate=1/)
  // over budget for this minute: nothing cached for daily candles, so a 503
  await assert.rejects(() => gecko.candles(curveOnly, 86400), {
    status: 503,
    code: 'MARKET_DATA_UNAVAILABLE',
  })
  assert.equal(gt.calls.length, 3)
  clock.t += 61_000
  assert.equal((await gecko.candles(curveOnly, 86400)).length, 1)
  assert.match(gt.calls[3], /ohlcv\/day\?aggregate=1/)
})

// ---- routes, with Redis refusing every command --------------------------------------------------

const QUOTA = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500000.'

test('GET /api/quantp and its candles and trades answer while Redis refuses every command', async () => {
  let redisCalls = 0
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () => {
      redisCalls++
      return new Response(JSON.stringify({ error: QUOTA }), { status: 400 })
    },
    log: () => {},
  })
  const connection = fakeConnection(chainAccounts({ migrated: true }), { holders: HOLDERS })
  const outside = fakeFetch([
    ['dexscreener', () => json(DEX_GRADUATED)],
    ['/trades', () => json(GT_TRADES)],
    ['/ohlcv/', () => json(OHLCV([[1792120200, 1.7e-7, 1.9e-7, 1.6e-7, 1.8e-7, 3.08]]))],
  ])
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-quantp-')),
    store,
    serverless: true,
    quantum: null,
    background: false,
    connection,
    priceFeed: async () => ({ usd: 150 }),
    quantpFetch: outside.request,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const live = await fetch(base + '/api/quantp')
    assert.equal(live.status, 200)
    assert.equal(live.headers.get('cache-control'), QUANTP_CACHE)
    assert.equal(QUANTP_CACHE, 'public, max-age=0, s-maxage=10, stale-while-revalidate=50')
    const body = await live.json()
    assert.equal(body.dammPool, DAMM_POOL)
    assert.equal(body.feeBps, 500)
    assert.deepEqual(body.sources, { chain: 'ok', dex: 'ok' })

    // the indexer cannot answer (the store refuses): GeckoTerminal, both pools, credited
    const candles = await (await fetch(base + '/api/quantp/candles?interval=60')).json()
    assert.equal(candles.source, 'geckoterminal')
    assert.equal(candles.interval, 60)
    assert.equal(candles.items.length, 1)
    assert.ok(outside.calls.some((u) => u.includes(`/pools/${DAMM_POOL}/ohlcv/minute`)))
    assert.ok(outside.calls.some((u) => u.includes(`/pools/${QUANTP.pool}/ohlcv/minute`)))
    const odd = await (await fetch(base + '/api/quantp/candles?interval=7')).json()
    assert.equal(odd.interval, 300)

    const sells = await fetch(base + '/api/quantp/trades?side=sell')
    assert.equal(sells.status, 200)
    const page = await sells.json()
    assert.equal(page.source, 'geckoterminal')
    assert.ok(page.items.length > 0)
    assert.ok(page.items.every((t) => t.side === 'sell'))
    assert.equal(page.next, null)

    const wrong = await fetch(base + '/api/quantp', { method: 'POST' })
    assert.equal(wrong.status, 405)
    assert.ok(redisCalls >= 1, 'the store was asked for the indexed history, and refused')
  } finally {
    await new Promise((r) => server.close(r))
    app.close()
  }
})

test('decodeDbcPool reads the fixtures as a transfer-hook pool (sanity)', () => {
  assert.equal(decodeDbcPool(POOL_MIGRATED).transferHook, true)
  assert.equal(decodeDbcPool(POOL_CURVE).migrationProgress, 0)
})

test('with a working store holding the whole history, the chart and trades come from the indexer', async () => {
  const connection = fakeConnection(chainAccounts({ migrated: true }), { holders: HOLDERS })
  const outside = fakeFetch([
    ['dexscreener', () => json(DEX_GRADUATED)],
    ['/trades', () => json(GT_TRADES)],
    ['/ohlcv/', () => json(OHLCV([[1792120200, 1.7e-7, 1.9e-7, 1.6e-7, 1.8e-7, 3.08]]))],
  ])
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-quantp-indexed-')),
    store: null,
    quantum: null,
    background: false,
    connection,
    priceFeed: async () => ({ usd: 150 }),
    quantpFetch: outside.request,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const record = { mint: QUANTP.mint, external: true, migrated: true, behind: false }
  const trade = {
    id: 'sig:1',
    signature: 'sig',
    slot: 1,
    index: 1,
    timestamp: 1792120000,
    venue: 'pool',
    side: 'buy',
    trader: WALLET_A,
    solAmount: '1000000000',
    tokenAmount: '5000000000000',
    price: 2e-7,
  }
  try {
    await app.store.set(`coin:${QUANTP.mint}`, {
      ...record,
      historyFrom: { cursor: 0, poolCursor: 0 },
    })
    await app.store.set(`trades:${QUANTP.mint}`, [trade])
    const candles = await (await fetch(base + '/api/quantp/candles?interval=60')).json()
    assert.equal(candles.source, 'indexer')
    assert.deepEqual(candles.items, [
      { time: 1792119960, open: 2e-7, high: 2e-7, low: 2e-7, close: 2e-7, volume: 1 },
    ])
    const trades = await (await fetch(base + '/api/quantp/trades')).json()
    assert.equal(trades.source, 'indexer')
    assert.equal(trades.items[0].id, 'sig:1')
    assert.ok(!outside.calls.some((u) => u.includes('geckoterminal')))

    // history still being read (or only the newest part of it): GeckoTerminal instead
    await app.store.set(`coin:${QUANTP.mint}`, { ...record, historyFrom: { cursor: 1792000000 } })
    const partial = await (await fetch(base + '/api/quantp/candles?interval=60')).json()
    assert.equal(partial.source, 'geckoterminal')
  } finally {
    await new Promise((r) => server.close(r))
    app.close()
  }
})
