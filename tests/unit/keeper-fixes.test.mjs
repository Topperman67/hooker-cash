import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createKeeper, loadQuantumClient, quantumClientError } from '../../server/keeper.mjs'
import { createFileStore } from '../../server/storage.mjs'
import { buildEntanglementTree, verifyClaim } from '../../shared/merkle.mjs'
import { network } from '../../shared/network.mjs'

const PROGRAM = SystemProgram.programId // any program id works for fake PDAs
const DAY = 86400
const keeperKey = Keypair.generate()
const holders = [Keypair.generate().publicKey, Keypair.generate().publicKey]
const nowSecs = () => Math.floor(Date.now() / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const newMint = () => Keypair.generate().publicKey.toBase58()
// Coins in the order runCoin first read them (it reads each coin's state more than once).
const visited = (fetched) => fetched.filter((m, i) => fetched[i - 1] !== m)
const newStore = () => createFileStore(mkdtempSync(join(tmpdir(), 'qp-keeper-fix-')))
const TOKEN_2022 = new PublicKey(network.token2022Program)
const SPL_TOKEN = new PublicKey(network.tokenProgram)
// Token account slices as getProgramAccounts returns them: owner (32 bytes) + amount (u64 LE).
const tokenAccounts = (rows) =>
  rows.map(([owner, amount]) => {
    const data = Buffer.alloc(40)
    owner.toBuffer().copy(data, 0)
    data.writeBigUInt64LE(amount, 32)
    return { pubkey: Keypair.generate().publicKey, account: { data } }
  })
const wellPda = (mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('well'), new PublicKey(mint).toBuffer()],
    PROGRAM,
  )[0]
const epochPda = (mint, index) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from('epoch'),
      new PublicKey(mint).toBuffer(),
      Buffer.from(Uint32Array.of(index).buffer),
    ],
    PROGRAM,
  )[0]
const ix = () =>
  SystemProgram.transfer({
    fromPubkey: keeperKey.publicKey,
    toPubkey: keeperKey.publicKey,
    lamports: 1,
  })

// A small simulated chain. Builders queue an effect that applies when the transaction lands; an
// effect that throws makes the transaction fail on-chain.
function fakeChain() {
  const chain = {
    coins: new Map(), // mint -> Quantum state
    epochs: new Map(), // epoch PDA -> Epoch account
    statuses: new Map(),
    logs: new Map(),
    inflight: [], // sent but not landed: [signature, effect]
    height: 1000,
    heightStep: 0,
    land: true,
    statusError: null,
    statusFor: null,
    pending: 0n,
    unallocated: 0n,
    complete: false,
    hang: new Set(),
    delay: 0,
    next: null,
    calls: [],
    fetched: [],
    logged: [],
    treeBuilds: 0,
    list: [],
    holders: [
      [holders[0], 600n],
      [holders[1], 400n],
    ], // [owner, amount] pairs, or a function returning prebuilt accounts
    mintOwners: new Map(), // mint -> token program; Token-2022 when absent
    scans: [], // getProgramAccounts calls
    blind: false, // getMultipleAccountsInfo shows no accounts (a lagging RPC node)
  }
  chain.epoch = (mint, index) => chain.epochs.get(epochPda(mint, index).toBase58())
  chain.register = (mint, state = {}) => {
    chain.coins.set(mint, {
      burnReserve: 0n,
      entangleReserve: 0n,
      fusionReserve: 0n,
      epochCount: 0,
      lastBurnAt: 0,
      lastFusionAt: 0,
      ...state,
    })
    chain.list.push({ mint, quantum: true, external: false })
  }
  const apply = (signature, effect) => {
    try {
      chain.logs.set(signature, effect?.() || [])
      chain.statuses.set(signature, { confirmationStatus: 'confirmed', err: null })
    } catch (e) {
      chain.statuses.set(signature, { confirmationStatus: 'confirmed', err: { Custom: e.message } })
    }
  }
  chain.landInflight = () => apply(...chain.inflight.shift())

  chain.connection = {
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: chain.height + 150,
    }),
    getBlockHeight: async () => (chain.height += chain.heightStep),
    sendRawTransaction: async (raw) => {
      const signature = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0])
      const effect = chain.next
      chain.next = null
      if (chain.land) apply(signature, effect)
      else chain.inflight.push([signature, effect])
      return signature
    },
    getSignatureStatuses: async (signatures, options) => {
      if (chain.statusError) throw new Error(chain.statusError)
      return {
        value: signatures.map((s) =>
          chain.statusFor ? chain.statusFor(s, options) : (chain.statuses.get(s) ?? null),
        ),
      }
    },
    getTransaction: async (s) => ({ meta: { logMessages: chain.logs.get(s) } }),
    getMultipleAccountsInfo: async (keys) =>
      keys.map((k) => {
        const epoch = !chain.blind && chain.epochs.get(k.toBase58())
        return epoch ? { data: epoch } : null
      }),
    getAccountInfo: async (key) => ({
      owner: chain.mintOwners.get(key.toBase58()) ?? TOKEN_2022,
      data: Buffer.alloc(82),
    }),
    getProgramAccounts: async (program, config) => {
      chain.scans.push({ program: program.toBase58(), filters: config.filters })
      return typeof chain.holders === 'function' ? chain.holders() : tokenAccounts(chain.holders)
    },
  }

  chain.quantum = {
    wellPda,
    epochPda,
    decodeEpoch: (data) => data,
    // Mirrors shared/quantum.mjs: the mint account's owner, Token-2022 or SPL Token.
    mintTokenProgram: (info) => {
      for (const id of [TOKEN_2022, SPL_TOKEN]) if (info?.owner?.equals(id)) return id
      throw new Error(info ? 'Mint is not an SPL Token mint' : 'Mint account not found')
    },
    fetchQuantum: async (_c, mint) => {
      const id = mint.toBase58()
      chain.fetched.push(id)
      if (chain.hang.has(id)) return new Promise(() => {})
      if (chain.delay) await sleep(chain.delay)
      const state = chain.coins.get(id)
      return state ? { ...state } : null
    },
    fetchConfig: async () => ({ minActionInterval: 60, maxBurnLamports: 50_000_000n }),
    pendingCreatorFees: async () => chain.pending,
    fetchWellBalance: async () => ({ unallocated: chain.unallocated }),
    fetchEpoch: async (_c, mint, index) => chain.epoch(mint, index) ?? null,
    isLeafClaimed: (epoch, leafIndex) => epoch.claimed.has(leafIndex),
    decodeQuantumEvents: (logs) => logs || [],
    buildEntanglementTree: (entries) => {
      chain.treeBuilds++
      return buildEntanglementTree(entries)
    },
    buildPulseInstructions: async () => {
      chain.calls.push('pulse')
      return [ix()]
    },
    buildBurnInstructions: async ({ spendLamports }) => {
      chain.calls.push(`burn:${spendLamports}`)
      chain.next = () => {
        if (chain.failBurn) throw new Error('6500')
        return [
          {
            name: 'Burned',
            data: { venue: 0, spent: (spendLamports * 97n) / 100n, tokensBurned: 7_000n },
          },
        ]
      }
      return [ix()]
    },
    buildFusionInstructions: async ({ spendLamports }) => {
      chain.calls.push(`fusion:${spendLamports}`)
      chain.next = () => [
        {
          name: 'Fused',
          data: { spent: spendLamports - 1_234n, lpReceived: 55n, tokensBurned: 3n },
        },
      ]
      return [ix()]
    },
    buildPostEpochInstruction: async ({ mint, index, root, total, leafCount }) => {
      chain.calls.push(`epoch:${index}`)
      chain.next = () => {
        const state = chain.coins.get(mint.toBase58())
        if (index !== state.epochCount) throw new Error('ConstraintSeeds')
        const now = nowSecs()
        chain.epochs.set(epochPda(mint, index).toBase58(), {
          index,
          root: Uint8Array.from(root),
          total,
          leafCount,
          createdAt: now,
          expiresAt: now + 30 * DAY,
          payer: keeperKey.publicKey.toBase58(),
          claimed: new Set(),
        })
        state.epochCount++
        state.entangleReserve -= total
      }
      return ix()
    },
    buildCloseEpochInstruction: async ({ mint, index }) => {
      chain.calls.push(`close:${index}`)
      chain.next = () => {
        chain.epochs.delete(epochPda(mint, index).toBase58())
      }
      return ix()
    },
  }
  return chain
}

function makeKeeper(chain, store) {
  return createKeeper({
    connection: chain.connection,
    store,
    quantum: chain.quantum,
    keeper: keeperKey,
    indexer: {
      list: async () => chain.list,
      coin: async (mint) => ({ mint, complete: chain.complete }),
    },
    log: (m) => chain.logged.push(m),
    pollMs: 1,
  })
}

// Lets a day pass for the epoch pace, refills the reserve and ticks.
async function postNextEpoch(chain, store, keeper, mint, reserve = 100_000_000n) {
  const state = chain.coins.get(mint)
  state.entangleReserve = reserve
  if (state.epochCount > 0) chain.epoch(mint, state.epochCount - 1).createdAt -= 2 * DAY
  await store.set(`epoch:last:${mint}`, 0)
  await keeper.tick()
}

function assertValidClaim(item, wallet, root) {
  assert.ok(
    verifyClaim({
      leafIndex: item.leafIndex,
      wallet: wallet.toBase58(),
      amount: BigInt(item.amount),
      proof: item.proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex'))),
      root,
    }),
    `proof for epoch ${item.index}`,
  )
}

test('an epoch whose confirmation polling fails is reconciled from the chain and stays claimable', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)

  chain.statusError = '429 Too Many Requests' // the post lands, but every status read fails
  await keeper.tick()
  assert.equal(chain.coins.get(mint).epochCount, 1, 'the post landed')
  assert.ok(chain.logged.some((m) => /entangle .*not confirmed yet.*429/.test(m)))
  const pending = await store.get(`epoch:${mint}:0`)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.root, Buffer.from(chain.epoch(mint, 0).root).toString('hex'))
  assert.deepEqual(await store.get(`epochs:${mint}`), [0])
  // Leaves were stored before sending, so holders can claim even before reconciliation.
  const early = await keeper.claims(mint, holders[0].toBase58())
  assert.equal(early.length, 1)
  assertValidClaim(early[0], holders[0], chain.epoch(mint, 0).root)

  chain.statusError = null
  await keeper.tick()
  const posted = await store.get(`epoch:${mint}:0`)
  assert.equal(posted.status, 'posted')
  assert.equal(posted.postedAt, chain.epoch(mint, 0).createdAt)
  assert.equal(posted.expiresAt, chain.epoch(mint, 0).expiresAt)
  assert.equal(await store.get(`epoch:last:${mint}`), chain.epoch(mint, 0).createdAt)
  assert.deepEqual(
    chain.calls.filter((c) => c.startsWith('epoch:')),
    ['epoch:0'],
    'no second epoch from the leftover reserve',
  )
  assert.deepEqual(
    (await keeper.log(mint)).map((r) => r.action),
    ['entangle'],
  )
  const rows = await keeper.epochs(mint)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].holders, 2)
})

test('a post still in flight blocks new posts until it lands, then is marked posted', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)

  chain.land = false
  await keeper.tick({ timeLimitMs: 150 })
  assert.ok(chain.logged.some((m) => /entangle .*time limit/.test(m)))
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'pending')
  assert.deepEqual(await keeper.epochs(mint), [], 'pending epochs are not listed')

  chain.land = true
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0'], 'nothing is posted over a post that may land')

  chain.landInflight()
  await keeper.tick()
  assert.equal((await store.get(`epoch:${mint}:0`)).status, 'posted')
  assert.deepEqual(chain.calls, ['epoch:0'])
  assert.equal((await keeper.claims(mint, holders[1].toBase58()))[0].amount, '40000000')
})

test('a dropped post is discarded after its blockhash expires and the epoch is posted again', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)

  chain.land = false
  chain.heightStep = 100
  await keeper.tick()
  assert.ok(chain.logged.some((m) => /entangle .*expired before confirmation/.test(m)))
  const dropped = await store.get(`epoch:${mint}:0`)
  assert.equal(dropped.status, 'pending')

  // Just past expiry the post is kept: a lagging RPC node could still be hiding it.
  chain.inflight.length = 0
  chain.land = true
  chain.heightStep = 0
  chain.height = dropped.lastValidBlockHeight + 1
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0'])

  chain.height = dropped.lastValidBlockHeight + 1000
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'epoch:0'], 'the index is reused')
  assert.equal(chain.coins.get(mint).epochCount, 1)
  const posted = await store.get(`epoch:${mint}:0`)
  assert.equal(posted.status, 'posted')
  const [claim] = await keeper.claims(mint, holders[0].toBase58())
  assertValidClaim(claim, holders[0], chain.epoch(mint, 0).root)
  assert.deepEqual(
    (await keeper.log(mint)).map((r) => r.action),
    ['entangle'],
  )
})

test('send re-checks history before calling a processed transaction expired, and logs what a burn spent', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { burnReserve: 30_000_000n })
  const keeper = makeKeeper(chain, store)

  // The plain status read only ever shows "processed" while the height runs past expiry.
  chain.statusFor = (s, options) =>
    options?.searchTransactionHistory
      ? chain.statuses.get(s)
      : { confirmationStatus: 'processed', err: null }
  chain.heightStep = 1000
  await keeper.tick()
  assert.ok(!chain.logged.some((m) => /expired/.test(m)), chain.logged.join('\n'))
  const [burn] = await keeper.log(mint)
  assert.equal(burn.action, 'burn')
  assert.equal(burn.budget, '30000000')
  assert.equal(burn.spent, '29100000', 'the Burned event, not the budget')
  assert.equal(burn.tokensBurned, '7000')
})

test('fusion logs the Fused event, and a failed transaction is not retried as an RPC error', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { fusionReserve: 80_000_000n, burnReserve: 20_000_000n })
  chain.complete = true
  chain.failBurn = true
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  assert.ok(chain.logged.some((m) => /burn .*Keeper transaction failed.*6500/.test(m)))
  const rows = await keeper.log(mint)
  assert.deepEqual(
    rows.map((r) => r.action),
    ['fusion'],
  )
  assert.equal(rows[0].budget, '50000000')
  assert.equal(rows[0].spent, String(50_000_000 - 1_234))
  assert.equal(rows[0].lpReceived, '55')
})

test('claims skips claimed, expired and externally closed epochs, and builds no trees', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint)
  const keeper = makeKeeper(chain, store)
  for (let i = 0; i < 4; i++) await postNextEpoch(chain, store, keeper, mint)
  assert.equal(chain.coins.get(mint).epochCount, 4)

  chain.epoch(mint, 0).claimed.add(0) // holder 0 (the larger balance) claimed epoch 0
  chain.epoch(mint, 1).expiresAt = nowSecs() - 10 // expired, not closed yet
  chain.epochs.delete(epochPda(mint, 2).toBase58()) // closed by someone else

  const builds = chain.treeBuilds
  const first = await keeper.claims(mint, holders[0].toBase58())
  assert.deepEqual(
    first.map((c) => c.index),
    [3],
  )
  assert.equal(first[0].expiresAt, chain.epoch(mint, 3).expiresAt)
  assertValidClaim(first[0], holders[0], chain.epoch(mint, 3).root)
  const second = await keeper.claims(mint, holders[1].toBase58())
  assert.deepEqual(
    second.map((c) => c.index),
    [3, 0],
  )
  second.forEach((c) => assertValidClaim(c, holders[1], chain.epoch(mint, c.index).root))
  assert.equal(chain.treeBuilds, builds, 'proofs are stored at post time')
  assert.deepEqual(await keeper.claims(mint, Keypair.generate().publicKey.toBase58()), [])
})

test('the close pass closes expired epochs found on-chain and marks ones closed elsewhere', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint)
  const keeper = makeKeeper(chain, store)
  for (let i = 0; i < 4; i++) await postNextEpoch(chain, store, keeper, mint)
  const zero = await store.get(`epoch:${mint}:0`)

  chain.epoch(mint, 0).expiresAt = nowSecs() - 120
  chain.epoch(mint, 1).expiresAt = nowSecs() - 120
  // Epoch 2 expired too, and someone else closed it (close_epoch is permissionless).
  const two = await store.get(`epoch:${mint}:2`)
  await store.set(`epoch:${mint}:2`, { ...two, expiresAt: nowSecs() - 120 })
  chain.epochs.delete(epochPda(mint, 2).toBase58())
  await store.delete(`epoch:${mint}:1`) // its record was lost: the chain still says to close it
  chain.calls.length = 0
  await keeper.tick()
  assert.deepEqual(chain.calls, ['close:0', 'close:1'])
  assert.equal((await store.get(`epoch:${mint}:0`)).closed, true)
  assert.equal((await store.get(`epoch:${mint}:2`)).closed, true)
  assert.equal((await store.get(`epoch:${mint}:3`)).closed, undefined)
  assert.equal(await store.get(`epoch:floor:${mint}`), 3)
  assert.equal(
    await store.get(`epoch:leaves:${mint}:0:${zero.root.slice(0, 16)}:0`),
    null,
    'leaves of closed epochs are deleted',
  )
  const rows = await keeper.epochs(mint)
  assert.deepEqual(
    rows.map((r) => [r.index, r.closed]),
    [
      [3, false],
      [2, true],
      [0, true],
    ],
  )

  chain.calls.length = 0
  await keeper.tick()
  assert.deepEqual(chain.calls, [], 'the closed prefix is not scanned again')
  assert.ok(!chain.logged.some((m) => /close-epoch \S+( \d+)?: /.test(m)), chain.logged.join('\n'))
})

test('a lagging account read does not close a live epoch: it stays claimable and is closed after expiry', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint)
  const keeper = makeKeeper(chain, store)
  for (let i = 0; i < 2; i++) await postNextEpoch(chain, store, keeper, mint)
  const zero = await store.get(`epoch:${mint}:0`)
  const leavesKey = `epoch:leaves:${mint}:0:${zero.root.slice(0, 16)}:0`

  chain.blind = true // one tick where getMultipleAccountsInfo shows no Epoch accounts
  chain.calls.length = 0
  await keeper.tick()
  chain.blind = false
  assert.deepEqual(chain.calls, [])
  assert.deepEqual(await store.get(`epoch:${mint}:0`), zero, 'the record is untouched')
  assert.equal(await store.get(`epoch:floor:${mint}`), null, 'the floor stays')
  assert.ok(await store.get(leavesKey), 'the leaves are kept')
  assert.deepEqual(
    (await keeper.claims(mint, holders[0].toBase58())).map((c) => c.index),
    [1, 0],
  )

  chain.epoch(mint, 0).expiresAt = nowSecs() - 120
  await keeper.tick()
  assert.deepEqual(chain.calls, ['close:0'], 'the epoch is still closed once it expires')
  assert.equal((await store.get(`epoch:${mint}:0`)).closed, true)
  assert.equal(await store.get(`epoch:floor:${mint}`), 1)
  assert.equal(await store.get(leavesKey), null)
  assert.deepEqual(
    (await keeper.claims(mint, holders[0].toBase58())).map((c) => c.index),
    [1],
  )
})

test('a missing epoch with no usable record is passed only once a later epoch proves it expired', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint)
  const keeper = makeKeeper(chain, store)
  for (let i = 0; i < 3; i++) await postNextEpoch(chain, store, keeper, mint)
  // Epochs 0 and 1 are gone on-chain. The store lost epoch 0's record and holds epoch 1 as
  // pending: neither proves the epoch expired, so this may be a lagging node.
  for (const i of [0, 1]) chain.epochs.delete(epochPda(mint, i).toBase58())
  await store.delete(`epoch:${mint}:0`)
  const one = await store.get(`epoch:${mint}:1`)
  const pending = { ...one, status: 'pending' }
  await store.set(`epoch:${mint}:1`, pending)
  chain.calls.length = 0
  await keeper.tick()
  assert.deepEqual(chain.calls, [])
  assert.equal(await store.get(`epoch:floor:${mint}`), null)
  assert.deepEqual(await store.get(`epoch:${mint}:1`), pending)

  // Epoch 2 expiring proves 0 and 1 expired (and so were closed): the floor moves past them,
  // and the pending record is still left to reconcile().
  chain.epoch(mint, 2).expiresAt = nowSecs() - 120
  await keeper.tick()
  assert.deepEqual(chain.calls, ['close:2'])
  assert.equal(await store.get(`epoch:floor:${mint}`), 3)
  assert.deepEqual(await store.get(`epoch:${mint}:1`), pending, 'a pending record is never closed')
  assert.equal((await store.get(`epoch:${mint}:2`)).closed, true)
})

test('claims serves stored proofs for a holder in many full epochs without building a tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-keeper-fix-'))
  try {
    const chain = fakeChain()
    const files = createFileStore(dir)
    const reads = []
    const store = { ...files, get: (key) => (reads.push(key), files.get(key)) }
    store.release = files.release.bind(files)
    const wallets = []
    while (wallets.length < 16_384) {
      const bytes = randomBytes(32)
      if (PublicKey.isOnCurve(bytes)) wallets.push(new PublicKey(bytes))
    }
    const accounts = tokenAccounts(wallets.map((w, i) => [w, 100_000n + BigInt(i)]))
    chain.holders = () => accounts
    const mint = newMint()
    chain.register(mint)
    const keeper = makeKeeper(chain, store)
    // 5 full epochs: more leaves than the old 65,536-leaf tree cache held.
    for (let i = 0; i < 5; i++) await postNextEpoch(chain, store, keeper, mint, 4_000_000_000n)
    assert.equal(chain.coins.get(mint).epochCount, 5)
    const rec = await files.get(`epoch:${mint}:0`)
    assert.equal(rec.holders, 16_384)
    let largest = 0
    for (let b = 0; b < rec.buckets; b++) {
      const bucket = await files.get(`epoch:leaves:${mint}:0:${rec.root.slice(0, 16)}:${b}`)
      largest = Math.max(largest, JSON.stringify(bucket).length)
    }
    assert.ok(largest < 200_000, `buckets stay far under store value limits (${largest} bytes)`)

    const wallet = wallets[12_345]
    const builds = chain.treeBuilds
    for (let round = 0; round < 2; round++) {
      reads.length = 0
      const items = await keeper.claims(mint, wallet.toBase58())
      assert.deepEqual(
        items.map((c) => c.index),
        [4, 3, 2, 1, 0],
      )
      items.forEach((c) => assertValidClaim(c, wallet, chain.epoch(mint, c.index).root))
      assert.equal(
        reads.filter((k) => k.startsWith('epoch:leaves:')).length,
        5,
        'one bucket read per epoch',
      )
    }
    assert.equal(chain.treeBuilds, builds, 'no tree is built to serve claims')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the holder snapshot reads the mint's own token program, SPL Token included", async () => {
  const chain = fakeChain()
  const store = newStore()
  const [legacy, modern] = [newMint(), newMint()]
  chain.register(legacy, { entangleReserve: 100_000_000n })
  chain.register(modern, { entangleReserve: 100_000_000n })
  chain.mintOwners.set(legacy, SPL_TOKEN) // made with pump.fun's legacy `create`
  chain.holders = [[holders[0], 1_000n]] // a single holder: an empty proof
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  assert.deepEqual(chain.scans, [
    {
      program: network.tokenProgram,
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: legacy } }],
    },
    { program: network.token2022Program, filters: [{ memcmp: { offset: 0, bytes: modern } }] },
  ])
  assert.equal(chain.coins.get(legacy).epochCount, 1, 'the SPL Token coin gets its epoch')
  const [claim, ...rest] = await keeper.claims(legacy, holders[0].toBase58())
  assert.deepEqual(rest, [])
  assert.equal(claim.amount, '100000000')
  assert.deepEqual(claim.proof, [])
  assertValidClaim(claim, holders[0], chain.epoch(legacy, 0).root)
})

test('epochs() reads summaries only and the epoch list stays bounded', async () => {
  const chain = fakeChain()
  const files = newStore()
  const reads = []
  const store = { ...files, get: (key) => (reads.push(key), files.get(key)) }
  store.release = files.release.bind(files)
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n, epochCount: 64 })
  const list = []
  for (let i = 63; i >= 0; i--) {
    list.push(i)
    await files.set(`epoch:${mint}:${i}`, {
      index: i,
      root: 'ab'.repeat(32),
      total: '1',
      holders: 1,
      buckets: 1,
      status: 'posted',
      postedAt: 1,
      closed: true,
    })
  }
  await files.set(`epochs:${mint}`, list)
  await files.set(`epoch:floor:${mint}`, 64)
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  const kept = await files.get(`epochs:${mint}`)
  assert.equal(kept.length, 64)
  assert.equal(kept[0], 64)
  assert.equal(await files.get(`epoch:${mint}:0`), null, 'summaries past the history are deleted')

  reads.length = 0
  const rows = await keeper.epochs(mint)
  assert.equal(rows.length, 30)
  assert.equal(rows[0].index, 64)
  assert.ok(!reads.some((k) => k.startsWith('epoch:leaves:')))
})

test('claims and epochs reject malformed addresses with a 400', async () => {
  const chain = fakeChain()
  const keeper = makeKeeper(chain, newStore())
  const bad = '1'.repeat(44) // base58, but not 32 bytes
  for (const call of [
    () => keeper.claims(bad, holders[0].toBase58()),
    () => keeper.claims(newMint(), bad),
    () => keeper.claims(newMint(), undefined),
    () => keeper.epochs(bad),
  ])
    await assert.rejects(call, (e) => e.status === 400 && /Invalid .* address/.test(e.message))
})

test('the keeper services verified Quantum coins regardless of external, and unknown flags whose creator is the well', async () => {
  const chain = fakeChain()
  const [a, b, c, d, e] = [newMint(), newMint(), newMint(), newMint(), newMint()]
  for (const mint of [a, b, c]) chain.register(mint)
  chain.list = [
    { mint: a, quantum: true, external: true },
    { mint: b, quantum: null, external: true, creator: wellPda(b).toBase58() },
    { mint: c, quantum: false, external: false, creator: wellPda(c).toBase58() },
    { mint: d, quantum: null, external: false, creator: newMint() },
    { mint: e, quantum: null, external: false, creator: wellPda(e).toBase58() }, // not registered
  ]
  const keeper = makeKeeper(chain, newStore())
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 3 })
  assert.deepEqual(
    visited(chain.fetched),
    [a, b, e],
    'each candidate is confirmed with fetchQuantum',
  )
})

test('the cursor advances before each coin, so a coin that never finishes is passed over next tick', async () => {
  const chain = fakeChain()
  const store = newStore()
  const [a, b, c] = [newMint(), newMint(), newMint()]
  for (const mint of [a, b, c]) chain.register(mint)
  chain.hang.add(a) // e.g. killed at the platform's time limit while polling
  const keeper = makeKeeper(chain, store)
  keeper.tick()
  for (let i = 0; i < 200 && (await store.get('keeper:cursor')) !== 1; i++) await sleep(5)
  assert.equal(await store.get('keeper:cursor'), 1)
  assert.deepEqual(chain.fetched, [a])

  chain.hang.clear()
  await store.delete('keeper:lease') // the killed tick never released it; its TTL would
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 3 })
  assert.deepEqual(visited(chain.fetched.slice(1)), [b, c, a])
})

test('tick stops starting coins at its time limit', async () => {
  const chain = fakeChain()
  const store = newStore()
  const [a, b] = [newMint(), newMint()]
  for (const mint of [a, b]) chain.register(mint)
  chain.delay = 60
  const keeper = makeKeeper(chain, store)
  assert.deepEqual(await keeper.tick({ timeLimitMs: 30 }), { enabled: true, ran: 1 })
  assert.deepEqual(visited(chain.fetched), [a])
  assert.equal(await store.get('keeper:cursor'), 1)
})

test('free well lamports alone do not make the keeper pulse', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint)
  const keeper = makeKeeper(chain, store)
  chain.pending = 25_000_000n // all of it donated straight to the well
  chain.unallocated = 25_000_000n
  await keeper.tick()
  assert.deepEqual(chain.calls, [])
  chain.pending = 45_000_000n // 0.02 SOL of real creator fees on top
  await keeper.tick()
  assert.deepEqual(chain.calls, ['pulse'])
})

test('loadQuantumClient logs why the client failed to load', async () => {
  const reported = []
  const missing = Object.assign(new Error("Cannot find package '@pump-fun/pump-swap-sdk'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
  const client = await loadQuantumClient({
    load: async () => {
      throw missing
    },
    report: (...args) => reported.push(args.join(' ')),
  })
  assert.equal(client, null)
  assert.equal(reported.length, 1)
  assert.match(reported[0], /ERR_MODULE_NOT_FOUND/)
  assert.match(reported[0], /pump-swap-sdk/)
  assert.equal(quantumClientError, 'ERR_MODULE_NOT_FOUND')

  assert.deepEqual(await loadQuantumClient({ load: async () => ({ ok: 1 }) }), { ok: 1 })
  assert.equal(quantumClientError, null)
})
