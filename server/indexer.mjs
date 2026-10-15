// Indexes Quant Pad coins (and any Meteora DBC coin a visitor opens) from Solana transactions.
// State lives in the shared store. Serverless instances cooperate through leases (one pass at a
// time, one sync per coin at a time) and short write locks around every read-modify-write.
import { createHash, randomBytes } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import {
  createFrom,
  tradesFrom,
  fetchTransactions,
  pendingSignatures,
  firstSignature,
  findDbcPool,
  readMarket,
  readTokenIdentity,
  isSolQuote,
} from './solana.mjs'
import {
  candlesFor,
  candleBuckets,
  candlesFromBuckets,
  compareTrades,
  capSupply,
  marketCap,
} from './market-math.mjs'
import { curveProgress, isAddress, isSignature, launchTiers } from '../shared/network.mjs'

// Quant Pad's DBC launch configs (QUANTPAD_DBC_CONFIG, comma-separated): a coin under one of them
// is found by its pool address without a program scan.
const envLaunchConfigs = () => [
  ...new Set([
    ...String(process.env.QUANTPAD_DBC_CONFIG || '')
      .split(',')
      .map((s) => s.trim())
      .filter(isAddress),
    ...launchTiers.map((t) => t.config),
  ]),
]

const MAX_TRADES = 4000
const TRADE_CHUNK = 500 // trades per stored chunk (see the trade storage section)
const MAX_CHUNKS = Math.ceil(MAX_TRADES / TRADE_CHUNK) + 1
const CANDLE_BASE = 15 // seconds per stored candle bucket; every served interval is a multiple
const PER_PASS = Number(process.env.QUANTPAD_INDEX_BATCH || 40)
const MAX_EXTERNAL = 400
// Defence in depth behind launch provenance: every summary lives in the one coins:list value.
// Hidden mints do not count, and at the cap stale launches make room (see evictStale).
const MAX_NATIVE = Number(process.env.QUANTPAD_MAX_LAUNCHES || 2000)
// A launch is evictable once it is this old and has had no trade, or less than STALE_VOLUME_SOL
// of volume, over the same span.
const STALE_NATIVE_MS = 7 * 86400_000
const STALE_VOLUME_SOL = 1
// Native launches one wallet (the launcher) can add per UTC day; 0 turns the limit off.
const LAUNCHES_PER_WALLET = Number(process.env.QUANTPAD_LAUNCHES_PER_WALLET || 10)
const EVICT_BATCH = 10 // stale launches evicted at once when the cap is reached
const CLAIM_TTL_MS = 30 * 86400_000 // an issued URI stays bound to its first coin this long
const NOTICE_RETRY_MS = 60_000 // a failed onNativeLaunch call is retried by syncs after this
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const DAY = 86400
const DAY_MS = DAY * 1000
const INITIAL_SIGNATURES = 200 // a tracked coin's first read covers its newest signatures
const SCAN_PAGES = 3 // signature pages per address per pass while paging back to a cursor
const CREATE_PAGES = 5 // signature pages searched for a coin's create transaction (its DBC pool's first)
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

// C2: /api/metadata records each URI it issues under this key. A native registration consumes
// it (K5), and binds the URI to that coin under issuedUriClaimKey, so one issued URI lists one
// coin even when /api/metadata issues it again.
const uriHash = (uri) => createHash('sha256').update(String(uri)).digest('hex').slice(0, 32)
export const issuedUriKey = (uri) => 'issued-uri:' + uriHash(uri)
export const issuedUriClaimKey = (uri) => 'issued-uri-mint:' + uriHash(uri)

// Operator moderation list (QUANTPAD_HIDDEN_MINTS): a Set, an array, or a predicate.
function hiddenTest(hidden) {
  if (typeof hidden === 'function') return hidden
  const set =
    hidden instanceof Set
      ? hidden
      : new Set(
          (Array.isArray(hidden)
            ? hidden
            : String(process.env.QUANTPAD_HIDDEN_MINTS || '').split(',')
          ).map((s) => String(s).trim()),
        )
  return (mint) => set.has(mint)
}

// A record still carrying the placeholder identity track() stored before identity reads fell back
// to Metaplex (legacy SPL Token coins) or when its identity read failed.
const needsIdentity = (r) =>
  r.identityPending === true ||
  (r.identityPending === undefined && r.name === 'Unknown' && r.symbol === '???' && !r.uri)

/**
 * `onNativeLaunch({ mint, uri })` (K5) is awaited once after a coin becomes a native launch (a
 * registration, or a tracked Quantum coin); a failed call is retried by later syncs, so it must be
 * idempotent. `hidden` (default QUANTPAD_HIDDEN_MINTS) keeps hidden mints out of the native cap.
 * `maxNative`, `staleVolume` (SOL) and `launchesPerWallet` override the native-cap settings.
 * `launchConfigs` (default QUANTPAD_DBC_CONFIG) are Quant Pad's DBC configs.
 */
export function createIndexer({
  connection,
  store,
  quantum,
  now = () => Date.now(),
  onNativeLaunch = null,
  hidden,
  maxNative = MAX_NATIVE,
  staleVolume = STALE_VOLUME_SOL,
  launchesPerWallet = LAUNCHES_PER_WALLET,
  launchConfigs = envLaunchConfigs(),
}) {
  const keys = {
    list: 'coins:list',
    listLock: 'lock:coins:list',
    coin: (mint) => `coin:${mint}`,
    coinLock: (mint) => `lock:coin:${mint}`,
    // Not `sync:coin:<mint>`: server/application.mjs uses that as its manual-sync cooldown key.
    coinLease: (mint) => `lease:sync-coin:${mint}`,
    trades: (mint) => `trades:${mint}`,
    tradeChunk: (mint, n) => `trades:${mint}:${n}`,
    candles: (mint) => `trades:${mint}:candles`,
    launcherDay: (launcher, day) => `launcher-day:${launcher}:${day}`,
    lease: 'sync:lease',
    cursor: 'sync:cursor',
  }
  const isHidden = hiddenTest(hidden)
  // Fields that start a native launch's onNativeLaunch notice (nothing to track without a callback).
  const notice = (at = now()) =>
    onNativeLaunch ? { nativeNotice: 'pending', nativeNoticeAt: at } : {}

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
    if (record.external && (await admitNative(record.mint, q.launcher)).ok)
      Object.assign(patch, {
        external: false,
        source: 'quantpad',
        provenance: 'quantum',
        launcher: q.launcher,
        createdAt: record.createdAt || q.createdAt,
        ...notice(0), // the caller announces it right after saving
      })
    else if (!record.launcher && !record.external) patch.launcher = q.launcher
    return patch
  }

  // Applies a healQuantum patch to the record as stored now. The upgrade to a native launch applies
  // only while that record is still external: a registration that won meanwhile keeps its fields.
  const UPGRADE_FIELDS = ['external', 'source', 'provenance', 'launcher', 'createdAt']
  function applyHeal(current, patch) {
    if (patch.external !== false || current.external) return { ...current, ...patch }
    const rest = { ...patch }
    for (const field of [...UPGRADE_FIELDS, 'nativeNotice', 'nativeNoticeAt']) delete rest[field]
    if (!current.launcher && patch.launcher) rest.launcher = patch.launcher
    return { ...current, ...rest }
  }

  // Fields of `patch` that change `record`.
  const changes = (record, patch) =>
    Object.fromEntries(Object.entries(patch).filter(([field, value]) => record[field] !== value))

  // Repairs a record's identity: re-read while it is a placeholder (its read failed, or the create
  // instruction could not be decoded). Returns the fields to change.
  async function healIdentity(record) {
    const patch = record.creator === SYSTEM_PROGRAM ? { creator: null } : {}
    if (needsIdentity(record)) Object.assign(patch, await identityPatch(record.mint))
    return changes(record, patch)
  }

  // A pending notice nobody is delivering: never attempted (a Quantum upgrade, or a coin whose uri
  // was not known yet), or last attempted NOTICE_RETRY_MS ago (a failed call, or a registration
  // that died before making it).
  const noticeDue = (r) =>
    !!onNativeLaunch &&
    r?.nativeNotice === 'pending' &&
    !r.external &&
    now() - (r.nativeNoticeAt || 0) >= NOTICE_RETRY_MS

  // K5: awaits onNativeLaunch for a native launch whose notice is pending, then marks it done. A
  // failure is retried by a later sync (see noticeDue), and so is a coin whose uri could not be
  // read yet. Resolves to the record.
  async function announce(record) {
    if (!onNativeLaunch || !record || record.external || record.nativeNotice !== 'pending')
      return record
    if (record.identityPending) return record
    let ok = true
    try {
      await onNativeLaunch({ mint: record.mint, uri: record.uri })
    } catch (e) {
      ok = false
      console.error('[indexer] onNativeLaunch', record.mint, e?.message || e)
    }
    const settle = ok ? { nativeNotice: 'done', nativeNoticeAt: now() } : { nativeNoticeAt: now() }
    return writeCoin(record.mint, (c) =>
      c && c.nativeNotice === 'pending' ? { ...c, ...settle } : c,
    ).catch(() => record)
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
      await deleteTrades(mint)
    })
  }

  async function ensureListed(record) {
    if ((await list()).some((c) => c.mint === record.mint)) return true
    await saveSummary(record)
    return false
  }

  // The native cap (QP-SEC-9). Hidden mints are not counted. At the cap, launches that went stale
  // are evicted to make room before a new one is refused.
  const countedNative = (items) => items.filter((c) => !c.external && !isHidden(c.mint)).length
  async function hasRoom(items) {
    if (countedNative(items) < maxNative) return true
    if (!(await evictStale(items))) return false
    return countedNative(await list()) < maxNative
  }

  // Admits `mint` as a new native launch of `launcher`: room under the native cap (evicting stale
  // launches), and a slot in the launcher's daily allowance. Resolves to { ok, refund } (refund
  // returns the slot when the caller did not create the record after all), or { error }. Both
  // refusals are 429 launch_cap: retrying now cannot help, and the coin can be registered later.
  const NO_SLOT = { refund: async () => {} }
  async function admitNative(mint, launcher) {
    const items = await list()
    if (items.some((c) => c.mint === mint && !c.external)) return { ok: true, ...NO_SLOT }
    if (!(await hasRoom(items)))
      return {
        error: fail(429, 'Quant Pad is not accepting new launches right now.', 'launch_cap'),
      }
    const slot = await takeLaunchSlot(launcher)
    if (!slot)
      return {
        error: fail(
          429,
          'This wallet has listed as many launches as Quant Pad takes in a day. Register this one again tomorrow.',
          'launch_cap',
        ),
      }
    return { ok: true, ...slot }
  }

  // The per-wallet daily allowance (QP-SEC-9). Wallets are free, so this only slows a script that
  // lists junk from one wallet; staleness eviction is what keeps the cap from filling for good.
  // Resolves to null when the launcher has none left today.
  async function takeLaunchSlot(launcher) {
    if (!launcher || !(launchesPerWallet > 0)) return NO_SLOT
    const key = keys.launcherDay(launcher, Math.floor(now() / DAY_MS))
    const change = (delta) =>
      locked(`lock:${key}`, async () => {
        const count = Number(await store.get(key)) || 0
        if (delta > 0 && count >= launchesPerWallet) return false
        await store.set(key, Math.max(0, count + delta), { ttl: 2 * DAY_MS })
        return true
      })
    if (!(await change(1))) return null
    return { refund: () => change(-1).catch(() => {}) }
  }

  // A native launch whose trading stopped: older than STALE_NATIVE_MS (from its on-chain create,
  // so registering it again does not reset the clock) with no trade in the last STALE_NATIVE_MS,
  // or less than `staleVolume` SOL traded over that span as of its last sync (dust trades do not
  // keep junk listed). Quantum coins always stay (the keeper finds the coins it serves in this
  // list), and so does a coin not yet known not to be one, or whose age or recent history is
  // unknown (still being read). Works on summaries and on stored records.
  function isStale(c, at = now()) {
    if (!c || c.external || c.quantum !== false || c.behind) return false
    const since = c.createdAt ? c.createdAt * 1000 : c.registeredAt || c.trackedAt || 0
    if (!since || at - since < STALE_NATIVE_MS) return false
    if (!c.lastTradeAt || at - c.lastTradeAt * 1000 >= STALE_NATIVE_MS) return true
    return typeof c.volume7d === 'number' && c.volume7d < staleVolume
  }

  // Evicts up to EVICT_BATCH stale native launches, least recently traded first: each is re-checked
  // and deleted (with its trades) under its own lock, then dropped from the list. Resolves to how
  // many went.
  async function evictStale(items) {
    const at = now()
    const candidates = items
      .filter((c) => !isHidden(c.mint) && isStale(c, at))
      .sort(
        (a, b) =>
          (a.lastTradeAt || 0) - (b.lastTradeAt || 0) || (a.createdAt || 0) - (b.createdAt || 0),
      )
      .slice(0, EVICT_BATCH)
    const gone = new Set()
    for (const { mint } of candidates) {
      const evicted = await locked(keys.coinLock(mint), async () => {
        const record = await store.get(keys.coin(mint))
        if (record && !isStale(record, at)) return false
        await store.delete(keys.coin(mint))
        await deleteTrades(mint)
        return true
      }).catch(() => false)
      if (evicted) gone.add(mint)
    }
    if (gone.size)
      await locked(keys.listLock, async () =>
        store.set(
          keys.list,
          (await list()).filter((c) => !gone.has(c.mint)),
        ),
      )
    return gone.size
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

  // ---- trade storage (QP-SEC-4) ------------------------------------------------------------------
  // A coin's trades (newest first, at most MAX_TRADES) are stored in chunks so a public page read
  // touches only the chunks it returns. `trades:<mint>` holds the index
  // { v: 2, total, next, chunks: [{ n, count, buys, sells }] }, newest chunk first; chunk n lives at
  // `trades:<mint>:<n>`, newest trade first, and only its first `count` trades are live (the cap
  // trims the oldest chunk without rewriting it). Chunks are full except the newest. A merge writes
  // the chunks that change under new numbers (never reused), then the index, then deletes the
  // chunks it replaced, so a reader holding an older index finds its chunks or none, and then reads
  // the index again. Candles come from 15-second buckets kept at `trades:<mint>:candles`. A legacy
  // value (the whole list as one array) is read as it is and rewritten by the coin's next sync.

  // Every stored trade, newest first, with the chunks it came from. Call with the coin's lock held.
  async function loadTrades(mint) {
    const head = await store.get(keys.trades(mint))
    if (!head) return { head: null, chunks: [], trades: [] }
    if (Array.isArray(head)) return { head: null, legacy: true, chunks: [], trades: head }
    const chunks = await Promise.all(
      (head.chunks || []).map(async (c) => {
        const rows = (await store.get(keys.tradeChunk(mint, c.n))) || []
        return { n: c.n, items: rows.slice(0, c.count), damaged: rows.length < c.count }
      }),
    )
    return { head, chunks, trades: chunks.flatMap((c) => c.items) }
  }

  // Stores `trades` (newest first, already capped) over what loadTrades read. Chunks whose trades
  // are unchanged from the oldest end are kept (the one the cap trimmed only gets a smaller count);
  // the rest are written again in full chunks, the newest partial.
  async function saveTrades(mint, loaded, trades) {
    const live = new Set(trades.map((t) => t.id))
    const kept = [] // oldest first
    let rest = trades.length // trades[0, rest) still need a chunk
    for (const chunk of [...loaded.chunks].reverse()) {
      if (chunk.damaged) break
      let count = chunk.items.length
      while (count && !live.has(chunk.items[count - 1].id)) count-- // cut by the cap
      if (!count) continue
      const start = rest - count
      if (start < 0 || chunk.items.slice(0, count).some((t, i) => t.id !== trades[start + i].id))
        break
      kept.push({ n: chunk.n, items: chunk.items.slice(0, count) })
      rest = start
    }
    // A partial newest chunk takes the newer trades: it is written again with them.
    if (rest && kept.length && kept.at(-1).items.length < TRADE_CHUNK)
      rest += kept.pop().items.length
    let next = loaded.head?.next || 0
    const written = []
    for (let end = rest; end > 0; end -= TRADE_CHUNK)
      written.push({ n: next++, items: trades.slice(Math.max(0, end - TRADE_CHUNK), end) })
    await Promise.all(written.map((c) => store.set(keys.tradeChunk(mint, c.n), c.items)))
    await store.set(keys.candles(mint), {
      v: 1,
      size: CANDLE_BASE,
      buckets: candleBuckets(trades, CANDLE_BASE),
    })
    const chunks = [...kept, ...written].reverse().map(({ n, items }) => ({
      n,
      count: items.length,
      buys: items.filter((t) => t.side === 'buy').length,
      sells: items.filter((t) => t.side === 'sell').length,
    }))
    await store.set(keys.trades(mint), { v: 2, total: trades.length, next, chunks })
    const current = new Set(chunks.map((c) => c.n))
    await Promise.all(
      loaded.chunks
        .filter((c) => !current.has(c.n))
        .map((c) => store.delete(keys.tradeChunk(mint, c.n)).catch(() => {})),
    )
  }

  // Deletes a coin's stored trades, including chunks a merge that died wrote past its index.
  async function deleteTrades(mint) {
    const head = await store.get(keys.trades(mint))
    const numbers = new Set()
    if (head && !Array.isArray(head)) {
      for (const c of head.chunks || []) numbers.add(c.n)
      for (let n = head.next || 0; n < (head.next || 0) + MAX_CHUNKS; n++) numbers.add(n)
    }
    await Promise.all([...numbers].map((n) => store.delete(keys.tradeChunk(mint, n))))
    await store.delete(keys.candles(mint))
    await store.delete(keys.trades(mint))
  }

  // Merges new trades into the stored ones (newest first) and tallies them into the record's 24h
  // activity. Call with the coin's lock held; returns the trades and the record's new `day`.
  async function mergeTrades(mint, record, fresh) {
    const loaded = await loadTrades(mint)
    const stored = loaded.trades
    const ids = new Set(stored.map((t) => t.id))
    const added = fresh.filter((t) => !ids.has(t.id))
    if (!added.length) {
      // A legacy or damaged value is rewritten in chunks even without new trades.
      if (loaded.legacy || loaded.chunks.some((c) => c.damaged))
        await saveTrades(mint, loaded, stored)
      return { trades: stored, day: record?.day ?? null }
    }
    const trades = [...added, ...stored].sort((a, b) => compareTrades(b, a)).slice(0, MAX_TRADES)
    await saveTrades(mint, loaded, trades)
    return { trades, day: tally(record?.day, stored, added, now() / 1000) }
  }

  // One page of a coin's trades, newest first (`side` 'buy' or 'sell' filters), reading only the
  // chunks the page covers.
  async function tradePage(mint, { side, offset = 0, limit = 50 } = {}) {
    offset = Math.max(0, Math.floor(Number(offset) || 0))
    limit = Math.min(TRADE_CHUNK, Math.max(1, Math.floor(Number(limit) || 50)))
    const page = (items, total) => ({
      items,
      total,
      next: offset + limit < total ? offset + limit : null,
    })
    for (let attempt = 0; ; attempt++) {
      const head = await store.get(keys.trades(mint))
      if (!head || Array.isArray(head)) {
        const rows = (head || []).filter((t) => !side || t.side === side)
        return page(rows.slice(offset, offset + limit), rows.length)
      }
      const size = (c) =>
        !side ? c.count : side === 'buy' ? c.buys : side === 'sell' ? c.sells : 0
      const chunks = head.chunks || []
      const total = chunks.reduce((sum, c) => sum + size(c), 0)
      const items = []
      let skip = offset
      let missing = false
      for (const c of chunks) {
        if (items.length >= limit) break
        if (skip >= size(c)) {
          skip -= size(c)
          continue
        }
        const rows = await store.get(keys.tradeChunk(mint, c.n))
        if (!rows) {
          missing = true // replaced by a merge since the index was read
          break
        }
        const picked = rows.slice(0, c.count).filter((t) => !side || t.side === side)
        items.push(...picked.slice(skip, skip + limit - items.length))
        skip = 0
      }
      if (!missing || attempt >= 2) return page(items, total)
    }
  }

  // Candles from the stored 15-second buckets; an interval that is not a multiple of those, or a
  // coin whose trades are still in the legacy form, is computed from the trades.
  async function candles(mint, interval = 60) {
    interval = Number(interval) || 60
    if (Number.isInteger(interval) && interval > 0 && interval % CANDLE_BASE === 0) {
      const stored = await store.get(keys.candles(mint))
      if (stored?.v === 1 && stored.size === CANDLE_BASE && Array.isArray(stored.buckets))
        return candlesFromBuckets(stored.buckets, interval)
    }
    const head = await store.get(keys.trades(mint))
    if (!head || Array.isArray(head)) return candlesFor(head || [], interval)
    return candlesFor((await loadTrades(mint)).trades, interval)
  }

  // When the indexed history starts, in unix seconds: 0 when complete, null when unknown. Native
  // coins are read from their first transaction; tracked coins from their newest signatures.
  function coveredFrom(record) {
    const from = (field) => record.historyFrom?.[field] ?? (record.external ? null : 0)
    const starts = [from('cursor'), ...(record.migrated ? [from('poolCursor')] : [])]
    return starts.includes(null) ? null : Math.max(...starts)
  }

  // Price, curve fill, progress, market cap and 24h stats from the indexed trades, overridden by a
  // live on-chain read when there is one (the backlog may still be catching up).
  function derive(record, trades, live) {
    const out = {}
    const curveTrade = trades.find((t) => t.venue === 'curve' && t.quoteReserve)
    if (curveTrade)
      Object.assign(out, {
        quoteReserve: curveTrade.quoteReserve,
        migrationThreshold: curveTrade.migrationThreshold,
        progress: curveProgress(curveTrade.quoteReserve, curveTrade.migrationThreshold),
      })
    let price = trades.find((t) => t.price > 0)?.price ?? record.price ?? null
    if (live?.curve) {
      Object.assign(out, {
        quoteReserve: live.curve.quoteReserve,
        migrationThreshold: live.curve.migrationThreshold,
        progress: live.curve.progress,
      })
      // A full curve keeps its last price until the DAMM v2 pool opens.
      if (live.curve.price && !live.curve.migrated) price = live.curve.price
    }
    if (record.migrated && live?.pool?.price) price = live.pool.price
    if (record.complete) out.progress = 100
    const supply = capSupply(record)
    const nowSecs = now() / 1000
    const day = stats(trades, nowSecs, {
      supply,
      decimals: record.decimals ?? undefined,
      coveredFrom: coveredFrom(record),
      behind: !!record.behind,
      day: record.day,
    })
    return {
      ...out,
      ...day,
      // SOL traded over the last 7 days (a lower bound once the trade list is cut), which decides
      // whether a launch is stale (QP-SEC-9).
      volume7d: Math.max(weekVolume(trades, nowSecs), day.volume24h || 0),
      price,
      marketCap: marketCap(price, supply, record.decimals ?? undefined),
    }
  }

  // ---- registration -------------------------------------------------------------------------------
  const notYet = (message = 'The launch is not visible on Solana yet. Try again in a moment.') =>
    fail(409, message, 'not_indexed_yet')
  const createIn = (found, mint) =>
    createFrom(found.tx, { signature: found.signature, mint: mint || undefined })

  // C2. Registers a native Quant Pad launch from its Meteora DBC create transaction. The signature
  // is optional when the mint is given (the create is then its DBC pool's first transaction). A
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
      const dbcPool = await rpc(findDbcPool(connection, mint, launchConfigs))
      if (!dbcPool) throw notYet()
      const first = await rpc(firstSignature(connection, dbcPool, { pages: CREATE_PAGES }))
      if (first.tooDeep)
        throw fail(400, "Could not find this coin's launch transaction.", 'not_quantpad')
      if (!first.signature) throw notYet()
      const [entry] = await rpc(fetchTransactions(connection, [first.signature]))
      if (!entry?.tx) throw notYet()
      found = entry
      create = createIn(found, mint)
      if (!create) throw fail(400, 'This coin was not created on Meteora.', 'not_quantpad')
    }
    if (!create) {
      if (failed) throw fail(400, 'That transaction failed on-chain.', 'failed_transaction')
      if (!found) throw notYet()
      throw fail(400, 'That transaction did not create a Meteora coin.', 'not_create')
    }
    const { identityPending, ...base } = {
      ...create,
      identityPending: !create.name && !create.symbol && !create.uri,
    }
    if (!isSolQuote(base.quoteMint))
      throw fail(400, 'Quant Pad tracks SOL-quoted coins only.', 'not_sol_quote')

    // Registering a coin again is idempotent (its issued URI was consumed the first time).
    const existing = await store.get(keys.coin(base.mint))
    if (existing && !existing.external) {
      const patch = await healQuantum(existing).catch(() => ({}))
      const changed = Object.keys(patch).length > 0
      const record = changed
        ? await writeCoin(base.mint, (c) => c && applyHeal(c, patch))
        : existing
      if ((await ensureListed(record)) && changed) await saveSummary(record)
      return noticeDue(record) ? announce(record) : record
    }

    const q = await verifyQuantum(base.mint, base.creator, { minContextSlot: found.tx.slot })
    // Issued by /api/metadata, or already bound to this coin by an earlier registration that a
    // cap refused (the issued-uri record lasts a day; the binding lasts CLAIM_TTL_MS).
    const claim = issuedUriClaimKey(base.uri)
    let bound = (await store.get(claim)) === base.mint
    const issued = bound || !!(await store.get(issuedUriKey(base.uri)))
    if (q.quantum !== true && !issued) {
      if (q.retry) throw notYet('Could not verify the launch yet. Try again in a moment.')
      throw fail(400, 'This coin was not launched on Quant Pad.', 'not_quantpad')
    }
    // An issued URI lists one coin (QP-SEC-9): the first registration binds it to its mint
    // atomically, and any other coin created with the same URI is refused. A verified Quantum
    // coin does not need the URI, so it only takes it when it is still free.
    if (issued && !bound) {
      bound =
        (await store.set(claim, base.mint, { nx: true, ttl: CLAIM_TTL_MS })) ||
        (await store.get(claim)) === base.mint
      if (!bound && q.quantum !== true)
        throw fail(
          400,
          'That metadata was already used by another launch. Each launch needs its own.',
          'not_quantpad',
        )
    }
    const admitted = await admitNative(base.mint, q.launcher || base.launcher)
    if (admitted.error) throw admitted.error

    // The dev buy usually shares the create transaction: index it now so the coin page has a price
    // immediately; the rest of the history is read by background syncs.
    const initial = tradesFrom(found.tx, {
      signature: found.signature,
      mint: base.mint,
      dbcPool: base.dbcPool,
      pool: null,
    }).filter((t) => !MARKERS.has(t.side))
    let created = false
    let record = await writeCoin(base.mint, async (current) => {
      if (current && !current.external) return current // registered concurrently
      created = true // otherwise the launcher's slot taken above is returned
      const next = {
        ...current,
        ...base,
        identityPending,
        quantum: q.quantum,
        launcher: q.launcher || base.launcher,
        external: false,
        source: 'quantpad',
        provenance: q.quantum === true ? 'quantum' : 'issued-uri',
        cursor: current?.cursor || null,
        poolCursor: current?.poolCursor || null,
        complete: current?.complete || false,
        migrated: current?.migrated || false,
        pool: current?.pool || null,
        supply: current?.supply || null,
        behind: true, // the history after the create is read by the sync below
        registeredAt: now(),
        ...notice(),
      }
      const { trades, day } = await mergeTrades(base.mint, current, initial)
      if (day) next.day = day
      return { ...next, ...derive(next, trades, null) }
    }).catch(async (e) => {
      await admitted.refund()
      throw e
    })
    if (!created) await admitted.refund()
    // K5: the registration consumes the issued URI (the claim keeps it bound to this coin).
    if (bound) await store.delete(issuedUriKey(base.uri)).catch(() => {})
    await saveSummary(record)
    if (created) record = await announce(record)
    syncCoin(record.mint).catch(() => {})
    return record
  }

  // Tracks any SOL-quoted Meteora DBC coin a visitor opens: external unless it is a verified
  // Quantum coin. Responds with the live on-chain price (the DAMM v2 pool's once migrated).
  async function track(mint) {
    if (!isAddress(mint)) throw fail(400, 'Enter a valid Solana mint address.', 'invalid_mint')
    const existing = await store.get(keys.coin(mint))
    if (existing) {
      const patch = {
        ...(await healQuantum(existing).catch(() => ({}))),
        ...(await healIdentity(existing)),
      }
      const changed = Object.keys(patch).length > 0
      let record = changed ? await writeCoin(mint, (c) => c && applyHeal(c, patch)) : existing
      // Re-list a coin that dropped out of the list, and sync one that never synced.
      const listed = await ensureListed(record)
      if (listed && changed) await saveSummary(record)
      if (noticeDue(record)) record = await announce(record)
      if (!listed || !record.syncedAt) syncCoin(mint).catch(() => {})
      return record
    }
    const market = await rpc(readMarket(connection, mint, { launchConfigs }))
    const curve = market.curve
    if (!curve) throw fail(404, 'That mint is not a Meteora coin.', 'not_meteora')
    if (!isSolQuote(curve.quoteMint))
      throw fail(400, 'Quant Pad tracks SOL-quoted coins only.', 'not_sol_quote')
    // A failed identity read is not "no metadata": the record says so and syncs read it again.
    const identity = await identityPatch(mint)
    const q = await verifyQuantum(mint, curve.creator)
    const admitted = q.quantum === true ? await admitNative(mint, q.launcher) : null
    const native = !!admitted?.ok
    const draft = {
      mint,
      name: 'Unknown',
      symbol: '???',
      uri: '',
      ...identity,
      creator: curve.creator,
      dbcPool: curve.dbcPool,
      dbcConfig: curve.dbcConfig,
      decimals: curve.decimals,
      quantum: q.quantum,
      external: !native,
      source: native ? 'quantpad' : 'meteora',
      // Without its uri yet, the launch is announced by the sync that reads it.
      ...(native
        ? {
            provenance: 'quantum',
            launcher: q.launcher,
            ...notice(identity.identityPending ? 0 : now()),
          }
        : {}),
      createdAt: native ? q.createdAt || null : null,
      complete: curve.complete,
      migrated: !!market.pool,
      pool: market.pool?.address || null,
      cursor: null,
      poolCursor: null,
      supply: market.supply,
      supplyAt: market.supply ? now() : null,
      price: (market.pool ? market.pool.price : curve.price) || null,
      quoteReserve: curve.quoteReserve,
      migrationThreshold: curve.migrationThreshold,
      progress: curve.progress,
      behind: true,
      statsPartial: true,
      registeredAt: now(),
    }
    draft.marketCap = marketCap(draft.price, capSupply(draft), draft.decimals ?? undefined)
    let created = false
    let record = await writeCoin(mint, (current) => {
      if (current) return current
      created = true
      return draft
    }).catch(async (e) => {
      if (native) await admitted.refund()
      throw e
    })
    if (native && !created) await admitted.refund()
    await saveSummary(record)
    if (created) record = await announce(record)
    // Trade history fills in on background syncs.
    syncCoin(mint).catch(() => {})
    return record
  }

  // The coin's name, symbol, uri and token program as record fields, with identityPending true
  // when they could not be read now (an RPC failure or a lagging node). A mint with no metadata at
  // all settles with its placeholder.
  async function identityPatch(mint) {
    try {
      const identity = await readTokenIdentity(connection, mint)
      if (!identity) return { identityPending: false }
      const { name, symbol, uri, tokenProgram } = identity
      return {
        name: name || 'Unknown',
        symbol: symbol || '???',
        uri: uri || '',
        ...(tokenProgram ? { tokenProgram } : {}),
        identityPending: false,
      }
    } catch {
      return { identityPending: true }
    }
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
    let migrated = !!record.migrated
    const dbcPool = record.dbcPool
    const decimals = record.decimals ?? undefined

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
            for (const t of tradesFrom(tx, { signature, mint, dbcPool, pool, decimals }))
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

    // A record without its DBC pool (none was found when it was stored) only reads live state.
    if (dbcPool) await collect(dbcPool, 'cursor', null)
    if (fresh.some((t) => t.side === 'complete')) complete = true
    const pool = record.pool || null
    // The DAMM v2 pool's history once Meteora migrated the coin.
    if (migrated && pool) await collect(pool, 'poolCursor', pool)

    const supplyStale = !record.supplyAt || now() - record.supplyAt > SUPPLY_TTL_MS
    let live = null
    if (
      Date.now() < deadline &&
      (moved ||
        behind ||
        !record.syncedAt ||
        !(record.price > 0) ||
        supplyStale ||
        (complete && !migrated))
    )
      live = await readMarket(connection, mint, {
        dbcPool,
        supply: supplyStale,
        launchConfigs,
      }).catch(() => null)
    if (live?.curve?.complete && !complete) complete = true
    if (live?.pool && !migrated) {
      migrated = true
      behind = true // the pool's history is read from the next pass
    }
    const healed = await healQuantum(record).catch(() => ({}))
    const identity = Date.now() < deadline ? await healIdentity(record) : {}
    const created = fresh.find((t) => t.side === 'create')
    const priced = fresh.filter((t) => !MARKERS.has(t.side))

    // Merged onto the record as stored now, changing only the indexer's own fields, so metadata or
    // an upgrade written while this pass read the chain is kept.
    const saved = await writeCoin(mint, async (current) => {
      if (!current) return null // evicted meanwhile
      const { trades, day } = await mergeTrades(mint, current, priced)
      const next = {
        ...applyHeal(current, { ...healed, ...identity }),
        ...(day ? { day } : {}),
        cursor: state.cursor,
        poolCursor: state.poolCursor,
        gaps: state.gaps,
        historyFrom: state.historyFrom,
        seq: state.seq,
        complete: !!current.complete || complete,
        migrated: !!current.migrated || migrated,
        pool: current.pool || live?.pool?.address || null,
        behind,
        syncedAt: now(),
      }
      if (!next.createdAt && created?.createdAt) next.createdAt = created.createdAt
      if (live?.supply) Object.assign(next, { supply: live.supply, supplyAt: now() })
      if (live?.curve) {
        // A DBC pool's creator can be handed on (to a Quantum well, for one): follow it.
        next.creator = live.curve.creator
        if (!next.dbcPool)
          Object.assign(next, { dbcPool: live.curve.dbcPool, dbcConfig: live.curve.dbcConfig })
        if (next.decimals == null) next.decimals = live.curve.decimals
      }
      return { ...next, ...derive(next, trades, live) }
    })
    if (!saved) return null
    await saveSummary(saved)
    if (error && !moved && !live) throw rpcFailure(error)
    return noticeDue(saved) ? announce(saved) : saved
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

  // Listing filters and sorts. Unknown names (including inherited ones such as 'constructor') mean
  // 'all' and 'newest', so external coins are only ever listed when 'tracked' is asked for
  // (QP-SEC-7: the route allowlists both too).
  const FILTERS = {
    all: (c) => !c.external,
    quantum: (c) => !!c.quantum && !c.external,
    graduated: (c) => !!c.complete && !c.external,
    tracked: (c) => !!c.external,
  }
  const SORTS = {
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    volume: (a, b) => (b.volume24h || 0) - (a.volume24h || 0),
    mcap: (a, b) => (b.marketCap || 0) - (a.marketCap || 0),
    progress: (a, b) => (b.progress || 0) - (a.progress || 0),
    trending: (a, b) =>
      (b.trades24h || 0) - (a.trades24h || 0) || (b.volume24h || 0) - (a.volume24h || 0),
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
    const needle = String(q || '')
      .toLowerCase()
      .trim()
    const shown = Object.hasOwn(FILTERS, filter) ? FILTERS[filter] : FILTERS.all
    offset = Math.max(0, Math.floor(Number(offset) || 0))
    limit = Math.max(1, Math.floor(Number(limit) || 24))
    let items = (await list()).filter(
      (c) =>
        !hidden.has(c.mint) &&
        (!launcher || c.launcher === launcher) &&
        shown(c) &&
        (!needle ||
          [c.name, c.symbol, c.mint].some((s) =>
            String(s || '')
              .toLowerCase()
              .includes(needle),
          )),
    )
    items.sort(Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.newest)
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
    trades: tradePage,
    candles,
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
    // Meteora moved the full curve into its DAMM v2 pool (until then a full curve cannot trade).
    migrated: !!r.migrated,
    progress: r.progress ?? 0,
    price: r.price ?? null,
    marketCap: r.marketCap ?? null,
    // 24h figures are null while unknown (see stats()), which is always flagged partial.
    volume24h: r.volume24h ?? null,
    change24h: r.change24h ?? null,
    trades24h: r.trades24h ?? null,
    statsPartial: !!r.statsPartial || r.volume24h == null || r.trades24h == null,
    lastTradeAt: r.lastTradeAt ?? null,
    volume7d: r.volume7d ?? null,
    image: r.image || null,
    trackedAt: r.registeredAt || null,
    syncedAt: r.syncedAt || null,
  }
}

// SOL traded in the 7 days before `nowSecs` by the trades given.
export const weekVolume = (trades, nowSecs) =>
  trades.reduce(
    (sum, t) =>
      t.price > 0 && t.timestamp >= nowSecs - 7 * DAY ? sum + (Number(t.solAmount) || 0) : sum,
    0,
  ) / 1e9

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
export function stats(
  trades,
  nowSecs,
  { supply, decimals, coveredFrom = 0, behind = false, day } = {},
) {
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
    marketCap: latest ? marketCap(latest.price, supply, decimals) : null,
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
