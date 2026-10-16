// Entanglement weights by holding time. The keeper samples each Entanglement coin's holder
// balances every few minutes and credits each wallet min(balance at one sample, balance at the
// next) for the seconds between them, so only tokens held through two consecutive samples earn:
// buying just before a sample and selling just after earns nothing, and a wallet that sells keeps
// what it earned until then. An epoch splits the reserve by these weights, which is each wallet's
// average balance over the window since the previous epoch.
//
// Storage (the keeper's key/value store, BigInts as decimal strings):
//   holdtime:<mint>  header {v, gen, since, at, covered, program, buckets, meta, offCurve, cut,
//                    next}
//     since/at   unix seconds the window began and of the last sample
//     covered    seconds credited in the window so far: the window's clock, which records use
//     meta[n]    [digest of bucket n's balances, records, live slot, written at]
//     offCurve   owners found to be PDAs (vaults, the well), left out of every sample
//     cut        {index, root, gen, at, covered} while an epoch built from this window is posting
//     next       the epoch index the window pays for (null until the keeper has read the chain)
//   holdtime:<mint>:<buckets>:<n>:<slot>  {wallet: [balance, acc, clock, gen]}
//     acc is balance x seconds earned up to `clock`; the wallet has held `balance` since, so its
//     weight at window clock C is acc + balance x (C - clock) (lazy accrual: a record changes only
//     when its balance does). A record from an older gen earned nothing in this window yet.
//   holdtime:schedule  {mint: [nextDue, every, slow, next, at, cut]}: slow 1 for a coin whose scan
//     outlasts the sampling pass (the keeper samples it on the coin's own turn instead); next,
//     at and cut summarise its window as last read or written, so a coin with nothing to settle
//     costs no header read on its turn
// A bucket whose balances still match its digest is neither read nor written, so an idle coin
// costs a header read and write per sample. Each bucket is written to its other slot before the
// header points at it, so a sample interrupted part way leaves the last one intact to redo.
// MAX_RECORDS bounds the records of all buckets together: past it, the records worth least are
// dropped wherever they are, so wallets ground into one bucket cannot push a seller's weight out.
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

export const SAMPLE_EVERY = 600
// A coin whose balances do not change is sampled less often, down to this: a cron interval under
// MAX_STEP, so an idle sample that runs a few minutes late is still credited in full.
export const SAMPLE_IDLE_MAX = 3000
// Keeper downtime cannot let one stale sample stand for hours: a gap credits at most this much.
export const MAX_STEP = 3600
export const MIN_COVERED = 43200 // an epoch needs this much sampled time behind it
export const BUCKET_TARGET = 256
export const MAX_TRACKED = 32768 // largest balances followed per sample
export const MAX_RECORDS = 65536 // holders plus sellers keeping their weight, in all buckets
export const HOLD_TTL = 30 * 86400
const VERSION = 1
const OFF_CURVE_MAX = 256
const BATCH = 8 // bucket reads and writes in flight at once
// A bucket holds at most this many times BUCKET_TARGET records (about 430 KB at 256), however
// many wallets are ground into it.
const BUCKET_SPREAD = 16
const EMPTY = Object.freeze(['', 0, 1, 0])

export const bucketOf = (wallet, buckets) =>
  buckets > 1 ? createHash('sha256').update(wallet).digest().readUInt32BE(0) % buckets : 0

/** The bucket count for `records`: a power of two keeping about `target` records per bucket. */
export function bucketCount(records, { target = BUCKET_TARGET, max = MAX_RECORDS / target } = {}) {
  let buckets = 1
  while (buckets * 2 <= max && records > buckets * target) buckets *= 2
  return buckets
}

/** A digest of [wallet, balance] pairs in any order; '' for none. */
export function digest(entries) {
  const rows = [...entries].map(([wallet, balance]) => `${wallet}:${balance}`)
  if (!rows.length) return ''
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex').slice(0, 32)
}

/** Seconds credited between samples at `at` and `now` (none for the first sample). */
export const step = (at, now, maxStep = MAX_STEP) =>
  at == null ? 0 : Math.min(Math.max(0, now - at), maxStep)

/** A record as of generation `gen`: an older one has earned nothing in this window yet. */
export function held(rec, gen) {
  if (!rec) return { balance: 0n, acc: 0n, clock: 0 }
  const balance = BigInt(rec[0])
  return rec[3] === gen
    ? { balance, acc: BigInt(rec[1]), clock: rec[2] }
    : { balance, acc: 0n, clock: 0 }
}

/** A record's weight (balance x seconds) at window clock `clock`. */
export function weight(rec, gen, clock) {
  const h = held(rec, gen)
  return h.acc + h.balance * BigInt(clock - h.clock)
}

/**
 * A wallet's record after a sample at window clock `to` shows `balance`, the previous sample
 * having been at `from`: it held its recorded balance through `from`, and only the lesser of the
 * two from `from` to `to`. Null when the record carries nothing.
 */
export function touch(rec, balance, { gen, from, to }) {
  const h = held(rec, gen)
  const kept = h.balance < balance ? h.balance : balance
  const acc = h.acc + h.balance * BigInt(from - h.clock) + kept * BigInt(to - from)
  return balance > 0n || acc > 0n ? [String(balance), String(acc), to, gen] : null
}

/**
 * Leaves for an epoch of `reserve` lamports: the `maxLeaves` largest weights (wallet order breaks
 * ties) share it pro rata, and amounts under `minClaim` are left in the reserve.
 */
export function allocate(weights, reserve, { maxLeaves = Infinity, minClaim = 1n } = {}) {
  const ranked = [...weights]
    .filter((e) => e.weight > 0n)
    .sort((a, b) =>
      a.weight === b.weight ? (a.wallet < b.wallet ? -1 : 1) : a.weight > b.weight ? -1 : 1,
    )
    .slice(0, maxLeaves)
  const total = ranked.reduce((sum, e) => sum + e.weight, 0n)
  if (!total) return []
  const pot = BigInt(reserve)
  return ranked
    .map((e) => ({ wallet: e.wallet, amount: (pot * e.weight) / total }))
    .filter((e) => e.amount >= BigInt(minClaim))
}

const byBalance = ([wa, a], [wb, b]) => (a === b ? (wa < wb ? -1 : 1) : a > b ? -1 : 1)
const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i)

async function mapBatched(items, task) {
  const out = []
  for (let n = 0; n < items.length; n += BATCH)
    out.push(...(await Promise.all(items.slice(n, n + BATCH).map(task))))
  return out
}

function isOnCurve(wallet) {
  try {
    return PublicKey.isOnCurve(new PublicKey(wallet).toBytes())
  } catch {
    return false
  }
}

export function createHoldtime({ store, now = Date.now, log = () => {}, opts = {} }) {
  const maxStep = opts.maxStep ?? MAX_STEP
  const maxTracked = opts.maxTracked ?? MAX_TRACKED
  const maxRecords = opts.maxRecords ?? MAX_RECORDS
  const target = opts.bucketTarget ?? BUCKET_TARGET
  const maxBuckets = bucketCount(Infinity, { target, max: Math.max(1, maxRecords / target) })
  const bucketMax = Math.min(maxRecords, opts.bucketMax ?? BUCKET_SPREAD * target)
  // Over maxRecords, records are dropped down to this, so the samples after need not read every
  // bucket again.
  const keepRecords = maxRecords - Math.floor(maxRecords / 8)
  const onCurve = opts.onCurve ?? isOnCurve
  const ttl = (opts.ttl ?? HOLD_TTL) * 1000
  const refreshAfter = ttl / 2000 // an unchanged bucket is rewritten before its TTL runs out
  const clock = () => Math.floor(now() / 1000)
  const keys = {
    header: (mint) => `holdtime:${mint}`,
    bucket: (mint, buckets, n, slot) => `holdtime:${mint}:${buckets}:${n}:${slot}`,
    schedule: 'holdtime:schedule',
  }

  // Every header read and written is reported to `onHeader`, so the keeper can keep a summary
  // of each window in the schedule it reads every tick anyway.
  const seen = opts.onHeader ?? (() => {})

  async function load(mint) {
    const stored = await store.get(keys.header(mint))
    const header =
      stored?.v === VERSION
        ? stored
        : {
            v: VERSION,
            gen: 0,
            since: null,
            at: null,
            covered: 0,
            program: null,
            buckets: 1,
            meta: [],
            offCurve: [],
            cut: null,
            next: null,
          }
    seen(mint, header)
    return header
  }

  const save = async (mint, header) => {
    await store.set(keys.header(mint), header, { ttl })
    seen(mint, header)
    return header
  }

  // A bucket the header counts records in but the store no longer has is added to `lost`.
  async function readBucket(mint, header, n, lost) {
    const m = header.meta[n]
    if (!m?.[1]) return {}
    const bucket = await store.get(keys.bucket(mint, header.buckets, n, m[2]))
    if (!bucket) lost?.add(n)
    return bucket || {}
  }

  const readAll = (mint, header, lost) =>
    mapBatched(range(0, header.buckets), (n) => readBucket(mint, header, n, lost))

  /**
   * Records a sample: `balances` maps each owner to its summed balance (owners in
   * header.offCurve already left out). Owners new to the records are checked to be wallets, and
   * PDAs among them join offCurve. Returns the new header and whether any balance changed.
   */
  async function sample(mint, header, balances) {
    if (header.cut) throw Error('an epoch built from this window is still posting')
    const t = clock()
    const { gen } = header
    const from = header.covered
    const to = from + step(header.at, t, maxStep)
    // What a record is worth keeping for: its weight now plus one more step at its balance, so a
    // large holder that has just arrived outranks dust that has sat through a few samples.
    const rank = (rec) => {
      const h = held(rec, gen)
      return h.acc + h.balance * BigInt(to - h.clock + maxStep)
    }
    // The `count` entries ([wallet, rec, ...]) worth least, wallet order breaking ties.
    const lowest = (entries, count) =>
      entries
        .map((e) => [rank(e[1]), e])
        .sort(([x, a], [y, b]) => (x === y ? (a[0] < b[0] ? -1 : 1) : x < y ? -1 : 1))
        .slice(0, count)
        .map(([, e]) => e)
    const offCurve = new Set(header.offCurve)
    let tracked = []
    for (const [wallet, balance] of balances)
      if (balance > 0n && !offCurve.has(wallet)) tracked.push([wallet, balance])
    if (tracked.length > maxTracked) tracked = tracked.sort(byBalance).slice(0, maxTracked)
    const known = header.meta.reduce((sum, m) => sum + m[1], 0)
    const buckets = Math.max(
      header.buckets,
      bucketCount(Math.max(known, tracked.length), { target, max: maxBuckets }),
    )
    // A larger bucket count moves every record: all buckets are read and split again.
    const regrow = buckets !== header.buckets
    const groups = Array.from({ length: buckets }, () => new Map())
    for (const [wallet, balance] of tracked) groups[bucketOf(wallet, buckets)].set(wallet, balance)

    const meta = []
    const todo = []
    let changed = header.at == null || regrow
    for (let n = 0; n < buckets; n++) {
      const m = regrow ? null : header.meta[n] || EMPTY
      if (m && m[0] === digest(groups[n]) && (!m[1] || t - m[3] < refreshAfter)) meta[n] = m
      else todo.push(n)
    }
    let moved = null
    if (regrow) {
      moved = Array.from({ length: buckets }, () => ({}))
      for (const bucket of await readAll(mint, header))
        for (const [wallet, rec] of Object.entries(bucket))
          moved[bucketOf(wallet, buckets)][wallet] = rec
    }
    const read = await mapBatched(todo, (n) => (regrow ? moved[n] : readBucket(mint, header, n)))
    // Bucket -> {records}; `kept` marks one read only to drop records from, until it loses some.
    const built = new Map()
    // A dropped holder leaves its bucket's digest too, so the next sample sees the bucket as
    // changed and weighs the holder again (from nothing) instead of locking it out.
    const drop = (n, wallet) => {
      delete built.get(n).records[wallet]
      built.get(n).kept = false
      groups[n].delete(wallet)
    }
    for (const [k, n] of todo.entries()) {
      const records = read[k]
      const group = groups[n]
      const before = regrow ? null : (header.meta[n] || EMPTY)[0]
      const next = {}
      for (const wallet of new Set([...Object.keys(records), ...group.keys()])) {
        const rec = records[wallet]
        const balance = group.get(wallet) ?? 0n
        // Only wallets earn. An owner past the list's cap stays in the digest, so its bucket
        // does not read as changed every sample.
        if (!rec && !onCurve(wallet)) {
          if (offCurve.size < OFF_CURVE_MAX) {
            offCurve.add(wallet)
            group.delete(wallet)
          }
          continue
        }
        const h = held(rec, gen)
        const out =
          h.balance === balance
            ? h.balance > 0n || h.acc > 0n
              ? rec
              : null
            : touch(rec, balance, { gen, from, to })
        if (out) next[wallet] = out
      }
      if (!regrow && digest(group) !== before) changed = true
      built.set(n, { records: next })
      const over = Object.keys(next).length - bucketMax
      if (over > 0) for (const [wallet] of lowest(Object.entries(next), over)) drop(n, wallet)
    }
    const count = (n) => (built.has(n) ? Object.keys(built.get(n).records).length : meta[n][1])
    const total = range(0, buckets).reduce((sum, n) => sum + count(n), 0)
    if (total > maxRecords) {
      // Every bucket is read, and the records worth least are dropped wherever they are.
      const rest = range(0, buckets).filter((n) => !built.has(n))
      const restRead = await mapBatched(rest, (n) => readBucket(mint, header, n))
      rest.forEach((n, k) => built.set(n, { records: restRead[k], kept: true }))
      const pool = []
      for (const [n, b] of built)
        for (const [wallet, rec] of Object.entries(b.records)) pool.push([wallet, rec, n])
      for (const [wallet, , n] of lowest(pool, total - keepRecords)) drop(n, wallet)
    }
    const writes = []
    for (const [n, b] of built) {
      if (b.kept) continue
      const slot = regrow ? 0 : 1 - (header.meta[n] || EMPTY)[2]
      const records = Object.keys(b.records).length
      meta[n] = [digest(groups[n]), records, slot, t]
      if (records) writes.push([n, slot, b.records])
    }
    await mapBatched(writes, ([n, slot, records]) =>
      store.set(keys.bucket(mint, buckets, n, slot), records, { ttl }),
    )
    const next = await save(mint, {
      ...header,
      since: header.since ?? t,
      at: Math.max(t, header.at ?? t),
      covered: to,
      buckets,
      meta,
      offCurve: [...offCurve],
    })
    if (regrow)
      await mapBatched(
        header.meta.flatMap((m, n) => (m[1] ? [keys.bucket(mint, header.buckets, n, m[2])] : [])),
        (key) => store.delete(key),
      ).catch(() => {}) // they expire anyway
    return { header: next, changed }
  }

  /**
   * Every wallet's weight for the window so far, with the header. A bucket the store lost is
   * marked to be built again from the next sample's balances (its wallets earn again from then);
   * until then they have no weight. A window of a single sample (covered 0, possible only when no
   * minimum is set) weighs that sample's balances.
   */
  async function weights(mint, header) {
    const lost = new Set()
    const out = []
    for (const bucket of await readAll(mint, header, lost))
      for (const [wallet, rec] of Object.entries(bucket)) {
        const w = header.covered
          ? weight(rec, header.gen, header.covered)
          : held(rec, header.gen).balance
        if (w > 0n) out.push({ wallet, weight: w })
      }
    if (!lost.size) return { weights: out, header }
    log(
      `holdtime ${mint}: bucket ${[...lost].join(', ')} is missing; its wallets earn again ` +
        `from the next sample`,
    )
    // No digest is '', so the next sample builds these again; a count of 0 reads nothing.
    const meta = header.meta.map((m, n) => (lost.has(n) ? ['', 0, m[2], m[3]] : m))
    return { weights: out, header: await save(mint, { ...header, meta }) }
  }

  // An epoch built from the window is about to be sent: its end is marked, and sampling waits
  // until settle() learns whether the post landed.
  const cut = (mint, header, { index, root }) =>
    save(mint, {
      ...header,
      cut: { index, root, gen: header.gen, at: header.at, covered: header.covered },
    })

  // The cut's epoch posted: the next window starts at its end and pays for the epoch after it.
  // Records from older generations read as having earned nothing, so this is one header write.
  const finalize = (mint, header) =>
    header.cut
      ? save(mint, {
          ...header,
          gen: header.gen + 1,
          since: header.cut.at,
          covered: 0,
          cut: null,
          next: header.cut.index + 1,
        })
      : header

  /** Settles a cut by its post's `status`: 'posted', 'dropped' (the window goes on) or 'pending'. */
  async function settle(mint, header, status) {
    if (!header.cut || status === 'pending') return header
    if (status === 'posted') return finalize(mint, header)
    return save(mint, { ...header, cut: null })
  }

  // The window pays for epoch `next`. A header with no sample yet is saved by its first one.
  const pays = (mint, header, next) =>
    header.next === next
      ? header
      : header.at == null
        ? { ...header, next }
        : save(mint, { ...header, next })

  // Epochs this window did not pay landed, and paid for its time already: a new window starts
  // at the last sample, paying for epoch `next`.
  const restart = (mint, header, next) =>
    save(mint, { ...header, gen: header.gen + 1, since: header.at, covered: 0, cut: null, next })

  // Entries are [nextDue, every], [nextDue, every, slow] (1 for a coin whose scan outlasts the
  // sampling pass's limit) or [nextDue, every, slow, next, at, cut], whose last three summarise
  // the coin's window (next -1 and at 0 for none, cut 1 while a post is unsettled). Anything
  // else is dropped: runCoin schedules those coins again.
  async function loadSchedule() {
    const stored = await store.get(keys.schedule)
    const flag = (v) => v === 0 || v === 1
    const ok = (e) =>
      Array.isArray(e) &&
      [2, 3, 6].includes(e.length) &&
      e.every(Number.isFinite) &&
      e[1] > 0 &&
      (e.length < 3 || flag(e[2])) &&
      (e.length < 6 || flag(e[5]))
    return Object.fromEntries(Object.entries(stored || {}).filter(([, e]) => ok(e)))
  }
  const saveSchedule = (schedule) => store.set(keys.schedule, schedule, { ttl })

  return {
    load,
    sample,
    weights,
    cut,
    settle,
    finalize,
    pays,
    restart,
    loadSchedule,
    saveSchedule,
  }
}
