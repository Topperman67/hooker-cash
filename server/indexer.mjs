// Indexes Quant Pad coins (and any pump.fun coin a visitor opens) from Solana transactions.
// State lives in the shared store. Serverless instances cooperate through leases (one pass at a
// time, one sync per coin at a time) and short write locks around every read-modify-write.
import { createHash, randomBytes } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import {
  extractEvents,
  normalizeCreate,
  tradesFrom,
  fetchTransactions,
  pendingSignatures,
  firstSignature,
  readMarket,
  readTokenIdentity,
  poolFor,
  curveFor,
  isSolQuote,
} from './solana.mjs'
import { candlesFor, compareTrades, capSupply, marketCap } from './market-math.mjs'
import { curveProgress, isAddress, isSignature } from '../shared/network.mjs'

const MAX_TRADES = 4000
const PER_PASS = Number(process.env.QUANTPAD_INDEX_BATCH || 40)
const MAX_EXTERNAL = 400
// Defence in depth behind launch provenance: every summary lives in the one coins:list value.
const MAX_NATIVE = Number(process.env.QUANTPAD_MAX_LAUNCHES || 2000)
const DAY = 86400
const INITIAL_SIGNATURES = 200 // a tracked coin's first read covers its newest signatures
const SCAN_PAGES = 3 // signature pages per address per pass while paging back to a cursor
const CREATE_PAGES = 5 // signature pages searched for a coin's create transaction
// A pass starts no new work after this long; serverless functions get 60 s in total.
const PASS_MS = Number(process.env.QUANTPAD_SYNC_MS) || (process.env.VERCEL ? 25_000 : 40_000)
const LEASE_SLACK_MS = 45_000 // leases outlive the request still in flight at a deadline
const SUPPLY_TTL_MS = 10 * 60_000
const BUCKET = 900 // seconds per 24h activity bucket
const MARKERS = new Set(['create', 'complete'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (status, message, code) => Object.assign(Error(message), { status, code })
const token = () => randomBytes(8).toString('hex')

// C1: an RPC failure reaching a route becomes a retryable error written for users. Provider
// messages can carry URLs or keys, so they are never passed on; 4xx errors pass through.
function rpcFailure(e) {
  const status = Number(e?.status)
  if (Number.isInteger(status) && status >= 400 && status < 500) return e
  const limited = /\b429\b|too many requests|rate limit/i.test(e?.message || '')
  return Object.assign(
    limited
      ? fail(429, 'Solana RPC is rate limiting requests. Try again shortly.', 'rpc_rate_limited')
      : fail(503, 'Solana RPC is not responding. Try again in a moment.', 'rpc_unavailable'),
    { expose: true, cause: e },
  )
}
const rpc = (promise) =>
  promise.catch((e) => {
    throw rpcFailure(e)
  })

// C2: /api/metadata records each URI it issues under this key.
export const issuedUriKey = (uri) =>
  'issued-uri:' + createHash('sha256').update(String(uri)).digest('hex').slice(0, 32)

export function createIndexer({ connection, store, quantum, now = () => Date.now() }) {
  const keys = {
    list: 'coins:list',
    listLock: 'lock:coins:list',
    coin: (mint) => `coin:${mint}`,
    coinLock: (mint) => `lock:coin:${mint}`,
    // Not `sync:coin:<mint>`: server/application.mjs uses that as its manual-sync cooldown key.
    coinLease: (mint) => `lease:sync-coin:${mint}`,
    trades: (mint) => `trades:${mint}`,
    lease: 'sync:lease',
    cursor: 'sync:cursor',
  }

  // A short exclusive section around a read-modify-write. A holder that died releases on its ttl.
  async function locked(name, fn, { ttl = 5000, wait = 8000 } = {}) {
    const owner = token()
    const until = Date.now() + wait
    for (let delay = 10; !(await store.set(name, owner, { nx: true, ttl }));) {
      if (Date.now() > until) throw fail(409, 'Quant Pad is busy. Try again in a moment.', 'busy')
      await sleep(delay / 2 + Math.random() * delay)
      delay = Math.min(delay * 2, 250)
    }
    try {
      return await fn()
    } finally {
      await store.release(name, owner).catch(() => {})
    }
  }

  // ---- Quantum verification (C3) ----------------------------------------------------------------
  // `quantum` undefined loads the shared client; null means no client, so nothing verifies.
  let quantumClient = quantum
  async function quantumLib() {
    if (quantumClient === undefined)
      quantumClient = await import('../shared/quantum.mjs').catch(() => null)
    return quantumClient
  }
  const wells = new Map()
  async function wellOf(mint) {
    const q = await quantumLib()
    if (!q?.wellPda) return null
    if (!wells.has(mint)) {
      if (wells.size > 5000) wells.clear()
      wells.set(mint, q.wellPda(new PublicKey(mint)).toBase58())
    }
    return wells.get(mint)
  }

  // { quantum: true, launcher } when the creator is the coin's well and its Quantum account exists,
  // { quantum: false } when not, { quantum: null } when it cannot be told now (`retry` when an RPC
  // read failed or lagged rather than the client being missing).
  async function verifyQuantum(mint, creator, { minContextSlot } = {}) {
    const well = await wellOf(mint).catch(() => null)
    if (!well) return { quantum: null, retry: false }
    if (well !== creator) return { quantum: false }
    const q = await quantumLib()
    try {
      let state
      if (q.quantumPda && q.decodeQuantum) {
        const info = await connection.getAccountInfo(q.quantumPda(new PublicKey(mint)), {
          commitment: 'confirmed',
          ...(minContextSlot ? { minContextSlot } : {}),
        })
        state = info ? q.decodeQuantum(info.data) : null
      } else state = await q.fetchQuantum(connection, new PublicKey(mint))
      return state
        ? { quantum: true, launcher: state.launcher, createdAt: Number(state.createdAt) || null }
        : { quantum: false }
    } catch {
      return { quantum: null, retry: true }
    }
  }

  // Settles the quantum flag of a stored record: re-checked whenever it is not true and the creator
  // is the coin's well, so a transient failure heals. A verified Quantum coin becomes a native
  // launch with the launcher from its Quantum account. Returns the fields to change.
  async function healQuantum(record) {
    if (!record?.creator || (record.quantum === true && !record.external)) return {}
    const unknown = record.quantum === undefined ? { quantum: null } : {}
    const well = await wellOf(record.mint).catch(() => null)
    if (!well) return unknown
    if (well !== record.creator) return record.quantum === false ? {} : { quantum: false }
    const q = await verifyQuantum(record.mint, record.creator)
    if (q.quantum === null) return unknown
    if (q.quantum === false) return record.quantum === false ? {} : { quantum: false }
    const patch = { quantum: true }
    if (record.external && (await canAddNative(record.mint)))
      Object.assign(patch, {
        external: false,
        source: 'quantpad',
        provenance: 'quantum',
        launcher: q.launcher,
        createdAt: record.createdAt || q.createdAt,
      })
    else if (!record.launcher && !record.external) patch.launcher = q.launcher
    return patch
  }

  // ---- stored state -----------------------------------------------------------------------------
  async function list() {
    return (await store.get(keys.list)) || []
  }

  // Upserts the coin's summary (`insert: false` only refreshes a listed coin). The summary is made
  // from the record as stored when the list lock is taken, so a caller holding an older copy never
  // lists stale fields (an image saved meanwhile, an older price), and a record deleted meanwhile
  // is not listed again. External coins are capped: the least recently synced or tracked drop
  // out, never the coin being saved, and their stored records and trades are deleted with them.
  async function saveSummary(record, { insert = true } = {}) {
    const mint = record.mint
    const dropped = await locked(keys.listLock, async () => {
      const stored = await store.get(keys.coin(mint))
      if (!stored) return []
      const items = await list()
      const summary = summarize(stored)
      const index = items.findIndex((c) => c.mint === mint)
      if (index >= 0) {
        if (JSON.stringify(items[index]) === JSON.stringify(summary)) return []
        items[index] = summary
      } else if (insert) items.unshift(summary)
      else return []
      const others = items.filter((c) => c.external && c.mint !== mint)
      const excess = others.length + (summary.external ? 1 : 0) - MAX_EXTERNAL
      const drop = new Set(
        excess > 0
          ? others
              .sort((a, b) => recency(a) - recency(b))
              .slice(0, excess)
              .map((c) => c.mint)
          : [],
      )
      await store.set(keys.list, drop.size ? items.filter((c) => !drop.has(c.mint)) : items)
      return [...drop]
    })
    for (const mint of dropped) await forget(mint).catch(() => {})
  }
  const recency = (c) => Math.max(c.syncedAt || 0, c.trackedAt || 0)

  async function forget(mint) {
    await locked(keys.coinLock(mint), async () => {
      if ((await list()).some((c) => c.mint === mint)) return // tracked again meanwhile
      const record = await store.get(keys.coin(mint))
      if (record && !record.external) return
      await store.delete(keys.coin(mint))
      await store.delete(keys.trades(mint))
    })
  }

  async function ensureListed(record) {
    if ((await list()).some((c) => c.mint === record.mint)) return true
    await saveSummary(record)
    return false
  }

  async function canAddNative(mint) {
    const items = await list()
    return (
      items.some((c) => c.mint === mint && !c.external) ||
      items.filter((c) => !c.external).length < MAX_NATIVE
    )
  }

  // Read-modify-write of one coin record under its lock. `change` gets the stored record (or null)
  // and returns the record to store, or a falsy value to leave it. Resolves to the stored record.
  function writeCoin(mint, change) {
    return locked(keys.coinLock(mint), async () => {
      const current = await store.get(keys.coin(mint))
      const next = await change(current)
      if (next && next !== current) await store.set(keys.coin(mint), next)
      return next || current
    })
  }

  // Merges new trades into the stored ones (newest first) and tallies them into the record's 24h
  // activity. Call with the coin's lock held; returns the trades and the record's new `day`.
  async function mergeTrades(mint, record, fresh) {
    const stored = (await store.get(keys.trades(mint))) || []
    const ids = new Set(stored.map((t) => t.id))
    const added = fresh.filter((t) => !ids.has(t.id))
    if (!added.length) return { trades: stored, day: record?.day ?? null }
    const trades = [...added, ...stored].sort((a, b) => compareTrades(b, a)).slice(0, MAX_TRADES)
    await store.set(keys.trades(mint), trades)
    return { trades, day: tally(record?.day, stored, added, now() / 1000) }
  }

  // When the indexed history starts, in unix seconds: 0 when complete, null when unknown. Native
  // coins are read from their first transaction; tracked coins from their newest signatures.
  function coveredFrom(record) {
    const from = (field) => record.historyFrom?.[field] ?? (record.external ? null : 0)
    const starts = [from('cursor'), ...(record.complete ? [from('poolCursor')] : [])]
    return starts.includes(null) ? null : Math.max(...starts)
  }

  // Price, reserves, progress, market cap and 24h stats from the indexed trades, overridden by a
  // live on-chain read when there is one (the backlog may still be catching up).
  function derive(record, trades, live) {
    const out = {}
    const curveTrade = trades.find((t) => t.price > 0 && t.venue === 'curve')
    if (curveTrade)
      Object.assign(out, {
        virtualSolReserves: curveTrade.virtualSolReserves,
        virtualTokenReserves: curveTrade.virtualTokenReserves,
        realTokenReserves: curveTrade.realTokenReserves,
        progress: curveProgress(curveTrade.realTokenReserves),
      })
    let price = trades.find((t) => t.price > 0)?.price ?? record.price ?? null
    if (live?.curve) {
      Object.assign(out, {
        virtualSolReserves: live.curve.virtualSolReserves,
        virtualTokenReserves: live.curve.virtualTokenReserves,
        realTokenReserves: live.curve.realTokenReserves,
        progress: live.curve.progress,
      })
      if (!live.curve.complete && live.curve.price) price = live.curve.price
    }
    if (record.complete && live?.pool?.price) price = live.pool.price
    if (record.complete) out.progress = 100
    const supply = capSupply(record)
    return {
      ...out,
      ...stats(trades, now() / 1000, {
        supply,
        coveredFrom: coveredFrom(record),
        behind: !!record.behind,
        day: record.day,
      }),
      price,
      marketCap: marketCap(price, supply),
    }
  }

  // ---- registration -------------------------------------------------------------------------------
  const notYet = (message = 'The launch is not visible on Solana yet. Try again in a moment.') =>
    fail(409, message, 'not_indexed_yet')
  const createIn = (found, mint) =>
    extractEvents(found.tx).find(
      (e) => e.name === 'CreateEvent' && (!mint || e.event.mint.toBase58() === mint),
    )

  // C2. Registers a native Quant Pad launch from its pump.fun create transaction. The signature is
  // optional when the mint is given (the create is then the bonding curve's first transaction). A
  // coin is native only when it is a verified Quantum coin or its metadata URI was issued by this
  // server; otherwise 409 not_indexed_yet (retry later) or 400 not_quantpad (track it instead).
  async function registerLaunch(signature, { mint } = {}) {
    signature = signature ? String(signature) : ''
    mint = mint ? String(mint) : ''
    if ((signature && !isSignature(signature)) || (!signature && !mint))
      throw fail(400, 'Provide the launch transaction signature.', 'invalid_signature')
    if (mint && !isAddress(mint))
      throw fail(400, 'Enter a valid Solana mint address.', 'invalid_mint')
    let found = null
    let create = null
    let failed = false
    if (signature) {
      const [entry] = await rpc(fetchTransactions(connection, [signature]))
      failed = !entry // failed transactions are left out
      found = entry?.tx ? entry : null
      create = found && createIn(found, mint)
    }
    if (!create && mint) {
      const first = await rpc(firstSignature(connection, curveFor(mint), { pages: CREATE_PAGES }))
      if (first.tooDeep)
        throw fail(400, "Could not find this coin's launch transaction.", 'not_quantpad')
      if (!first.signature) throw notYet()
      const [entry] = await rpc(fetchTransactions(connection, [first.signature]))
      if (!entry?.tx) throw notYet()
      found = entry
      create = createIn(found, mint)
      if (!create) throw fail(400, 'This coin was not created on pump.fun.', 'not_quantpad')
    }
    if (!create) {
      if (failed) throw fail(400, 'That transaction failed on-chain.', 'failed_transaction')
      if (!found) throw notYet()
      throw fail(400, 'That transaction did not create a pump.fun coin.', 'not_create')
    }
    const base = normalizeCreate(create.event, { signature: found.signature, slot: found.tx.slot })
    if (!isSolQuote(base.quoteMint))
      throw fail(400, 'Quant Pad tracks SOL-quoted coins only.', 'not_sol_quote')

    const existing = await store.get(keys.coin(base.mint))
    if (existing && !existing.external) {
      const patch = await healQuantum(existing).catch(() => ({}))
      const changed = Object.keys(patch).length > 0
      const record = changed ? await writeCoin(base.mint, (c) => c && { ...c, ...patch }) : existing
      if ((await ensureListed(record)) && changed) await saveSummary(record)
      return record
    }

    const q = await verifyQuantum(base.mint, base.creator, { minContextSlot: found.tx.slot })
    const issued = q.quantum !== true && !!(await store.get(issuedUriKey(base.uri)))
    if (q.quantum !== true && !issued) {
      if (q.retry) throw notYet('Could not verify the launch yet. Try again in a moment.')
      throw fail(400, 'This coin was not launched on Quant Pad.', 'not_quantpad')
    }
    if (!(await canAddNative(base.mint)))
      throw fail(429, 'Quant Pad is not accepting new launches right now.', 'launch_cap')

    // The dev buy usually shares the create transaction: index it now so the coin page has a price
    // immediately; the rest of the history is read by background syncs.
    const initial = tradesFrom(found.tx, {
      signature: found.signature,
      mint: base.mint,
      pool: null,
    }).filter((t) => !MARKERS.has(t.side))
    const record = await writeCoin(base.mint, async (current) => {
      if (current && !current.external) return current // registered concurrently
      const next = {
        ...current,
        ...base,
        quantum: q.quantum,
        launcher: q.launcher || base.launcher,
        external: false,
        source: 'quantpad',
        provenance: q.quantum === true ? 'quantum' : 'issued-uri',
        cursor: current?.cursor || null,
        poolCursor: current?.poolCursor || null,
        complete: current?.complete || false,
        pool: current?.pool || null,
        supply: current?.supply || null,
        behind: true, // the history after the create is read by the sync below
        registeredAt: now(),
      }
      const { trades, day } = await mergeTrades(base.mint, current, initial)
      if (day) next.day = day
      return { ...next, ...derive(next, trades, null) }
    })
    await saveSummary(record)
    syncCoin(record.mint).catch(() => {})
    return record
  }

  // Tracks any SOL-quoted pump.fun coin a visitor opens: external unless it is a verified Quantum
  // coin. Responds with the live on-chain price (the pool's once the curve has completed).
  async function track(mint) {
    if (!isAddress(mint)) throw fail(400, 'Enter a valid Solana mint address.', 'invalid_mint')
    const existing = await store.get(keys.coin(mint))
    if (existing) {
      const patch = await healQuantum(existing).catch(() => ({}))
      const changed = Object.keys(patch).length > 0
      const record = changed ? await writeCoin(mint, (c) => c && { ...c, ...patch }) : existing
      // Re-list a coin that dropped out of the list, and sync one that never synced.
      const listed = await ensureListed(record)
      if (listed && changed) await saveSummary(record)
      if (!listed || !record.syncedAt) syncCoin(mint).catch(() => {})
      return record
    }
    const market = await rpc(readMarket(connection, mint))
    const curve = market.curve
    if (!curve) throw fail(404, 'That mint is not a pump.fun coin.', 'not_pump')
    if (!isSolQuote(curve.quoteMint))
      throw fail(400, 'Quant Pad tracks SOL-quoted coins only.', 'not_sol_quote')
    const identity = (await readTokenIdentity(connection, mint)) || {}
    const q = await verifyQuantum(mint, curve.creator)
    const native = q.quantum === true && (await canAddNative(mint))
    const draft = {
      mint,
      name: identity.name || 'Unknown',
      symbol: identity.symbol || '???',
      uri: identity.uri || '',
      creator: curve.creator,
      bondingCurve: curveFor(mint),
      quantum: q.quantum,
      external: !native,
      source: native ? 'quantpad' : 'pump.fun',
      ...(native ? { provenance: 'quantum', launcher: q.launcher } : {}),
      mayhem: curve.mayhem,
      createdAt: native ? q.createdAt || null : null,
      complete: curve.complete,
      pool: curve.complete ? poolFor(mint) : null,
      cursor: null,
      poolCursor: null,
      supply: market.supply,
      supplyAt: market.supply ? now() : null,
      price: (curve.complete ? market.pool?.price : curve.price) || null,
      virtualSolReserves: curve.virtualSolReserves,
      virtualTokenReserves: curve.virtualTokenReserves,
      realTokenReserves: curve.realTokenReserves,
      progress: curve.progress,
      behind: true,
      statsPartial: true,
      registeredAt: now(),
    }
    draft.marketCap = marketCap(draft.price, capSupply(draft))
    const record = await writeCoin(mint, (current) => current || draft)
    await saveSummary(record)
    // Trade history fills in on background syncs.
    syncCoin(mint).catch(() => {})
    return record
  }

  // ---- syncing ------------------------------------------------------------------------------------
  // One bounded pass over a coin. Only one instance syncs a coin at a time; another caller gets the
  // stored record back. Progress is saved even when the RPC throttles part of the pass.
  async function syncCoin(mint, { deadline = Date.now() + PASS_MS } = {}) {
    if (!isAddress(mint)) return null
    const owner = token()
    const ttl = Math.max(1000, deadline - Date.now()) + LEASE_SLACK_MS
    if (!(await store.set(keys.coinLease(mint), owner, { nx: true, ttl })))
      return store.get(keys.coin(mint))
    try {
      return await syncHeld(mint, deadline)
    } finally {
      await store.release(keys.coinLease(mint), owner).catch(() => {})
    }
  }

  async function syncHeld(mint, deadline) {
    const record = await store.get(keys.coin(mint))
    if (!record) return null
    const state = {
      cursor: record.cursor ?? null,
      poolCursor: record.poolCursor ?? null,
      gaps: { ...record.gaps },
      historyFrom: { ...record.historyFrom },
      seq: record.seq || 0,
    }
    const fresh = []
    let behind = false
    let moved = false
    let error = null
    let complete = !!record.complete

    // Reads the oldest unread signatures of one address, at most PER_PASS transactions, in
    // execution order. `seq` numbers transactions as read, so trades in one slot keep their order.
    const collect = async (address, field, pool) => {
      try {
        if (Date.now() >= deadline) {
          behind = true
          return
        }
        const plan = await pendingSignatures(connection, address, {
          cursor: state[field],
          anchor: state.gaps[field] || null,
          fromStart: !record.external,
          pages: SCAN_PAGES,
          initial: INITIAL_SIGNATURES,
        })
        if ((state.gaps[field] || null) !== plan.anchor) moved = true
        state.gaps[field] = plan.anchor
        if (!state[field] && plan.historyFrom !== undefined)
          state.historyFrom[field] = plan.historyFrom
        const batch = plan.window.slice(0, PER_PASS)
        let read = 0
        if (batch.length) {
          const fetched = await fetchTransactions(
            connection,
            batch.map((s) => s.signature),
            { deadline },
          )
          for (const { signature, tx } of fetched) {
            if (!tx) break // not visible to this node yet: never step past it
            state.seq++
            for (const t of tradesFrom(tx, { signature, mint, pool }))
              fresh.push({ ...t, seq: state.seq })
            state[field] = signature
            read++
          }
          if (fetched.error) error ||= fetched.error
        }
        if (read) moved = true
        if (!plan.reached || plan.anchor || read < plan.window.length) behind = true
      } catch (e) {
        error ||= e
        behind = true
      }
    }

    await collect(record.bondingCurve || curveFor(mint), 'cursor', null)
    if (fresh.some((t) => t.side === 'complete')) complete = true
    const pool = record.pool || poolFor(mint)
    if (complete) await collect(pool, 'poolCursor', pool)

    const supplyStale = !record.supplyAt || now() - record.supplyAt > SUPPLY_TTL_MS
    let live = null
    if (
      Date.now() < deadline &&
      (moved || behind || !record.syncedAt || !(record.price > 0) || supplyStale)
    )
      live = await readMarket(connection, mint, { supply: supplyStale }).catch(() => null)
    if (live?.curve?.complete && !complete) {
      complete = true
      behind = true // the pool's history is read from the next pass
    }
    const healed = await healQuantum(record).catch(() => ({}))
    const created = fresh.find((t) => t.side === 'create')
    const priced = fresh.filter((t) => !MARKERS.has(t.side))

    // Merged onto the record as stored now, changing only the indexer's own fields, so metadata or
    // an upgrade written while this pass read the chain is kept.
    const saved = await writeCoin(mint, async (current) => {
      if (!current) return null // evicted meanwhile
      const { trades, day } = await mergeTrades(mint, current, priced)
      const next = {
        ...current,
        ...healed,
        ...(day ? { day } : {}),
        cursor: state.cursor,
        poolCursor: state.poolCursor,
        gaps: state.gaps,
        historyFrom: state.historyFrom,
        seq: state.seq,
        complete: !!current.complete || complete,
        pool: current.pool || (complete ? pool : null),
        behind,
        syncedAt: now(),
      }
      if (!next.createdAt && created?.createdAt) next.createdAt = created.createdAt
      if (live?.supply) Object.assign(next, { supply: live.supply, supplyAt: now() })
      if (live?.curve) next.mayhem = live.curve.mayhem
      return { ...next, ...derive(next, trades, live) }
    })
    if (!saved) return null
    await saveSummary(saved)
    if (error && !moved && !live) throw rpcFailure(error)
    return saved
  }

  // One time-bounded pass: a lease keeps instances from double-indexing, and a shared rotation
  // cursor, saved after every coin, moves through the coins across cold starts and killed passes.
  let running = null
  function sync(options = {}) {
    if (running) return Promise.resolve({ skipped: true })
    running = pass(options).finally(() => {
      running = null
    })
    return running
  }
  async function pass({ budget = 4, timeMs = PASS_MS } = {}) {
    const deadline = Date.now() + timeMs
    const owner = token()
    if (!(await store.set(keys.lease, owner, { nx: true, ttl: timeMs + LEASE_SLACK_MS })))
      return { skipped: true }
    try {
      const items = await list()
      if (!items.length) return { synced: 0 }
      // Quant Pad launches first, then recently viewed external coins.
      const ordered = [...items.filter((c) => !c.external), ...items.filter((c) => c.external)]
      const start = Number((await store.get(keys.cursor)) || 0) % ordered.length
      let synced = 0
      let failed = 0
      for (let n = 0; n < Math.min(budget, ordered.length) && Date.now() < deadline; n++) {
        try {
          await syncCoin(ordered[(start + n) % ordered.length].mint, { deadline })
          synced++
        } catch {
          failed++
        }
        await store.set(keys.cursor, (start + n + 1) % ordered.length)
      }
      return { synced, failed }
    } finally {
      await store.release(keys.lease, owner).catch(() => {})
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
    // Locked update of a stored coin (e.g. cached metadata) that also refreshes its listed summary;
    // `change` gets the record (or null) and returns the new record or nothing.
    async updateCoin(mint, change) {
      const record = await writeCoin(mint, change)
      if (record) await saveSummary(record, { insert: false })
      return record
    },
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
    // C3: true, false, or null while unknown (re-checked on sync).
    quantum: r.quantum === true ? true : r.quantum === false ? false : null,
    external: !!r.external,
    createdAt: r.createdAt ?? null,
    complete: !!r.complete,
    progress: r.progress ?? 0,
    price: r.price ?? null,
    marketCap: r.marketCap ?? null,
    // 24h figures are null while unknown (see stats()), which is always flagged partial.
    volume24h: r.volume24h ?? null,
    change24h: r.change24h ?? null,
    trades24h: r.trades24h ?? null,
    statsPartial: !!r.statsPartial || r.volume24h == null || r.trades24h == null,
    lastTradeAt: r.lastTradeAt ?? null,
    image: r.image || null,
    trackedAt: r.registeredAt || null,
    syncedAt: r.syncedAt || null,
  }
}

const bucketOf = (secs) => Math.floor(secs / BUCKET) * BUCKET
// The later of two [price, time] points.
const later = (a, b) => (!a || (b && b[1] >= a[1]) ? b : a)

// Trades are newest-first. Volumes are SOL (not lamports) for display and sorting.
//
// The 24h volume and trade counts come from the trade list when it reaches back past the window,
// else from `day` (see tally()), whose oldest bucket may reach up to 15 minutes further back.
// They are null rather than counted from part of the day when the indexed history does not reach
// back a day: `coveredFrom` is when it starts (0 = from the coin's first transaction, null =
// unknown). `statsPartial` says they are unknown, or are a lower bound because `behind` says
// unread transactions remain. change24h is null without a price from before the window, rather
// than measured against the oldest indexed trade.
export function stats(trades, nowSecs, { supply, coveredFrom = 0, behind = false, day } = {}) {
  const priced = trades.filter((t) => t.price > 0)
  const latest = priced[0]
  const dayAgo = nowSecs - DAY
  const covered = coveredFrom === 0 || (coveredFrom !== null && coveredFrom <= dayAgo)
  const whole = trades.length < MAX_TRADES // the list holds every indexed trade
  const listReaches = whole || (trades.at(-1)?.timestamp || 0) < dayAgo
  const start = bucketOf(dayAgo)
  let activity = null
  if (covered && listReaches) {
    const recent = priced.filter((t) => t.timestamp >= dayAgo)
    activity = [
      recent.reduce((sum, t) => sum + Number(t.solAmount || 0), 0),
      recent.length,
      recent.filter((t) => t.side === 'buy').length,
      recent.filter((t) => t.side === 'sell').length,
    ]
  } else if (covered && day && day.from <= start)
    activity = day.b
      .filter((b) => b[0] >= start)
      .reduce((sum, b) => sum.map((v, i) => v + b[i + 1]), [0, 0, 0, 0])
  // The last price before the window: from the list (complete from its oldest trade on), else
  // from the tally. With no trade before the window in a history indexed from the coin's start,
  // the change is measured from its first trade.
  let before = priced.find((t) => t.timestamp < dayAgo)?.price ?? null
  if (before === null && whole) before = coveredFrom === 0 ? (priced.at(-1)?.price ?? null) : null
  else if (before === null && day) {
    const last = day.b
      .filter((b) => b[0] < start && b[2])
      .reduce((point, b) => later(point, [b[5], b[6]]), day.prior || null)
    before = last ? last[0] : coveredFrom === 0 && day.from === 0 ? (day.first?.[0] ?? null) : null
  }
  return {
    marketCap: latest ? marketCap(latest.price, supply) : null,
    volume24h: activity ? activity[0] / 1e9 : null,
    trades24h: activity ? activity[1] : null,
    change24h: latest && before > 0 ? ((latest.price - before) / before) * 100 : null,
    lastTradeAt: latest?.timestamp || null,
    buys24h: activity ? activity[2] : null,
    sells24h: activity ? activity[3] : null,
    statsPartial: behind || !activity,
  }
}

// 24h activity for coins that trade more than the trade list keeps: per 15-minute bucket
// [start, lamports, trades, buys, sells, close price, close time], kept for a day and a bucket,
// with `prior` the last trade before the kept buckets and `first` the first trade counted. It
// starts once the list fills, from the trades the list holds then (every indexed trade, since the
// list was never cut before), and `from` is the time since which every indexed trade is counted
// (0: all of them). `stored` is the list before `added` (oldest first) was merged into it.
export function tally(day, stored, added, nowSecs) {
  if (!day && stored.length + added.length < MAX_TRADES) return null
  const keep = bucketOf(nowSecs - DAY) - BUCKET
  const next = day
    ? { ...day, b: [] }
    : {
        from: stored.length >= MAX_TRADES ? stored.at(-1)?.timestamp || 0 : 0,
        first: null,
        prior: null,
        b: [],
      }
  const trades = (day ? added : [...stored].reverse().concat(added)).filter(
    (t) => t.price > 0 && t.timestamp > 0,
  )
  if (!day && next.from === 0 && trades.length) next.first = [trades[0].price, trades[0].timestamp]
  const buckets = new Map()
  for (const b of day?.b || []) {
    if (b[0] >= keep) buckets.set(b[0], [...b])
    else next.prior = later(next.prior, [b[5], b[6]])
  }
  for (const t of trades) {
    if (t.timestamp < keep) {
      next.prior = later(next.prior, [t.price, t.timestamp])
      continue
    }
    const start = bucketOf(t.timestamp)
    const b = buckets.get(start) || [start, 0, 0, 0, 0, 0, 0]
    b[1] += Number(t.solAmount || 0)
    b[2] += 1
    if (t.side === 'buy') b[3] += 1
    else if (t.side === 'sell') b[4] += 1
    if (t.timestamp >= b[6]) [b[5], b[6]] = [t.price, t.timestamp]
    buckets.set(start, b)
  }
  next.b = [...buckets.values()].sort((x, y) => x[0] - y[0])
  return next
}
