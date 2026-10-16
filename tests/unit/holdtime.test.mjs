// Entanglement weights by holding time (server/holdtime.mjs): the min rule, the gap cap,
// generations, allocation and the bucketed storage.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import {
  MAX_STEP,
  allocate,
  bucketCount,
  bucketOf,
  createHoldtime,
  digest,
  touch,
  weight,
} from '../../server/holdtime.mjs'

const wallet = () => Keypair.generate().publicKey.toBase58()
const MINT = wallet()
const T0 = 1_800_000_000

// The keeper store's interface over a Map. Values go through JSON like the real stores, so a
// BigInt left in a record would throw here.
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
  }
}

// A holdtime instance on its own clock (unix seconds), sampling maps of wallet -> balance.
function setup(opts = {}, store = memoryStore()) {
  const clock = { t: T0 }
  const hold = createHoldtime({ store, now: () => clock.t * 1000, opts })
  let header = null
  const run = {
    store,
    clock,
    hold,
    get header() {
      return header
    },
    async sample(balances, after = 600) {
      if (header) clock.t += after
      header ??= await hold.load(MINT)
      const out = await hold.sample(MINT, header, new Map(Object.entries(balances)))
      header = out.header
      return out
    },
    async weights() {
      const out = await hold.weights(MINT, header)
      header = out.header
      return Object.fromEntries(out.weights.map((r) => [r.wallet, r.weight]))
    },
    async cut(index = 0, root = 'ab'.repeat(32)) {
      header = await hold.cut(MINT, header, { index, root })
    },
    async finalize() {
      header = await hold.finalize(MINT, header)
    },
    async settle(status) {
      header = await hold.settle(MINT, header, status)
    },
    reload: async () => (header = await hold.load(MINT)),
  }
  return run
}

test('a wallet holding the same balance earns balance x covered seconds', async () => {
  const run = setup()
  const a = wallet()
  await run.sample({ [a]: 500n })
  await run.sample({ [a]: 500n })
  await run.sample({ [a]: 500n })
  assert.equal(run.header.covered, 1200)
  assert.equal(run.header.since, T0)
  assert.equal(run.header.at, T0 + 1200)
  assert.deepEqual(await run.weights(), { [a]: 500n * 1200n })
})

test('a wallet that buys just before a sample and sells just after earns nothing', async () => {
  const run = setup()
  const [a, straddler] = [wallet(), wallet()]
  await run.sample({ [a]: 100n })
  await run.sample({ [a]: 100n, [straddler]: 1_000_000n })
  await run.sample({ [a]: 100n })
  assert.deepEqual(await run.weights(), { [a]: 100n * 1200n })
  // A record that holds nothing and earned nothing is not kept.
  const [, , slot] = run.header.meta[0]
  const bucket = await run.store.get(`holdtime:${MINT}:1:0:${slot}`)
  assert.deepEqual(Object.keys(bucket), [a])
})

test('an interval over which the balance changes credits the lesser balance', async () => {
  const run = setup()
  const a = wallet()
  await run.sample({ [a]: 100n })
  await run.sample({ [a]: 300n }) // bought: still 100 for the first interval
  await run.sample({ [a]: 50n }) // sold most: 50 for the second
  await run.sample({ [a]: 50n })
  assert.deepEqual(await run.weights(), { [a]: (100n + 50n + 50n) * 600n })
  // The same rule as a pure step.
  const rec = touch(null, 100n, { gen: 0, from: 0, to: 0 })
  const up = touch(rec, 300n, { gen: 0, from: 0, to: 600 })
  assert.deepEqual(up, ['300', '60000', 600, 0])
  assert.equal(weight(up, 0, 1200), 60_000n + 300n * 600n)
  assert.equal(touch(rec, 0n, { gen: 0, from: 0, to: 0 }), null, 'bought and sold at one sample')
})

test('a seller keeps its weight until the window is finalized, then its record is cleared', async () => {
  const run = setup()
  const [a, seller] = [wallet(), wallet()]
  await run.sample({ [a]: 100n, [seller]: 200n })
  await run.sample({ [a]: 100n, [seller]: 200n })
  await run.sample({ [a]: 100n }) // sold everything
  await run.sample({ [a]: 100n })
  assert.deepEqual(await run.weights(), { [a]: 100n * 1800n, [seller]: 200n * 600n })

  await run.cut()
  await assert.rejects(
    run.hold.sample(MINT, run.header, new Map([[a, 100n]])),
    /still posting/,
    'no sample while posting',
  )
  await run.finalize()
  assert.equal(run.header.gen, 1)
  assert.equal(run.header.covered, 0)
  assert.equal(run.header.since, T0 + 1800, 'the next window starts where this one ended')
  assert.equal(run.header.cut, null)
  // A window of one instant weighs balances; the seller has none.
  assert.deepEqual(await run.weights(), { [a]: 100n })
  await run.sample({ [a]: 150n }) // rewrites the bucket: the seller's old record goes
  assert.deepEqual(await run.weights(), { [a]: 100n * 600n })
  const [, , slot] = run.header.meta[0]
  const bucket = await run.store.get(`holdtime:${MINT}:1:0:${slot}`)
  assert.deepEqual(Object.keys(bucket), [a])
})

test('a gap between samples credits at most MAX_STEP, and a new generation starts from zero', async () => {
  const run = setup()
  const a = wallet()
  await run.sample({ [a]: 10n })
  await run.sample({ [a]: 10n }, 5 * 3600) // the keeper was down for five hours
  assert.equal(run.header.covered, MAX_STEP)
  assert.deepEqual(await run.weights(), { [a]: 10n * BigInt(MAX_STEP) })

  await run.cut()
  await run.finalize()
  await run.sample({ [a]: 10n }, 600)
  assert.equal(run.header.covered, 600)
  assert.deepEqual(await run.weights(), { [a]: 10n * 600n }, 'last window is not paid again')

  const capped = setup({ maxStep: 900 })
  await capped.sample({ [a]: 10n })
  await capped.sample({ [a]: 10n }, 1000)
  assert.equal(capped.header.covered, 900)
})

test('a dropped post leaves the window open, and a pending one keeps it cut', async () => {
  const run = setup()
  const a = wallet()
  await run.sample({ [a]: 10n })
  await run.sample({ [a]: 10n })
  await run.cut(3)
  assert.deepEqual(run.header.cut, {
    index: 3,
    root: 'ab'.repeat(32),
    gen: 0,
    at: T0 + 600,
    covered: 600,
  })
  await run.settle('pending')
  assert.equal(run.header.cut.index, 3)
  await run.settle('dropped')
  assert.equal(run.header.cut, null)
  assert.equal(run.header.gen, 0)
  await run.sample({ [a]: 10n })
  assert.deepEqual(await run.weights(), { [a]: 10n * 1200n }, 'the window goes on')
  await run.cut(3)
  await run.settle('posted')
  assert.equal(run.header.gen, 1)
  assert.equal(run.header.since, T0 + 1200)
  assert.equal(run.header.next, 4, 'the next window pays for the epoch after')

  // Epochs posted elsewhere paid for the window's time: it starts over at the last sample.
  await run.sample({ [a]: 10n })
  const restarted = await run.hold.restart(MINT, run.header, 7)
  assert.deepEqual(
    [restarted.gen, restarted.since, restarted.covered, restarted.next],
    [2, T0 + 1800, 0, 7],
  )
  assert.deepEqual(await run.store.get(`holdtime:${MINT}`), restarted)
})

test('a sample interrupted before its header write is safe to redo', async () => {
  const a = wallet()
  const control = setup()
  await control.sample({ [a]: 200n })
  await control.sample({ [a]: 200n }, 1200)

  // The sample in between wrote its bucket and failed on the header: as if it never happened.
  const files = memoryStore()
  const failing = { ...files, fail: false }
  failing.set = async (key, value, options) => {
    if (failing.fail && key === `holdtime:${MINT}`) throw Error('storage unavailable')
    return files.set(key, value, options)
  }
  const run = setup({}, failing)
  await run.sample({ [a]: 200n })
  failing.fail = true
  await assert.rejects(run.sample({ [a]: 50n }), /storage unavailable/)
  failing.fail = false
  run.clock.t = T0 + 1200
  await run.reload()
  assert.equal(run.header.at, T0)
  // Back at the first balance, so its bucket's digest matches and the bucket is not even read.
  await run.sample({ [a]: 200n }, 0)
  assert.deepEqual(await run.weights(), await control.weights())
  assert.deepEqual(await run.weights(), { [a]: 200n * 1200n })

  // Redone with the interrupted sample's own balances, it lands as one clean sample.
  await run.sample({ [a]: 50n })
  failing.fail = true
  await assert.rejects(run.sample({ [a]: 80n }))
  failing.fail = false
  await run.reload()
  await run.sample({ [a]: 80n }, 0)
  assert.deepEqual(await run.weights(), { [a]: 200n * 1200n + 50n * 600n + 50n * 600n })
})

test('allocate keeps the largest weights, breaks ties by wallet and leaves dust in the reserve', () => {
  const big = 1n << 70n // weights summing far above 2^64
  const rows = [
    { wallet: 'c', weight: big },
    { wallet: 'a', weight: big },
    { wallet: 'b', weight: big * 2n },
    { wallet: 'd', weight: 1n },
    { wallet: 'e', weight: 0n },
  ]
  const reserve = 1_000_000_007n
  // d's share rounds to nothing: no leaf.
  assert.deepEqual(allocate(rows, reserve), [
    { wallet: 'b', amount: (reserve * big * 2n) / (big * 4n + 1n) },
    { wallet: 'a', amount: (reserve * big) / (big * 4n + 1n) },
    { wallet: 'c', amount: (reserve * big) / (big * 4n + 1n) },
  ])
  // Capped to the top leaves, which then share the whole reserve.
  assert.deepEqual(allocate(rows, reserve, { maxLeaves: 2 }), [
    { wallet: 'b', amount: (reserve * 2n) / 3n },
    { wallet: 'a', amount: reserve / 3n },
  ])
  assert.deepEqual(
    allocate(rows, reserve, { minClaim: reserve / 4n + 1n }).map((e) => e.wallet),
    ['b'],
  )
  assert.deepEqual(allocate([{ wallet: 'a', weight: 0n }], reserve), [])
})

test('digests ignore order; the bucket count grows by powers of two', () => {
  const [a, b] = [wallet(), wallet()]
  const d = digest(
    new Map([
      [a, 1n],
      [b, 2n],
    ]),
  )
  assert.equal(
    d,
    digest([
      [b, 2n],
      [a, 1n],
    ]),
  )
  assert.notEqual(
    d,
    digest([
      [a, 1n],
      [b, 3n],
    ]),
  )
  assert.equal(digest([]), '')
  assert.deepEqual(
    [0, 256, 257, 512, 513, 40_000, 1e9].map((n) => bucketCount(n)),
    [1, 1, 2, 2, 4, 256, 256],
  )
  assert.equal(bucketOf(a, 1), 0)
  assert.ok(bucketOf(a, 8) >= 0 && bucketOf(a, 8) < 8)
})

test('records move to more buckets as holders grow, and keep their weight', async () => {
  const run = setup({ bucketTarget: 4, maxRecords: 64 })
  const first = Array.from({ length: 3 }, wallet)
  const balances = Object.fromEntries(first.map((w, i) => [w, BigInt(i + 1)]))
  await run.sample(balances)
  await run.sample(balances)
  assert.equal(run.header.buckets, 1)
  const old = `holdtime:${MINT}:1:0:${run.header.meta[0][2]}`
  assert.ok(run.store.data.has(old))

  const more = Array.from({ length: 17 }, wallet)
  for (const w of more) balances[w] = 7n
  await run.sample(balances)
  assert.equal(run.header.buckets, 8, '20 records at 4 a bucket')
  assert.equal(run.header.meta.length, 8)
  assert.equal(
    run.header.meta.reduce((n, m) => n + m[1], 0),
    20,
  )
  assert.ok(!run.store.data.has(old), 'the old bucket is deleted')
  const weights = await run.weights()
  first.forEach((w, i) => assert.equal(weights[w], BigInt(i + 1) * 1200n))
  for (const w of more) assert.equal(weights[w], undefined, 'new holders start at this sample')
  await run.sample(balances)
  for (const w of more) assert.equal((await run.weights())[w], 7n * 600n)
})

test('only buckets whose balances changed are read and written', async () => {
  const run = setup({ bucketTarget: 4 })
  const wallets = Array.from({ length: 30 }, wallet)
  const balances = Object.fromEntries(wallets.map((w) => [w, 1_000n]))
  await run.sample(balances)
  assert.equal(run.header.buckets, 8)
  const bucketOps = () => run.store.ops.filter(([, key]) => key.split(':').length === 5)

  // Nothing changed: no bucket is touched, and the header is the one write.
  run.store.ops.length = 0
  const idle = await run.sample(balances)
  assert.equal(idle.changed, false)
  assert.deepEqual(bucketOps(), [])
  assert.deepEqual(run.store.ops, [['set', `holdtime:${MINT}`]])

  // One wallet's balance moved: its bucket alone is read and written to its other slot.
  const moved = wallets[7]
  const n = bucketOf(moved, 8)
  const slot = run.header.meta[n][2]
  run.store.ops.length = 0
  const busy = await run.sample({ ...balances, [moved]: 10n })
  assert.equal(busy.changed, true)
  assert.deepEqual(bucketOps(), [
    ['get', `holdtime:${MINT}:8:${n}:${slot}`],
    ['set', `holdtime:${MINT}:8:${n}:${1 - slot}`],
  ])
  assert.equal(run.header.meta[n][2], 1 - slot)
})

test('owners that are not wallets are found once and left out', async () => {
  const checked = []
  const pda = PublicKey.findProgramAddressSync([Buffer.from('well')], SystemProgram.programId)[0]
  const run = setup({
    onCurve: (w) => (checked.push(w), PublicKey.isOnCurve(new PublicKey(w).toBytes())),
  })
  const a = wallet()
  await run.sample({ [a]: 5n, [pda.toBase58()]: 1_000_000n })
  assert.deepEqual(run.header.offCurve, [pda.toBase58()])
  assert.deepEqual(Object.keys(await run.weights()), [a])
  checked.length = 0
  // The keeper skips listed owners itself; known wallets are not checked again.
  await run.sample({ [a]: 6n })
  assert.deepEqual(checked, [])
  assert.ok(!(await run.weights())[pda.toBase58()])
})

test('dust wallets ground into one bucket cannot push out a seller that earned weight', async () => {
  // 32 records at most, 4 a bucket (8 buckets). Before, each bucket kept 4 and dropped sellers.
  const run = setup({ bucketTarget: 4, maxRecords: 32, onCurve: () => true })
  const honest = Array.from({ length: 6 }, wallet)
  const [whale, attacker] = [wallet(), wallet()]
  const balances = Object.fromEntries(honest.map((w) => [w, 1_000n]))
  Object.assign(balances, { [whale]: 600_000n, [attacker]: 200_000n })
  for (let i = 0; i < 10; i++) await run.sample(balances)
  balances[whale] = 0n // sells an hour before the post
  await run.sample(balances)
  const before = await run.weights()
  assert.equal(before[whale], 600_000n * 5400n)

  // 40 wallets of 1 base unit in the whale's bucket at the count they bring about, plus a large
  // holder arriving there in the same sample.
  const target = bucketOf(whale, 8)
  const ground = []
  while (ground.length < 41) {
    const w = wallet()
    if (bucketOf(w, 8) === target) ground.push(w)
  }
  const newcomer = ground.pop()
  for (const w of ground) balances[w] = 1n
  balances[newcomer] = 500_000n
  await run.sample(balances)
  assert.equal(run.header.buckets, 8)
  assert.ok(run.header.meta.reduce((n, m) => n + m[1], 0) <= 32)
  const after = await run.weights()
  assert.equal(after[whale], before[whale], 'the seller keeps its weight')
  assert.equal(after[attacker], 200_000n * 6600n)
  for (const w of honest) assert.equal(after[w], 1_000n * 6600n)
  await run.sample(balances)
  assert.equal((await run.weights())[newcomer], 500_000n * 600n, 'outranks the dust')
})

test('past MAX_RECORDS the records worth least go, in any bucket, and new holders get back in', async () => {
  // 16 records at most (14 kept when over), 4 buckets.
  const run = setup({ bucketTarget: 4, maxRecords: 16, onCurve: () => true })
  const holders = Array.from({ length: 14 }, wallet)
  const small = wallet()
  const balances = Object.fromEntries(holders.map((w) => [w, 1_000n]))
  balances[small] = 1n
  for (let i = 0; i < 3; i++) await run.sample(balances)
  balances[small] = 0n // a seller with a little weight
  await run.sample(balances)
  assert.equal(run.header.buckets, 4)
  const n = bucketOf(small, 4)
  const [digestBefore, records, slot] = run.header.meta[n]

  // Two holders arrive in other buckets: 17 records, so 3 go, the seller's from a bucket this
  // sample did not change.
  const newcomers = []
  while (newcomers.length < 2) {
    const w = wallet()
    if (bucketOf(w, 4) !== n) newcomers.push(w)
  }
  for (const w of newcomers) balances[w] = 1_000n
  run.store.ops.length = 0
  await run.sample(balances)
  assert.equal(
    run.header.meta.reduce((sum, m) => sum + m[1], 0),
    14,
  )
  assert.deepEqual(run.header.meta[n].slice(0, 3), [digestBefore, records - 1, 1 - slot])
  assert.ok(
    run.store.ops.some(([op, key]) => op === 'get' && key === `holdtime:${MINT}:4:${n}:${slot}`),
  )
  const weights = await run.weights()
  assert.equal(weights[small], undefined)
  for (const w of holders) assert.equal(weights[w], 1_000n * 2400n)

  // Their buckets read as changed, so the next sample takes the newcomers back.
  await run.sample(balances)
  await run.sample(balances)
  const later = await run.weights()
  for (const w of newcomers) assert.equal(later[w], 1_000n * 600n)
})

test('a bucket the store lost is built again from the next sample', async () => {
  const run = setup()
  const [a, b] = [wallet(), wallet()]
  await run.sample({ [a]: 100n, [b]: 100n })
  await run.sample({ [a]: 100n, [b]: 100n })
  const [, , slot] = run.header.meta[0]
  run.store.data.delete(`holdtime:${MINT}:1:0:${slot}`)
  assert.deepEqual(await run.weights(), {})
  assert.deepEqual(run.header.meta[0].slice(0, 2), ['', 0], 'marked to be built again')
  assert.deepEqual((await run.store.get(`holdtime:${MINT}`)).meta, run.header.meta)

  // Unchanged balances, yet the bucket is written again; its wallets earn from here.
  await run.sample({ [a]: 100n, [b]: 100n })
  assert.equal(run.header.meta[0][1], 2)
  await run.sample({ [a]: 100n, [b]: 100n })
  assert.deepEqual(await run.weights(), { [a]: 100n * 600n, [b]: 100n * 600n })
})

test('only the largest balances are followed', async () => {
  const run = setup({ maxTracked: 2 })
  const [a, b, c] = [wallet(), wallet(), wallet()]
  await run.sample({ [a]: 3n, [b]: 2n, [c]: 1n })
  await run.sample({ [a]: 3n, [b]: 2n, [c]: 1n })
  assert.deepEqual(await run.weights(), { [a]: 1800n, [b]: 1200n })
})
