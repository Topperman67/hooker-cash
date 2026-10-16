// $QUANTP's live figures, chart and trades without the store: GET /api/quantp and its candles and
// trades routes (server/application.mjs) keep working while Redis is down.
//
// Sources, each cached in memory with one shared fetch at a time (as in prices.mjs), each failing
// on its own (its fields go null, or keep the last good value marked stale):
//   - chain: one getMultipleAccounts of the DBC pool and the mint (plus the DAMM v2 pool once the
//     curve has graduated, and the config on the first read; DBC configs never change);
//   - DexScreener: USD price, 24h change, volume and trade counts;
//   - holders: a Token-2022 getProgramAccounts scan of the mint's accounts, every 10 minutes;
//   - SOL/USD: the app's price feed (prices.mjs);
//   - GeckoTerminal: candles and trades for the token page when the indexer has none to give,
//     within its free tier (30 calls a minute per IP).
// Never used for transaction amounts: the trade ticket quotes from the chain itself.
import { Buffer } from 'node:buffer'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { getTotalFeeNumeratorFromIncludedFeeAmount } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { POOL_TOKEN_A_MINT_OFFSET, POOL_TOKEN_B_MINT_OFFSET } from '@meteora-ag/cp-amm-sdk'
import * as meteora from '../shared/meteora.mjs'
import { QUANTP, network, priceFromSqrtPrice } from '../shared/network.mjs'
import { candlesFor } from './market-math.mjs'

const DAY = 86_400
// Tokens sent here are gone for good: a burn by transfer instead of a Token-2022 Burn.
const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
// The pools' vaults belong to these authorities: liquidity, not holders.
const POOL_OWNERS = new Set([
  meteora.DBC_POOL_AUTHORITY.toBase58(),
  meteora.DAMM_POOL_AUTHORITY.toBase58(),
])

const big = (v) => BigInt(v?.toString?.() ?? v ?? 0)
const finite = (v) => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? n : null
}
const sum = (values) => {
  const known = values.filter((v) => v != null)
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

// Resolves when `promise` settles or after `ms`, whichever is first (never rejects).
function settleWithin(promise, ms) {
  let timer
  const wait = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  return Promise.race([promise.catch(() => {}), wait]).finally(() => clearTimeout(timer))
}

/**
 * One cached value: fresh for `ttl` ms, refreshed by one shared `load()` at a time. A failed load
 * keeps the last good value and is not retried for `retry` ms. A reader waits at most `wait` ms
 * for a refresh, then gets what is cached while the load finishes for the next reader.
 * Resolves to { value, at, state: 'ok' | 'stale' | 'down' }.
 */
export function cachedSource(load, { ttl, retry = ttl, wait = 6000, now = Date.now }) {
  let last = null
  let failedAt = -Infinity
  let pending = null
  const refresh = () =>
    (pending ||= Promise.resolve()
      .then(load)
      .then(
        (value) => {
          last = { value, at: now() }
          failedAt = -Infinity
        },
        () => {
          failedAt = now()
        },
      )
      .finally(() => (pending = null)))
  return async function read() {
    const t = now()
    if (!(last && t - last.at < ttl) && (pending || t - failedAt >= retry))
      await settleWithin(refresh(), wait)
    if (!last) return { value: null, at: null, state: 'down' }
    return { value: last.value, at: last.at, state: now() - last.at < ttl ? 'ok' : 'stale' }
  }
}

// ---- chain --------------------------------------------------------------------------------------

/** The verified DAMM v2 pool state of `token` from an account, or null. */
function dammOf(info, token) {
  if (info?.owner?.toBase58?.() !== network.dammV2Program) return null
  const damm = meteora.decodeDammPool(info.data)
  return damm && damm.tokenAMint === token.mint && damm.tokenBMint === network.wsolMint
    ? damm
    : null
}

/**
 * The curve fee charged now, in bps, from the config's base fee schedule (QUANTP's is a flat 2%).
 * Falls back to the schedule's starting fee if the SDK cannot evaluate it.
 */
export function curveFeeBps(pool, config, nowSecs) {
  const fees = config.raw.poolFees
  const starting = () => Number(fees.baseFee.cliffFeeNumerator.toString()) / 100_000
  // A slot-clocked pool would need the slot: its starting fee is shown instead.
  if (config.activationType !== 1) return starting()
  try {
    const s = pool.raw.poolState
    const numerator = getTotalFeeNumeratorFromIncludedFeeAmount(
      fees,
      s.volatilityTracker,
      new BN(Math.floor(nowSecs)),
      s.activationPoint,
      new BN(1_000_000_000),
      1, // QuoteToBase
    )
    return Number(numerator.toString()) / 100_000 // numerators are over 1e9
  } catch {
    return starting()
  }
}

/**
 * Fees the token's pools have earned so far, in SOL: every trading and protocol fee, the
 * creator's share of them, and that share split by the team's stated policy (`holdersShareBps` to
 * holders, the rest to buybacks). On the curve the creator gets `creatorTradingFeePercentage` of
 * the trading fee (the rest goes to the partner, and the protocol fee to Meteora). In the DAMM v2
 * pool fees go to liquidity positions: the creator holds its config's LP share of the liquidity
 * the curve migrated, diluted by any liquidity added since. Fees taken in the token are valued at
 * `priceSol`. Earned, not paid: the team claims and pays them out off-chain.
 */
export function feeFigures({ pool, config, damm, decimals = 6 }, priceSol, token = QUANTP) {
  const m = pool.raw.poolState.metrics
  const tokenToSol = (raw) => (priceSol > 0 ? (Number(big(raw)) / 10 ** decimals) * priceSol : 0)
  const trading = Number(big(m.totalTradingQuoteFee)) / 1e9 + tokenToSol(m.totalTradingBaseFee)
  const protocol = Number(big(m.totalProtocolQuoteFee)) / 1e9 + tokenToSol(m.totalProtocolBaseFee)
  let lifetimeSol = trading + protocol
  let creatorLifetimeSol = (trading * config.creatorTradingFeePercentage) / 100
  if (damm) {
    const dm = damm.raw.metrics
    const lp = Number(big(dm.totalLpBFee)) / 1e9 + tokenToSol(dm.totalLpAFee)
    lifetimeSol += lp + Number(big(dm.totalProtocolBFee)) / 1e9 + tokenToSol(dm.totalProtocolAFee)
    const r = config.raw
    const creatorShare =
      (Number(r.creatorLiquidityPercentage || 0) +
        Number(r.creatorPermanentLockedLiquidityPercentage || 0) +
        Number(r.creatorLiquidityVestingInfo?.vestingPercentage || 0)) /
      100
    // Migrated LP is the only permanently locked liquidity: it tells how much of the pool the
    // migrated positions still hold.
    const lockedShare =
      (Number(r.creatorPermanentLockedLiquidityPercentage || 0) +
        Number(r.partnerPermanentLockedLiquidityPercentage || 0)) /
      100
    const liquidity = Number(big(damm.raw.liquidity))
    const locked = Number(big(damm.raw.permanentLockLiquidity))
    const migrated =
      lockedShare > 0 && liquidity > 0 ? Math.min(1, locked / lockedShare / liquidity) : 1
    creatorLifetimeSol += lp * creatorShare * migrated
  }
  const holdersSol = (creatorLifetimeSol * token.holdersShareBps) / 10_000
  return {
    lifetimeSol,
    creatorLifetimeSol,
    holdersSol,
    buybackSol: creatorLifetimeSol - holdersSol,
  }
}

// ---- DexScreener --------------------------------------------------------------------------------

/** DexScreener's SOL pairs for `token`, reduced to the fields used (null fields when missing). */
export function dexPairs(body, token = QUANTP) {
  return (Array.isArray(body?.pairs) ? body.pairs : [])
    .filter(
      (p) =>
        p?.chainId === 'solana' &&
        p.baseToken?.address === token.mint &&
        p.quoteToken?.address === network.wsolMint,
    )
    .map((p) => ({
      address: String(p.pairAddress || ''),
      priceUsd: finite(p.priceUsd),
      priceNative: finite(p.priceNative),
      change24h: finite(p.priceChange?.h24), // percent
      volume24hUsd: finite(p.volume?.h24),
      buys: finite(p.txns?.h24?.buys),
      sells: finite(p.txns?.h24?.sells),
      createdAt: finite(p.pairCreatedAt), // ms
    }))
}

/**
 * Market figures across the token's pairs (the bonding curve's and, after graduation, the DAMM v2
 * pool's): price from the pair trading now (`activePool`, else the busiest), 24h volume and trade
 * counts summed, and the 24h change measured from the oldest pair's price a day ago, so a pool
 * opened at graduation does not restart the change from its first trade.
 */
export function dexFigures(pairs, activePool, nowMs = Date.now()) {
  if (!pairs?.length) return null
  const busiest = [...pairs].sort((a, b) => (b.volume24hUsd || 0) - (a.volume24hUsd || 0))[0]
  const active = pairs.find((p) => p.address === activePool) || busiest
  const oldest = [...pairs].sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity))[0]
  let change24h = active.change24h == null ? null : active.change24h / 100
  if (
    oldest !== active &&
    oldest.change24h != null &&
    oldest.priceNative > 0 &&
    active.priceNative > 0 &&
    !(active.createdAt < nowMs - DAY * 1000)
  ) {
    const dayAgo = oldest.priceNative / (1 + oldest.change24h / 100)
    if (dayAgo > 0) change24h = active.priceNative / dayAgo - 1
  }
  const buys = sum(pairs.map((p) => p.buys))
  const sells = sum(pairs.map((p) => p.sells))
  return {
    priceUsd: active.priceUsd,
    priceNative: active.priceNative,
    change24h: Number.isFinite(change24h) ? change24h : null,
    volume24hUsd: sum(pairs.map((p) => p.volume24hUsd)),
    txns24h: buys == null && sells == null ? null : { buys: buys ?? 0, sells: sells ?? 0 },
  }
}

// ---- the snapshot -------------------------------------------------------------------------------

/**
 * The /api/quantp response (src/context/QuantpContext.jsx documents it) from each source's latest
 * read: `chain`, `dex` and `holders` as cachedSource gives them, `usd` SOL/USD (or null).
 */
export function quantpSnapshot({ chain, dex, holders, usd, nowMs = Date.now(), token = QUANTP }) {
  const c = chain?.value || null
  const decimals = c?.config?.tokenDecimal ?? token.decimals
  const dammPool = c?.damm ? c.dammPool : null
  // The pair trading now: the curve's until it graduates, then the DAMM v2 pool's (any pair
  // but the curve's while that pool is still unknown here).
  const active = !c?.migrated
    ? token.pool
    : dammPool || dex?.value?.find((p) => p.address !== token.pool)?.address
  const d = dexFigures(dex?.value, active, nowMs)
  const curvePrice = c ? priceFromSqrtPrice(c.pool.sqrtPrice, decimals) : null
  // After graduation the curve's last price is history: the DAMM v2 pool's, else DexScreener's.
  const priceSol =
    (c?.damm ? priceFromSqrtPrice(c.damm.sqrtPrice, decimals) : null) ??
    (c && !c.migrated ? curvePrice : null) ??
    d?.priceNative ??
    curvePrice
  const fromSol = priceSol != null && usd > 0 ? priceSol * usd : null
  // DexScreener's USD price, unless it lags the pool: it trails the chain by up to a minute, so
  // when it is more than 3% off the pool's own price (in USD at our SOL/USD) the pool's wins and
  // the USD and SOL prices shown together never contradict.
  const dexUsd = dex?.state === 'ok' ? d?.priceUsd : null
  const lagging =
    dexUsd != null &&
    fromSol != null &&
    chain?.state === 'ok' &&
    Math.abs(dexUsd / fromSol - 1) > 0.03
  const priceUsd = (lagging ? null : dexUsd) ?? fromSol ?? d?.priceUsd ?? null
  const supply = c?.supply ?? null
  const tokens = Number(supply ?? token.supply) / 10 ** decimals
  const burnHeld = holders?.value?.burnHeld ?? 0n
  const threshold = c?.config?.migrationQuoteThreshold
  const curveProgress = !c
    ? null
    : c.complete
      ? 1
      : threshold > 0n
        ? Math.max(0, Math.min(1, Number(c.pool.quoteReserve) / Number(threshold)))
        : null
  const postGradFeeBps = Number(c?.config?.raw?.migratedPoolFeeBps ?? token.postGradFeeBps)
  // A full curve trades next in its DAMM v2 pool, so its fee is the pool's.
  const feeBps = !c
    ? null
    : c.complete
      ? postGradFeeBps
      : curveFeeBps(c.pool, c.config, nowMs / 1000)
  const launchedAt =
    c?.config?.activationType === 1 && c.pool.activationPoint > 0n
      ? Number(c.pool.activationPoint)
      : token.launchedAt
  const times = [chain?.at, dex?.at].filter((t) => t != null)
  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals,
    pool: token.pool,
    config: token.config,
    priceSol,
    priceUsd,
    change24h: d?.change24h ?? null,
    marketCapSol: priceSol != null ? priceSol * tokens : null,
    marketCapUsd: priceUsd != null ? priceUsd * tokens : null,
    volume24hUsd: d?.volume24hUsd ?? null,
    txns24h: d?.txns24h ?? null,
    supply,
    burned: supply == null ? null : (big(token.supply) - big(supply) + big(burnHeld)).toString(),
    holders: holders?.value?.holders ?? null,
    curveProgress,
    migrated: !!c?.migrated,
    dammPool,
    feeBps,
    postGradFeeBps,
    fees: c ? feeFigures({ ...c, decimals }, priceSol, token) : null,
    launchedAt,
    updatedAt: times.length ? Math.floor(Math.max(...times) / 1000) : null,
    sources: { chain: chain?.state || 'down', dex: dex?.state || 'down' },
  }
}

/**
 * Live $QUANTP figures from the chain, DexScreener and a holder scan. `connection` is a web3.js
 * Connection, `request` a fetch, `solUsd` the app's price feed (resolves to { usd }).
 * snapshot() resolves to the /api/quantp response, or throws a 503 when neither the chain nor
 * DexScreener has ever answered on this instance. pools() lists the pools its trades ran through,
 * oldest first, for the chart and trades fallback.
 */
export function createQuantpFeed({
  connection,
  request = fetch,
  solUsd = async () => ({ usd: null }),
  now = Date.now,
  token = QUANTP,
  ttl = { chain: 15_000, dex: 30_000, holders: 600_000 },
} = {}) {
  const poolKey = new PublicKey(token.pool)
  const mintKey = new PublicKey(token.mint)
  let config = null
  let dammKey = null
  let dammSearchAt = -Infinity

  const decodeConfig = (info) =>
    info?.owner?.toBase58?.() === network.dbcProgram ? meteora.decodeDbcConfig(info.data) : null

  // The DAMM v2 pool the curve migrated into: the address DBC derives for the config's migration
  // fee option, verified on-chain. If that is not it, the pools holding the token against SOL are
  // searched (at most every 5 minutes) and the one holding the most locked liquidity, as migrated
  // liquidity is, is taken.
  async function findDamm() {
    const predicted = meteora.migratedPoolFor(config, mintKey)
    const info = await connection.getAccountInfo(predicted, 'confirmed')
    const damm = dammOf(info, token)
    if (damm) return { key: predicted, damm }
    if (now() - dammSearchAt < 300_000) return null
    dammSearchAt = now()
    const found = await connection.getProgramAccounts(meteora.DAMM_V2_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: POOL_TOKEN_A_MINT_OFFSET, bytes: token.mint } },
        { memcmp: { offset: POOL_TOKEN_B_MINT_OFFSET, bytes: network.wsolMint } },
      ],
    })
    let best = null
    for (const { pubkey, account } of found) {
      const candidate = dammOf(account, token)
      if (
        candidate &&
        (!best || candidate.raw.permanentLockLiquidity.gt(best.damm.raw.permanentLockLiquidity))
      )
        best = { key: pubkey, damm: candidate }
    }
    return best
  }

  async function loadChain() {
    const keys = [
      poolKey,
      mintKey,
      ...(dammKey ? [dammKey] : []),
      ...(config ? [] : [new PublicKey(token.config)]),
    ]
    const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed')
    const [poolInfo, mintInfo] = infos
    const pool =
      poolInfo?.owner?.toBase58?.() === network.dbcProgram
        ? meteora.decodeDbcPool(poolInfo.data)
        : null
    if (!pool || pool.baseMint !== token.mint) throw Error('The $QUANTP pool could not be read.')
    if (!config) {
      const decoded = decodeConfig(infos.at(-1))
      config =
        decoded && pool.config === token.config
          ? decoded
          : decodeConfig(await connection.getAccountInfo(new PublicKey(pool.config), 'confirmed'))
      if (!config) throw Error('The $QUANTP pool config could not be read.')
    }
    const mintData = mintInfo?.data ? Buffer.from(mintInfo.data) : null
    const supply = mintData?.length >= 45 ? mintData.readBigUInt64LE(36).toString() : null
    const complete = pool.migrationProgress > meteora.PROGRESS.PRE
    const migrated = pool.isMigrated || pool.migrationProgress === meteora.PROGRESS.MIGRATED
    let damm = dammKey ? dammOf(infos[2], token) : null
    if (migrated && !damm) {
      const found = await findDamm().catch(() => null)
      dammKey = found?.key || null
      damm = found?.damm || null
    }
    return {
      pool,
      config,
      supply,
      complete: complete || migrated,
      migrated,
      damm,
      dammPool: damm ? dammKey.toBase58() : null,
    }
  }

  async function loadDex() {
    const r = await request(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) throw Error(`DexScreener answered ${r.status}`)
    const pairs = dexPairs(await r.json(), token)
    if (!pairs.length) throw Error('DexScreener lists no $QUANTP pair')
    return pairs
  }

  // Distinct wallets holding any: token accounts are read as owner and amount only (40 bytes
  // each). Pool vaults are liquidity, and the incinerator's balance counts as burned.
  async function loadHolders() {
    const accounts = await connection.getProgramAccounts(new PublicKey(network.token2022Program), {
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
    })
    const owners = new Set()
    let burnHeld = 0n
    for (const { account } of accounts) {
      const data = Buffer.from(account.data)
      if (data.length < 40) continue
      const amount = data.readBigUInt64LE(32)
      if (amount === 0n) continue
      const owner = new PublicKey(data.subarray(0, 32)).toBase58()
      if (owner === INCINERATOR) burnHeld += amount
      else if (!POOL_OWNERS.has(owner)) owners.add(owner)
    }
    return { holders: owners.size, burnHeld }
  }

  const chain = cachedSource(loadChain, { ttl: ttl.chain, retry: 5_000, wait: 8_000, now })
  const dex = cachedSource(loadDex, { ttl: ttl.dex, retry: 10_000, wait: 6_000, now })
  const holders = cachedSource(loadHolders, { ttl: ttl.holders, retry: 120_000, wait: 4_000, now })

  return {
    async snapshot() {
      const [c, d, h, price] = await Promise.all([
        chain(),
        dex(),
        holders(),
        Promise.resolve()
          .then(solUsd)
          .catch(() => null),
      ])
      if (c.state === 'down' && d.state === 'down')
        throw Object.assign(
          Error('Live $QUANTP figures are unavailable right now. Retrying shortly.'),
          {
            status: 503,
            expose: true,
            code: 'QUANTP_UNAVAILABLE',
          },
        )
      return quantpSnapshot({
        chain: c,
        dex: d,
        holders: h,
        usd: price?.usd ?? null,
        nowMs: now(),
        token,
      })
    },
    async pools() {
      const c = (await chain()).value
      return [
        { address: token.pool, venue: 'curve', done: !!c?.complete },
        ...(c?.dammPool ? [{ address: c.dammPool, venue: 'pool', done: false }] : []),
      ]
    },
  }
}

// ---- GeckoTerminal ------------------------------------------------------------------------------

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana/pools'
// Our chart intervals as GeckoTerminal timeframes (its seconds timeframe is a paid plan: 15 s
// candles are built from its trades instead), with how long each stays cached.
const TIMEFRAMES = {
  60: ['minute', 1, 30_000],
  300: ['minute', 5, 30_000],
  900: ['minute', 15, 60_000],
  3600: ['hour', 1, 120_000],
  14400: ['hour', 4, 300_000],
  86400: ['day', 1, 600_000],
}
const TRADES_TTL = 15_000
// A graduated curve trades no more: its history is cached this long.
const DONE_TTL = 3_600_000

// A decimal amount as integer base units ("0.042589317" SOL → "42589317").
function units(text, decimals) {
  const value = String(text ?? '').trim()
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value)
  if (m) {
    const fraction = (m[2] || '').slice(0, decimals).padEnd(decimals, '0')
    return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(fraction || '0')).toString()
  }
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? BigInt(Math.round(n * 10 ** decimals)).toString() : null
}

/** GeckoTerminal OHLCV (priced in SOL, volume in SOL) as the chart's candles, oldest first. */
export function geckoCandles(body) {
  const rows = body?.data?.attributes?.ohlcv_list
  if (!Array.isArray(rows)) return []
  const byTime = new Map()
  for (const row of rows) {
    const [time, open, high, low, close, volume] = (Array.isArray(row) ? row : []).map(Number)
    if (!(time > 0) || ![open, high, low, close].every((v) => v > 0)) continue
    byTime.set(time, { time, open, high, low, close, volume: volume >= 0 ? volume : 0 })
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/** GeckoTerminal trades as the trades table's rows (the indexer's shape), newest first. */
export function geckoTrades(body, { venue = 'curve', token = QUANTP } = {}) {
  const out = []
  for (const row of Array.isArray(body?.data) ? body.data : []) {
    const a = row?.attributes
    if (!a?.tx_hash) continue
    const buy = a.from_token_address === network.wsolMint && a.to_token_address === token.mint
    const sell = a.from_token_address === token.mint && a.to_token_address === network.wsolMint
    if (!buy && !sell) continue
    const solAmount = units(buy ? a.from_token_amount : a.to_token_amount, network.nativeDecimals)
    const tokenAmount = units(buy ? a.to_token_amount : a.from_token_amount, token.decimals)
    const timestamp = Math.floor(Date.parse(a.block_timestamp) / 1000)
    if (!solAmount || !tokenAmount || !(timestamp > 0)) continue
    // Prices are in the pool's "currency token", SOL here (its own price reads 1).
    const solPrice = finite(buy ? a.price_from_in_currency_token : a.price_to_in_currency_token)
    const quoted = finite(buy ? a.price_to_in_currency_token : a.price_from_in_currency_token)
    const ratio =
      Number(tokenAmount) > 0
        ? Number(solAmount) / 1e9 / (Number(tokenAmount) / 10 ** token.decimals)
        : null
    const index = Number(String(row.id || '').split('_')[3]) || 0
    out.push({
      id: `${a.tx_hash}:${index}`,
      signature: a.tx_hash,
      slot: finite(a.block_number) ?? 0,
      index,
      timestamp,
      venue,
      side: buy ? 'buy' : 'sell',
      trader: String(a.tx_from_address || ''),
      solAmount,
      tokenAmount,
      price: solPrice != null && Math.abs(solPrice - 1) < 1e-6 && quoted > 0 ? quoted : ratio,
    })
  }
  return out.sort((x, y) => y.timestamp - x.timestamp || y.slot - x.slot || y.index - x.index)
}

/** Candles of several pools (oldest pool first) as one series: a shared bucket is merged. */
export function mergeCandles(lists) {
  const byTime = new Map()
  for (const list of lists)
    for (const c of list) {
      const prev = byTime.get(c.time)
      byTime.set(
        c.time,
        prev
          ? {
              time: c.time,
              open: prev.open,
              high: Math.max(prev.high, c.high),
              low: Math.min(prev.low, c.low),
              close: c.close,
              volume: prev.volume + c.volume,
            }
          : c,
      )
    }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/**
 * Candles and trades from GeckoTerminal's public API, for pools as createQuantpFeed().pools()
 * lists them. Calls are capped at `perMinute` per instance (its free tier allows 30 a minute per
 * IP); past that, cached answers are served. candles()/trades() throw a 503 when nothing is cached.
 */
export function createGeckoFeed({
  request = fetch,
  now = Date.now,
  perMinute = 20,
  token = QUANTP,
} = {}) {
  let minute = { start: -Infinity, used: 0 }
  const allow = () => {
    const t = now()
    if (t - minute.start >= 60_000) minute = { start: t, used: 0 }
    if (minute.used >= perMinute) return false
    minute.used++
    return true
  }
  const sources = new Map()
  function cached(url, ttl) {
    const key = `${ttl}|${url}`
    if (!sources.has(key)) {
      if (sources.size > 100) sources.clear()
      sources.set(
        key,
        cachedSource(
          async () => {
            if (!allow()) throw Error('GeckoTerminal budget used for this minute')
            const r = await request(url, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(6000),
            })
            if (!r.ok) throw Error(`GeckoTerminal answered ${r.status}`)
            return r.json()
          },
          { ttl, retry: 10_000, wait: 7_000, now },
        ),
      )
    }
    return sources.get(key)()
  }
  const unavailable = () =>
    Object.assign(Error('Chart data is unavailable right now. Retrying shortly.'), {
      status: 503,
      expose: true,
      code: 'MARKET_DATA_UNAVAILABLE',
    })

  async function trades(pools) {
    const reads = await Promise.all(
      pools.map((p) => cached(`${GECKO}/${p.address}/trades`, p.done ? DONE_TTL : TRADES_TTL)),
    )
    if (reads.every((r) => r.state === 'down')) throw unavailable()
    return reads
      .flatMap((r, i) => (r.value ? geckoTrades(r.value, { venue: pools[i].venue, token }) : []))
      .sort((x, y) => y.timestamp - x.timestamp || y.slot - x.slot || y.index - x.index)
  }

  async function candles(pools, interval) {
    const frame = TIMEFRAMES[interval]
    if (!frame) return candlesFor(await trades(pools), interval)
    const [timeframe, aggregate, ttl] = frame
    const reads = await Promise.all(
      pools.map((p) =>
        cached(
          `${GECKO}/${p.address}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=1000&currency=token&token=${token.mint}`,
          p.done ? DONE_TTL : ttl,
        ),
      ),
    )
    if (reads.every((r) => r.state === 'down')) throw unavailable()
    return mergeCandles(reads.map((r) => geckoCandles(r.value)))
  }

  return { candles, trades }
}
