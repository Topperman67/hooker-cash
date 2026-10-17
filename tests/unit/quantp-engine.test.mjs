// The $QUANTP payout engine (server/quantp-engine.mjs): the market cap tiers, who is eligible,
// what a run releases and where it goes, the transactions it builds (the buyback against the
// $QUANTP DAMM v2 pool's mainnet state, as in quantp.test.mjs), that it never sends without its
// pinned key, and a run against a stubbed chain: once an hour, under a lock, stopping at the
// first failure. Nothing here reaches a network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  decodeBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  buybackInstructions,
  createQuantpEngine,
  dailyBpsAt,
  eligibleHolders,
  engineBlocker,
  payoutTransactions,
  planRun,
  refusedBeforeRunning,
} from '../../server/quantp-engine.mjs'
import { createApplication } from '../../server/application.mjs'
import { DAMM_POOL_AUTHORITY, decodeDammPool } from '../../shared/meteora.mjs'
import { QUANTP, network } from '../../shared/network.mjs'

const wallet = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58()
const SUPPLY = 1_000_000_000_000_000n // 1B at 6 decimals
const MIN = 1_500_000_000_000n // 0.15% of it
const [A, B, C, D, E] = [11, 12, 13, 14, 15].map(wallet)
const INCINERATOR = '1nc1nerator11111111111111111111111111111111'

// The $QUANTP DAMM v2 pool on mainnet just after graduation (tests/unit/quantp.test.mjs).
const DAMM_POOL = 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw'
const DAMM = Buffer.from(
  '8ZptBBGxbbyA8PoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7tensUw7MAwAAAAAAAAAAYif3sgFIIVlmSXHa8mSQdaoGusROIxyQZUVf/USRFoIGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAfdADFl+KbCeOTeOcvLfyVaaXEA0MClTdT4rHLlVLlKMQYSh6/B+6RPx43oLoSsFLy2cxAIxA0nzhGd+ORIzJAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv3ouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEsCrQIAAAAAAAAAAAAAAAAAAAAAAAAAAFA7AQABAAAAAAAAAAAAAACbV2lOqRpchLHE/v8AAAAAsBG0s6GXzAMAAAAAAAAAAGib0WoAAAAAAQABAAEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKivW7q/QIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAA+CbQKAAAAAAAAAAAAAAAAAAAAAAAAAABLAq0CAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAA2mNoH3KGvMgGcZ4sK1CiAVckO/yWaLEVILxThD7c2wiXLSZAD/EAAPX8aZcNAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
)

test('the share of the wallet released per day rises with the market cap', () => {
  assert.equal(dailyBpsAt(null), 2000)
  assert.equal(dailyBpsAt(50_000), 2000)
  assert.equal(dailyBpsAt(99_999), 2000)
  assert.equal(dailyBpsAt(100_000), 5000)
  assert.equal(dailyBpsAt(999_999), 5000)
  assert.equal(dailyBpsAt(1_000_000), 10_000)
  assert.equal(dailyBpsAt(25_000_000), 10_000)
})

test('eligible: wallets holding at least 0.15% of the supply, summed, team and pools left out', () => {
  const accounts = [
    { owner: A, amount: MIN }, // exactly 0.15%
    { owner: B, amount: MIN - 1n }, // just under
    { owner: C, amount: 1_000_000_000_000n }, // two accounts that add up
    { owner: C, amount: 1_000_000_000_000n },
    { owner: D, amount: 4_000_000_000_000n },
    { owner: DAMM_POOL_AUTHORITY.toBase58(), amount: 300_000_000_000_000n }, // a pool's vault
    { owner: QUANTP.creator, amount: 5_000_000_000_000n }, // the team's own
    { owner: INCINERATOR, amount: 9_000_000_000_000n }, // burned
  ]
  const held = eligibleHolders(accounts, {
    supply: SUPPLY,
    minHoldBps: 15,
    exclude: [QUANTP.creator, QUANTP.payoutWallet],
  })
  assert.deepEqual(held, [
    { owner: D, amount: 4_000_000_000_000n },
    { owner: C, amount: 2_000_000_000_000n },
    { owner: A, amount: MIN },
  ])
  // after burns the supply is smaller, and so is the bar
  assert.equal(
    eligibleHolders([{ owner: B, amount: MIN - 1n }], { supply: SUPPLY - 1_000n, minHoldBps: 15 })
      .length,
    1,
  )
})

const HOLDERS = [
  { owner: D, amount: 4_000_000_000_000n },
  { owner: C, amount: 2_000_000_000_000n },
  { owner: A, amount: MIN },
]

test('a run releases the tier’s daily share over 24 runs: 60% to holders by balance, 40% to buy back', () => {
  // 1.02 SOL, 0.02 kept for fees: 1 SOL × 20% a day ÷ 24
  const plan = planRun({ balance: 1_020_000_000n, marketCapUsd: 50_000, holders: HOLDERS })
  assert.equal(plan.available, 1_000_000_000n)
  assert.equal(plan.dailyBps, 2000)
  assert.equal(plan.release, 8_333_333n)
  assert.equal(plan.holdersPot, 4_999_999n)
  assert.equal(plan.buybackPot, 3_333_334n)
  assert.equal(plan.buyback, 3_333_334n)
  assert.equal(plan.eligible, 3)
  assert.deepEqual(
    plan.payouts.map((p) => [p.wallet, p.lamports]),
    [
      [D, 2_666_666n],
      [C, 1_333_333n],
      [A, 999_999n],
    ],
  )
  assert.equal(plan.paying, 4_999_998n)
  // above $1M a day's runs release the whole wallet
  assert.equal(
    planRun({ balance: 1_020_000_000n, marketCapUsd: 2_000_000, holders: HOLDERS }).release,
    41_666_666n,
  )
  // never more than 1 SOL in one run, and nothing below the fee reserve
  assert.equal(
    planRun({ balance: 1_000_000_000_000n, marketCapUsd: 2_000_000, holders: HOLDERS }).release,
    1_000_000_000n,
  )
  const dry = planRun({ balance: 15_000_000n, marketCapUsd: 50_000, holders: HOLDERS })
  assert.deepEqual([dry.release, dry.payouts, dry.buyback], [0n, [], 0n])
})

test('shares too small wait for a later run: under the minimum, or under rent for an empty wallet', () => {
  // 0.1 SOL: 0.08 available, 666,666 lamports released, 399,999 for holders
  const plan = planRun({
    balance: 100_000_000n,
    marketCapUsd: 50_000,
    holders: HOLDERS,
    lamportsOf: new Map([[D, 0n]]), // D's wallet is empty: 213,332 is under its rent minimum
    policy: { ...QUANTP.engine, minTransferLamports: '100000' },
  })
  assert.equal(plan.holdersPot, 399_999n)
  assert.deepEqual(
    plan.payouts.map((p) => [p.wallet, p.lamports]),
    [[C, 106_666n]], // A's 79,999 is under the minimum transfer
  )
  // a 266,667-lamport buyback is under its 0.002 SOL minimum
  assert.equal(plan.buybackPot, 266_667n)
  assert.equal(plan.buyback, 0n)
})

test('payouts go out 18 transfers a transaction, from the engine wallet', () => {
  const engine = wallet(40)
  const payouts = Array.from({ length: 45 }, (_, i) => ({
    wallet: wallet(50 + i),
    lamports: BigInt(1_000_000 + i),
  }))
  const txs = payoutTransactions(engine, payouts)
  assert.deepEqual(
    txs.map((t) => [t.recipients, t.instructions.length]),
    [
      [18, 18],
      [18, 18],
      [9, 9],
    ],
  )
  const first = SystemInstruction.decodeTransfer(txs[0].instructions[0])
  assert.equal(first.fromPubkey.toBase58(), engine)
  assert.equal(first.toPubkey.toBase58(), payouts[0].wallet)
  assert.equal(first.lamports, 1_000_000n)
  assert.equal(
    txs.reduce((s, t) => s + t.lamports, 0n),
    payouts.reduce((s, p) => s + p.lamports, 0n),
  )
})

test('a buyback swaps SOL for $QUANTP in its DAMM v2 pool and burns what it bought plus what it held', async () => {
  const damm = decodeDammPool(DAMM)
  const engine = QUANTP.payoutWallet
  const held = 3_070_967_498_088n
  const buy = await buybackInstructions({
    venue: { damm, dammPool: DAMM_POOL },
    wallet: engine,
    lamports: 10_000_000n,
    held,
    point: 1_792_130_000n,
    slippageBps: 300,
  })
  assert.ok(buy.minOut > 0n && buy.minOut < buy.expected)
  assert.ok(buy.minOut * 10_000n >= buy.expected * 9_700n - 10_000n) // within 3%
  assert.equal(buy.burn, buy.minOut + held)
  const programs = buy.instructions.map((ix) => ix.programId.toBase58())
  assert.ok(programs.includes(network.dammV2Program), 'the swap runs in the DAMM v2 pool')
  assert.ok(programs.includes(SystemProgram.programId.toBase58()), 'SOL is wrapped for it')
  // the burn comes last, after the swap filled the wallet's $QUANTP account
  const burn = decodeBurnCheckedInstruction(buy.instructions.at(-1), TOKEN_2022_PROGRAM_ID)
  const account = getAssociatedTokenAddressSync(
    new PublicKey(QUANTP.mint),
    new PublicKey(engine),
    false,
    TOKEN_2022_PROGRAM_ID,
  )
  assert.equal(burn.keys.account.pubkey.toBase58(), account.toBase58())
  assert.equal(burn.keys.mint.pubkey.toBase58(), QUANTP.mint)
  assert.equal(burn.keys.owner.pubkey.toBase58(), engine)
  assert.equal(burn.data.amount, buy.burn)
  assert.equal(burn.data.decimals, 6)
})

// ---- the engine itself ----------------------------------------------------------------------------

const KEY = Keypair.fromSeed(new Uint8Array(32).fill(7))
const SECRET = bs58.encode(KEY.secretKey)
const PINNED = { ...QUANTP.engine, wallet: KEY.publicKey.toBase58() }

test('it never sends without its pinned key: unpinned, no key, a bad key, another key, paused', async () => {
  assert.equal(engineBlocker({ pinned: null, keypair: KEY }), 'unpinned')
  const reasons = []
  for (const [policy, secret, paused] of [
    [{ ...PINNED, wallet: null }, SECRET, false],
    [PINNED, undefined, false],
    [PINNED, 'not-a-key', false],
    [PINNED, bs58.encode(Keypair.fromSeed(new Uint8Array(32).fill(8)).secretKey), false],
    [PINNED, SECRET, true],
  ]) {
    const engine = createQuantpEngine({
      connection: {},
      store: {},
      feed: {},
      secret,
      paused,
      policy,
    })
    reasons.push((await engine.tick()).reason)
  }
  assert.deepEqual(reasons, ['unpinned', 'no-key', 'bad-key', 'key-mismatch', 'paused'])
  const unpinned = createQuantpEngine({
    connection: {},
    store: {},
    feed: {},
    policy: { ...PINNED, wallet: null },
  })
  assert.deepEqual(await unpinned.status(), { configured: false })
})

/** A store in memory that can be made to fail. */
function memoryStore() {
  const values = new Map()
  return {
    values,
    down: false,
    async get(name) {
      if (this.down) throw Error('store down')
      return values.has(name) ? values.get(name) : null
    },
    async set(name, value, { nx = false } = {}) {
      if (this.down) throw Error('store down')
      if (nx && values.has(name)) return false
      values.set(name, value)
      return true
    },
    async release(name, owner) {
      if (values.get(name) === owner) values.delete(name)
    },
  }
}

/**
 * A chain with `holders` ([owner, raw amount]) that confirms what is sent, or refuses the n-th (a
 * program failing in preflight, with its logs). Its first `refuse` sends are refused before any
 * program runs, as a node behind the one that gave the blockhash refuses them (no logs).
 */
function stubChain({ balance = 1_020_000_000, holders, failAt = 0, refuse = 0, newest = null }) {
  const holderData = (owner, amount) => {
    const data = Buffer.alloc(40)
    new PublicKey(owner).toBuffer().copy(data, 0)
    data.writeBigUInt64LE(BigInt(amount), 32)
    return data
  }
  let blockhashes = 0
  return {
    sent: [],
    refused: [],
    async getBalance() {
      return balance
    },
    async getProgramAccounts(program, { filters }) {
      assert.equal(program.toBase58(), network.token2022Program)
      assert.equal(filters[0].memcmp.bytes, QUANTP.mint)
      return holders.map(([owner, amount]) => ({ account: { data: holderData(owner, amount) } }))
    },
    async getMultipleAccountsInfo(keys) {
      return keys.map(() => ({ lamports: 5_000_000 }))
    },
    async getTokenAccountBalance() {
      throw Error('could not find account')
    },
    async getRecentPrioritizationFees() {
      return []
    },
    async getLatestBlockhash() {
      blockhashes++
      return {
        blockhash: new PublicKey(new Uint8Array(32).fill(blockhashes)).toBase58(),
        lastValidBlockHeight: 1_000,
      }
    },
    async sendRawTransaction(bytes) {
      const tx = VersionedTransaction.deserialize(bytes)
      if (this.refused.length < refuse) {
        this.refused.push(tx)
        throw Object.assign(
          Error('Simulation failed. \nMessage: Transaction simulation failed. \nLogs: \n[].'),
          { transactionLogs: [] },
        )
      }
      this.sent.push(tx)
      if (this.sent.length === failAt)
        throw Object.assign(Error('Transaction simulation failed: insufficient funds'), {
          transactionLogs: ['Program log: Error: insufficient funds'],
        })
      return bs58.encode(tx.signatures[0])
    },
    async getSignatureStatuses(signatures) {
      return { value: signatures.map(() => ({ confirmationStatus: 'confirmed', err: null })) }
    },
    async getBlockHeight() {
      return 10
    },
    async getSignaturesForAddress() {
      return newest ? [newest] : []
    },
  }
}

const feed = { snapshot: async () => ({ supply: SUPPLY.toString(), marketCapUsd: 50_000 }) }
// 25 eligible wallets, the most 3% of the supply each: two payout transactions
const MANY = Array.from({ length: 25 }, (_, i) => [
  wallet(100 + i),
  30_000_000_000_000n - BigInt(i),
])
// Payouts only: no buyback is big enough (its DAMM v2 path is covered above and on mainnet).
const PAYOUTS_ONLY = { ...PINNED, minBuybackLamports: '1000000000000' }

/** The SOL transfers in sent transactions: [from, to, lamports]. */
function transfersIn(tx) {
  const keys = tx.message.staticAccountKeys
  return tx.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex].equals(SystemProgram.programId))
    .map((ix) => {
      const t = SystemInstruction.decodeTransfer(
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: ix.accountKeyIndexes.map((i) => ({
            pubkey: keys[i],
            isSigner: tx.message.isAccountSigner(i),
            isWritable: tx.message.isAccountWritable(i),
          })),
          data: Buffer.from(ix.data),
        }),
      )
      return [t.fromPubkey.toBase58(), t.toPubkey.toBase58(), t.lamports]
    })
}

test('a live run: once an hour, every eligible holder paid by balance in signed transfers', async () => {
  const clock = { t: 1_800_000_000_000 }
  const store = memoryStore()
  const connection = stubChain({ holders: MANY })
  const engine = createQuantpEngine({
    connection,
    store,
    feed,
    secret: SECRET,
    policy: PAYOUTS_ONLY,
    now: () => clock.t,
    log: { error() {} },
  })
  const run = await engine.tick()
  assert.equal(run.ran, true)
  assert.equal(run.eligible, 25)
  assert.equal(run.paying, 25)
  assert.equal(run.release, '8333333')
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [18, 7],
  )
  assert.equal(run.buyback, null)
  // what went out: signed by the engine, 25 transfers that add up to the holders' 60%
  assert.equal(connection.sent.length, 2)
  const transfers = connection.sent.flatMap(transfersIn)
  assert.equal(transfers.length, 25)
  assert.ok(transfers.every(([from]) => from === KEY.publicKey.toBase58()))
  assert.deepEqual(new Set(transfers.map(([, to]) => to)), new Set(MANY.map(([owner]) => owner)))
  const paid = transfers.reduce((s, [, , l]) => s + l, 0n)
  assert.ok(paid <= 4_999_999n && paid > 4_999_999n - 25n)
  assert.equal(run.payouts[0].signature, bs58.encode(connection.sent[0].signatures[0]))
  assert.equal(connection.sent[0].message.staticAccountKeys[0].toBase58(), KEY.publicKey.toBase58())
  assert.equal(store.values.get('quantp:engine:last'), clock.t)
  assert.equal(store.values.has('quantp:engine:lock'), false, 'the lock is released')

  // ten minutes later: not due
  clock.t += 600_000
  const early = await engine.tick()
  assert.deepEqual([early.ran, early.reason], [false, 'not-due'])
  assert.equal(early.nextAt, clock.t - 600_000 + 3_600_000)
  assert.equal(connection.sent.length, 2)
  // another instance holds the lock
  clock.t += 3_000_000
  await store.set('quantp:engine:lock', 'someone', { nx: true })
  assert.equal((await engine.tick()).reason, 'locked')
  await store.release('quantp:engine:lock', 'someone')
  // an hour on: it runs again
  assert.equal((await engine.tick()).ran, true)
  assert.equal(connection.sent.length, 4)
})

test('a run stops at the first transaction that fails, and is not repeated for an hour', async () => {
  const clock = { t: 1_800_000_000_000 }
  const store = memoryStore()
  const connection = stubChain({ holders: MANY, failAt: 2 })
  const engine = createQuantpEngine({
    connection,
    store,
    feed,
    secret: SECRET,
    policy: PAYOUTS_ONLY,
    now: () => clock.t,
    log: { error() {} },
  })
  const run = await engine.tick()
  assert.equal(run.ran, true)
  assert.match(run.error, /insufficient funds/)
  // the first went out and is reported; the second was refused; nothing after it
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [18],
  )
  assert.equal(connection.sent.length, 2)
  clock.t += 60_000
  assert.equal((await engine.tick()).reason, 'not-due')
})

test('with the store down, the wallet’s newest transaction says when it last ran', async () => {
  const clock = { t: 1_800_000_000_000 }
  const store = memoryStore()
  store.down = true
  const recent = stubChain({ holders: MANY, newest: { blockTime: clock.t / 1000 - 600 } })
  const engine = (connection) =>
    createQuantpEngine({
      connection,
      store,
      feed,
      secret: SECRET,
      policy: PAYOUTS_ONLY,
      now: () => clock.t,
      log: { error() {} },
    })
  assert.equal((await engine(recent).tick()).reason, 'not-due')
  assert.equal(recent.sent.length, 0)
  const old = stubChain({ holders: MANY, newest: { blockTime: clock.t / 1000 - 7_200 } })
  assert.equal((await engine(old).tick()).ran, true)
  assert.equal(old.sent.length, 2)
})

test('status says what the next run would release, to how many, and whether it is live', async () => {
  const clock = { t: 1_800_000_000_000 }
  const store = memoryStore()
  store.values.set('quantp:engine:last', clock.t - 1_200_000)
  const status = await createQuantpEngine({
    connection: stubChain({ holders: MANY }),
    store,
    feed,
    policy: PINNED, // no key on this server
    now: () => clock.t,
  }).status()
  assert.equal(status.configured, true)
  assert.equal(status.wallet, KEY.publicKey.toBase58())
  assert.deepEqual([status.live, status.reason], [false, 'no-key'])
  assert.equal(status.minHold, MIN.toString())
  assert.equal(status.dailyBps, 2000)
  assert.equal(status.balance, '1020000000')
  assert.deepEqual(status.next, {
    release: '8333333',
    holders: status.next.holders,
    buyback: '3333334',
    paying: 25,
  })
  assert.equal(status.eligible, 25)
  assert.equal(status.lastRunAt, (clock.t - 1_200_000) / 1000)
  assert.equal(status.state, 'ok')
})

test('the keeper tick runs the engine first, and GET /api/quantp/engine shows its status', async () => {
  const calls = []
  const quantpEngine = {
    async tick({ deadline }) {
      calls.push(['tick', deadline])
      return { ran: false, reason: 'not-due' }
    },
    async status() {
      return { configured: true, live: false, reason: 'no-key' }
    },
  }
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'tick-secret'
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-engine-')),
    serverless: true,
    quantum: null,
    background: false,
    connection: {},
    priceFeed: async () => ({ usd: 150 }),
    quantpEngine,
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const status = await fetch(base + '/api/quantp/engine')
    assert.equal(status.status, 200)
    assert.deepEqual(await status.json(), { configured: true, live: false, reason: 'no-key' })
    assert.equal((await fetch(base + '/api/keeper/tick')).status, 401)
    assert.equal(calls.length, 0)
    const started = Date.now()
    const tick = await fetch(base + '/api/keeper/tick', {
      headers: { authorization: 'Bearer tick-secret' },
    })
    const body = await tick.json()
    assert.deepEqual(body.engine, { ran: false, reason: 'not-due' })
    assert.equal(calls.length, 1)
    assert.ok(calls[0][1] >= started + 25_000 - 1_000 && calls[0][1] <= Date.now() + 25_000)
  } finally {
    process.env.CRON_SECRET = previous
    if (previous === undefined) delete process.env.CRON_SECRET
    await new Promise((r) => server.close(r))
    app.close()
  }
})

test('with the store down, dust sent to the wallet does not hold off a run: its last payout counts', async () => {
  const clock = { t: 1_800_000_000_000 }
  const store = memoryStore()
  store.down = true
  // what the ledger read: the engine wallet's last payout `paidSecsAgo` ago (or never)
  const ledgerSaying = (paidSecsAgo, { unread = 0 } = {}) => ({
    async ledger() {
      return {
        unread,
        payouts:
          paidSecsAgo == null
            ? []
            : [
                {
                  wallet: KEY.publicKey.toBase58(),
                  transactions: [{ timestamp: clock.t / 1000 - paidSecsAgo }],
                },
              ],
        burns: [],
      }
    },
  })
  // the wallet's newest transaction is dust a stranger sent a minute ago
  const engine = (ledger) =>
    createQuantpEngine({
      connection: stubChain({ holders: MANY, newest: { blockTime: clock.t / 1000 - 60 } }),
      store,
      feed,
      ledger,
      secret: SECRET,
      policy: PAYOUTS_ONLY,
      now: () => clock.t,
      log: { error() {} },
    })
  // last paid two hours ago: due, dust or not
  assert.equal((await engine(ledgerSaying(7_200)).tick()).ran, true)
  // paid ten minutes ago: not due
  assert.equal((await engine(ledgerSaying(600)).tick()).reason, 'not-due')
  // never paid: due
  assert.equal((await engine(ledgerSaying(null)).tick()).ran, true)
  // the ledger has not read everything yet: the newest transaction (the dust) counts, and it waits
  assert.equal((await engine(ledgerSaying(7_200, { unread: 1 })).tick()).reason, 'not-due')
})

test('a transaction refused before any program ran is sent again with a fresh blockhash', async () => {
  const clock = { t: 1_800_000_000_000 }
  const run = async (refuse) => {
    const connection = stubChain({ holders: MANY, refuse })
    const engine = createQuantpEngine({
      connection,
      store: memoryStore(),
      feed,
      secret: SECRET,
      policy: PAYOUTS_ONLY,
      now: () => clock.t,
      log: { error() {} },
      retryMs: 0,
    })
    return { connection, report: await engine.tick() }
  }
  // refused twice, through on the third try: the run goes on and pays everyone
  const twice = await run(2)
  assert.equal(twice.report.error, undefined)
  assert.equal(twice.report.payouts.length, 2)
  assert.equal(twice.connection.sent.length, 2)
  const hashes = [...twice.connection.refused, twice.connection.sent[0]].map(
    (tx) => tx.message.recentBlockhash,
  )
  assert.equal(new Set(hashes).size, 3, 'each try has its own blockhash')
  // the same transfers each time
  assert.deepEqual(transfersIn(twice.connection.refused[0]), transfersIn(twice.connection.sent[0]))
  // refused three times: it stops there, having sent nothing
  const always = await run(3)
  assert.match(always.report.error, /Simulation failed/)
  assert.deepEqual(always.report.payouts, [])
  assert.equal(always.connection.sent.length, 0)
  // a program that failed (with logs) is not sent again
  assert.equal(
    refusedBeforeRunning(
      Object.assign(Error('Simulation failed. Message: Transaction simulation failed.'), {
        transactionLogs: ['Program log: Error: exceeded slippage'],
      }),
    ),
    false,
  )
  assert.equal(refusedBeforeRunning(Error('fetch failed')), false)
})

test('a store without the run’s record (refused at its plan limit) goes by the ledger', async () => {
  // half past the hour, and the engine wallet paid ten minutes ago
  const clock = { t: 1_800_000_000_000 + 1_800_000 }
  const paidAt = clock.t / 1000 - 600
  // Upstash at its plan limit: this read answers, empty, and the write is refused
  const store = {
    async get() {
      return null
    },
    async set() {
      throw Error('ERR max requests limit exceeded')
    },
    async release() {},
  }
  const ledger = {
    async ledger() {
      return {
        unread: 0,
        payouts: [{ wallet: KEY.publicKey.toBase58(), transactions: [{ timestamp: paidAt }] }],
        burns: [],
      }
    },
  }
  const connection = stubChain({ holders: MANY })
  const engine = createQuantpEngine({
    connection,
    store,
    feed,
    ledger,
    secret: SECRET,
    policy: PAYOUTS_ONLY,
    now: () => clock.t,
    log: { error() {} },
  })
  assert.equal((await engine.tick()).reason, 'not-due')
  assert.equal(connection.sent.length, 0)
  // and the site says when it last ran, not that it never has
  assert.equal((await engine.status()).lastRunAt, paidAt)
})
