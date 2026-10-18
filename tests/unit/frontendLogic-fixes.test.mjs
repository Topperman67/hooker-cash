// Frontend logic fixes: launch grouping and resume bookkeeping, confirmation retries, lookup-table
// loading, Meteora spend limits, platform-fee rent safety and error mapping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

// src/lib/solana.js builds its Connection from window.location at import time.
globalThis.window ??= { location: { origin: 'http://127.0.0.1:9' } }

const {
  confirmWith,
  createLookupTableLoader,
  isTransientRpcError,
  packGroups,
  sendAndConfirmAll,
  sendWithRetry,
  transferKeepsRentExempt,
  RENT_EXEMPT_MINIMUM,
} = await import('../../src/lib/txflow.js')
const { explainError, friendlyWalletError, failingProgram, MESSAGES, PROGRAMS } =
  await import('../../src/lib/txerrors.js')
const amounts = await import('../../src/lib/amounts.js')
const plan = await import('../../src/lib/launchPlan.js')
const solana = await import('../../src/lib/solana.js')
const launch = await import('../../src/lib/launch.js')
const trade = await import('../../src/lib/trade.js')
const { dbcPoolPda, dbcCoder, dammCoder } = await import('../../shared/meteora.mjs')
// Installs the Quantum Hooks error table, as the app does whenever it builds a Quantum transaction.
const quantumClient = await (await import('../../src/lib/quantum.js')).loadQuantum()

const key = () => Keypair.generate().publicKey
const noSleep = async () => {}
const SOL = 1_000_000_000n

// Offline RPC for solana.js: fixed blockhash and fee, no lookup table unless a test sets one.
const BLOCKHASH = key().toBase58()
solana.connection.getLatestBlockhash = async () => ({
  blockhash: BLOCKHASH,
  lastValidBlockHeight: 1000,
})
solana.connection.getRecentPrioritizationFees = async () => []

// An instruction with `accounts` distinct non-signer keys and `data` bytes.
const ix = (accounts, data = 8, keys = Array.from({ length: accounts }, key)) =>
  new TransactionInstruction({
    programId: new PublicKey(PROGRAMS.dbc),
    keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.alloc(data),
  })

// ---------------------------------------------------------------------------------------------
// C5: launch groups are indivisible and never reordered
// ---------------------------------------------------------------------------------------------

test('packGroups merges whole groups greedily, keeps order and reports group indexes', () => {
  const size = (ixs) => ixs.reduce((s, x) => s + x.size, 0)
  const fits = (ixs) => size(ixs) <= 10
  const g = (...sizes) => sizes.map((size) => ({ size }))
  const packed = packGroups([g(3), g(4, 3), [], g(2), g(9)], fits)
  assert.deepEqual(
    packed.map((t) => t.groups),
    [[0, 1], [3], [4]],
  )
  assert.deepEqual(packed[0].instructions.length, 3)
  assert.deepEqual(
    packGroups([g(5), g(4, 3), g(1)], fits).map((t) => t.groups),
    [[0], [1, 2]],
  )
  const tooBig = (() => {
    try {
      packGroups([g(2), g(6, 6)], fits)
    } catch (e) {
      return e
    }
  })()
  assert.equal(tooBig.code, 'too_large')
  assert.equal(tooBig.group, 1)
})

test('packGroups merges only what passes canMerge, while a lone group may fill the limit', () => {
  const size = (ixs) => ixs.reduce((s, x) => s + x.size, 0)
  const fits = (ixs) => size(ixs) <= 10
  const roomy = (ixs) => size(ixs) <= 7
  const g = (...sizes) => sizes.map((size) => ({ size }))
  // register 2 + launch 5 leaves room; adding the lock (2) would fit but leaves none, so it splits
  assert.deepEqual(
    packGroups([g(2), g(5), g(2)], fits, roomy).map((t) => t.groups),
    [[0, 1], [2]],
  )
  // a launch group of 10 still goes out on its own
  assert.deepEqual(
    packGroups([g(1), g(10), g(1)], fits, roomy).map((t) => t.groups),
    [[0], [1], [2]],
  )
})

test('launch packing leaves the wallet room and sets the loaded-data limit explicitly', () => {
  const solana = readFileSync(new URL('../../src/lib/solana.js', import.meta.url), 'utf8')
  assert.match(solana, /const WALLET_HEADROOM = \d+/)
  assert.match(solana, /fits\(message\(ixs\), WALLET_HEADROOM\)/)
  assert.match(solana, /loadedDataLimitInstruction\(\),/)
})

test('launch groups keep the DBC create, the dev buy and the fee in one group (Quantum and standard)', () => {
  const [register, create, ata, buy, fee, lock] = [
    'register',
    'create',
    'ata',
    'buy',
    'fee',
    'lock',
  ]
  const quantum = plan.launchGroups({
    register: [register],
    launch: [create, ata, buy],
    fee,
    lock: [lock],
    devBuy: true,
  })
  assert.deepEqual(quantum.groups, [[register], [create, ata, buy, fee], [lock]])
  assert.deepEqual(quantum.stages, [['register'], ['launch', 'buy'], ['lock']])

  const standard = plan.launchGroups({ launch: [create, ata, buy], fee, devBuy: true })
  assert.deepEqual(standard.groups, [[create, ata, buy, fee]])
  assert.deepEqual(standard.stages, [['launch', 'buy']])

  const noBuy = plan.launchGroups({ register: [register], launch: [create] })
  assert.deepEqual(noBuy.groups, [[register], [create]])
  assert.deepEqual(noBuy.stages, [['register'], ['launch']])
})

test('real packing never splits the create + dev buy group and fails loudly when it cannot fit', async () => {
  solana.connection.getAddressLookupTable = async () => ({ value: null })
  const register = [ix(6, 200)]
  const launchGroup = [ix(14, 120), ix(6, 40), ix(2, 12)] // ~ create, buy, fee
  const lock = [ix(4, 40)]
  const { groups, stages } = plan.launchGroups({
    register,
    launch: launchGroup.slice(0, 2),
    fee: launchGroup[2],
    lock,
    devBuy: true,
  })
  const packed = await solana.packTransactions(key().toBase58(), groups, { units: 500_000 })
  const txStages = plan.stagesPerTransaction(packed.groupIndexes, stages)
  // Every transaction is whole groups, in order; the launch group sits in exactly one of them.
  assert.equal(packed.transactions.length, packed.groupIndexes.length)
  assert.deepEqual(packed.groupIndexes.flat(), [0, 1, 2])
  assert.equal(txStages.filter((s) => s.includes('launch')).length, 1)
  assert.ok(txStages.find((s) => s.includes('launch')).includes('buy'))
  for (const tx of packed.transactions) assert.ok(tx.serialize().length <= 1232)

  // A launch group too large for one transaction is an error, never a split.
  const huge = plan.launchGroups({ launch: [ix(20, 200), ix(20, 200)], devBuy: true })
  const error = await solana
    .packTransactions(key().toBase58(), huge.groups, { units: 500_000 })
    .catch((e) => e)
  assert.equal(error.code, 'too_large')
  assert.equal(error.lookupTable, false)
  const explained = launch.launchTooLargeError(error, { devBuy: true })
  assert.match(explained.message, /same transaction as the create/)
  assert.match(explained.message, /QUANTPAD_LOOKUP_TABLE/)
})

test('a launch without a dev buy builds [register], [create, hand-over, sync] (Quantum) or [create]', async () => {
  const { CONFIG, dbcConfigAccount } = await import('./meteora-chain.mjs')
  const original = solana.connection.getAccountInfo
  const config = await dbcConfigAccount()
  solana.connection.getAccountInfo = async (address) =>
    address.toBase58() === CONFIG ? config : null
  try {
    const args = {
      launcher: key().toBase58(),
      mint: key(),
      name: 'Cat',
      symbol: 'CAT',
      uri: 'https://example.invalid/m.json',
      devBuyLamports: 0n,
      slippagePct: 2,
      platform: { treasury: key().toBase58(), feeBps: 50 },
      dbcConfig: CONFIG,
    }
    const built = await launch.launchInstructions({
      ...args,
      quantum: true,
      hooks: { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000, splits: [] },
    })
    assert.deepEqual(built.stages, [['register'], ['launch']])
    assert.deepEqual(
      built.groups.map((g) => g.map((ix) => ix.programId.toBase58())),
      [
        [PROGRAMS.quantum],
        // DBC create, transfer_pool_creator to the well, then sync records the binding before
        // anyone can trade.
        [PROGRAMS.dbc, PROGRAMS.dbc, PROGRAMS.quantum],
      ],
    )
    assert.equal(built.dbcPool.toBase58(), dbcPoolPda(CONFIG, args.mint).toBase58())
    const standard = await launch.launchInstructions({ ...args, quantum: false })
    assert.deepEqual(standard.stages, [['launch']])
    assert.deepEqual(
      standard.groups.map((g) => g.map((ix) => ix.programId.toBase58())),
      [[PROGRAMS.dbc]],
    )
    // No launch config, no launch.
    await assert.rejects(launch.launchInstructions({ ...args, quantum: false, dbcConfig: null }), {
      friendly: true,
    })
  } finally {
    solana.connection.getAccountInfo = original
  }
})

// ---------------------------------------------------------------------------------------------
// C5: confirmed-only bookkeeping, frozen snapshot, persisted signatures, resume reconciliation
// ---------------------------------------------------------------------------------------------

test('sendAndConfirmAll reports only confirmed signatures and the failing one separately', async () => {
  const sigs = ['s1', 's2', 's3']
  const send = async (i) => sigs[i]
  const expire = async (signature) => {
    throw Object.assign(Error('expired'), { signature, expired: true })
  }
  // The first transaction expires: nothing completed (it used to be counted as done).
  let e = await sendAndConfirmAll(3, { send, confirm: expire }).catch((x) => x)
  assert.deepEqual(e.completed, [])
  assert.equal(e.failedIndex, 0)
  assert.equal(e.failedSignature, 's1')
  // The second fails on-chain: only the first completed.
  e = await sendAndConfirmAll(3, {
    send,
    confirm: async (s) => {
      if (s === 's2') throw Object.assign(Error('failed'), { failed: true })
    },
  }).catch((x) => x)
  assert.deepEqual(e.completed, ['s1'])
  assert.equal(e.failedSignature, 's2')
  // Send failure for the third.
  e = await sendAndConfirmAll(3, {
    send: async (i) => {
      if (i === 2) throw Error('preflight failed')
      return sigs[i]
    },
    confirm: async () => {},
  }).catch((x) => x)
  assert.deepEqual(e.completed, ['s1', 's2'])
  assert.equal(e.failedIndex, 2)
  assert.deepEqual(await sendAndConfirmAll(0, { send, confirm: expire }), [])
})

test('sendWithRetry re-sends the same bytes only on transient failures', async () => {
  let calls = 0
  const sig = await sendWithRetry(
    async () => {
      if (++calls < 3) throw Error('502 Bad Gateway: upstream')
      return 'sig'
    },
    { sleep: noSleep },
  )
  assert.equal(sig, 'sig')
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(
    sendWithRetry(
      async () => {
        calls++
        throw Error('Simulation failed. Message: custom program error: 0x1772')
      },
      { sleep: noSleep },
    ),
  )
  assert.equal(calls, 1)
})

const snapshotFor = (overrides = {}) =>
  plan.launchSnapshot({
    launcher: key().toBase58(),
    name: 'Cat',
    symbol: 'CAT',
    uri: 'https://example.invalid/m.json',
    quantum: true,
    hooks: {
      creatorBps: 3000,
      burnBps: 3000,
      entangleBps: 2000,
      fusionBps: 2000,
      splits: [],
      lock: { bps: 5000, cliffSecs: 604800, durationSecs: 7776000 },
    },
    devBuyLamports: SOL,
    slippagePct: 2,
    platform: { treasury: key().toBase58(), feeBps: 50 },
    lookupTable: key().toBase58(),
    ...overrides,
  })

test('the launch snapshot is frozen, so resuming cannot pick up form edits', () => {
  const hooks = {
    creatorBps: 10000,
    burnBps: 0,
    entangleBps: 0,
    fusionBps: 0,
    splits: [{ wallet: key().toBase58(), bps: 100 }],
    lock: { bps: 5000, cliffSecs: 1, durationSecs: 2 },
  }
  const snapshot = snapshotFor({ hooks })
  hooks.lock.durationSecs = 999 // the form changes after submit
  hooks.splits.push({ wallet: key().toBase58(), bps: 1 })
  assert.equal(snapshot.hooks.lock.durationSecs, 2)
  assert.equal(snapshot.hooks.splits.length, 1)
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.hooks.lock))
  assert.throws(() => {
    snapshot.hooks.lock.durationSecs = 5
  }, TypeError)
  assert.deepEqual(plan.plannedStages(snapshot), ['register', 'launch', 'buy', 'lock'])
  assert.deepEqual(plan.plannedStages(snapshotFor({ quantum: false, hooks: null })), [
    'launch',
    'buy',
  ])
  assert.deepEqual(plan.plannedStages(snapshotFor({ devBuyLamports: 0n })), ['register', 'launch'])
})

test('jobs keep confirmed signatures across attempts and register with the create transaction', () => {
  const memory = new Map()
  const storage = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
    key: (i) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size
    },
  }
  const keypair = Keypair.generate()
  const job = plan.newJob({ mint: keypair.publicKey.toBase58(), keypair, snapshot: snapshotFor() })
  // Attempt 1: [register], [create+ATA+buy+fee] confirm, [lock] expires.
  const txStages = [['register'], ['launch', 'buy'], ['lock']]
  const error = {
    completed: ['sigR', 'sigC'],
    failedIndex: 2,
    failedSignature: 'sigL',
    expired: true,
  }
  plan.recordConfirmed(job, txStages, error.completed)
  plan.recordPending(job, txStages, error)
  assert.equal(job.pending, null, 'an expired transaction is not pending')
  assert.equal(plan.createSignature(job), 'sigC')
  assert.deepEqual(plan.remainingStages(job), ['lock'])
  assert.ok(plan.hasProgress(job))
  plan.saveJob(storage, job)

  // Attempt 2 (a later page or a resume): the lock's outcome is unknown.
  const again = plan.loadJob(storage, job.mint)
  assert.equal(again.keypair, null, 'the mint keypair is never persisted')
  const stored = JSON.parse(memory.get(plan.JOB_PREFIX + job.mint))
  assert.equal(stored.keypair, undefined)
  assert.doesNotMatch(JSON.stringify(stored), /secret/i)
  assert.equal(again.snapshot.devBuyLamports, SOL)
  plan.recordPending(again, [['lock']], { unknown: true, failedIndex: 0, failedSignature: 'sigL2' })
  assert.deepEqual(again.pending, { signature: 'sigL2', stages: ['lock'] })
  // Resume: the history lookup says it landed.
  plan.reconcileJob(again, { registered: true, created: true, tokens: 5n, locked: false }, true)
  assert.equal(again.done.lock, 'sigL2')
  assert.deepEqual(again.signatures, ['sigR', 'sigC', 'sigL2'])
  assert.ok(plan.launchComplete(again))
  assert.equal(plan.createSignature(again), 'sigC')
  plan.saveJob(storage, again)
  plan.markRegistered(storage, again.mint)
  assert.equal(plan.loadJob(storage, again.mint), null, 'finished and registered jobs are dropped')
})

test('reconcileJob trusts the chain: a created coin has its dev buy, nothing is re-sent', () => {
  const job = plan.newJob({ mint: key().toBase58(), snapshot: snapshotFor() })
  plan.recordPending(job, [['register', 'launch', 'buy']], {
    unknown: true,
    failedIndex: 0,
    failedSignature: 'sigX',
  })
  plan.reconcileJob(job, { registered: true, created: true, tokens: 0n, locked: false }, null)
  assert.equal(job.done.register, 'chain')
  assert.equal(job.done.launch, 'chain')
  assert.equal(job.done.buy, 'chain')
  assert.equal(plan.createSignature(job), null, 'registration falls back to the mint')
  assert.deepEqual(plan.remainingStages(job), ['lock'])
  assert.equal(job.pending, null)

  const failed = plan.newJob({ mint: key().toBase58(), snapshot: snapshotFor() })
  plan.recordPending(failed, [['register', 'launch', 'buy']], {
    unknown: true,
    failedIndex: 0,
    failedSignature: 'sigY',
  })
  plan.reconcileJob(failed, { registered: false, created: false, tokens: 0n, locked: false }, false)
  assert.deepEqual(plan.remainingStages(failed), ['register', 'launch', 'buy', 'lock'])
  assert.equal(plan.hasProgress(failed), false)
})

test('registration retries 409/429/5xx/network errors and tracks as external only on not_quantpad', async () => {
  const delays = []
  const sleep = async (ms) => delays.push(ms)
  const calls = []
  const failures = [
    Object.assign(Error('not yet'), { status: 409, code: 'not_indexed_yet' }),
    Object.assign(Error('slow down'), { status: 429 }),
    Object.assign(Error('Something went wrong'), { status: 502 }),
    Error('Quant Pad could not be reached. Check your connection and retry.'),
  ]
  let result = await plan.registerLaunch({
    signature: 'sigC',
    mint: 'M',
    sleep,
    post: async (path, body) => {
      calls.push([path, body])
      if (failures.length) throw failures.shift()
      return { ok: true }
    },
  })
  assert.equal(result.status, 'registered')
  assert.equal(calls.length, 5)
  assert.ok(calls.every(([path, body]) => path === '/api/launches' && body.signature === 'sigC'))
  assert.deepEqual(calls[0][1], { signature: 'sigC', mint: 'M' })

  // Exhausted: at least five attempts over about a minute, and never tracked as external.
  calls.length = 0
  delays.length = 0
  result = await plan.registerLaunch({
    signature: 'sigC',
    mint: 'M',
    sleep,
    post: async (path) => {
      calls.push(path)
      throw Object.assign(Error('not yet'), { status: 409 })
    },
  })
  assert.equal(result.status, 'failed')
  assert.ok(calls.length >= 5)
  assert.ok(!calls.includes('/api/coins/track'))
  const waited = delays.reduce((a, b) => a + b, 0)
  assert.ok(waited >= 45_000 && waited <= 90_000, `waited ${waited} ms`)

  // Provably not a Quant Pad launch: track it as an external coin.
  calls.length = 0
  result = await plan.registerLaunch({
    mint: 'M',
    sleep,
    post: async (path, body) => {
      calls.push([path, body])
      if (path === '/api/launches')
        throw Object.assign(Error('no'), { status: 400, code: 'not_quantpad' })
    },
  })
  assert.equal(result.status, 'external')
  assert.deepEqual(calls, [
    ['/api/launches', { mint: 'M' }],
    ['/api/coins/track', { mint: 'M' }],
  ])

  // Any other 400 stops without tracking.
  calls.length = 0
  result = await plan.registerLaunch({
    signature: 's',
    mint: 'M',
    sleep,
    post: async (path) => {
      calls.push(path)
      throw Object.assign(Error('bad'), { status: 400 })
    },
  })
  assert.equal(result.status, 'failed')
  assert.deepEqual(calls, ['/api/launches'])
})

// ---------------------------------------------------------------------------------------------
// C6: confirmation keeps polling through transient RPC failures
// ---------------------------------------------------------------------------------------------

test('transient RPC errors are classified', () => {
  const transient = [
    Error('502 Bad Gateway: {"error":{"code":429}}'),
    Error('429 Too Many Requests: {"error":"slow down"}'),
    Error('503 Service Unavailable: '),
    Error('504 Gateway Timeout: '),
    new TypeError('Failed to fetch'),
    Error('fetch failed'),
    Object.assign(Error('failed to get signature status: rate limited'), { code: 429 }),
    Object.assign(Error('x'), { status: 503 }),
  ]
  const permanent = [
    Error('500 Internal Server Error: boom'),
    Error('400 Bad Request: nope'),
    Object.assign(Error('failed to get signature status: Invalid param'), { code: -32602 }),
    Error(
      'Simulation failed. Message: Transaction simulation failed: custom program error: 0x1772',
    ),
  ]
  for (const e of transient) assert.equal(isTransientRpcError(e), true, e.message)
  for (const e of permanent) assert.equal(isTransientRpcError(e), false, e.message)
})

function fakeConnection({ statuses, heights = () => 0 }) {
  const calls = { statuses: [], heights: 0 }
  return {
    calls,
    async getSignatureStatuses(signatures, options) {
      calls.statuses.push(options)
      const next = statuses(calls.statuses.length - 1, options)
      if (next instanceof Error) throw next
      return { value: [next] }
    },
    async getBlockHeight() {
      calls.heights++
      const h = heights(calls.heights - 1)
      if (h instanceof Error) throw h
      return h
    },
  }
}
const confirmed = { confirmationStatus: 'confirmed', err: null }

test('a 502 or 429 while polling does not fail a transaction that then confirms', async () => {
  for (const failure of ['502 Bad Gateway: upstream', '429 Too Many Requests: limit']) {
    const connection = fakeConnection({
      statuses: (i) => (i < 3 ? Error(failure) : confirmed),
      heights: () => 10,
    })
    assert.equal(await confirmWith(connection, 'sig', 100, { sleep: noSleep }), 'sig')
    assert.equal(connection.calls.statuses.length, 4)
  }
})

test('a non-transient polling failure throws unknown (with the signature), not a failure', async () => {
  const connection = fakeConnection({ statuses: () => Error('500 Internal Server Error: boom') })
  const e = await confirmWith(connection, 'sig', 100, { sleep: noSleep }).catch((x) => x)
  assert.equal(e.unknown, true)
  assert.equal(e.signature, 'sig')
  assert.equal(friendlyWalletError(e), e.message)
  assert.match(e.message, /may still land/)
})

test('after the blockhash expires the status is re-checked with full history first', async () => {
  // Never seen, block height past the limit: one history lookup, then "expired".
  let connection = fakeConnection({ statuses: () => null, heights: () => 200 })
  let e = await confirmWith(connection, 'sig', 100, { sleep: noSleep }).catch((x) => x)
  assert.equal(e.expired, true)
  assert.equal(connection.calls.statuses.at(-1).searchTransactionHistory, true)
  // Found in history: confirmed after all.
  connection = fakeConnection({
    statuses: (i, o) => (o.searchTransactionHistory && i >= 4 ? confirmed : null),
    heights: () => 200,
  })
  assert.equal(await confirmWith(connection, 'sig', 100, { sleep: noSleep }), 'sig')
  // Every history lookup fails transiently: unknown, not expired.
  connection = fakeConnection({
    statuses: (i) => (i < 4 ? null : Error('502 Bad Gateway: x')),
    heights: () => 200,
  })
  e = await confirmWith(connection, 'sig', 100, { sleep: noSleep }).catch((x) => x)
  assert.equal(e.unknown, true)
  assert.notEqual(e.expired, true)
})

test('polling keeps going through failures until a hard time cap, then reports unknown', async () => {
  let clock = 0
  const connection = fakeConnection({
    statuses: () => Error('503 Service Unavailable: '),
    heights: () => Error('503 Service Unavailable: '),
  })
  const e = await confirmWith(connection, 'sig', 100, {
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    maxWaitMs: 60_000,
  }).catch((x) => x)
  assert.equal(e.unknown, true)
  assert.ok(connection.calls.statuses.length > 5)
})

test('an on-chain failure is explained by the program that raised it', async () => {
  const programIds = [
    'ComputeBudget111111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
    PROGRAMS.quantum,
  ]
  const connection = fakeConnection({
    statuses: () => ({
      confirmationStatus: 'processed',
      err: { InstructionError: [2, { Custom: 6005 }] },
    }),
  })
  const e = await confirmWith(connection, 'sig', 100, { sleep: noSleep, programIds }).catch(
    (x) => x,
  )
  assert.equal(e.failed, true)
  assert.match(e.message, /lock terms differ/i)
})

// ---------------------------------------------------------------------------------------------
// Lookup tables: failures are not cached; launches do not silently drop the table
// ---------------------------------------------------------------------------------------------

test('a failed lookup-table fetch is retried and never cached', async () => {
  let calls = 0
  let fail = true
  const table = { key: 'T' }
  const load = createLookupTableLoader(
    async () => {
      calls++
      if (fail) throw Error('429 Too Many Requests: ')
      return table
    },
    { sleep: noSleep },
  )
  assert.deepEqual(await load(['T']), { tables: [], missing: ['T'] })
  assert.equal(calls, 3, 'retried')
  fail = false
  assert.deepEqual(await load(['T']), { tables: [table], missing: [] })
  assert.equal(calls, 4, 'the failure was not cached')
  await load(['T'])
  assert.equal(calls, 4, 'a success is cached')

  let empty = 0
  const loadEmpty = createLookupTableLoader(async () => (empty++ ? table : null), {
    sleep: noSleep,
    attempts: 1,
  })
  assert.deepEqual((await loadEmpty(['T'])).missing, ['T'])
  assert.deepEqual((await loadEmpty(['T'])).tables, [table])
})

test('a launch fails with a retryable error when the lookup table cannot be loaded', async () => {
  const groups = [[ix(3, 10)]]
  const address = key().toBase58()
  let fail = true
  const table = new AddressLookupTableAccount({
    key: new PublicKey(address),
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: [key()],
    },
  })
  solana.connection.getAddressLookupTable = async () => {
    if (fail) throw Error('502 Bad Gateway: ')
    return { value: table }
  }
  const e = await solana
    .packTransactions(key().toBase58(), groups, {
      lookupTableAddresses: [address],
      requireLookupTables: true,
    })
    .catch((x) => x)
  assert.equal(e.code, 'lookup_table_unavailable')
  assert.equal(e.retryable, true)
  // Trades may go ahead without it when they fit.
  const trade = await solana.packTransactions(key().toBase58(), groups, {
    lookupTableAddresses: [address],
  })
  assert.equal(trade.transactions.length, 1)
  // Once the RPC recovers the table loads (the earlier failure was not cached).
  fail = false
  assert.deepEqual(await solana.lookupTables([address]), [table])
})

// ---------------------------------------------------------------------------------------------
// Meteora buys spend at most the amount entered; Max and the balance check
// ---------------------------------------------------------------------------------------------

// Real mainnet accounts (tests/fixtures/meteora-accounts.json): Quant Pad's 1% launch config and a
// launch's DBC pool on it, and a coin Meteora migrated with its DAMM v2 pool.
const ACCOUNTS = JSON.parse(
  readFileSync(new URL('../fixtures/meteora-accounts.json', import.meta.url), 'utf8'),
)
const MARKETS = {
  curve: {
    mint: 'CVmkkge8UBWfCpJJHB2GZ5CzrpHppaoJgs2Rn45r6sQP',
    dbcPool: 'FHbTvBB7jRmY7FgQunGAji9NjcvrAcsXfyjokGiiXy2P',
  },
  pool: {
    mint: 'JA4eXGb8kHSpaLSSTJSxpk1Yfp4JLvFrMAXgN59vDwaY',
    dbcPool: 'A13LcotgbqqUkvMK94b7koZPrSUT7rXze4Hv7vFfHQL4',
  },
}
// Serves the fixture accounts, the coin mints as SPL Token mints, and a funded treasury.
async function withMarkets(fn) {
  const info = (address) => {
    const a = ACCOUNTS[address]
    if (a)
      return {
        owner: new PublicKey(a.owner),
        lamports: a.lamports,
        data: Buffer.from(a.data, 'base64'),
        executable: false,
      }
    if (Object.values(MARKETS).some((m) => m.mint === address))
      return {
        owner: new PublicKey(PROGRAMS.token),
        lamports: 1,
        data: Buffer.alloc(82),
        executable: false,
      }
    return null
  }
  const saved = { ...solana.connection }
  solana.connection.getAccountInfo = async (k) => info(k.toBase58())
  solana.connection.getMultipleAccountsInfo = async (keys) => keys.map((k) => info(k.toBase58()))
  solana.connection.getBalance = async () => 1_000_000_000
  try {
    return await fn()
  } finally {
    for (const name of ['getAccountInfo', 'getMultipleAccountsInfo', 'getBalance'])
      solana.connection[name] = saved[name]
  }
}
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
// What a buy's instructions move: the SOL wrapped for the swap, the swap's arguments, the fee.
function spending(instructions, user) {
  const wsol = getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), new PublicKey(user), true)
  const transfers = instructions
    .filter((ix) => ix.programId.equals(SystemProgram.programId))
    .map((ix) => ({ to: ix.keys[1].pubkey, lamports: ix.data.readBigUInt64LE(4) }))
  const swap = instructions.find(
    (ix) => ix.programId.toBase58() === PROGRAMS.dbc || ix.programId.toBase58() === PROGRAMS.damm,
  )
  const coder = swap.programId.toBase58() === PROGRAMS.dbc ? dbcCoder : dammCoder
  const { params } = coder.instruction.decode(swap.data).data
  return {
    wrapped: transfers.filter((t) => t.to.equals(wsol)).reduce((sum, t) => sum + t.lamports, 0n),
    fee: transfers.filter((t) => !t.to.equals(wsol)).reduce((sum, t) => sum + t.lamports, 0n),
    amountIn: BigInt(params.amount0.toString()),
    minOut: BigInt(params.amount1.toString()),
    swapMode: params.swapMode,
  }
}

test('a Meteora buy never spends or wraps more than the amount entered, on the curve or the pool', async () => {
  await withMarkets(async () => {
    const user = key().toBase58()
    const platform = { feeBps: 50, treasury: key().toBase58() }
    for (const [venue, market] of Object.entries(MARKETS))
      for (const slippagePct of [1, 2, 5, 15])
        for (const lamports of [1_000_000n, 250_000_000n, 1_980_000_000n]) {
          const label = `${venue} ${lamports} @ ${slippagePct}%`
          const state = await trade.marketState(market.mint, user, market.dbcPool)
          assert.equal(state.venue, venue, label)
          const quoted = trade.quoteBuy(state, lamports, slippagePct)
          const built = await trade.buyInstructions({
            mint: market.mint,
            user,
            lamports,
            slippagePct,
            platform,
            dbcPool: market.dbcPool,
          })
          assert.equal(built.venue, venue)
          const spent = spending(built.instructions, user)
          assert.ok(spent.wrapped <= lamports, `${label}: wraps ${spent.wrapped}`)
          assert.ok(spent.amountIn <= lamports, `${label}: swaps ${spent.amountIn}`)
          // The minimum out is the quote less exactly the slippage tolerance picked: never more
          // than quoted, and not a tighter limit that fails on any price move.
          assert.ok(spent.minOut > 0n && spent.minOut <= quoted.tokens, label)
          const expected = amounts.minimumOut(quoted.tokens, slippagePct)
          assert.ok(
            spent.minOut >= expected - 1n && spent.minOut <= expected + 1n,
            `${label}: min ${spent.minOut} of ${quoted.tokens}, expected ${expected}`,
          )
          // A curve buy fills partially at the threshold instead of failing (the rest is refunded).
          if (venue === 'curve') assert.equal(spent.swapMode, 1, label)
          // The platform fee is its own transfer, at most feeBps of the amount entered.
          assert.ok(spent.fee <= amounts.platformFee(lamports, platform.feeBps), label)
        }
  })
})

test('Max and the insufficient-balance check include the fee, rent and network fees', async () => {
  const balance = 2n * SOL
  for (const venue of ['curve', 'pool'])
    for (const feeBps of [0, 50, 100]) {
      const max = amounts.maxBuy(balance, { feeBps, venue })
      assert.ok(max > 0n)
      assert.equal(amounts.buyExceedsBalance(max, balance, { feeBps, venue }), false)
      assert.ok(amounts.buyCost(max, { feeBps, venue }) <= balance)
    }
  // 2 SOL, 50 bps, a graduated coin: Max fits, and the swap (at most the amount entered) plus the
  // fee, the WSOL and token account rent and network fees stay within the balance.
  const max = amounts.maxBuy(balance, { feeBps: 50, venue: 'pool' })
  const user = key().toBase58()
  const built = await withMarkets(() =>
    trade.buyInstructions({
      mint: MARKETS.pool.mint,
      user,
      lamports: max,
      slippagePct: 2,
      platform: { feeBps: 50, treasury: key().toBase58() },
      dbcPool: MARKETS.pool.dbcPool,
    }),
  )
  const spent = spending(built.instructions, user)
  const rent = 2n * 2_039_280n // the WSOL and coin token accounts
  assert.ok(spent.wrapped + spent.fee + rent + 1_000_000n <= balance)
  assert.equal(amounts.buyExceedsBalance(balance, balance, { venue: 'pool' }), true)
  assert.equal(amounts.maxBuy(1_000_000n, { venue: 'pool' }), 0n)
  assert.equal(amounts.buyExceedsBalance(1n, null), false)
})

// ---------------------------------------------------------------------------------------------
// Platform fee to an unfunded treasury
// ---------------------------------------------------------------------------------------------

test('a fee transfer that would leave the treasury below rent-exemption is never produced', async () => {
  assert.equal(transferKeepsRentExempt(0n, 500_000n), false)
  assert.equal(transferKeepsRentExempt(null, 500_000n), false)
  assert.equal(transferKeepsRentExempt(0n, RENT_EXEMPT_MINIMUM), true)
  assert.equal(transferKeepsRentExempt(400_000n, 500_000n), true)
  assert.equal(transferKeepsRentExempt(RENT_EXEMPT_MINIMUM, 1n), true)

  const user = key().toBase58()
  const balances = new Map()
  let reads = 0
  solana.connection.getBalance = async (pubkey) => {
    reads++
    const b = balances.get(pubkey.toBase58())
    if (b instanceof Error) throw b
    return b ?? 0
  }
  const unfunded = { treasury: key().toBase58(), feeBps: 50 }
  // 0.1 SOL at 50 bps = 500 000 lamports < rent minimum: skipped while the treasury is empty.
  assert.equal(await solana.platformFeeInstruction(user, unfunded, SOL / 10n), null)
  // 0.5 SOL → 2 500 000 lamports: always safe, no balance read needed.
  const before = reads
  const big = await solana.platformFeeInstruction(user, unfunded, SOL / 2n)
  assert.equal(reads, before)
  assert.equal(big.programId.toBase58(), SystemProgram.programId.toBase58())
  // Funded treasury: small fees go through, and the funded state is remembered.
  const funded = { treasury: key().toBase58(), feeBps: 50 }
  balances.set(funded.treasury, 5_000_000)
  assert.ok(await solana.platformFeeInstruction(user, funded, SOL / 10n))
  const after = reads
  assert.ok(await solana.platformFeeInstruction(user, funded, SOL / 10n))
  assert.equal(reads, after)
  // Balance unreadable: small fee skipped rather than risking the trade.
  const unknown = { treasury: key().toBase58(), feeBps: 50 }
  balances.set(unknown.treasury, Error('502 Bad Gateway: '))
  assert.equal(await solana.platformFeeInstruction(user, unknown, SOL / 10n), null)
})

// ---------------------------------------------------------------------------------------------
// Error mapping by program
// ---------------------------------------------------------------------------------------------

const simulation = (programId, hex, { inner } = {}) =>
  new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: `Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${hex}`,
    logs: [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      `Program ${programId} invoke [1]`,
      'Program log: Instruction: Something',
      ...(inner
        ? [
            `Program ${inner} invoke [2]`,
            'Transfer: insufficient lamports 100, need 2000',
            `Program ${inner} failed: custom program error: 0x${hex}`,
          ]
        : ['Program log: AnchorError occurred. Error Code: X. Error Number: 1. Error Message: x.']),
      `Program ${programId} consumed 5000 of 400000 compute units`,
      `Program ${programId} failed: custom program error: 0x${hex}`,
    ],
  })

test('custom errors are mapped by the program that raised them', () => {
  const q = PROGRAMS.quantum
  // Quantum Hooks errors are never "slippage".
  assert.equal(
    friendlyWalletError(simulation(q, '1777')),
    'Quant Pad is paused right now. Try again later.',
  )
  assert.match(friendlyWalletError(simulation(q, '1775')), /lock terms differ/i)
  assert.match(friendlyWalletError(simulation(q, '177c')), /launcher/)
  assert.equal(friendlyWalletError(simulation(q, '177f')), 'Nothing new has vested yet.')
  assert.match(friendlyWalletError(simulation(q, '1780')), /0\.001 SOL/)
  assert.equal(friendlyWalletError(simulation(q, '178e')), 'You already claimed this reward.')
  const epoch = friendlyWalletError(simulation(q, '178b'))
  assert.match(epoch, /epoch has expired/)
  assert.doesNotMatch(epoch, /transaction expired/)
  // Meteora DBC and DAMM v2: slippage, a full curve, a paused pool, dust.
  assert.equal(friendlyWalletError(simulation(PROGRAMS.dbc, '1772')), MESSAGES.slippage)
  assert.equal(friendlyWalletError(simulation(PROGRAMS.dbc, '177d')), MESSAGES.graduated)
  assert.match(friendlyWalletError(simulation(PROGRAMS.dbc, '1775')), /too small to trade/)
  assert.match(friendlyWalletError(simulation(PROGRAMS.dbc, '177c')), /Not enough tokens left/)
  assert.equal(friendlyWalletError(simulation(PROGRAMS.damm, '1772')), MESSAGES.slippage)
  assert.match(friendlyWalletError(simulation(PROGRAMS.damm, '1773')), /paused trading/)
  // The same number from another program means something else: DBC's 6003 is not "paused".
  assert.doesNotMatch(friendlyWalletError(simulation(PROGRAMS.dbc, '1773')), /paused/)
  // CPI failures: the innermost failing program decides.
  assert.equal(
    friendlyWalletError(simulation(PROGRAMS.dbc, '1', { inner: PROGRAMS.system })),
    MESSAGES.noSol,
  )
  assert.equal(
    friendlyWalletError(simulation(PROGRAMS.dbc, '1', { inner: PROGRAMS.token })),
    MESSAGES.tokens,
  )
  // Unknown programs: a short message, never the raw logs.
  const other = friendlyWalletError(simulation(key().toBase58(), '1772'))
  assert.doesNotMatch(other, /Program log|invoke|slippage/)
  assert.match(other, /error 6002/)
  // Every Quantum Hooks error in the IDL has its own message.
  assert.equal(q, quantumClient.QUANTUM_PROGRAM_ID.toBase58())
  for (const { code } of quantumClient.QUANTUM_IDL.errors) {
    const message = friendlyWalletError(simulation(q, code.toString(16)))
    assert.doesNotMatch(message, /\(error \d+\)|slippage/, `${code}: ${message}`)
  }
  assert.deepEqual(failingProgram(simulation(q, '1777').logs), {
    programId: q,
    code: 6007,
    reason: 'custom program error: 0x1777',
  })
})

test('rent, expiry, not-enough-SOL and wallet rejection messages', () => {
  const sim = (message) =>
    new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: message,
      logs: [],
    })
  assert.equal(
    friendlyWalletError(
      sim('Transaction results in an account (0) with insufficient funds for rent'),
    ),
    MESSAGES.walletRent,
  )
  assert.equal(
    friendlyWalletError(
      sim('Transaction results in an account (15) with insufficient funds for rent'),
    ),
    MESSAGES.accountRent,
  )
  assert.equal(
    friendlyWalletError(
      sim(
        'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
      ),
    ),
    MESSAGES.noSol,
  )
  assert.equal(
    friendlyWalletError(sim('Transaction simulation failed: Blockhash not found')),
    MESSAGES.sendExpired,
  )
  assert.equal(friendlyWalletError(Error('block height exceeded')), MESSAGES.sendExpired)
  assert.equal(
    friendlyWalletError(Object.assign(Error('User rejected the request.'), { code: 4001 })),
    MESSAGES.declined,
  )
  // Program errors carried only as text are mapped with the instruction's program.
  const text = Error(
    'Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1777',
  )
  const programIds = ['c', 'c', PROGRAMS.dbc, PROGRAMS.quantum]
  assert.match(friendlyWalletError(text, { programIds }), /paused/)
  // Mapped messages stay stable when mapped again (callers re-map errors from sendTransactions).
  for (const message of Object.values(MESSAGES))
    assert.equal(friendlyWalletError(Error(message)), message)
})

test('explainError maps status errors per program and rent by account', () => {
  const ids = ['cb', 'cb', PROGRAMS.dbc, PROGRAMS.quantum]
  assert.equal(
    explainError({ InstructionError: [2, { Custom: 6013 }] }, { programIds: ids }),
    MESSAGES.graduated,
  )
  assert.match(
    explainError({ InstructionError: [3, { Custom: 6005 }] }, { programIds: ids }),
    /lock terms/i,
  )
  assert.match(
    explainError({ InstructionError: [3, { Custom: 6019 }] }, { programIds: ids }),
    /Too soon/,
  )
  assert.equal(
    explainError({ InstructionError: [2, { Custom: 6005 }] }, { programIds: ids }),
    'That amount is too small to trade.',
  )
  assert.equal(
    explainError({ InsufficientFundsForRent: { account_index: 0 } }),
    MESSAGES.walletRent,
  )
  assert.equal(
    explainError({ InsufficientFundsForRent: { account_index: 7 } }),
    MESSAGES.accountRent,
  )
  assert.equal(explainError({ InstructionError: [1, 'InsufficientFunds'] }), MESSAGES.noSol)
  assert.match(explainError({ InstructionError: [2, { Custom: 6002 }] }), /program error 6002/)
})

// ---------------------------------------------------------------------------------------------
// Second pass: re-sends refused as "already processed", the native-launch cap, the Quantum pause
// check before signing, and the proxy's exact rate-limit and upstream-failure messages
// ---------------------------------------------------------------------------------------------

const { isAlreadyProcessedError, sendSigned } = await import('../../src/lib/txflow.js')

// What web3.js throws when preflight finds the bytes in the status cache.
const alreadyProcessed = () =>
  new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage:
      'Transaction simulation failed: This transaction has already been processed',
    logs: [],
  })

test('a re-send refused as "already processed" is confirmed by polling, never shown as a failure', async () => {
  assert.equal(isAlreadyProcessedError(alreadyProcessed()), true)
  assert.equal(
    isAlreadyProcessedError(Object.assign(Error('x'), { data: { err: 'AlreadyProcessed' } })),
    true,
  )
  assert.equal(
    isAlreadyProcessedError(Object.assign(Error('wrapped'), { cause: alreadyProcessed() })),
    true,
  )
  assert.equal(
    isAlreadyProcessedError(Error('Transaction simulation failed: Blockhash not found')),
    false,
  )
  assert.equal(
    isAlreadyProcessedError(Error('Simulation failed. Message: custom program error: 0x1772')),
    false,
  )

  // The first send reached the cluster but its response was lost (502); the re-send of the same
  // bytes is refused as already processed. The trade landed: it must confirm, not fail.
  let sends = 0
  const sendRaw = async () => {
    if (++sends === 1)
      throw Error('502 Bad Gateway: {"error":"Solana RPC is unreachable. Try again shortly."}')
    throw alreadyProcessed()
  }
  const connection = fakeConnection({ statuses: () => confirmed, heights: () => 10 })
  const signatures = await sendAndConfirmAll(1, {
    send: () => sendSigned('sigLanded', sendRaw, { sleep: noSleep }),
    confirm: (signature) => confirmWith(connection, signature, 100, { sleep: noSleep }),
  })
  assert.deepEqual(signatures, ['sigLanded'])
  assert.equal(sends, 2)
  assert.equal(connection.calls.statuses.length, 1, 'the signature was polled')

  // If that earlier send failed on-chain, polling reports the on-chain failure with its
  // signature, still not a send failure that hides the transaction.
  const failedOnChain = fakeConnection({
    statuses: () => ({
      confirmationStatus: 'confirmed',
      err: { InstructionError: [0, { Custom: 1 }] },
    }),
  })
  const e = await sendAndConfirmAll(1, {
    send: () =>
      sendSigned('sigFailed', async () => Promise.reject(alreadyProcessed()), { sleep: noSleep }),
    confirm: (signature) => confirmWith(failedOnChain, signature, 100, { sleep: noSleep }),
  }).catch((x) => x)
  assert.equal(e.failed, true)
  assert.equal(e.failedSignature, 'sigFailed')
})

test('sendSigned: transient failures end as unknown with the signature, others as a worded failure', async () => {
  let calls = 0
  let e = await sendSigned(
    'sigU',
    async () => {
      calls++
      throw Error(
        '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"rate limited"}}',
      )
    },
    { sleep: noSleep },
  ).catch((x) => x)
  assert.equal(calls, 3, 'the same bytes are re-sent on transient failures')
  assert.equal(e.unknown, true)
  assert.equal(e.signature, 'sigU')

  calls = 0
  const cause = Error('Simulation failed. Message: custom program error: 0x1772')
  e = await sendSigned(
    'sigF',
    async () => {
      calls++
      throw cause
    },
    { sleep: noSleep, explain: () => 'Price moved past your slippage limit.' },
  ).catch((x) => x)
  assert.equal(calls, 1)
  assert.equal(e.message, 'Price moved past your slippage limit.')
  assert.equal(e.friendly, true)
  assert.equal(e.cause, cause)
  assert.notEqual(e.unknown, true)

  assert.equal(await sendSigned('sigOk', async () => 'sigOk', { sleep: noSleep }), 'sigOk')
})

test('the rpc proxy 429 and 502 answers are transient; its 400 for too many keys is not', () => {
  for (const message of [
    '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32005,"message":"Too many requests"},"id":1}',
    '502 Bad Gateway: {"error":"Solana RPC is unreachable. Try again shortly."}',
    '502 Bad Gateway: {"error":"Solana RPC returned 503."}',
  ])
    assert.equal(isTransientRpcError(Error(message)), true, message)
  assert.equal(
    isTransientRpcError(Error('400 Bad Request: {"error":"Request at most 100 accounts."}')),
    false,
  )
})

test('a rate-limited RPC reads as a busy network, never the raw 429 body', () => {
  const e = Error(
    'failed to get recent blockhash: Error: 429 Too Many Requests:  {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}, "id": 1 }',
  )
  assert.equal(friendlyWalletError(e), MESSAGES.busy)
  assert.equal(
    friendlyWalletError(Object.assign(Error('rejected'), { code: 4001 })),
    MESSAGES.declined,
  )
})

test('a launch_cap answer stops retrying and tracks the coin without marking the job registered', async () => {
  assert.equal(plan.registrationOutcome({ status: 429, code: 'launch_cap' }), 'capped')
  assert.equal(plan.registrationOutcome({ status: 429 }), 'retry', 'a plain rate limit retries')

  const calls = []
  const delays = []
  const result = await plan.registerLaunch({
    signature: 'sigC',
    mint: 'M',
    sleep: async (ms) => delays.push(ms),
    post: async (path, body) => {
      calls.push([path, body])
      if (path === '/api/launches')
        throw Object.assign(Error('Quant Pad is not accepting new launches right now.'), {
          status: 429,
          code: 'launch_cap',
        })
    },
  })
  assert.equal(result.status, 'capped')
  assert.deepEqual(delays, [], 'no retries')
  assert.deepEqual(calls, [
    ['/api/launches', { signature: 'sigC', mint: 'M' }],
    ['/api/coins/track', { mint: 'M' }],
  ])

  // registerOnce: a capped registration is tried again on a later visit; an external one is settled.
  const memory = new Map()
  const storage = {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  }
  const answer = (error) => async (path) => {
    if (path === '/api/launches') throw error
  }
  const capped = plan.newJob({ mint: key().toBase58(), snapshot: snapshotFor() })
  capped.done.launch = 'sigC'
  plan.saveJob(storage, capped)
  const first = await plan.registerOnce(capped, {
    storage,
    sleep: noSleep,
    post: answer(Object.assign(Error('cap'), { status: 429, code: 'launch_cap' })),
  })
  assert.equal(first.status, 'capped')
  assert.equal(capped.registered, false)
  assert.equal(plan.loadJob(storage, capped.mint).registered, false)

  const external = plan.newJob({ mint: key().toBase58(), snapshot: snapshotFor() })
  external.done.launch = 'sigE'
  plan.saveJob(storage, external)
  await plan.registerOnce(external, {
    storage,
    sleep: noSleep,
    post: answer(Object.assign(Error('no'), { status: 400, code: 'not_quantpad' })),
  })
  assert.equal(external.registered, true)
  assert.equal(plan.loadJob(storage, external.mint).registered, true)
})

test('a Quantum launch is not signed while Quantum Hooks is paused', async () => {
  const { BorshCoder } = await import('@coral-xyz/anchor')
  const coder = new BorshCoder(quantumClient.QUANTUM_IDL)
  const configAccount = async (paused) => ({
    data: await coder.accounts.encode('Config', {
      authority: key(),
      treasury: key(),
      keeper: key(),
      protocol_bps: 100,
      max_burn_lamports: new BN(1_000_000_000),
      min_action_interval: new BN(60),
      keeper_grace: new BN(300),
      paused,
      bump: 255,
    }),
    owner: quantumClient.QUANTUM_PROGRAM_ID,
    lamports: 1,
    executable: false,
  })

  // The rule.
  assert.equal(plan.quantumConfigError({ paused: false }), null)
  const paused = plan.quantumConfigError({ paused: true })
  assert.equal(paused.code, 'quantum_paused')
  assert.match(paused.message, /Quantum launches are paused/)
  assert.equal(paused.retryable, true, 'the same job can be finished once launches reopen')
  assert.equal(plan.quantumConfigError(null).code, 'quantum_unavailable')

  // Only a job that still has to send register is checked.
  const job = plan.newJob({ mint: key().toBase58(), snapshot: snapshotFor() })
  assert.equal(plan.needsRegister(job), true)
  job.done.register = 'sigR'
  assert.equal(plan.needsRegister(job), false)
  const standard = plan.newJob({
    mint: key().toBase58(),
    snapshot: snapshotFor({ quantum: false }),
  })
  assert.equal(plan.needsRegister(standard), false)

  // The live read right before signing (the page's status can be a minute old).
  const original = solana.connection.getAccountInfo
  const reads = []
  try {
    solana.connection.getAccountInfo = async (address) => {
      reads.push(address.toBase58())
      return configAccount(true)
    }
    await assert.rejects(launch.assertQuantumOpen(), { code: 'quantum_paused' })
    assert.deepEqual(reads, [quantumClient.configPda().toBase58()])

    solana.connection.getAccountInfo = async () => configAccount(false)
    await launch.assertQuantumOpen()

    solana.connection.getAccountInfo = async () => null
    await assert.rejects(launch.assertQuantumOpen(), { code: 'quantum_unavailable' })

    // A failed read does not block the launch: preflight still refuses a paused register.
    solana.connection.getAccountInfo = async () => {
      throw Error('502 Bad Gateway: x')
    }
    await launch.assertQuantumOpen()
  } finally {
    solana.connection.getAccountInfo = original
  }
})
