// Indexes Quant Pad coins (and any pump.fun coin a visitor opens) from Solana transactions.
// State lives in the shared store so serverless instances cooperate through short leases.
import { randomBytes } from 'node:crypto'
import {
  extractEvents,
  normalizeCreate,
  tradesFrom,
  fetchTransactions,
  newSignatures,
  readCurve,
  readTokenIdentity,
  poolFor,
  curveFor,
  isSolQuote,
} from './solana.mjs'
import { candlesFor } from './market-math.mjs'
import { curveProgress, isAddress, isSignature } from '../shared/network.mjs'

const MAX_TRADES = 4000
const PER_PASS = Number(process.env.QUANTPAD_INDEX_BATCH || 40)
const MAX_EXTERNAL = 400
const DAY = 86400

export function createIndexer({
  connection,
  store,
  isQuantumCreator = () => false,
  now = () => Date.now(),
}) {
  const keys = {
    list: 'coins:list',
    coin: (mint) => `coin:${mint}`,
    trades: (mint) => `trades:${mint}`,
    lease: 'sync:lease',
    cursor: 'sync:cursor',
  }

  async function list() {
    return (await store.get(keys.list)) || []
  }
  async function saveSummary(record) {
    const items = await list()
    const summary = summarize(record)
    const index = items.findIndex((c) => c.mint === record.mint)
    if (index >= 0) items[index] = summary
    else items.unshift(summary)
    // External coins are capped; the least recently synced ones drop out of tracking.
    const external = items.filter((c) => c.external)
    if (external.length > MAX_EXTERNAL) {
      const drop = new Set(
        external
          .sort((a, b) => (a.syncedAt || 0) - (b.syncedAt || 0))
          .slice(0, external.length - MAX_EXTERNAL)
          .map((c) => c.mint),
      )
      await store.set(
        keys.list,
        items.filter((c) => !drop.has(c.mint)),
      )
    } else await store.set(keys.list, items)
  }

  async function registerLaunch(signature) {
    if (!isSignature(signature)) throw Error('Provide the launch transaction signature.')
    const [found] = await fetchTransactions(connection, [signature])
    if (!found)
      throw Object.assign(
        Error('Launch transaction is not confirmed yet. Try again in a moment.'),
        {
          status: 409,
        },
      )
    const create = extractEvents(found.tx).find((e) => e.name === 'CreateEvent')
    if (!create) throw Error('That transaction did not create a pump.fun coin.')
    const base = normalizeCreate(create.event, { signature, slot: found.tx.slot })
    if (!isSolQuote(base.quoteMint)) throw Error('Quant Pad tracks SOL-quoted coins only.')
    const existing = await store.get(keys.coin(base.mint))
    if (existing && !existing.external) return existing
    const record = {
      ...existing,
      ...base,
      quantum: await isQuantumCreator(base.mint, base.creator),
      external: false,
      source: 'quantpad',
      cursor: existing?.cursor || null,
      poolCursor: existing?.poolCursor || null,
      complete: existing?.complete || false,
      pool: existing?.pool || null,
      registeredAt: now(),
    }
    // The dev buy usually shares the create transaction: index it now so the coin page has a price
    // immediately; history beyond this transaction is picked up by background syncs.
    const initial = tradesFrom(found.tx, { signature, mint: record.mint, pool: null }).filter(
      (t) => t.side !== 'complete',
    )
    const known = (await store.get(keys.trades(record.mint))) || []
    const trades = [...initial.filter((t) => !known.some((k) => k.id === t.id)), ...known]
    const latest = trades.find((t) => t.price > 0)
    if (latest) {
      Object.assign(record, {
        price: latest.price,
        virtualSolReserves: latest.virtualSolReserves,
        virtualTokenReserves: latest.virtualTokenReserves,
        realTokenReserves: latest.realTokenReserves,
        progress: curveProgress(latest.realTokenReserves),
      })
    }
    Object.assign(record, stats(trades, now() / 1000))
    await store.set(keys.trades(record.mint), trades)
    await store.set(keys.coin(record.mint), record)
    await saveSummary(record)
    syncCoin(record.mint).catch(() => {})
    return record
  }

  async function track(mint) {
    if (!isAddress(mint)) throw Error('Enter a valid Solana mint address.')
    const existing = await store.get(keys.coin(mint))
    if (existing) return existing
    const curve = await readCurve(connection, mint)
    if (!curve) throw Object.assign(Error('That mint is not a pump.fun coin.'), { status: 404 })
    if (!isSolQuote(curve.quoteMint)) throw Error('Quant Pad tracks SOL-quoted coins only.')
    const identity = (await readTokenIdentity(connection, mint)) || {}
    const record = {
      mint,
      name: identity.name || 'Unknown',
      symbol: identity.symbol || '???',
      uri: identity.uri || '',
      creator: curve.creator,
      bondingCurve: curveFor(mint),
      quantum: await isQuantumCreator(mint, curve.creator),
      external: true,
      source: 'pump.fun',
      createdAt: null,
      complete: curve.complete,
      pool: curve.complete ? poolFor(mint) : null,
      cursor: null,
      poolCursor: null,
      ...curveFields(curve),
      registeredAt: now(),
    }
    await store.set(keys.coin(mint), record)
    await saveSummary(record)
    // Respond with the on-chain curve state now; trade history fills in on background syncs.
    syncCoin(mint).catch(() => {})
    return record
  }

  function curveFields(curve) {
    return {
      price: curve.price,
      marketCap: curve.price ? (curve.price * Number(curve.totalSupply)) / 1e6 : null,
      virtualSolReserves: curve.virtualSolReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
      realTokenReserves: curve.realTokenReserves,
      progress: curve.progress,
    }
  }

  async function syncCoin(mint) {
    const record = await store.get(keys.coin(mint))
    if (!record) return null
    let trades = (await store.get(keys.trades(mint))) || []
    const seen = new Set(trades.map((t) => t.id))
    const fresh = []
    // Oldest first, bounded per pass; the cursor only advances over transactions actually read.
    const collect = async (address, cursorField, pool) => {
      const sigs = await newSignatures(
        connection,
        address,
        record[cursorField],
        record[cursorField] ? 1000 : 200,
      )
      if (!sigs.length) return
      const batch = sigs
        .map((s) => s.signature)
        .reverse()
        .slice(0, PER_PASS)
      for (const { signature, tx } of await fetchTransactions(connection, batch)) {
        if (!tx) break
        for (const t of tradesFrom(tx, { signature, mint, pool }))
          if (!seen.has(t.id)) {
            seen.add(t.id)
            fresh.push(t)
          }
        record[cursorField] = signature
      }
    }
    await collect(record.bondingCurve || curveFor(mint), 'cursor', null)
    if (fresh.some((t) => t.side === 'complete')) record.complete = true
    if (record.complete) {
      record.pool ||= poolFor(mint)
      await collect(record.pool, 'poolCursor', record.pool)
    }
    if (!record.createdAt) {
      // External coins: fall back to the earliest trade we have seen.
      const first = [...trades, ...fresh]
        .filter((t) => t.timestamp)
        .sort((a, b) => a.timestamp - b.timestamp)[0]
      record.createdAt = first?.timestamp || null
    }
    const priced = fresh.filter((t) => t.side !== 'complete')
    trades = [...priced.reverse(), ...trades]
      .sort((a, b) => b.slot - a.slot || b.id.localeCompare(a.id))
      .slice(0, MAX_TRADES)
    const latest = trades.find((t) => t.price > 0)
    if (latest) {
      record.price = latest.price
      if (latest.venue === 'curve') {
        record.virtualSolReserves = latest.virtualSolReserves
        record.virtualTokenReserves = latest.virtualTokenReserves
        record.realTokenReserves = latest.realTokenReserves
        record.progress = curveProgress(latest.realTokenReserves)
      }
    }
    if (record.complete) record.progress = 100
    Object.assign(record, stats(trades, now() / 1000))
    record.syncedAt = now()
    await store.set(keys.trades(mint), trades)
    await store.set(keys.coin(mint), record)
    await saveSummary(record)
    return record
  }

  // One bounded pass: a lease prevents concurrent instances from double-indexing, and a shared
  // cursor rotates through coins so every coin advances across cold starts.
  async function sync({ budget = 4 } = {}) {
    const owner = randomBytes(8).toString('hex')
    if (!(await store.set(keys.lease, owner, { nx: true, ttl: 25000 }))) return { skipped: true }
    try {
      const items = await list()
      if (!items.length) return { synced: 0 }
      // Quant Pad launches first, then recently viewed external coins.
      const ordered = [...items.filter((c) => !c.external), ...items.filter((c) => c.external)]
      const start = Number((await store.get(keys.cursor)) || 0) % ordered.length
      let synced = 0
      for (let n = 0; n < Math.min(budget, ordered.length); n++) {
        await syncCoin(ordered[(start + n) % ordered.length].mint).catch(() => {})
        synced++
      }
      await store.set(keys.cursor, (start + synced) % ordered.length)
      return { synced }
    } finally {
      await store.release(keys.lease, owner)
    }
  }

  async function market({
    q = '',
    sort = 'newest',
    filter = 'all',
    launcher = '',
    hidden = new Set(),
    offset = 0,
    limit = 24,
  } = {}) {
    const needle = q.toLowerCase().trim()
    let items = (await list()).filter(
      (c) =>
        !hidden.has(c.mint) &&
        (!launcher || c.launcher === launcher) &&
        (filter === 'all'
          ? !c.external
          : filter === 'quantum'
            ? c.quantum && !c.external
            : filter === 'graduated'
              ? c.complete && !c.external
              : filter === 'tracked'
                ? c.external
                : true) &&
        (!needle ||
          [c.name, c.symbol, c.mint].some((s) =>
            String(s || '')
              .toLowerCase()
              .includes(needle),
          )),
    )
    const by = {
      newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      volume: (a, b) => (b.volume24h || 0) - (a.volume24h || 0),
      mcap: (a, b) => (b.marketCap || 0) - (a.marketCap || 0),
      progress: (a, b) => (b.progress || 0) - (a.progress || 0),
      trending: (a, b) =>
        (b.trades24h || 0) - (a.trades24h || 0) || (b.volume24h || 0) - (a.volume24h || 0),
    }
    items.sort(by[sort] || by.newest)
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      next: offset + limit < items.length ? offset + limit : null,
    }
  }

  return {
    registerLaunch,
    track,
    sync,
    syncCoin,
    market,
    list,
    coin: (mint) => store.get(keys.coin(mint)),
    async trades(mint, { side, offset = 0, limit = 50 } = {}) {
      const rows = ((await store.get(keys.trades(mint))) || []).filter(
        (t) => !side || t.side === side,
      )
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        next: offset + limit < rows.length ? offset + limit : null,
      }
    },
    async candles(mint, interval) {
      return candlesFor((await store.get(keys.trades(mint))) || [], interval)
    },
  }
}

export function summarize(r) {
  return {
    mint: r.mint,
    name: r.name,
    symbol: r.symbol,
    uri: r.uri,
    creator: r.creator,
    launcher: r.launcher || null,
    quantum: !!r.quantum,
    external: !!r.external,
    createdAt: r.createdAt,
    complete: !!r.complete,
    progress: r.progress ?? 0,
    price: r.price ?? null,
    marketCap: r.marketCap ?? null,
    volume24h: r.volume24h ?? 0,
    change24h: r.change24h ?? null,
    trades24h: r.trades24h ?? 0,
    lastTradeAt: r.lastTradeAt ?? null,
    image: r.image || null,
    syncedAt: r.syncedAt || null,
  }
}

// Trades are newest-first. Volumes are SOL (not lamports) for display and sorting.
export function stats(trades, nowSecs) {
  const priced = trades.filter((t) => t.price > 0)
  const latest = priced[0]
  const dayAgo = nowSecs - DAY
  const recent = priced.filter((t) => t.timestamp >= dayAgo)
  const before = priced.find((t) => t.timestamp < dayAgo) || priced.at(-1)
  const volume24h = recent.reduce((sum, t) => sum + Number(t.solAmount || 0) / 1e9, 0)
  return {
    marketCap: latest ? latest.price * 1e9 : null,
    volume24h,
    trades24h: recent.length,
    change24h:
      latest && before && before.price > 0
        ? ((latest.price - before.price) / before.price) * 100
        : null,
    lastTradeAt: latest?.timestamp || null,
    buys24h: recent.filter((t) => t.side === 'buy').length,
    sells24h: recent.filter((t) => t.side === 'sell').length,
  }
}
