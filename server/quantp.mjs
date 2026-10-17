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
//     within its free tier (30 calls a minute per IP);
//   - the team's wallets (QUANTP.creator and QUANTP.payoutWallet): the payouts to holders and the
//     burns, from their transaction histories, each transaction read once.
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
 * `due(value)` may ask for the next refresh sooner than `ttl` (a value still being completed),
 * without the value counting as stale before `ttl`.
 * Resolves to { value, at, state: 'ok' | 'stale' | 'down' }. read.peek() gives the same at once,
 * never waiting: it starts a refresh when one is due and leaves it to finish in the background.
 * read.loading() says whether a refresh is under way.
 */
export function cachedSource(load, { ttl, retry = ttl, wait = 6000, now = Date.now, due }) {
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
  // A refresh is started when the value is past its lifetime, unless the last one failed lately.
  const refreshDue = (t) =>
    !(last && t - last.at < Math.min(ttl, due?.(last.value) ?? ttl)) &&
    (pending || t - failedAt >= retry)
  const cached = () =>
    last
      ? { value: last.value, at: last.at, state: now() - last.at < ttl ? 'ok' : 'stale' }
      : { value: null, at: null, state: 'down' }
  async function read() {
    if (refreshDue(now())) await settleWithin(refresh(), wait)
    return cached()
  }
  read.peek = () => {
    if (refreshDue(now())) refresh()
    return cached()
  }
  read.loading = () => pending !== null
  return read
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

// ---- payouts and burns --------------------------------------------------------------------------

const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
])
// Programs a payout transaction may hold besides its SOL transfers.
const PAYOUT_EXTRAS = new Set(['ComputeBudget111111111111111111111111111111', ...MEMO_PROGRAMS])
// The memo the payout engine ends each of its transactions with: `h` is the run's period (the UTC
// clock hour, server/quantp-engine.mjs), the same in every transaction of one run.
const RUN_MEMO = /qp-engine:v1 h=(\d+)/
const TOKEN_PROGRAMS = new Set([network.tokenProgram, network.token2022Program])
// web3.js gives keys as PublicKeys, the RPC's JSON as strings.
const key = (v) => (v == null ? null : String(v.toBase58?.() ?? v))

/**
 * The team wallets the payouts and burns are read from: the payout wallet the team pays from by
 * hand, the payout engine's wallet once it is set (server/quantp-engine.mjs), the creator, and any
 * other wallet the team keeps (`otherWallets`: SOL moved there alone is the team's, no payout).
 * `payers` are the ones whose SOL transfers to holders are payouts.
 */
export function teamWallets(token = QUANTP) {
  const engine = token.engine?.wallet || null
  const payers = [...new Set([token.payoutWallet, engine].filter(Boolean))]
  return {
    payout: token.payoutWallet,
    creator: token.creator,
    engine,
    payers,
    all: [...new Set([...payers, token.creator, ...(token.otherWallets ?? [])].filter(Boolean))],
  }
}

/**
 * What one transaction (getParsedTransaction's shape) did for the ledger, as entries:
 *   - payout: a transaction of nothing but SOL transfers (compute budget and memos aside) out of
 *     a paying wallet (the payout wallet or the engine's), as the team's payout page and the engine
 *     send them. A transfer to one of the team's own
 *     wallets counts only beside transfers to others (a holder paid in a round), never alone (SOL
 *     moved back);
 *   - burn: what a team wallet burned of the token (Burn, BurnChecked, or a transfer to the
 *     incinerator), one entry per wallet;
 *   - buy: a team wallet ending up with more of the token (counting what it burned here) for less
 *     SOL. `lamports` is the drop in the SOL it holds, its own and its token accounts' (so wrapped
 *     SOL and rent it keeps are not spent), less the network fee.
 * Failed transactions give none, and so does the payout engine's hourly claim (a 0-byte account
 * made from its wallet, earlier ones swept back, and its memo): no SOL leaves the team in it.
 * A payout also keeps what each recipient got (`paid`, as [recipient, lamports] pairs). Every entry
 * of a transaction the engine sent carries its run (`run`, the period its memo names).
 */
export function ledgerEntries(tx, { token = QUANTP, wallets = teamWallets(token) } = {}) {
  const meta = tx?.meta
  const message = tx?.transaction?.message
  if (!meta || meta.err || !message) return []
  const team = new Set(wallets.all)
  const keys = message.accountKeys.map((k) => key(k.pubkey ?? k))
  const top = message.instructions
  const all = [...top, ...(meta.innerInstructions || []).flatMap((group) => group.instructions)]
  const program = (ix) => key(ix.programId)
  const isTransfer = (ix) => program(ix) === SYSTEM_PROGRAM && ix.parsed?.type === 'transfer'
  // a parsed memo instruction's `parsed` is its text
  const memo = top
    .filter((ix) => MEMO_PROGRAMS.has(program(ix)) && typeof ix.parsed === 'string')
    .map((ix) => RUN_MEMO.exec(ix.parsed))
    .find(Boolean)
  const base = {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    timestamp: tx.blockTime ?? null,
    ...(memo ? { run: Number(memo[1]) } : {}),
  }
  const out = []

  const payer = top.find((ix) => isTransfer(ix) && wallets.payers.includes(ix.parsed.info.source))
    ?.parsed.info.source
  if (payer && top.every((ix) => isTransfer(ix) || PAYOUT_EXTRAS.has(program(ix)))) {
    const sent = top.filter(
      (ix) =>
        isTransfer(ix) && ix.parsed.info.source === payer && ix.parsed.info.destination !== payer,
    )
    const paid = new Map() // recipient -> lamports
    if (sent.some((ix) => !team.has(ix.parsed.info.destination)))
      for (const { parsed } of sent)
        paid.set(
          parsed.info.destination,
          (paid.get(parsed.info.destination) ?? 0n) + big(parsed.info.lamports),
        )
    if (paid.size)
      out.push({
        kind: 'payout',
        ...base,
        wallet: payer,
        lamports: [...paid.values()].reduce((s, v) => s + v, 0n),
        recipients: [...paid.keys()],
        paid: [...paid],
      })
  }

  // Token accounts this transaction touched: their mint and owner, and their balance before/after.
  const accounts = new Map()
  for (const [field, list] of [
    ['pre', meta.preTokenBalances],
    ['post', meta.postTokenBalances],
  ])
    for (const b of list || []) {
      const address = keys[b.accountIndex]
      const entry = accounts.get(address) || {
        index: b.accountIndex,
        mint: b.mint,
        owner: b.owner,
        pre: 0n,
        post: 0n,
      }
      entry[field] = big(b.uiTokenAmount?.amount)
      accounts.set(address, entry)
    }

  const burned = new Map() // wallet -> { amount, method }
  for (const ix of all) {
    if (!TOKEN_PROGRAMS.has(program(ix)) || !ix.parsed?.info) continue
    const { type, info } = ix.parsed
    const wallet = info.authority ?? info.multisigAuthority
    if (!team.has(wallet)) continue
    const to = accounts.get(info.destination)
    const method =
      (type === 'burn' || type === 'burnChecked') && info.mint === token.mint
        ? 'burn'
        : (type === 'transfer' || type === 'transferChecked') &&
            to?.owner === INCINERATOR &&
            to.mint === token.mint
          ? 'incinerator'
          : null
    const amount = big(info.amount ?? info.tokenAmount?.amount)
    if (!method || amount <= 0n) continue
    const prev = burned.get(wallet)
    burned.set(wallet, {
      amount: (prev?.amount || 0n) + amount,
      method: prev && prev.method !== method ? 'burn' : method,
    })
  }

  for (const wallet of wallets.all) {
    const at = keys.indexOf(wallet)
    if (at < 0) continue
    const owned = [...accounts.values()].filter((a) => a.owner === wallet)
    const bought =
      owned.filter((a) => a.mint === token.mint).reduce((s, a) => s + a.post - a.pre, 0n) +
      (burned.get(wallet)?.amount || 0n)
    if (bought <= 0n) continue
    const held = (i) => big(meta.postBalances[i]) - big(meta.preBalances[i])
    let change = held(at) + owned.reduce((s, a) => s + held(a.index), 0n)
    if (at === 0) change += big(meta.fee) // the fee payer: the network fee is not part of the price
    if (change < 0n) out.push({ kind: 'buy', ...base, wallet, lamports: -change, amount: bought })
  }
  for (const [wallet, { amount, method }] of burned)
    out.push({ kind: 'burn', ...base, wallet, amount, method })
  return out
}

// Payout transactions this close together (seconds) are one burst: a round split over several
// transactions, or resumed after an interruption (round 1, paid by hand, took 9 s).
const BURST_GAP = 1800
// Across a clock hour, only transactions this close together (seconds) are one burst: the engine
// runs once an hour (each run's transactions confirm within its 25 s deadline), so a late run and
// the next hour's early one are two payouts even when less than BURST_GAP apart.
const HOUR_GAP = 120

/**
 * The real figures behind $QUANTP's 60/40 split, from a ledger() result (or null): what was paid
 * to holders and to how many wallets, the SOL spent buying $QUANTP back (burned or not yet), what
 * the team burned, and the SOL waiting in the payout wallet. /api/quantp carries it as `payouts`,
 * so every page that shows the split shows what actually happened, never an estimate. `complete`
 * is false while older history is still being read: the figures are then at least these, counted
 * from `since` (the oldest transaction read).
 */
export function ledgerSummary(ledger) {
  const t = ledger?.totals
  if (!t) return null
  return {
    paidLamports: t.paidLamports,
    wallets: t.recipients,
    boughtLamports: (BigInt(t.buybackLamports) + BigInt(t.unburned?.lamports ?? 0)).toString(),
    burnedAmount: t.burnedAmount,
    waitingLamports: ledger.payoutLamports ?? null,
    updatedAt: ledger.updatedAt ?? null,
    complete: ledger.complete !== false,
    since: ledger.since ?? null,
  }
}

/**
 * The /api/quantp/ledger lists from every entry read so far (ledgerEntries), newest first.
 *   - payouts: bursts, each the payout transactions of one run: sent by one wallet, with the same
 *     run memo (or none), within BURST_GAP of the one before and in the same clock hour unless
 *     within HOUR_GAP. A burn by the wallet ends its burst (a run pays out, then buys back).
 *     `lastTimestamp` is its newest transaction's.
 *   - burns: each with `solSpent`, what the burning wallet paid for the tokens it bought since its
 *     burn before (the buyback, in small buys or in the burn's own transaction), in proportion
 *     to the amount burned; null when nothing was bought for it. Buys in the launch (the creator's
 *     dev buy) are not buybacks. `totals.unburned` is what was bought and not burned yet, and
 *     `totals.unburnedByWallet` the same for each wallet holding some.
 * `payoutLamports` is the payout wallet's balance now (null when unknown).
 */
export function quantpLedger(
  entries,
  { token = QUANTP, wallets = teamWallets(token), payoutLamports = null } = {},
) {
  const order = { buy: 0, payout: 1, burn: 2 } // within a transaction, a buy comes before its burn
  const chronological = [...entries].sort(
    (a, b) =>
      a.slot - b.slot ||
      (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) ||
      order[a.kind] - order[b.kind],
  )
  const pending = new Map() // wallet -> { lamports, amount }: bought back and not burned yet
  const hour = (t) => Math.floor(t / 3600)
  const bursts = []
  let open = null // the burst the next payout may join
  const burns = []
  for (const e of chronological) {
    if (e.kind === 'buy') {
      if (!(e.timestamp > token.launchedAt)) continue
      const p = pending.get(e.wallet) ?? { lamports: 0n, amount: 0n }
      pending.set(e.wallet, { lamports: p.lamports + e.lamports, amount: p.amount + e.amount })
    } else if (e.kind === 'payout') {
      const prev = open?.at(-1)
      const gap = prev ? e.timestamp - prev.timestamp : Infinity
      if (
        prev &&
        prev.wallet === e.wallet &&
        (prev.run ?? null) === (e.run ?? null) &&
        gap <= BURST_GAP &&
        (gap <= HOUR_GAP || hour(prev.timestamp) === hour(e.timestamp))
      )
        open.push(e)
      else bursts.push((open = [e]))
    } else if (e.kind === 'burn') {
      if (open?.[0].wallet === e.wallet) open = null
      let solSpent = null
      const p = pending.get(e.wallet)
      if (p?.amount > 0n) {
        const take = e.amount < p.amount ? e.amount : p.amount
        solSpent = (p.lamports * take) / p.amount
        pending.set(e.wallet, { lamports: p.lamports - solSpent, amount: p.amount - take })
      }
      burns.push({ ...e, solSpent })
    }
  }
  const sum = (list, field) => list.reduce((s, e) => s + (e[field] ?? 0n), 0n)
  const paid = bursts.flat()
  const unburned = [...pending].filter(([, p]) => p.amount > 0n || p.lamports > 0n)
  const amounts = (p) => ({ lamports: p.lamports.toString(), amount: p.amount.toString() })
  return {
    mint: token.mint,
    wallets: { payout: wallets.payout, creator: wallets.creator, engine: wallets.engine },
    payoutLamports: payoutLamports == null ? null : payoutLamports.toString(),
    payouts: bursts.reverse().map((burst) => {
      const recipients = new Set(burst.flatMap((e) => e.recipients))
      return {
        timestamp: burst[0].timestamp,
        lastTimestamp: burst.at(-1).timestamp,
        wallet: burst[0].wallet,
        lamports: sum(burst, 'lamports').toString(),
        recipients: recipients.size,
        recipient: recipients.size === 1 ? [...recipients][0] : null,
        transactions: burst.map((e) => ({
          signature: e.signature,
          slot: e.slot,
          timestamp: e.timestamp,
          lamports: e.lamports.toString(),
          recipients: e.recipients.length,
        })),
      }
    }),
    burns: burns.reverse().map((e) => ({
      signature: e.signature,
      slot: e.slot,
      timestamp: e.timestamp,
      wallet: e.wallet,
      method: e.method,
      amount: e.amount.toString(),
      solSpent: e.solSpent == null ? null : e.solSpent.toString(),
    })),
    totals: {
      paidLamports: sum(paid, 'lamports').toString(),
      payoutTxs: paid.length,
      recipients: new Set(paid.flatMap((e) => e.recipients)).size,
      burnedAmount: sum(burns, 'amount').toString(),
      buybackLamports: sum(burns, 'solSpent').toString(),
      unburned: amounts({
        lamports: unburned.reduce((s, [, p]) => s + p.lamports, 0n),
        amount: unburned.reduce((s, [, p]) => s + p.amount, 0n),
      }),
      unburnedByWallet: Object.fromEntries(unburned.map(([wallet, p]) => [wallet, amounts(p)])),
    },
  }
}

// Reads of one transaction that may fail before the ledger stops hurrying for it. It is still
// asked for on every refresh, after the rest, but no longer refreshes the lists every partialTtl
// or holds up the engine's health check: anyone can send the team's wallets dust in a transaction
// version the node cannot return.
const READ_TRIES = 3

/**
 * $QUANTP's payouts and burns from the team wallets' histories, read a part at a time. Each refresh
 * (every `ttl` per instance, every `partialTtl` while there is more to list, or to read that has
 * not failed READ_TRIES times):
 *   - lists every wallet's signatures newer than the newest one listed (the wallets at once), at
 *     most `maxPages` pages of `pageLimit`. A listing cut off there leaves a cursor on what it did
 *     not reach: the older history on a first listing, or the gap down to the newest signature
 *     listed before. Every refresh lists one more page from each open cursor until it closes, so
 *     no signature is ever skipped and no refresh lists without bound;
 *   - reads the transactions listed and not read yet, newest first, at most `maxReads` of them or
 *     for `readMs` (at least one batch): a confirmed transaction never changes, so each is read
 *     once. On the public RPC, which rate-limits hard, it pauses between batches;
 *   - reads the payout wallet's balance (one call).
 * ledger() resolves to quantpLedger's lists with `updatedAt`, `state`, `unread` (transactions
 * listed but not read yet), `unreadable` (how many of those failed READ_TRIES reads),
 * `newestUnreadAt` (the block time of the newest unread one, unreadable ones aside, or null),
 * `complete` (false while a cursor is open or anything is unread: the lists may then be missing
 * transactions, older ones first) and `since` (the oldest transaction read). `state` is 'partial'
 * while incomplete. It throws a 503 when the histories have never been listed on this instance.
 * peek() is the same, or null, at once: it never waits for a refresh. loading() says whether a
 * refresh is under way. forWallet(address) resolves to what the payouts read so far sent that
 * wallet.
 */
export function createQuantpLedger({
  connection,
  now = Date.now,
  token = QUANTP,
  ttl = 120_000,
  partialTtl = 10_000,
  pageLimit = 1000,
  maxPages = 3,
  concurrency = 4,
  maxReads = 200,
  readMs = 5_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const wallets = teamWallets(token)
  const listed = new Map() // successful transactions' signatures -> { slot, blockTime }
  const read = new Map() // signature -> its entries
  const failed = new Map() // signature -> reads that came back empty or were refused
  const newest = new Map() // wallet -> the newest signature listed
  const cursors = new Map() // wallet -> [{ before, until }]: ranges of its history not listed yet
  let hurry = false // the last load left more to list, or to read that may yet be read
  const publicRpc = String(connection?.rpcEndpoint ?? '').includes('api.mainnet-beta.solana.com')

  // Up to `pages` pages of `wallet`'s signatures, newest first, older than `before` and newer than
  // `until` (each when given). `truncated` when the last page was full: there may be more.
  async function signaturesOf(wallet, { before, until } = {}, pages = maxPages) {
    const list = []
    for (let page = 0; page < pages; page++) {
      const found = await connection.getSignaturesForAddress(
        new PublicKey(wallet),
        { limit: pageLimit, ...(before ? { before } : {}), ...(until ? { until } : {}) },
        'confirmed',
      )
      list.push(...found)
      if (found.length < pageLimit) return { list, truncated: false }
      before = found.at(-1).signature
    }
    return { list, truncated: true }
  }

  // What is new at the tip of `wallet`'s history, and one more page of each range still open. A
  // tip listing cut off before the newest signature listed so far opens a range for the gap below
  // it, so `newest` moves up without leaving that gap behind.
  async function listWallet(wallet) {
    const until = newest.get(wallet)
    const tip = await signaturesOf(wallet, { until })
    const older = []
    const open = []
    for (const range of cursors.get(wallet) ?? []) {
      const page = await signaturesOf(wallet, range, 1)
      older.push(...page.list)
      if (page.truncated) open.push({ ...range, before: page.list.at(-1).signature })
    }
    if (tip.truncated) open.push({ before: tip.list.at(-1).signature, until })
    if (tip.list.length) newest.set(wallet, tip.list[0].signature)
    cursors.set(wallet, open)
    for (const s of [...tip.list, ...older])
      if (!s.err && !listed.has(s.signature))
        listed.set(s.signature, { slot: s.slot ?? 0, blockTime: s.blockTime ?? null })
  }

  async function load() {
    const started = now()
    await Promise.all(wallets.all.map(listWallet))
    // Read what has not been read, newest first, and what failed to read before after the rest.
    // One the node could not return or refused is left for a later refresh and counted in
    // `unread`, so no transaction (anyone can send the team's wallets dust in any transaction
    // version) holds up the lists. Version 1 is the newest.
    const pending = [...listed]
      .filter(([s]) => !read.has(s))
      .sort(([a, x], [b, y]) => (failed.get(a) ?? 0) - (failed.get(b) ?? 0) || y.slot - x.slot)
      .slice(0, maxReads)
      .map(([s]) => s)
    for (let i = 0; i < pending.length; i += concurrency) {
      if (i > 0 && now() - started >= readMs) break
      if (i > 0 && publicRpc) await sleep(250)
      const batch = pending.slice(i, i + concurrency)
      const txs = await Promise.allSettled(
        batch.map((s) =>
          connection.getParsedTransaction(s, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 1,
          }),
        ),
      )
      txs.forEach((r, j) => {
        if (r.value) read.set(batch[j], ledgerEntries(r.value, { token, wallets }))
        else failed.set(batch[j], (failed.get(batch[j]) ?? 0) + 1)
      })
    }
    // what the payout wallet holds for the next bursts (unknown if it cannot be read)
    const payoutLamports = wallets.payout
      ? await Promise.resolve()
          .then(() => connection.getBalance(new PublicKey(wallets.payout), 'confirmed'))
          .then(BigInt, () => null)
      : null
    // The oldest transaction read; of those left to read, how many failed READ_TRIES times, and
    // the newest of the rest (one listed without a block time counts as now).
    let since = null
    let unreadable = 0
    let newestUnreadAt = null
    for (const [s, { blockTime }] of listed) {
      if (read.has(s)) {
        if (blockTime != null && (since == null || blockTime < since)) since = blockTime
      } else if ((failed.get(s) ?? 0) >= READ_TRIES) unreadable++
      else newestUnreadAt = Math.max(newestUnreadAt ?? 0, blockTime ?? Math.floor(now() / 1000))
    }
    const unread = listed.size - read.size
    const listing = [...cursors.values()].some((open) => open.length > 0)
    hurry = listing || unread > unreadable
    return {
      ...quantpLedger([...read.values()].flat(), { token, wallets, payoutLamports }),
      unread,
      unreadable,
      newestUnreadAt,
      complete: unread === 0 && !listing,
      since,
    }
  }

  const source = cachedSource(load, {
    ttl,
    retry: 30_000,
    wait: 8_000,
    now,
    due: () => (hurry ? partialTtl : ttl),
  })
  const shown = (r) => ({
    ...r.value,
    updatedAt: Math.floor(r.at / 1000),
    state: r.state === 'ok' && !r.value.complete ? 'partial' : r.state,
  })
  async function ledger() {
    const r = await source()
    if (r.state === 'down')
      throw Object.assign(Error('Payouts and burns are unavailable right now. Retrying shortly.'), {
        status: 503,
        expose: true,
        code: 'LEDGER_UNAVAILABLE',
      })
    return shown(r)
  }
  return {
    ledger,
    peek() {
      const r = source.peek()
      return r.state === 'down' ? null : shown(r)
    },
    loading: source.loading,
    // The payouts that paid `address` (newest first, at most `limit` listed), with the lists'
    // `complete` and `since`.
    async forWallet(address, { limit = 50 } = {}) {
      const { complete, since } = await ledger()
      const items = []
      for (const entries of read.values())
        for (const e of entries) {
          const paid = e.kind === 'payout' ? e.paid.filter(([to]) => to === address) : []
          if (paid.length)
            items.push({ ...e, lamports: paid.reduce((s, [, lamports]) => s + lamports, 0n) })
        }
      items.sort((a, b) => b.slot - a.slot)
      return {
        lamports: items.reduce((s, e) => s + e.lamports, 0n).toString(),
        payouts: items.length,
        lastAt: items[0]?.timestamp ?? null,
        items: items.slice(0, limit).map((e) => ({
          signature: e.signature,
          timestamp: e.timestamp,
          lamports: e.lamports.toString(),
        })),
        complete,
        since,
      }
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
