// The keeper paying Entanglement by holding time: holder samples on the keeper's own clock,
// the 12 h minimum window, posts that drop or stay pending, and the sampling pass's limits.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { createHoldtime } from '../../server/holdtime.mjs'
import { createKeeper } from '../../server/keeper.mjs'
import { buildEntanglementTree, verifyClaim } from '../../shared/merkle.mjs'
import { network } from '../../shared/network.mjs'

const HOUR = 3600
const DAY = 86400
const T0 = 1_800_000_000
const PROGRAM = Keypair.generate().publicKey
const TOKEN_2022 = new PublicKey(network.token2022Program)
const keeperKey = Keypair.generate()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const newKey = () => Keypair.generate().publicKey
const newMint = () => newKey().toBase58()
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map(Buffer.from), PROGRAM)[0]
const wellPda = (mint) => pda('well', new PublicKey(mint).toBuffer())
const epochPda = (mint, index) =>
  pda('epoch', new PublicKey(mint).toBuffer(), Buffer.from(Uint32Array.of(index).buffer))
const ix = () =>
  SystemProgram.transfer({
    fromPubkey: keeperKey.publicKey,
    toPubkey: keeperKey.publicKey,
    lamports: 1,
  })

// The store interface over a Map, with the lease's NX set and owner-checked release. Values go
// through JSON like the real stores.
function memoryStore() {
  const data = new Map()
  const ops = []
  return {
    data,
    ops,
    async get(key) {
      ops.push(['get', key])
      return data.has(key) ? JSON.parse(data.get(key)) : null
    },
    async set(key, value, { nx = false } = {}) {
      ops.push(['set', key])
      if (nx && data.has(key)) return false
      data.set(key, JSON.stringify(value))
      return true
    },
    async delete(key) {
      ops.push(['delete', key])
      data.delete(key)
    },
    async release(key, owner) {
      if (data.get(key) === JSON.stringify(owner)) data.delete(key)
    },
  }
}

// A simulated chain on a clock the test moves (`t`, unix seconds). `holders` maps each mint to
// its token balances by owner; posts and closes apply when their transaction lands.
function world() {
  const w = {
    t: T0,
    coins: new Map(),
    epochs: new Map(), // epoch PDA -> Epoch account
    statuses: new Map(),
    inflight: [],
    holders: new Map(), // mint -> Map(owner base58 -> amount)
    scans: [], // [mint, t] for each holder scan
    calls: [],
    logged: [],
    list: [],
    next: null,
    land: true,
    statusError: null,
    blind: false,
    height: 1000,
    heightStep: 0,
    scanDelay: 0,
    hangScans: false,
    config: {
      keeper: keeperKey.publicKey.toBase58(),
      claimDelay: 6 * HOUR,
      minActionInterval: 60,
      maxBurnLamports: 50_000_000n,
    },
  }
  w.now = () => w.t * 1000
  w.epoch = (mint, index) => w.epochs.get(epochPda(mint, index).toBase58())
  w.register = (mint, state = {}, balances = {}) => {
    w.coins.set(mint, {
      burnReserve: 0n,
      entangleReserve: 0n,
      fusionReserve: 0n,
      entangleBps: 2000,
      epochCount: 0,
      lastBurnAt: 0,
      lastFusionAt: 0,
      lastEpochAt: 0,
      ...state,
    })
    // The well holds tokens too: an owner that is no wallet, left out of every epoch.
    w.holders.set(mint, new Map([[wellPda(mint).toBase58(), 5_000_000n]]))
    w.hold(mint, balances)
    w.list.push({ mint, quantum: true, external: false })
  }
  // Sets owners' balances (0 sells everything).
  w.hold = (mint, balances) => {
    for (const [owner, amount] of Object.entries(balances)) w.holders.get(mint).set(owner, amount)
  }
  const apply = (signature, effect) => {
    try {
      effect?.()
      w.statuses.set(signature, { confirmationStatus: 'confirmed', err: null })
    } catch (e) {
      w.statuses.set(signature, { confirmationStatus: 'confirmed', err: { Custom: e.message } })
    }
  }
  w.connection = {
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: w.height + 150,
    }),
    getBlockHeight: async () => (w.height += w.heightStep),
    sendRawTransaction: async (raw) => {
      const signature = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0])
      const effect = w.next
      w.next = null
      if (w.land) apply(signature, effect)
      else w.inflight.push([signature, effect])
      return signature
    },
    getSignatureStatuses: async (signatures) => {
      if (w.statusError) throw new Error(w.statusError)
      return { value: signatures.map((s) => w.statuses.get(s) ?? null) }
    },
    getTransaction: async () => null,
    getSignaturesForAddress: async () => [],
    getMultipleAccountsInfo: async (keys) =>
      keys.map((k) => {
        const epoch = !w.blind && w.epochs.get(k.toBase58())
        return epoch ? { data: epoch } : null
      }),
    getAccountInfo: async () => ({ owner: TOKEN_2022, data: Buffer.alloc(82) }),
    getProgramAccounts: async (program, config) => {
      assert.equal(program.toBase58(), network.token2022Program)
      const mint = config.filters.find((f) => f.memcmp).memcmp.bytes
      w.scans.push([mint, w.t])
      if (w.hangScans) return new Promise(() => {})
      if (w.scanDelay) await sleep(w.scanDelay)
      return [...w.holders.get(mint)].map(([owner, amount]) => {
        const data = Buffer.alloc(40)
        new PublicKey(owner).toBuffer().copy(data, 0)
        data.writeBigUInt64LE(amount, 32)
        return { pubkey: newKey(), account: { data } }
      })
    },
  }
  w.quantum = {
    wellPda,
    epochPda,
    decodeEpoch: (data) => data,
    mintTokenProgram: () => TOKEN_2022,
    fetchQuantum: async (_c, mint) => {
      const state = w.coins.get(mint.toBase58())
      return state ? { ...state } : null
    },
    fetchConfig: async () => w.config && { ...w.config },
    pendingCreatorFees: async () => 0n,
    fetchWellBalance: async () => ({ unallocated: 0n }),
    fetchVenue: async () => ({ kind: 'curve' }),
    isLeafClaimed: (epoch, leafIndex) => epoch.claimed.has(leafIndex),
    decodeQuantumEvents: (logs) => logs || [],
    buildEntanglementTree,
    buildPostEpochInstruction: async ({ mint, index, root, total, leafCount }) => {
      w.calls.push(`epoch:${index}:${total}:${Buffer.from(root).toString('hex')}`)
      w.next = () => {
        const state = w.coins.get(mint.toBase58())
        if (index !== state.epochCount) throw new Error('ConstraintSeeds')
        w.epochs.set(epochPda(mint, index).toBase58(), {
          index,
          root: Uint8Array.from(root),
          total,
          leafCount,
          createdAt: w.t,
          claimStart: w.t + w.config.claimDelay,
          expiresAt: w.t + 30 * DAY,
          payer: keeperKey.publicKey.toBase58(),
          claimed: new Set(),
        })
        state.epochCount++
        state.entangleReserve -= total
        state.lastEpochAt = w.t
      }
      return ix()
    },
    buildCloseEpochInstruction: async () => ix(),
  }
  return w
}

function makeKeeper(w, store, holdtime = {}) {
  return createKeeper({
    connection: w.connection,
    store,
    quantum: w.quantum,
    keeper: keeperKey,
    indexer: { list: async () => w.list, coin: async (mint) => ({ mint, complete: false }) },
    log: (m) => w.logged.push(m),
    pollMs: 1,
    now: w.now,
    holdtime,
  })
}

// Ticks at each multiple of `every` seconds after T0 up to `end` (unix seconds), then sets the
// clock to `end`.
async function run(w, keeper, end, every = HOUR, options) {
  for (let t = T0 + (Math.floor((w.t - T0) / every) + 1) * every; t <= end; t += every) {
    w.t = t
    await keeper.tick(options)
  }
  w.t = end
}

// What each wallet is owed once claims open, read through the keeper's API.
async function owed(w, keeper, mint, wallets) {
  const t = w.t
  w.t = Math.max(...[...w.epochs.values()].map((e) => e.claimStart)) + 60
  const out = {}
  for (const wallet of wallets) {
    const items = await keeper.claims(mint, wallet)
    for (const item of items) {
      const epoch = w.epoch(mint, item.index)
      assert.ok(
        verifyClaim({
          leafIndex: item.leafIndex,
          wallet,
          amount: BigInt(item.amount),
          proof: item.proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex'))),
          root: epoch.root,
        }),
      )
    }
    out[wallet] = items.map((c) => [c.index, BigInt(c.amount)])
  }
  w.t = t
  return out
}

const share = (reserve, weights, wallet) =>
  (reserve * weights[wallet]) / Object.values(weights).reduce((s, v) => s + v, 0n)

test('a late buyer is paid by its time held, and nothing is posted before 12 h are covered', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const [early, late] = [newMint(), newMint()]
  const reserve = 1_000_000_000n
  w.register(mint, { entangleReserve: reserve }, { [early]: 600_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick() // the first sample opens the window
  await run(w, keeper, T0 + 3.5 * HOUR)
  w.hold(mint, { [late]: 400_000n }) // first seen by the 3 h 50 min sample (idle back-off)
  await run(w, keeper, T0 + 12 * HOUR - 600, 600)
  assert.deepEqual(w.calls, [], 'no post before 12 h of samples')
  await run(w, keeper, T0 + 12 * HOUR, 600)
  assert.equal(w.calls.length, 1)

  const weights = { [early]: 600_000n * 43_200n, [late]: 400_000n * 29_400n }
  assert.deepEqual(await owed(w, keeper, mint, [early, late]), {
    [early]: [[0, share(reserve, weights, early)]],
    [late]: [[0, share(reserve, weights, late)]],
  })
  const [row] = await keeper.epochs(mint)
  assert.deepEqual(row.window, { from: T0, to: T0 + 12 * HOUR, covered: 43_200 })
  assert.equal(row.holders, 2, 'the well is no holder')
  assert.equal(row.total, String(share(reserve, weights, early) + share(reserve, weights, late)))
})

test('a wallet that straddles one sample gets no leaf; one that sells keeps what it earned', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const [holder, seller, straddler] = [newMint(), newMint(), newMint()]
  const reserve = 1_700_000_000n
  w.register(mint, { entangleReserve: reserve }, { [holder]: 500_000n, [seller]: 500_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 6 * HOUR - 60)
  w.hold(mint, { [seller]: 0n }) // held through the 5 h sample, gone by the 6 h one
  await run(w, keeper, T0 + 8 * HOUR - 60)
  w.hold(mint, { [straddler]: 2_000_000n }) // bought just before the 8 h sample...
  await run(w, keeper, T0 + 8 * HOUR + 60)
  w.hold(mint, { [straddler]: 0n }) // ...and sold just after it
  await run(w, keeper, T0 + 12 * HOUR)
  assert.equal(w.calls.length, 1)
  const weights = { [holder]: 500_000n * 12n, [seller]: 500_000n * 5n }
  assert.deepEqual(await owed(w, keeper, mint, [holder, seller, straddler]), {
    [holder]: [[0, share(reserve, weights, holder)]],
    [seller]: [[0, share(reserve, weights, seller)]],
    [straddler]: [],
  })
})

test('a dropped post keeps its window: the re-post pays the same leaves', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const [a, b] = [newMint(), newMint()]
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 700_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 2 * HOUR)
  w.hold(mint, { [b]: 300_000n })
  await run(w, keeper, T0 + 12 * HOUR - HOUR)

  w.land = false // the post never lands and its blockhash expires
  w.heightStep = 200
  await run(w, keeper, T0 + 12 * HOUR)
  assert.ok(w.logged.some((m) => /entangle .*expired before confirmation/.test(m)))
  const dropped = await store.get(`epoch:${mint}:0`)
  assert.equal(dropped.status, 'pending')
  assert.equal((await store.get(`holdtime:${mint}`)).cut.index, 0)

  // Next tick, same moment: the record is dropped, the cut reopened, and the epoch posted again.
  w.inflight.length = 0
  w.land = true
  w.heightStep = 0
  w.height += 1000
  await keeper.tick()
  assert.equal(w.calls.length, 2)
  assert.equal(w.calls[1], w.calls[0], 'same index, total and root')
  const posted = await store.get(`epoch:${mint}:0`)
  assert.equal(posted.status, 'posted')
  assert.deepEqual(posted.window, dropped.window)
  assert.deepEqual(posted.window, { from: T0, to: T0 + 12 * HOUR, covered: 43_200 })
  const header = await store.get(`holdtime:${mint}`)
  assert.equal(header.cut, null)
  assert.equal(header.gen, 1, 'finalized once posted')
  assert.equal(header.since, T0 + 12 * HOUR)
})

test("each epoch's window starts where the last one ended, and pays only its own time", async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const [a, b] = [newMint(), newMint()]
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 100_000n, [b]: 100_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 12 * HOUR)
  assert.equal(w.calls.length, 1)
  w.hold(mint, { [b]: 0n }) // b sells right after the first epoch
  w.coins.get(mint).entangleReserve = 500_000_000n
  await run(w, keeper, T0 + 36 * HOUR - 600, 600)
  assert.equal(w.calls.length, 1, 'the next post waits a day')
  await run(w, keeper, T0 + 36 * HOUR, 600)
  assert.equal(w.calls.length, 2)
  const [second, first] = await keeper.epochs(mint)
  assert.equal(second.window.from, first.window.to)
  assert.deepEqual(second.window, { from: T0 + 12 * HOUR, to: T0 + 36 * HOUR, covered: DAY })
  // b's last window was paid by epoch 0; it held nothing in this one.
  const items = await owed(w, keeper, mint, [a, b])
  assert.deepEqual(items[b], [[0, 500_000_000n]])
  assert.deepEqual(items[a], [
    [1, 500_000_000n],
    [0, 500_000_000n],
  ])
})

test('a post still in flight pauses sampling; once it lands the next window opens', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const a = newMint()
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 100_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 11 * HOUR)
  w.land = false // sent, not landed yet, and its blockhash stays valid
  // A short tick, so the post's confirmation gives up soon (the pass has no time to sample).
  await run(w, keeper, T0 + 12 * HOUR, HOUR, { timeLimitMs: 1000 })
  assert.ok(w.logged.some((m) => /entangle .*not confirmed yet \(time limit\)/.test(m)))
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'pending')
  const cut = await store.get(`holdtime:${mint}`)
  assert.equal(cut.cut.index, 0)

  const scans = w.scans.length
  await run(w, keeper, T0 + 14 * HOUR)
  assert.equal(w.scans.length, scans, 'no samples while the post may still land')
  assert.deepEqual(await store.get(`holdtime:${mint}`), cut)

  const [signature, effect] = w.inflight.shift() // it lands
  effect()
  w.statuses.set(signature, { confirmationStatus: 'confirmed', err: null })
  w.land = true
  await run(w, keeper, T0 + 15 * HOUR) // reconciled as posted, then the cut is finalized
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'posted')
  let header = await store.get(`holdtime:${mint}`)
  assert.deepEqual([header.cut, header.gen, header.next], [null, 1, 1])
  assert.equal(header.since, T0 + 12 * HOUR)
  assert.equal(w.scans.length, scans, 'the pass ran before the cut was settled')
  await run(w, keeper, T0 + 16 * HOUR)
  header = await store.get(`holdtime:${mint}`)
  assert.equal(header.at, T0 + 16 * HOUR)
  assert.equal(header.covered, HOUR, 'the gap is capped')
  assert.equal(w.scans.length, scans + 1)
})

test('a post that landed is settled by the epoch count while its status and account stay unreadable', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const a = newMint()
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 100_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 11 * HOUR)
  w.statusError = '429 Too Many Requests' // the post lands, but its status is never read
  w.blind = true // nor does this node show its account (a cancel would look the same)
  await run(w, keeper, T0 + 12 * HOUR)
  w.statusError = null
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'pending')
  assert.equal((await store.get(`holdtime:${mint}`)).cut.index, 0)

  // Entangle stops early for a day after a post; the count alone settles the cut.
  const scans = w.scans.length
  await run(w, keeper, T0 + 13 * HOUR)
  const header = await store.get(`holdtime:${mint}`)
  assert.deepEqual([header.cut, header.gen, header.next], [null, 1, 1])
  await run(w, keeper, T0 + 14 * HOUR)
  assert.equal(w.scans.length, scans + 1, 'sampling resumes at once, not a day later')
  assert.equal((await store.get(`holdtime:${mint}`)).at, T0 + 14 * HOUR)
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'pending', 'still unreadable')
})

test('epochs posted outside the holding window start it over; one this store never saw does not', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const [a, b] = [newMint(), newMint()]
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 100_000n, [b]: 100_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick()
  await run(w, keeper, T0 + 12 * HOUR)
  assert.equal(w.calls.length, 1)
  await run(w, keeper, T0 + 18.5 * HOUR)
  w.hold(mint, { [a]: 0n }) // a held through the 18 h sample, then sold
  await run(w, keeper, T0 + 20 * HOUR)

  // This keeper is down; an older one on the same store and key posts epoch 1 at 36 h.
  const state = w.coins.get(mint)
  const posted = (index, root, record) => {
    w.t = T0 + (index === 1 ? 36 : 70) * HOUR
    w.epochs.set(epochPda(mint, index).toBase58(), {
      index,
      root: Uint8Array.from(root),
      total: 1n,
      leafCount: 1,
      createdAt: w.t,
      claimStart: w.t + w.config.claimDelay,
      expiresAt: w.t + 30 * DAY,
      payer: keeperKey.publicKey.toBase58(),
      claimed: new Set(),
    })
    state.epochCount = index + 1
    state.lastEpochAt = w.t
    if (record)
      return store.set(`epoch:${mint}:${index}`, {
        index,
        root: root.toString('hex'),
        total: '1',
        holders: 1,
        status: 'posted',
        createdAt: w.t,
        postedAt: w.t,
        claimStart: w.t + w.config.claimDelay,
        expiresAt: w.t + 30 * DAY,
      })
  }
  await posted(1, Buffer.alloc(32, 7), true)
  state.entangleReserve = 500_000_000n
  w.t = T0 + 40 * HOUR
  await run(w, keeper, T0 + 41 * HOUR)
  let header = await store.get(`holdtime:${mint}`)
  assert.deepEqual(
    [header.gen, header.next, header.since, header.covered],
    [2, 2, T0 + 41 * HOUR, 0],
    'starts over at the last sample',
  )
  assert.ok(w.logged.some((m) => /epochs 1 to 1 were posted outside its holding window/.test(m)))

  await run(w, keeper, T0 + 60 * HOUR)
  assert.equal(w.calls.length, 2)
  const [row] = await keeper.epochs(mint)
  assert.equal(row.index, 2)
  assert.deepEqual(row.window, { from: T0 + 41 * HOUR, to: T0 + 60 * HOUR, covered: 19 * HOUR })
  // a's holding from 12 h to 18 h was in the time epoch 1 paid for.
  const items = await owed(w, keeper, mint, [a, b])
  assert.deepEqual(items[a], [[0, 500_000_000n]])
  assert.deepEqual(items[b], [
    [2, 500_000_000n],
    [0, 500_000_000n],
  ])

  // An epoch with no record here was posted elsewhere with the key: flagged, window kept.
  await posted(3, Buffer.alloc(32, 9), false)
  await run(w, keeper, T0 + 71 * HOUR)
  header = await store.get(`holdtime:${mint}`)
  assert.deepEqual([header.gen, header.next], [3, 4])
  assert.equal(header.since, T0 + 60 * HOUR)
  assert.ok(w.logged.some((m) => /epoch .*#3 was not posted by this keeper/.test(m)))
})

test('the sampling pass takes the oldest due coins first, at most 16, and backs off idle ones', async () => {
  const w = world()
  const store = memoryStore()
  const mints = Array.from({ length: 20 }, newMint)
  for (const mint of mints) w.register(mint, {}, { [newMint()]: 1_000n })
  const keeper = makeKeeper(w, store)
  // Due longest ago first: the schedule lists them in reverse.
  await store.set(
    'holdtime:schedule',
    Object.fromEntries(mints.map((m, i) => [m, [T0 - 100 + (19 - i), 600]])),
  )
  await keeper.tick({ budget: 0 })
  const first = w.scans.map(([m]) => m)
  assert.equal(first.length, 16)
  assert.deepEqual(new Set(first), new Set(mints.slice(4)), 'the 16 oldest')
  const schedule = await store.get('holdtime:schedule')
  for (const m of mints.slice(4)) assert.deepEqual(schedule[m].slice(0, 3), [T0 + 600, 600, 0])

  // Next time the four left over go first.
  w.scans.length = 0
  w.t += 600
  await keeper.tick({ budget: 0 })
  const second = w.scans.map(([m]) => m)
  assert.equal(second.length, 16)
  for (const m of mints.slice(0, 4)) assert.ok(second.includes(m), 'the four left over')
})

test('a coin whose holders do not move is sampled half as often each time, down to every 50 min', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  w.register(mint, {}, { [newMint()]: 1_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick() // scheduled, due at once
  const every = async () => (await store.get('holdtime:schedule'))[mint]
  const gaps = []
  for (let i = 0; i < 6; i++) {
    w.t = (await every())[0]
    await keeper.tick()
    gaps.push((await every())[1])
  }
  assert.deepEqual(gaps, [600, 1200, 2400, 3000, 3000, 3000], 'the first sample is news')
  assert.equal(w.scans.length, 6)
  // A change brings it back to every 10 minutes.
  w.hold(mint, { [newMint()]: 5n })
  w.t = (await every())[0]
  await keeper.tick()
  assert.deepEqual((await every()).slice(0, 3), [w.t + 600, 600, 0])
})

test("a coin's turn reads its window header only when there is something to settle", async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  w.register(mint, {}, { [newMint()]: 1_000n })
  const keeper = makeKeeper(w, store)
  await keeper.tick() // scheduled, due at once
  await keeper.tick() // sampled; its turn records which epoch the window pays for
  const [, , slow, next, at, cut] = (await store.get('holdtime:schedule'))[mint]
  assert.deepEqual([slow, next, at, cut], [0, 0, T0, 0], 'the schedule summarises the window')
  const headerReads = () =>
    store.ops.filter(([op, key]) => op === 'get' && key === `holdtime:${mint}`).length

  // Ticks between samples: the coin runs each time but its header is not read.
  store.ops.length = 0
  for (let i = 0; i < 3; i++) {
    w.t += 120
    await keeper.tick()
  }
  assert.equal(w.scans.length, 1, 'no sample was due')
  assert.equal(headerReads(), 0)

  // An epoch the window has not accounted for (posted elsewhere) is read and settled again.
  w.coins.get(mint).epochCount = 1
  w.t += 120
  await keeper.tick()
  assert.equal(headerReads(), 1)
  assert.equal((await store.get('holdtime:schedule'))[mint][3], 1, 'the window now pays epoch 1')
})

test('coins without Entanglement are never scheduled or sampled, and cost no store reads', async () => {
  const w = world()
  const store = memoryStore()
  const [plain, entangled] = [newMint(), newMint()]
  w.register(plain, { entangleBps: 0 }, { [newMint()]: 1_000n })
  w.register(entangled, {}, { [newMint()]: 1_000n })
  const keeper = makeKeeper(w, store)
  for (let i = 0; i < 4; i++) {
    await keeper.tick()
    w.t += 600
  }
  const schedule = await store.get('holdtime:schedule')
  assert.deepEqual(Object.keys(schedule), [entangled])
  assert.ok(w.scans.every(([m]) => m === entangled))
  assert.ok(w.scans.length >= 2)
  assert.ok(!store.ops.some(([, key]) => key.startsWith(`holdtime:${plain}`)))

  // A coin that leaves the list leaves the schedule.
  w.list = w.list.filter((c) => c.mint !== entangled)
  w.t += HOUR
  await keeper.tick()
  assert.deepEqual(await store.get('holdtime:schedule'), {})
})

test('scans in flight end with the pass share, so the coins still run within the tick limit', async () => {
  const w = world()
  const store = memoryStore()
  const mints = Array.from({ length: 10 }, newMint)
  for (const mint of mints) w.register(mint, {}, { [newMint()]: 1_000n })
  const keeper = makeKeeper(w, store, { scanTimeoutMs: 2000 })
  await store.set('holdtime:schedule', Object.fromEntries(mints.map((m) => [m, [w.t - 1, 600]])))

  // A quarter of 2 s: the first three scans hang and are cut off there, and no more start.
  w.hangScans = true
  const started = Date.now()
  const result = await keeper.tick({ budget: 3, timeLimitMs: 2000 })
  const took = Date.now() - started
  assert.equal(result.ran, 3)
  assert.ok(took < 1500, `${took} ms`)
  assert.equal(w.scans.length, 3)
  const limits = w.logged.map((m) => /holder scan timed out after (\d+) ms/.exec(m)?.[1])
  const cut = limits.filter(Boolean).map(Number)
  assert.equal(cut.length, 3)
  assert.ok(
    cut.every((ms) => ms > 250 && ms <= 500),
    `cut off at ${cut} ms, not 2000`,
  )
  const schedule = await store.get('holdtime:schedule')
  for (const [m] of w.scans)
    assert.deepEqual(schedule[m].slice(0, 3), [w.t + 600, 600, 0], 'not marked slow')
})

test('a scan that takes the pass its whole limit leaves the coin to runCoin; another keeper samples nothing', async () => {
  const w = world()
  const store = memoryStore()
  const mints = Array.from({ length: 10 }, newMint)
  for (const mint of mints) w.register(mint, {}, { [newMint()]: 1_000n })
  const due = () => Object.fromEntries(mints.map((m) => [m, [w.t - 1, 600]]))
  const keeper = makeKeeper(w, store, { scanTimeoutMs: 30 })

  await store.set('holdtime:schedule', due())
  w.hangScans = true
  await keeper.tick({ budget: 0 })
  assert.ok(w.logged.some((m) => /holdtime .*holder scan timed out after 30 ms/.test(m)))
  assert.equal(w.scans.length, 10)
  const schedule = await store.get('holdtime:schedule')
  for (const m of mints) assert.deepEqual(schedule[m].slice(0, 3), [w.t + 600, 600, 1], 'slow')
  w.scans.length = 0
  w.t += 600
  await keeper.tick({ budget: 0 })
  assert.deepEqual(w.scans, [], 'the pass leaves slow coins alone')
  w.hangScans = false

  w.config.keeper = newMint() // this keeper could not post: nothing to sample for
  await store.set('holdtime:schedule', due())
  await keeper.tick({ budget: 0 })
  assert.deepEqual(w.scans, [])
})

test('a coin whose scan outlasts the pass limit is sampled by runCoin with a longer one, and posts', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  const a = newMint()
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [a]: 100_000n })
  const keeper = makeKeeper(w, store, { scanTimeoutMs: 30 })
  w.scanDelay = 40
  const alerts = []
  for (let t = T0; t <= T0 + 16 * HOUR; t += HOUR) {
    w.t = t
    alerts.push(...((await keeper.tick()).alerts || []))
  }
  assert.equal(w.logged.filter((m) => /holder scan timed out/.test(m)).length, 1, 'once')
  assert.equal((await store.get('holdtime:schedule'))[mint][2], 1, 'slow')
  assert.equal(w.calls.length, 1)
  const [row] = await keeper.epochs(mint)
  assert.deepEqual(row.window, { from: T0, to: T0 + 13 * HOUR, covered: 43_200 })
  assert.deepEqual(alerts, [])
})

test('an Entanglement coin with a reserve and no holder samples for 3 h is an alert', async () => {
  const w = world()
  const store = memoryStore()
  const mint = newMint()
  w.register(mint, { entangleReserve: 1_000_000_000n }, { [newMint()]: 100_000n })
  const keeper = makeKeeper(w, store, { scanTimeoutMs: 30, slowScanMs: 60 })
  const alerts = []
  for (let t = T0; t <= T0 + 5 * HOUR; t += HOUR) {
    w.t = t
    if (t === T0 + 3 * HOUR) w.hangScans = true // last sample at 2 h
    alerts.push([t, ((await keeper.tick()).alerts || []).map((a) => a.kind)])
  }
  assert.deepEqual(
    alerts.map(([t, kinds]) => [(t - T0) / HOUR, kinds]),
    [
      [0, []],
      [1, []],
      [2, []],
      [3, []],
      [4, []],
      [5, ['holdtime-stalled']],
    ],
  )
  assert.ok(
    w.logged.some((m) => /no holder sample since .*Entanglement cannot post without them/.test(m)),
  )
})

test('a web3.js Connection is scanned with one plain JSON-RPC request, aborted at the limit', async () => {
  const w = world()
  const store = memoryStore()
  const [mint, stuck] = [newMint(), newMint()]
  const [a, b] = [newMint(), newMint()]
  w.register(mint, {}, { [a]: 600_000n, [b]: 400_000n })
  w.register(stuck, {}, { [a]: 1n })
  const requests = []
  let aborted = 0
  const server = http.createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const { id, method, params } = JSON.parse(text)
    requests.push({ method, params })
    const owner = params[1].filters[0].memcmp.bytes
    if (owner === stuck) return res.on('close', () => aborted++) // never answers
    const result = [...w.holders.get(owner)].map(([holder, amount]) => {
      const data = Buffer.alloc(40)
      new PublicKey(holder).toBuffer().copy(data, 0)
      data.writeBigUInt64LE(amount, 32)
      const account = { data: [data.toString('base64'), 'base64'], lamports: 2_039_280 }
      return { pubkey: newMint(), account }
    })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const connection = new Connection(`http://127.0.0.1:${server.address().port}`, 'confirmed')
    // Everything else stays on the fake chain.
    for (const [name, fn] of Object.entries(w.connection)) connection[name] = fn
    connection.getProgramAccounts = () => assert.fail('web3.js getProgramAccounts is not used')
    connection.getBalance = undefined
    w.connection = connection
    const keeper = makeKeeper(w, store, { scanTimeoutMs: 200 })
    await store.set('holdtime:schedule', { [mint]: [w.t, 600], [stuck]: [w.t + 1, 600] })
    w.t += 1
    await keeper.tick({ budget: 0 })
    assert.equal(requests.length, 2)
    assert.deepEqual(
      requests.find((r) => r.params[1].filters[0].memcmp.bytes === mint),
      {
        method: 'getProgramAccounts',
        params: [
          network.token2022Program,
          {
            commitment: 'confirmed',
            filters: [{ memcmp: { offset: 0, bytes: mint } }],
            dataSlice: { offset: 32, length: 40 },
            encoding: 'base64',
          },
        ],
      },
    )
    assert.ok(w.logged.some((m) => m === `holdtime ${stuck}: holder scan timed out after 200 ms`))
    await sleep(50)
    assert.equal(aborted, 1, 'the request is aborted')

    w.t += 600
    await keeper.tick({ budget: 0 })
    const hold = createHoldtime({ store, now: w.now })
    const { weights } = await hold.weights(mint, await hold.load(mint))
    assert.deepEqual(
      Object.fromEntries(weights.map((e) => [e.wallet, e.weight])),
      { [a]: 600_000n * 600n, [b]: 400_000n * 600n },
      'the well is left out',
    )
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
