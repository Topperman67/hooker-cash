// Keeper against the K1 program: claim delay (claimStart), cancel_epoch and the minimum interval
// between a coin's epochs (Quantum.last_epoch_at).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createKeeper } from '../../server/keeper.mjs'
import { createFileStore } from '../../server/storage.mjs'
import { buildEntanglementTree, verifyClaim } from '../../shared/merkle.mjs'
import { network } from '../../shared/network.mjs'

const PROGRAM = Keypair.generate().publicKey // the fake Quantum Hooks program id
const HOUR = 3600
const DAY = 86400
const keeperKey = Keypair.generate()
const holders = [Keypair.generate().publicKey, Keypair.generate().publicKey]
const TOKEN_2022 = new PublicKey(network.token2022Program)
const nowSecs = () => Math.floor(Date.now() / 1000)
const newMint = () => Keypair.generate().publicKey.toBase58()
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

function newStore() {
  const files = createFileStore(mkdtempSync(join(tmpdir(), 'qp-keeper-r2-')))
  const reads = []
  const store = { ...files, get: (key) => (reads.push(key), files.get(key)) }
  store.release = files.release.bind(files)
  store.reads = reads
  return store
}

// A small simulated chain that keeps each address's signature history, so a cancel can be
// proven from its EpochCancelled event. `minInterval` is what the program enforces;
// `exportInterval` is what the client exports as MIN_EPOCH_INTERVAL (none when undefined).
// Epoch accounts are owned by PROGRAM, which the client exports as QUANTUM_PROGRAM_ID unless
// `exportProgramId` is false. Like Anchor's coder, decodeEpoch throws on data that is not an
// Epoch, such as the empty data of a system-owned account.
function fakeChain({ minInterval = 20 * HOUR, exportInterval, exportProgramId = true } = {}) {
  const chain = {
    coins: new Map(),
    epochs: new Map(), // epoch PDA -> Epoch account
    funded: new Map(), // address -> lamports of a system-owned account with no data
    statuses: new Map(),
    txs: new Map(), // signature -> getTransaction result
    history: new Map(), // address -> [{ signature, err, blockTime }], newest first
    next: null,
    calls: [],
    logged: [],
    scans: 0,
    lookups: 0,
    list: [],
    blind: false, // getMultipleAccountsInfo shows no accounts (a lagging RPC node)
    statusError: null,
    failEpochReads: false, // getMultipleAccountsInfo fails (rate limited)
    balance: null, // the keeper wallet's lamports; null = getBalance fails
    minInterval,
    config: {
      keeper: keeperKey.publicKey.toBase58(),
      claimDelay: 6 * HOUR,
      minActionInterval: 60,
      maxBurnLamports: 50_000_000n,
      version: 1n,
    },
  }
  const touch = (address, signature, err = null, blockTime = nowSecs()) =>
    chain.history.set(address, [
      { signature, err, blockTime },
      ...(chain.history.get(address) || []),
    ])
  chain.epoch = (mint, index) => chain.epochs.get(epochPda(mint, index).toBase58())
  // What getAccountInfo / getMultipleAccountsInfo return for an address.
  chain.accountInfo = (address) => {
    const epoch = chain.epochs.get(address)
    if (epoch) return { owner: PROGRAM, lamports: 2_039_280, data: epoch }
    const lamports = chain.funded.get(address)
    if (lamports) return { owner: SystemProgram.programId, lamports, data: Buffer.alloc(0) }
    return null
  }
  // Anyone sends lamports to an epoch's address once its account is gone: each transfer is a
  // successful transaction there and leaves a system-owned account with no data.
  chain.fund = (mint, index, { times = 1, blockTime = nowSecs() } = {}) => {
    const address = epochPda(mint, index).toBase58()
    assert.ok(!chain.epochs.has(address), 'funds a closed address')
    for (let n = 0; n < times; n++) {
      chain.funded.set(address, (chain.funded.get(address) || 0) + 1_000_000)
      const signature = bs58.encode(randomBytes(64))
      chain.txs.set(signature, { meta: { err: null, logMessages: [] } })
      touch(address, signature, null, blockTime)
    }
  }
  // An epoch posted with the keeper key by someone else (no record in the keeper's store).
  chain.inject = (mint, { claimStart } = {}) => {
    const state = chain.coins.get(mint)
    const index = state.epochCount
    const now = nowSecs()
    const total = 90_000_000n
    chain.epochs.set(epochPda(mint, index).toBase58(), {
      index,
      root: Uint8Array.from(randomBytes(32)),
      total,
      leafCount: 1,
      createdAt: now,
      claimStart: claimStart ?? now + chain.config.claimDelay,
      expiresAt: now + 30 * DAY,
      payer: keeperKey.publicKey.toBase58(),
      claimed: new Set(),
    })
    state.epochCount++
    state.entangleReserve -= total
    state.lastEpochAt = now
    return index
  }
  chain.register = (mint, state = {}) => {
    chain.coins.set(mint, {
      burnReserve: 0n,
      entangleReserve: 0n,
      fusionReserve: 0n,
      epochCount: 0,
      lastBurnAt: 0,
      lastFusionAt: 0,
      lastEpochAt: 0,
      ...state,
    })
    chain.list.push({ mint, quantum: true, external: false })
  }
  // The authority's cancel_epoch: SOL back to the reserve, account closed, event emitted.
  chain.cancel = (mint, index, { blockTime } = {}) => {
    const address = epochPda(mint, index).toBase58()
    const epoch = chain.epochs.get(address)
    chain.epochs.delete(address)
    chain.coins.get(mint).entangleReserve += epoch.total
    const signature = bs58.encode(randomBytes(64))
    chain.txs.set(signature, {
      meta: {
        err: null,
        logMessages: [{ name: 'EpochCancelled', data: { mint, index, returned: epoch.total } }],
      },
    })
    touch(address, signature, null, blockTime)
    return signature
  }
  // Lets a post through the pace checks: the last one is moved a day and more into the past.
  chain.age = async (store, mint) => {
    const state = chain.coins.get(mint)
    state.lastEpochAt -= 2 * DAY
    for (let i = 0; i < state.epochCount; i++) {
      const epoch = chain.epoch(mint, i)
      if (epoch) epoch.createdAt -= 2 * DAY
    }
    await store.set(`epoch:last:${mint}`, 0)
  }

  chain.connection = {
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1150,
    }),
    getBlockHeight: async () => 1000,
    sendRawTransaction: async (raw) => {
      const signature = bs58.encode(VersionedTransaction.deserialize(raw).signatures[0])
      const effect = chain.next
      chain.next = null
      try {
        const logMessages = effect?.(signature) || []
        chain.txs.set(signature, { meta: { err: null, logMessages } })
        chain.statuses.set(signature, { confirmationStatus: 'confirmed', err: null })
      } catch (e) {
        chain.statuses.set(signature, {
          confirmationStatus: 'confirmed',
          err: { Custom: e.message },
        })
      }
      return signature
    },
    getSignatureStatuses: async (signatures) => {
      if (chain.statusError) throw new Error(chain.statusError)
      return { value: signatures.map((s) => chain.statuses.get(s) ?? null) }
    },
    getTransaction: async (signature) => chain.txs.get(signature) ?? null,
    getSignaturesForAddress: async (address, options) => {
      chain.lookups++
      return (chain.history.get(address.toBase58()) || []).slice(0, options?.limit ?? 1000)
    },
    getMultipleAccountsInfo: async (keys) => {
      if (chain.failEpochReads) throw new Error('429 Too Many Requests')
      return keys.map((k) => (chain.blind ? null : chain.accountInfo(k.toBase58())))
    },
    // Epoch addresses as on chain; anything else is the coin's Token-2022 mint.
    getAccountInfo: async (k) =>
      chain.epochs.has(k.toBase58()) || chain.funded.has(k.toBase58())
        ? chain.accountInfo(k.toBase58())
        : { owner: TOKEN_2022, data: Buffer.alloc(82) },
    getBalance: async (k) => {
      assert.equal(k.toBase58(), keeperKey.publicKey.toBase58())
      if (chain.balance == null) throw new Error('getBalance failed')
      return chain.balance
    },
    getProgramAccounts: async () => {
      chain.scans++
      return [
        [holders[0], 600n],
        [holders[1], 400n],
      ].map(([owner, amount]) => {
        const data = Buffer.alloc(40)
        owner.toBuffer().copy(data, 0)
        data.writeBigUInt64LE(amount, 32)
        return { pubkey: Keypair.generate().publicKey, account: { data } }
      })
    },
  }

  const decodeEpoch = (data) => {
    if (Buffer.isBuffer(data)) throw new Error('Invalid account discriminator')
    return data
  }
  chain.quantum = {
    ...(exportInterval === undefined ? {} : { MIN_EPOCH_INTERVAL: exportInterval }),
    ...(exportProgramId ? { QUANTUM_PROGRAM_ID: PROGRAM } : {}),
    wellPda,
    epochPda,
    decodeEpoch,
    mintTokenProgram: () => TOKEN_2022,
    fetchQuantum: async (_c, mint) => {
      const state = chain.coins.get(mint.toBase58())
      return state ? { ...state } : null
    },
    fetchConfig: async () => chain.config && { ...chain.config },
    pendingCreatorFees: async () => 0n,
    fetchWellBalance: async () => ({ unallocated: 0n }),
    // Like shared/quantum.mjs: decodes whatever is at the address, so a funded one throws.
    fetchEpoch: async (_c, mint, index) => {
      const info = chain.accountInfo(epochPda(mint, index).toBase58())
      return info ? decodeEpoch(info.data) : null
    },
    isLeafClaimed: (epoch, leafIndex) => epoch.claimed.has(leafIndex),
    decodeQuantumEvents: (logs) => logs || [],
    buildEntanglementTree,
    buildPostEpochInstruction: async ({ mint, index, root, total, leafCount }) => {
      chain.calls.push(`epoch:${index}`)
      chain.next = (signature) => {
        const state = chain.coins.get(mint.toBase58())
        if (index !== state.epochCount) throw new Error('ConstraintSeeds')
        const now = nowSecs()
        if (now < state.lastEpochAt + chain.minInterval) throw new Error('EpochTooSoon')
        if (chain.config.keeper !== keeperKey.publicKey.toBase58()) throw new Error('KeeperOnly')
        const address = epochPda(mint, index).toBase58()
        chain.epochs.set(address, {
          index,
          root: Uint8Array.from(root),
          total,
          leafCount,
          createdAt: now,
          claimStart: now + chain.config.claimDelay,
          expiresAt: now + 30 * DAY,
          payer: keeperKey.publicKey.toBase58(),
          claimed: new Set(),
        })
        touch(address, signature)
        state.epochCount++
        state.entangleReserve -= total
        state.lastEpochAt = now
        return [{ name: 'EpochPosted', data: { mint: mint.toBase58(), index } }]
      }
      return ix()
    },
    buildCloseEpochInstruction: async ({ mint, index }) => {
      chain.calls.push(`close:${index}`)
      chain.next = (signature) => {
        const address = epochPda(mint, index).toBase58()
        if (!chain.epochs.delete(address)) throw new Error('AccountNotInitialized')
        touch(address, signature)
        return [{ name: 'EpochClosed', data: { mint: mint.toBase58(), index } }]
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
      coin: async (mint) => ({ mint, complete: false }),
    },
    log: (m) => chain.logged.push(m),
    pollMs: 1,
    // One sample is a window: these tests are about posting, not holding time.
    holdtime: { minCovered: 0 },
  })
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

const leavesKey = (mint, rec) => `epoch:leaves:${mint}:${rec.index}:${rec.root.slice(0, 16)}:0`

test('claims are offered only once claimStart has passed, and both read APIs report it', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0'])
  const onchain = chain.epoch(mint, 0)
  const [row] = await keeper.epochs(mint)
  assert.equal(row.claimStart, onchain.claimStart)
  assert.equal(row.cancelled, false)
  assert.ok(row.claimStart >= nowSecs() + 6 * HOUR - 5)

  store.reads.length = 0
  assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])
  assert.ok(
    !store.reads.some((k) => k.startsWith('epoch:leaves:')),
    'no bucket is read for an epoch whose claims are not open',
  )

  // The store says open but the chain's clock may trail by a little: still nothing.
  const rec = await store.get(`epoch:${mint}:0`)
  await store.set(`epoch:${mint}:0`, { ...rec, claimStart: nowSecs() - 60 })
  onchain.claimStart = nowSecs() - 5
  assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])

  onchain.claimStart = nowSecs() - 60
  const [claim, ...rest] = await keeper.claims(mint, holders[0].toBase58())
  assert.deepEqual(rest, [])
  assert.equal(claim.claimStart, onchain.claimStart)
  assert.equal(claim.expiresAt, onchain.expiresAt)
  assert.equal(claim.amount, '60000000')
  assertValidClaim(claim, holders[0], onchain.root)
})

test('a post whose Epoch account cannot be read stores a claimStart that is never early', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  chain.failEpochReads = true
  await keeper.tick()
  chain.failEpochReads = false
  const rec = await store.get(`epoch:${mint}:0`)
  assert.equal(rec.status, 'posted')
  assert.equal(rec.claimStart, rec.postedAt + 6 * HOUR, 'estimated from the config claim delay')
  assert.ok(rec.claimStart >= chain.epoch(mint, 0).claimStart)
  assert.equal((await keeper.epochs(mint))[0].claimStart, rec.claimStart)
})

test('posting waits out the on-chain minimum interval, even after a post the store never saw', async () => {
  // The client exports a 30 h interval: the keeper paces by it, past its own 24 h.
  const chain = fakeChain({ minInterval: 30 * HOUR, exportInterval: 30 * HOUR })
  const store = newStore()
  const mint = newMint()
  // Epoch 0 was posted and then cancelled: no account and no record, only last_epoch_at.
  chain.register(mint, {
    entangleReserve: 100_000_000n,
    epochCount: 1,
    lastEpochAt: nowSecs() - 25 * HOUR,
  })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  assert.deepEqual(chain.calls, [])
  assert.equal(chain.scans, 0, 'no holder snapshot for a post that would fail')
  assert.equal(await store.get(`epochs:${mint}`), null, 'no pending record or leaves')

  chain.coins.get(mint).lastEpochAt = nowSecs() - 30 * HOUR // the chain's clock may trail
  await keeper.tick()
  assert.deepEqual(chain.calls, [])

  chain.coins.get(mint).lastEpochAt = nowSecs() - 30 * HOUR - 60
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:1'])
  assert.equal((await store.get(`epoch:${mint}:1`)).status, 'posted')
  assert.ok(!chain.logged.some((m) => /EpochTooSoon/.test(m)), chain.logged.join('\n'))
})

test('without an exported interval the keeper keeps its 24 h pace from last_epoch_at', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, {
    entangleReserve: 100_000_000n,
    epochCount: 1,
    lastEpochAt: nowSecs() - 21 * HOUR, // past the program's 20 h, inside the keeper's pace
  })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  assert.deepEqual(chain.calls, [])
  chain.coins.get(mint).lastEpochAt = nowSecs() - 24 * HOUR - 1
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:1'])
})

test('a keeper key that is not config.keeper does not pay for a post', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  chain.config.keeper = Keypair.generate().publicKey.toBase58() // rotated by the authority
  await keeper.tick()
  chain.config = null // config unreadable
  await keeper.tick()
  assert.deepEqual(chain.calls, [])
  assert.equal(chain.scans, 0)
  chain.config = {
    keeper: keeperKey.publicKey.toBase58(),
    claimDelay: 6 * HOUR,
    minActionInterval: 60,
    maxBurnLamports: 50_000_000n,
  }
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0'])
})

test('a cancelled epoch is settled on proof: closed as cancelled, leaves deleted, never offered', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  const rec = await store.get(`epoch:${mint}:0`)
  assert.ok(await store.get(leavesKey(mint, rec)))

  // A node that shows no accounts is no proof: the post is the only transaction on the address.
  chain.blind = true
  await keeper.tick()
  chain.blind = false
  assert.ok(chain.lookups >= 1, 'the cancel was looked for')
  assert.deepEqual(await store.get(`epoch:${mint}:0`), rec)
  assert.ok(await store.get(leavesKey(mint, rec)), 'the leaves are kept')
  assert.equal(await store.get(`epoch:floor:${mint}`), null)

  const signature = chain.cancel(mint, 0)
  chain.calls.length = 0
  await keeper.tick()
  const settled = await store.get(`epoch:${mint}:0`)
  assert.equal(settled.closed, true)
  assert.equal(settled.cancelled, true)
  assert.equal(await store.get(leavesKey(mint, rec)), null, 'its leaves are deleted')
  assert.equal(await store.get(`epoch:floor:${mint}`), 1, 'the floor passes it')
  assert.deepEqual(
    (await keeper.epochs(mint)).map((r) => [r.index, r.closed, r.cancelled]),
    [[0, true, true]],
  )
  const [entry] = await keeper.log(mint)
  assert.equal(entry.action, 'cancel-epoch')
  assert.equal(entry.signature, signature)
  assert.equal(entry.index, 0)
  assert.deepEqual(chain.calls, [], 'no close and no re-post inside the interval')
  assert.equal(chain.coins.get(mint).entangleReserve, 100_000_000n, 'the reserve is back')

  // Even past its claimStart nothing is offered, and the settled cancel is not looked up again.
  await store.set(`epoch:${mint}:0`, { ...settled, claimStart: nowSecs() - HOUR })
  assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])
  chain.lookups = 0
  await keeper.tick()
  assert.equal(chain.lookups, 0)
  assert.equal(
    (await keeper.log(mint)).filter((r) => r.action === 'cancel-epoch').length,
    1,
    'logged once',
  )
  assert.deepEqual(chain.calls, [])
})

test('a cancelled epoch after a live one is settled at once, and the floor passes it later', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  await chain.age(store, mint)
  chain.coins.get(mint).entangleReserve = 100_000_000n
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'epoch:1'])

  chain.cancel(mint, 1)
  await keeper.tick()
  assert.equal((await store.get(`epoch:${mint}:1`)).cancelled, true, 'settled behind a live epoch')
  assert.equal(await store.get(`epoch:floor:${mint}`), null, 'epoch 0 is still open')

  chain.epoch(mint, 0).expiresAt = nowSecs() - 120
  chain.calls.length = 0
  await keeper.tick()
  assert.deepEqual(chain.calls, ['close:0'])
  assert.equal((await store.get(`epoch:${mint}:0`)).closed, true)
  assert.equal(await store.get(`epoch:floor:${mint}`), 2, 'past the cancelled epoch too')
})

test('a post that landed and was cancelled before it was reconciled is dropped', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  chain.statusError = '429 Too Many Requests' // the post lands, but its status is never read
  await keeper.tick()
  chain.statusError = null
  const pending = await store.get(`epoch:${mint}:0`)
  assert.equal(pending.status, 'pending')
  const signature = chain.cancel(mint, 0)

  chain.lookups = 0
  await keeper.tick() // too fresh to judge: a lagging node may hide a new account
  assert.equal(chain.lookups, 0)
  assert.deepEqual(await store.get(`epoch:${mint}:0`), pending)

  await store.set(`epoch:${mint}:0`, { ...pending, createdAt: nowSecs() - 600 })
  await keeper.tick()
  assert.equal(await store.get(`epoch:${mint}:0`), null)
  assert.deepEqual(await store.get(`epochs:${mint}`), [])
  assert.equal(await store.get(leavesKey(mint, pending)), null)
  assert.deepEqual(
    (await keeper.log(mint)).map((r) => [r.action, r.signature]),
    [['cancel-epoch', signature]],
  )
  assert.deepEqual(chain.calls, ['epoch:0'], 'last_epoch_at holds the next post back')

  chain.coins.get(mint).lastEpochAt -= 2 * DAY
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'epoch:1'])
  assert.equal((await store.get(`epoch:${mint}:1`)).status, 'posted')
})

// ---- accounts at a closed epoch's address (QH-2 re-check) ------------------------------------

// Error lines look like `<action> <mint>[ <index>]: <message>`; records are `<action> <mint> <sig>`.
const errorsIn = (chain) => chain.logged.filter((m) => m.includes(': '))

for (const exportProgramId of [true, false]) {
  const how = exportProgramId ? 'by owner' : 'by its data'
  test(`lamports sent to a cancelled epoch's address read as no epoch (${how}): the cancel settles, claims and posting go on`, async () => {
    const chain = fakeChain({ exportProgramId })
    const store = newStore()
    const mint = newMint()
    chain.register(mint, { entangleReserve: 100_000_000n })
    const keeper = makeKeeper(chain, store)
    await keeper.tick()
    const rec = await store.get(`epoch:${mint}:0`)
    const signature = chain.cancel(mint, 0, { blockTime: nowSecs() - 120 })
    // Production timing: claims were due a minute ago and the window has 29 days left.
    await store.set(`epoch:${mint}:0`, {
      ...rec,
      claimStart: nowSecs() - 60,
      expiresAt: nowSecs() + 29 * DAY,
    })
    // Anyone funds the closed address, more often than the keeper reads transactions there.
    chain.fund(mint, 0, { times: 8 })
    await assert.rejects(chain.quantum.fetchEpoch(null, new PublicKey(mint), 0), /discriminator/)

    assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])
    assert.deepEqual(await keeper.claims(mint, holders[1].toBase58()), [])

    chain.calls.length = 0
    assert.deepEqual(await keeper.tick(), { enabled: true, ran: 1 })
    const settled = await store.get(`epoch:${mint}:0`)
    assert.equal(settled.closed, true)
    assert.equal(settled.cancelled, true)
    assert.equal(await store.get(leavesKey(mint, rec)), null, 'its leaves are deleted')
    assert.equal(await store.get(`epoch:floor:${mint}`), 1, 'the floor passes it')
    const [entry] = await keeper.log(mint)
    assert.deepEqual([entry.action, entry.signature, entry.index], ['cancel-epoch', signature, 0])
    assert.deepEqual(chain.calls, [], 'no re-post inside the interval')
    assert.deepEqual(errorsIn(chain), [])

    // The next post reads the funded address as the latest epoch, and goes ahead.
    await chain.age(store, mint)
    await keeper.tick()
    assert.deepEqual(chain.calls, ['epoch:1'])
    assert.equal((await store.get(`epoch:${mint}:1`)).status, 'posted')
    assert.deepEqual(
      (await keeper.epochs(mint)).map((r) => [r.index, r.closed, r.cancelled]),
      [
        [1, false, false],
        [0, true, true],
      ],
    )
    chain.lookups = 0
    await keeper.tick()
    assert.equal(chain.lookups, 0, 'the settled cancel is not looked up again')
    assert.deepEqual(errorsIn(chain), [])
  })
}

test('a pending post that was cancelled and whose address was funded is dropped on proof', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  chain.statusError = '429 Too Many Requests' // the post lands, but its status is never read
  await keeper.tick()
  chain.statusError = null
  const pending = await store.get(`epoch:${mint}:0`)
  assert.equal(pending.status, 'pending')
  const signature = chain.cancel(mint, 0)
  chain.fund(mint, 0, { times: 2 })
  await store.set(`epoch:${mint}:0`, { ...pending, createdAt: nowSecs() - 600 })
  assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])

  chain.logged.length = 0 // the unconfirmed post was logged
  await keeper.tick()
  assert.equal(await store.get(`epoch:${mint}:0`), null)
  assert.equal(await store.get(leavesKey(mint, pending)), null)
  assert.deepEqual(
    (await keeper.log(mint)).map((r) => [r.action, r.signature]),
    [['cancel-epoch', signature]],
  )
  assert.deepEqual(errorsIn(chain), [])

  chain.coins.get(mint).lastEpochAt -= 2 * DAY
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'epoch:1'])
  assert.equal((await store.get(`epoch:${mint}:1`)).status, 'posted')
})

test('lamports sent to an expired, closed epoch do not stop the next post or the close loop', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  await keeper.tick()
  chain.epoch(mint, 0).expiresAt = nowSecs() - 120
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'close:0'])
  assert.equal(await store.get(`epoch:floor:${mint}`), 1)

  chain.fund(mint, 0)
  // A lost floor makes the close loop read the funded address again.
  await store.delete(`epoch:floor:${mint}`)
  const closed = await store.get(`epoch:${mint}:0`)
  await store.set(`epoch:${mint}:0`, { ...closed, expiresAt: nowSecs() - 120 })
  chain.coins.get(mint).entangleReserve = 100_000_000n
  await chain.age(store, mint)
  await keeper.tick()
  assert.deepEqual(chain.calls, ['epoch:0', 'close:0', 'epoch:1'])
  assert.equal((await store.get(`epoch:${mint}:1`)).status, 'posted')
  assert.equal(await store.get(`epoch:floor:${mint}`), 1, 'passed again without a close')
  assert.deepEqual(errorsIn(chain), [])
})

// ---- epochs this keeper did not post ----------------------------------------------------------

test('an epoch this keeper did not post is flagged while it can still be cancelled', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 200_000_000n })
  const keeper = makeKeeper(chain, store)
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 1 }, 'its own post is not flagged')
  assert.deepEqual(chain.calls, ['epoch:0'])

  // Someone holding the keeper key posts the next epoch.
  const index = chain.inject(mint)
  const foreign = chain.epoch(mint, index)
  const result = await keeper.tick()
  assert.deepEqual(result.alerts, [
    {
      kind: 'foreign-epoch',
      mint,
      index: 1,
      claimStart: foreign.claimStart,
      total: '90000000',
      payer: keeperKey.publicKey.toBase58(),
    },
  ])
  const line = chain.logged.find((m) => m.startsWith(`epoch ${mint}#1 `))
  assert.ok(line, chain.logged.join('\n'))
  const deadline = new Date(foreign.claimStart * 1000).toISOString()
  assert.ok(
    line.startsWith(
      `epoch ${mint}#1 was not posted by this keeper; cancel it with cancel_epoch before ${deadline}`,
    ),
    line,
  )
  assert.deepEqual(chain.calls, ['epoch:0'], 'the keeper posts nothing over it')
  assert.ok((await keeper.tick()).alerts, 'flagged again every tick until it is dealt with')

  // The authority cancels it: nothing is flagged and nothing is looked up for it.
  chain.cancel(mint, index)
  chain.lookups = 0
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 1 })
  assert.equal(chain.lookups, 0)

  // One whose claimStart has passed can no longer be cancelled: not flagged.
  chain.coins.get(mint).lastEpochAt = nowSecs() - 2 * DAY
  chain.config.keeper = Keypair.generate().publicKey.toBase58() // keeps this keeper from posting
  chain.inject(mint, { claimStart: nowSecs() - 10 })
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 1 })
})

test('a foreign root at the index of a pending post drops the post and is flagged', async () => {
  const chain = fakeChain()
  const store = newStore()
  const mint = newMint()
  chain.register(mint, { entangleReserve: 100_000_000n })
  const keeper = makeKeeper(chain, store)
  chain.statusError = '429 Too Many Requests'
  await keeper.tick()
  chain.statusError = null
  const pending = await store.get(`epoch:${mint}:0`)
  assert.equal(pending.status, 'pending')
  // Another post took index 0 first, so the keeper's never landed.
  chain.epoch(mint, 0).root = Uint8Array.from(randomBytes(32))

  const result = await keeper.tick()
  assert.equal(await store.get(`epoch:${mint}:0`), null, 'the pending record is dropped')
  assert.equal(await store.get(leavesKey(mint, pending)), null)
  assert.deepEqual(
    result.alerts.map((a) => [a.kind, a.mint, a.index]),
    [['foreign-epoch', mint, 0]],
  )
  assert.ok(chain.logged.some((m) => m.startsWith(`entangle ${mint} 0: another root`)))
  assert.deepEqual(await keeper.claims(mint, holders[0].toBase58()), [])
})

test('a keeper wallet under about a day of epoch rent and fees is flagged', async () => {
  const chain = fakeChain()
  const store = newStore()
  const keeper = makeKeeper(chain, store)
  chain.register(newMint())
  chain.register(newMint())
  assert.deepEqual(
    await keeper.tick(),
    { enabled: true, ran: 2 },
    'a failed balance read is ignored',
  )

  chain.balance = 15_000_000 // two coins want 0.02 SOL
  const { alerts } = await keeper.tick()
  assert.deepEqual(alerts, [{ kind: 'low-balance', lamports: '15000000', wanted: '20000000' }])
  assert.ok(
    chain.logged.some((m) => /holds 0\.0150 SOL, under .* for 2 coins \(0\.0200 SOL\)/.test(m)),
    chain.logged.join('\n'),
  )

  chain.balance = 20_000_000
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 2 })
})
