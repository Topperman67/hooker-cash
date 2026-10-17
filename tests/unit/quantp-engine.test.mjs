// The $QUANTP payout engine (server/quantp-engine.mjs): the market cap tiers, who is eligible,
// what a run releases and where it goes, the transactions it builds (the buyback against the
// $QUANTP DAMM v2 pool's mainnet state, as in quantp.test.mjs), that it never sends without its
// pinned key, and runs against a stubbed chain: once an hour whatever the store does, the hour
// claimed on-chain (by one run's own claim, never late), one failing payout batch or recipient
// never stopping the rest, and refusals resent as the same signed bytes. Nothing here reaches a
// network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bs58 from 'bs58'
import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  SendTransactionError,
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
  engineMemo,
  engineTransaction,
  hourAccount,
  hourSeed,
  memoHour,
  payoutTransactions,
  planRun,
} from '../../server/quantp-engine.mjs'
import { createApplication } from '../../server/application.mjs'
import { DAMM_POOL_AUTHORITY, decodeDammPool } from '../../shared/meteora.mjs'
import { QUANTP, network } from '../../shared/network.mjs'

const wallet = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58()
const SUPPLY = 1_000_000_000_000_000n // 1B at 6 decimals
const MIN = 1_500_000_000_000n // 0.15% of it
const [A, B, C, D, E] = [11, 12, 13, 14, 15].map(wallet)
const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

// The $QUANTP DAMM v2 pool on mainnet just after graduation (tests/unit/quantp.test.mjs), with
// the DBC pool that graduated to it and its config.
const DAMM_POOL = 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw'
const DAMM = Buffer.from(
  '8ZptBBGxbbyA8PoCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7tensUw7MAwAAAAAAAAAAYif3sgFIIVlmSXHa8mSQdaoGusROIxyQZUVf/USRFoIGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAfdADFl+KbCeOTeOcvLfyVaaXEA0MClTdT4rHLlVLlKMQYSh6/B+6RPx43oLoSsFLy2cxAIxA0nzhGd+ORIzJAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAv3ouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEsCrQIAAAAAAAAAAAAAAAAAAAAAAAAAAFA7AQABAAAAAAAAAAAAAACbV2lOqRpchLHE/v8AAAAAsBG0s6GXzAMAAAAAAAAAAGib0WoAAAAAAQABAAEBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFKivW7q/QIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvnouXEpMyrSn06/UkwMAAAAAAAAAAAAAAAAAAAAAAAA+CbQKAAAAAAAAAAAAAAAAAAAAAAAAAABLAq0CAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAA2mNoH3KGvMgGcZ4sK1CiAVckO/yWaLEVILxThD7c2wiXLSZAD/EAAPX8aZcNAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
)
const POOL_MIGRATED = Buffer.from(
  '7du4Fyq9qSMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1L//ODinAbNVOgpEAlvh3xMczE5MhP7Cgr1nvmkPVoQgS8BvtFPCaOQZAkw3qGuKnYL0DjeP5FHtvEVfZ9Q+v2In97IBSCFZZklx2vJkkHWqBrrETiMckGVFX/1EkRaCXTZLIhKA9rcWoUSHTvbhzLuQx+y/DBUUNRFoymbVr5I/1ptwo6FSpIyi44+Q4WsIcWWKPXf6HsYSYHeohwTyBX/4KEat8QAA4mGT4w0AAAAAAAAAAAAAADiSyAIAAAAAAAAAAAAAAAAVlWMMAAAAADu16exTDswDAAAAAAAAAAAFhdFqAAAAAAEBAAADAAAAAAAAAAAAAABrw8EbAAAAAAAAAAAAAAAAY9DjewAAAABnm9FqAAAAAAAAAAAAAAAATjuAbwAAAAAAAAEAAAAAABQAAAAAAAAATo7yvHsAAACwC/gGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  'base64',
)
const CONFIG = Buffer.from(
  'KNzC+ynHe/0Gm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAQP9iGGhFqFWGj5S6+sk6ADB33YBO5S+wszJVMFqJ7jOIEvAb7RTwmjkGQJMN6hrip2C9A43j+RR7bxFX2fUPr8ALTEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAQYAAQAKAFoABgFaAQIAAAAAAAAAAMGHnV7RmwIAxWGT4w0AAAANVt4JrfEAADu16exTDswDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAACAxqR+jQMAAAD0AQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACLJG04mfRmAQAAAAAAAAAAO7Xp7FMOzAMAAAAAAAAAABPMVpM4y5IOZW5FocwFAACbV2lOqRpchLHE/v8AAAAA+Dcz1/X5Gh/2mwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADrXQRt8GD3lgOjIB1NwkMukHXli62JxVlmIA62JeIq3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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

test('eligible: the runtime’s reserved keys are never holders, on the curve or not', () => {
  const reserved = [
    '11111111111111111111111111111111', // the System Program: on the curve
    'SysvarRent111111111111111111111111111111111',
    'SysvarC1ock11111111111111111111111111111111',
    'Sysvar1111111111111111111111111111111111111',
    'NativeLoader1111111111111111111111111111111',
  ]
  assert.ok(PublicKey.isOnCurve(new PublicKey(reserved[0]).toBytes()))
  const held = eligibleHolders(
    [...reserved.map((owner) => ({ owner, amount: 9n * MIN })), { owner: A, amount: MIN }],
    { supply: SUPPLY, minHoldBps: 15 },
  )
  assert.deepEqual(held, [{ owner: A, amount: MIN }])
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
  assert.equal(plan.buybackSkipped, null)
  assert.equal(plan.eligible, 3)
  assert.equal(plan.held, 7_500_000_000_000n)
  assert.deepEqual(
    plan.payouts.map((p) => [p.wallet, p.lamports]),
    [
      [D, 2_666_666n],
      [C, 1_333_333n],
      [A, 999_999n],
    ],
  )
  assert.equal(plan.paying, 4_999_998n)
  // above $1M each run releases 100%/24 of the wallet: 24 runs release about 64% of it
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

test('shares too small are skipped that run: under the minimum, or under rent for an empty wallet', () => {
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
    [[C, 106_666n]],
  )
  // and why the others are not paid: A's 79,999 is under the minimum transfer
  assert.deepEqual(
    plan.skipped.map((s) => [s.wallet, s.lamports, s.reason]),
    [
      [D, 213_332n, 'no-sol'],
      [A, 79_999n, 'below-minimum'],
    ],
  )
  // a 266,667-lamport buyback is under its 0.002 SOL minimum: skipped, its SOL stays
  assert.equal(plan.buybackPot, 266_667n)
  assert.equal(plan.buyback, 0n)
  assert.equal(plan.buybackSkipped, 'below minimum')
})

test('an empty wallet is paid when its share covers the chain’s rent exemption', () => {
  // 0.16 SOL: 1,166,667 lamports released, 700,000 of it to the one holder, whose wallet is empty
  const run = (rentExemptLamports) =>
    planRun({
      balance: 160_000_040n,
      marketCapUsd: 50_000,
      holders: [{ owner: D, amount: MIN }],
      lamportsOf: new Map([[D, 0n]]),
      ...(rentExemptLamports ? { rentExemptLamports } : {}),
    })
  const paid = run(650_240n)
  assert.equal(paid.holdersPot, 700_000n)
  assert.deepEqual(
    paid.payouts.map((p) => [p.wallet, p.lamports]),
    [[D, 700_000n]],
  )
  // under the older 890,880 it waited
  assert.deepEqual(
    run(null).skipped.map((s) => s.reason),
    ['no-sol'],
  )
})

test('payouts go out 18 transfers a transaction, from the engine wallet, each ending with its memo', () => {
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
  // with the run's memo last, the longest a memo gets (a 1 SOL pot, the whole supply held), and
  // the largest compute budget: 18 transfers still fit the 1,232 bytes of a transaction
  const memo = engineMemo.payout(9_999_999, { holdersPot: 600_000_000n, held: SUPPLY })
  const [full] = payoutTransactions(engine, payouts, { memo })
  assert.equal(full.instructions.length, 19)
  assert.equal(full.instructions.at(-1).programId.toBase58(), MEMO)
  assert.equal(full.instructions.at(-1).data.toString(), memo)
  const tx = engineTransaction({
    payer: engine,
    instructions: full.instructions,
    units: 1_400_000,
    price: 500_000,
    blockhash: Keypair.generate().publicKey.toBase58(),
  })
  tx.sign([Keypair.fromSeed(new Uint8Array(32).fill(40))])
  assert.ok(tx.serialize().length <= 1_232, `${tx.serialize().length} bytes`)
  assert.equal(memoHour(`[${memo.length}] ${memo}`), 9_999_999)
  assert.equal(memoHour('[5] hello'), null)
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
const ENGINE = KEY.publicKey.toBase58()

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

/**
 * A store in memory that can be made to fail: `down` refuses everything, `readOnly` answers reads
 * and refuses writes (as Upstash at a plan limit can).
 */
function memoryStore() {
  const values = new Map()
  return {
    values,
    down: false,
    readOnly: false,
    async get(name) {
      if (this.down) throw Error('store down')
      return values.has(name) ? values.get(name) : null
    },
    async set(name, value, { nx = false } = {}) {
      if (this.down || this.readOnly) throw Error('store down')
      if (nx && values.has(name)) return false
      values.set(name, value)
      return true
    },
    async release(name, owner) {
      if (values.get(name) === owner) values.delete(name)
    },
  }
}

const SYSTEM = SystemProgram.programId
const plainWallet = (lamports = 5_000_000) => ({
  lamports,
  owner: SYSTEM,
  executable: false,
  data: Buffer.alloc(0),
})
const dbcAccount = (owner, data) => ({
  owner: new PublicKey(owner),
  data,
  lamports: 1,
  executable: false,
})
const VENUE = {
  [QUANTP.pool]: dbcAccount(network.dbcProgram, POOL_MIGRATED),
  [QUANTP.config]: dbcAccount(network.dbcProgram, CONFIG),
  [DAMM_POOL]: dbcAccount(network.dammV2Program, DAMM),
}

/** A sent transaction's instructions, decompiled. */
function instructionsOf(tx) {
  const keys = tx.message.staticAccountKeys
  return tx.message.compiledInstructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: keys[ix.programIdIndex],
        keys: ix.accountKeyIndexes.map((i) => ({
          pubkey: keys[i],
          isSigner: tx.message.isAccountSigner(i),
          isWritable: tx.message.isAccountWritable(i),
        })),
        data: Buffer.from(ix.data),
      }),
  )
}
const systemType = (ix) =>
  ix.programId.equals(SYSTEM) ? SystemInstruction.decodeInstructionType(ix) : null
const memosOf = (tx) =>
  instructionsOf(tx)
    .filter((ix) => ix.programId.toBase58() === MEMO)
    .map((ix) => ix.data.toString())
/** What an engine transaction is, from its memo: 'claim', 'payout' or 'buyback'. */
const kindOf = (tx) => {
  const memo = memosOf(tx).join(' ')
  return / h=\d+ claim [0-9a-f]{8}$/.test(memo)
    ? 'claim'
    : / pot=/.test(memo)
      ? 'payout'
      : / bb=/.test(memo)
        ? 'buyback'
        : null
}
/** The SOL transfers in a sent transaction: [from, to, lamports]. */
const transfersIn = (tx) =>
  instructionsOf(tx)
    .filter((ix) => systemType(ix) === 'Transfer')
    .map((ix) => {
      const t = SystemInstruction.decodeTransfer(ix)
      return [t.fromPubkey.toBase58(), t.toPubkey.toBase58(), t.lamports]
    })
const payoutsIn = (connection) =>
  connection.sent.filter((tx) => kindOf(tx) === 'payout').flatMap(transfersIn)
const signatureOf = (tx) => bs58.encode(tx.signatures[0])
/** A preflight refusal as web3.js throws it. */
const refusal = (message, logs) =>
  new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: message, logs })

/**
 * A chain holding `holders` ([owner, raw amount]) that acts as a node would on what is sent:
 * preflight refuses (a web3.js SendTransactionError) a transaction that would fail, and what
 * lands is confirmed and listed in the wallet's history with its memo, at `clock`'s time.
 *   accounts: address -> account info (null for none), for holders' wallets (default: a wallet)
 *   readonly: wallets no transfer can credit (InstructionError ReadonlyLamportChange)
 *   created: the seed accounts that exist (a second createAccountWithSeed of one is refused)
 *   venue: serve the $QUANTP pools for the buyback; held: the wallet's $QUANTP
 * Tests set `refuse(tx, n)` to refuse the n-th preflight with an error of their own (a plain
 * Error is a network error: not refused, not landed), `simulate(tx)` to say what a simulation
 * finds, and `onLand(tx)` to act as a transaction lands. With `defer(tx)` set, what passes
 * preflight waits until a status poll finds `defer(tx)` false, and then lands, or fails on-chain
 * as preflight would refuse it then (listed with its error, and changing nothing). As a node
 * does, it takes the same signed bytes sent twice as one transaction.
 */
function stubChain({
  balance = 1_020_000_000,
  holders,
  clock = { t: HOUR0 },
  accounts = {},
  readonly = [],
  created = new Set(),
  rent = 890_880,
  venue = false,
  held = null,
  history = [],
}) {
  const holderData = (owner, amount) => {
    const data = Buffer.alloc(40)
    new PublicKey(owner).toBuffer().copy(data, 0)
    data.writeBigUInt64LE(BigInt(amount), 32)
    return data
  }
  const owners = new Set(holders.map(([owner]) => owner))
  const landed = new Map() // signature -> { tx, blockTime, err }
  const pending = new Map() // signature -> tx: past preflight, waiting on `defer`
  // What a node finds wrong with `tx`: { err, message, logs }, or null.
  const judge = (tx) => {
    for (const [i, ix] of instructionsOf(tx).entries()) {
      const type = systemType(ix)
      if (
        type === 'CreateWithSeed' &&
        created.has(SystemInstruction.decodeCreateWithSeed(ix).newAccountPubkey.toBase58())
      )
        return {
          err: { InstructionError: [i, { Custom: 0 }] },
          message: `Transaction simulation failed: Error processing Instruction ${i}: custom program error: 0x0`,
          logs: [
            'Program 11111111111111111111111111111111 invoke [1]',
            'Create Account with seed: account already in use',
            'Program 11111111111111111111111111111111 failed: custom program error: 0x0',
          ],
        }
      if (
        type === 'Transfer' &&
        readonly.includes(SystemInstruction.decodeTransfer(ix).toPubkey.toBase58())
      )
        return {
          err: { InstructionError: [i, 'ReadonlyLamportChange'] },
          message: `Transaction simulation failed: Error processing Instruction ${i}: instruction changed the balance of a read-only account`,
          logs: [
            'Program 11111111111111111111111111111111 invoke [1]',
            'Program 11111111111111111111111111111111 success',
          ],
        }
    }
    return null
  }
  return {
    sent: [], // what landed, in order
    attempts: [], // every sendRawTransaction: { signature, bytes, options }
    simulations: [],
    feeQueries: [],
    preflights: 0,
    created,
    history,
    signaturesFail: false,
    land(tx, err = null) {
      if (!err) {
        for (const ix of instructionsOf(tx)) {
          const type = systemType(ix)
          if (type === 'CreateWithSeed')
            created.add(SystemInstruction.decodeCreateWithSeed(ix).newAccountPubkey.toBase58())
          if (type === 'TransferWithSeed')
            created.delete(SystemInstruction.decodeTransferWithSeed(ix).fromPubkey.toBase58())
        }
        this.onLand?.(tx)
      }
      const blockTime = Math.floor(clock.t / 1000)
      landed.set(signatureOf(tx), { tx, blockTime, err })
      if (!err) this.sent.push(tx)
      const memos = memosOf(tx)
      history.unshift({
        signature: signatureOf(tx),
        blockTime,
        err,
        memo: memos.length ? memos.map((m) => `[${m.length}] ${m}`).join('; ') : null,
      })
    },
    async getBalance() {
      return balance
    },
    async getProgramAccounts(program, { filters }) {
      assert.equal(program.toBase58(), network.token2022Program)
      assert.equal(filters[0].memcmp.bytes, QUANTP.mint)
      return holders.map(([owner, amount]) => ({ account: { data: holderData(owner, amount) } }))
    },
    async getMultipleAccountsInfo(keys) {
      return keys.map((k) => {
        const a = k.toBase58()
        if (created.has(a)) return plainWallet(rent)
        if (a in accounts) return accounts[a]
        return owners.has(a) ? plainWallet() : null
      })
    },
    async getMinimumBalanceForRentExemption(space) {
      assert.equal(space, 0)
      return rent
    },
    async getTokenAccountBalance() {
      if (held == null) throw Error('could not find account')
      return { value: { amount: String(held) } }
    },
    async getRecentPrioritizationFees(config) {
      this.feeQueries.push(config?.lockedWritableAccounts?.map((k) => k.toBase58()))
      return []
    },
    async getLatestBlockhashAndContext() {
      return {
        context: { slot: 100 },
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000 },
      }
    },
    async getLatestBlockhash() {
      return (await this.getLatestBlockhashAndContext()).value
    },
    async sendRawTransaction(bytes, options = {}) {
      const tx = VersionedTransaction.deserialize(bytes)
      this.attempts.push({ signature: signatureOf(tx), bytes: Buffer.from(bytes), options })
      if (options.skipPreflight) return signatureOf(tx) // sent again: it lands once at most
      const refused = this.refuse?.(tx, ++this.preflights)
      if (refused) throw refused
      const wrong = judge(tx)
      if (wrong) throw refusal(wrong.message, wrong.logs)
      if (this.defer) {
        if (!landed.has(signatureOf(tx))) pending.set(signatureOf(tx), tx)
      } else this.land(tx)
      return signatureOf(tx)
    },
    async simulateTransaction(tx, config) {
      this.simulations.push({ tx, config })
      const wrong = this.simulate?.(tx) ?? judge(tx)
      return {
        context: { slot: 100 },
        value: { err: wrong?.err ?? null, logs: wrong?.logs ?? [], unitsConsumed: 1_234 },
      }
    },
    async getSignatureStatuses(signatures) {
      for (const s of signatures) {
        const tx = pending.get(s)
        if (tx && !this.defer(tx)) {
          pending.delete(s)
          this.land(tx, judge(tx)?.err ?? null)
        }
      }
      return {
        value: signatures.map((s) =>
          landed.has(s) ? { confirmationStatus: 'confirmed', err: landed.get(s).err } : null,
        ),
      }
    },
    async getBlockHeight() {
      return 10
    },
    async getSignaturesForAddress(address, { limit }) {
      assert.equal(address.toBase58(), ENGINE)
      if (this.signaturesFail) throw Error('429 Too Many Requests')
      return history.slice(0, limit)
    },
    async getTransaction(signature) {
      const own = landed.get(signature)
      if (own) return { blockTime: own.blockTime, transaction: { message: own.tx.message } }
      // someone else's transaction: its fee payer first
      const other = history.find((s) => s.signature === signature && s.payer)
      return other
        ? {
            blockTime: other.blockTime,
            transaction: { message: { staticAccountKeys: [new PublicKey(other.payer)] } },
          }
        : null
    },
    async getAccountInfo(key) {
      return venue ? (VENUE[key.toBase58()] ?? null) : null
    },
    async getSlot() {
      return 300_000_000
    },
  }
}

const HOUR0 = 1_800_000_000_000 // on the hour (UTC): hour 500,000
const HALF_PAST = HOUR0 + 1_800_000
const LAST = 'quantp:engine:last'
const feed = { snapshot: async () => ({ supply: SUPPLY.toString(), marketCapUsd: 50_000 }) }
// 25 eligible wallets, the most 3% of the supply each: two payout transactions
const MANY = Array.from({ length: 25 }, (_, i) => [
  wallet(100 + i),
  30_000_000_000_000n - BigInt(i),
])
const MANY_HELD = MANY.reduce((s, [, amount]) => s + amount, 0n)
// Payouts only: no buyback is big enough (the buyback has tests of its own below).
const PAYOUTS_ONLY = { ...PINNED, minBuybackLamports: '1000000000000' }
const quiet = { error() {}, warn() {} }
/** An engine on `connection` and `store`, its clock `clock` (which its waits move on). */
const engineOn = (connection, store, clock, options = {}) =>
  createQuantpEngine({
    connection,
    store,
    feed,
    secret: SECRET,
    policy: PAYOUTS_ONLY,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    log: quiet,
    ...options,
  })

test('a live run: the hour claimed on-chain, then every eligible holder paid by balance in signed transfers', async () => {
  const clock = { t: HOUR0 }
  const store = memoryStore()
  // the engine's own wallet and the team's hold the most, and are never paid
  const big = 90_000_000_000_000n
  const connection = stubChain({
    holders: [...MANY, [ENGINE, big], [QUANTP.creator, big], [QUANTP.payoutWallet, big]],
    clock,
  })
  const engine = engineOn(connection, store, clock)
  const run = await engine.tick()
  assert.equal(run.ran, true)
  assert.equal(run.eligible, 25)
  assert.equal(run.paying, 25)
  assert.equal(run.release, '8333333')
  assert.equal(run.plannedBuyback, '0')
  assert.equal(run.buybackSkipped, 'below minimum')
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [18, 7],
  )
  assert.equal(run.buyback, null)
  assert.equal(run.stopped, undefined)
  assert.equal(run.error, undefined)
  // what went out: the claim, then two payout transactions, all signed and paid by the engine
  assert.deepEqual(connection.sent.map(kindOf), ['claim', 'payout', 'payout'])
  assert.ok(connection.sent.every((tx) => tx.message.staticAccountKeys[0].toBase58() === ENGINE))
  assert.equal(run.claim, signatureOf(connection.sent[0]))
  // the claim: the hour's account, from a seed only the key can derive, rent-exempt and empty
  const [, , create, ...rest] = instructionsOf(connection.sent[0])
  const made = SystemInstruction.decodeCreateWithSeed(create)
  const seed = hourSeed(KEY.secretKey, 500_000)
  assert.equal(made.basePubkey.toBase58(), ENGINE)
  assert.equal(made.seed, seed)
  assert.match(seed, /^[0-9a-f]{32}$/)
  assert.equal(made.newAccountPubkey.toBase58(), (await hourAccount(ENGINE, seed)).toBase58())
  assert.deepEqual([made.lamports, made.space], [890_880, 0])
  assert.ok(made.programId.equals(SYSTEM))
  assert.deepEqual(
    rest.map((ix) => ix.programId.toBase58()),
    [MEMO],
  )
  // its memo ends with a random word of the run's own, so no two runs sign the same claim
  assert.match(memosOf(connection.sent[0])[0], /^qp-engine:v1 h=500000 claim [0-9a-f]{8}$/)
  // 25 transfers that add up to the holders' 60%, none to the team or the engine
  const transfers = payoutsIn(connection)
  assert.equal(transfers.length, 25)
  assert.ok(transfers.every(([from]) => from === ENGINE))
  assert.deepEqual(new Set(transfers.map(([, to]) => to)), new Set(MANY.map(([owner]) => owner)))
  const paid = transfers.reduce((s, [, , l]) => s + l, 0n)
  assert.ok(paid <= 4_999_999n && paid > 4_999_999n - 25n)
  assert.equal(run.payouts[0].signature, signatureOf(connection.sent[1]))
  // each payout transaction ends with its memo: the hour, the pot and what it is shared over
  for (const tx of connection.sent.slice(1)) {
    assert.equal(instructionsOf(tx).at(-1).programId.toBase58(), MEMO)
    assert.deepEqual(memosOf(tx), [`qp-engine:v1 h=500000 pot=4999999 H=${MANY_HELD}`])
  }
  assert.equal(store.values.get(LAST), clock.t)
  assert.equal(store.values.has('quantp:engine:lock'), false, 'the lock is released')
  // what status shows of it
  const { lastRun } = await engine.status()
  assert.deepEqual(lastRun, {
    at: clock.t / 1000,
    ok: true,
    stopped: null,
    error: null,
    payouts: run.payouts.map((p) => p.signature),
    buyback: null,
    skipped: [],
  })

  // ten minutes later: not due
  clock.t += 600_000
  const early = await engine.tick()
  assert.deepEqual([early.ran, early.reason, early.source], [false, 'not-due', 'store'])
  assert.equal(early.nextAt, clock.t - 600_000 + 3_600_000)
  assert.equal(connection.sent.length, 3)
  // another instance holds the lock
  clock.t += 3_000_000
  await store.set('quantp:engine:lock', 'someone', { nx: true })
  assert.equal((await engine.tick()).reason, 'locked')
  await store.release('quantp:engine:lock', 'someone')
  // an hour on: it runs again, and keeps the last hour's account, which a late run of that hour
  // could otherwise create again
  assert.equal((await engine.tick()).ran, true)
  assert.equal(connection.sent.length, 6)
  const next = instructionsOf(connection.sent[3])
  assert.equal(
    SystemInstruction.decodeCreateWithSeed(next[2]).seed,
    hourSeed(KEY.secretKey, 500_001),
  )
  assert.deepEqual(
    next.slice(3).map((ix) => ix.programId.toBase58()),
    [MEMO],
  )
  const [first, second] = [0, 3].map((i) => memosOf(connection.sent[i])[0])
  assert.match(second, /^qp-engine:v1 h=500001 claim [0-9a-f]{8}$/)
  assert.notEqual(second.slice(-8), first.slice(-8))
  // two hours on: its claim takes back the rent of the first hour's account
  clock.t += 3_600_000
  assert.equal((await engine.tick()).ran, true)
  assert.equal(connection.sent.length, 9)
  const claim = instructionsOf(connection.sent[6])
  assert.equal(
    SystemInstruction.decodeCreateWithSeed(claim[2]).seed,
    hourSeed(KEY.secretKey, 500_002),
  )
  const back = SystemInstruction.decodeTransferWithSeed(claim[3])
  assert.equal(back.fromPubkey.toBase58(), made.newAccountPubkey.toBase58())
  assert.equal(back.basePubkey.toBase58(), ENGINE)
  assert.equal(back.toPubkey.toBase58(), ENGINE)
  assert.equal(back.seed, seed)
  assert.equal(back.lamports, 890_880n)
  assert.deepEqual(
    claim.slice(4).map((ix) => ix.programId.toBase58()),
    [MEMO],
  )
  assert.deepEqual(
    [...connection.created],
    await Promise.all(
      [500_001, 500_002].map(async (h) =>
        (await hourAccount(ENGINE, hourSeed(KEY.secretKey, h))).toBase58(),
      ),
    ),
  )
})

test('a claim after days without one still takes back the rent of the last claims', async () => {
  const clock = { t: HALF_PAST }
  const connection = stubChain({ holders: MANY, clock })
  const engine = engineOn(connection, memoryStore(), clock)
  for (let i = 0; i < 2; i++) {
    assert.equal((await engine.tick()).ran, true)
    clock.t += 3_600_000
  }
  // two days with nothing sent (the engine paused, or its wallet nearly empty), then a run
  clock.t += 48 * 3_600_000
  assert.equal((await engine.tick()).ran, true)
  const claim = connection.sent.filter((tx) => kindOf(tx) === 'claim').at(-1)
  assert.deepEqual(
    instructionsOf(claim)
      .filter((ix) => systemType(ix) === 'TransferWithSeed')
      .map((ix) => SystemInstruction.decodeTransferWithSeed(ix).seed),
    [500_001, 500_000].map((h) => hourSeed(KEY.secretKey, h)),
  )
  assert.deepEqual(
    [...connection.created],
    [(await hourAccount(ENGINE, hourSeed(KEY.secretKey, 500_050))).toBase58()],
  )
})

test('it runs once in each clock hour, wherever in the hour the tick comes', async () => {
  // Vercel Cron on Hobby starts each hour's cron anywhere within that hour
  const clock = { t: HOUR0 + 59 * 60_000 } // 0:59
  const store = memoryStore()
  const connection = stubChain({ holders: MANY, clock })
  const engine = engineOn(connection, store, clock)
  assert.equal((await engine.tick()).ran, true)
  clock.t += 2 * 60_000 // 1:01, the next hour: due
  assert.equal((await engine.tick()).ran, true)
  clock.t += 58 * 60_000 // 1:59, the same hour: not due until 2:00
  const early = await engine.tick()
  assert.deepEqual([early.ran, early.reason], [false, 'not-due'])
  assert.equal(early.nextAt, HOUR0 + 2 * 3_600_000)
  clock.t += 100 * 60_000 // 3:39, after an hour with no tick: one run, not two
  assert.equal((await engine.tick()).ran, true)
  assert.equal((await engine.tick()).reason, 'not-due')
  assert.equal(connection.sent.length, 3 * 3)
})

test('with the store down, a second tick while one runs in the same instance waits', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true // no lock, and no record of the run until its transactions land
  const connection = stubChain({ holders: MANY, clock })
  const engine = engineOn(connection, store, clock)
  const [first, second] = await Promise.all([engine.tick(), engine.tick()])
  assert.equal(first.ran, true)
  assert.deepEqual([second.ran, second.reason], [false, 'locked'])
  assert.equal(connection.sent.length, 3, 'one run went out')
  // it is free again afterwards (and this instance remembers its run)
  const after = await engine.tick()
  assert.deepEqual([after.reason, after.source], ['not-due', 'local'])
})

test('a store that answers reads and refuses writes cannot repeat an hour, on this instance or another', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.values.set(LAST, HALF_PAST - 3_600_000) // last hour's record, which no write replaces
  store.readOnly = true
  const connection = stubChain({ holders: MANY, clock })
  // the record is last hour's: this hour's run goes ahead, and its own record is refused
  const a = engineOn(connection, store, clock)
  assert.equal((await a.tick()).ran, true)
  assert.equal(store.values.get(LAST), HALF_PAST - 3_600_000)
  assert.equal(connection.sent.length, 3)
  // the same instance, the store still answering with last hour's record: its own run counts
  clock.t += 60_000
  const again = await a.tick()
  assert.deepEqual([again.ran, again.reason, again.source], [false, 'not-due', 'local'])
  // another instance, the store answering null: the chain shows the run
  store.values.delete(LAST)
  const other = await engineOn(connection, store, clock).tick()
  assert.deepEqual([other.ran, other.reason, other.source], [false, 'not-due', 'chain'])
  assert.equal(connection.sent.length, 3, 'one run in the hour')
})

test('a run another instance records while this one takes the lock is not repeated', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.values.set(LAST, HALF_PAST - 3_600_000)
  const connection = stubChain({ holders: MANY, clock })
  // between this tick's check and its lock, another instance ran the hour (its transactions are
  // not listed yet)
  const set = store.set.bind(store)
  store.set = async (name, value, options) => {
    if (name === 'quantp:engine:lock') store.values.set(LAST, HALF_PAST - 5_000)
    return set(name, value, options)
  }
  const run = await engineOn(connection, store, clock).tick()
  assert.deepEqual([run.ran, run.reason, run.source], [false, 'not-due', 'store'])
  assert.equal(connection.attempts.length, 0)
  assert.equal(store.values.has('quantp:engine:lock'), false, 'the lock is released')
})

test('the rent exemption comes from the chain: an empty wallet owed less than the old figure is paid', async () => {
  const clock = { t: HOUR0 }
  const empty = wallet(64)
  // 750,708 lamports to a wallet holding none: under the old 890,880, over the chain's 650,240
  const connection = stubChain({
    holders: [...MANY.slice(0, 5), [empty, 26_500_000_000_000n]],
    clock,
    accounts: { [empty]: null },
    rent: 650_240,
  })
  const engine = engineOn(connection, memoryStore(), clock)
  const status = await engine.status()
  assert.equal(status.rentExemptLamports, '650240')
  assert.deepEqual(
    status.holders.find((h) => h.wallet === empty),
    {
      wallet: empty,
      amount: '26500000000000',
      lamports: '750708',
      reason: null,
    },
  )
  assert.equal((await engine.tick()).ran, true)
  assert.ok(payoutsIn(connection).some(([, to, lamports]) => to === empty && lamports === 750_708n))
  // and the hour's claim account holds that much rent
  const create = instructionsOf(connection.sent[0])[2]
  assert.equal(SystemInstruction.decodeCreateWithSeed(create).lamports, 650_240)
})

test('with the store down, two instances ticking at once make one run: the hour’s claim decides', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  const runs = await Promise.all([
    engineOn(connection, store, clock).tick(),
    engineOn(connection, store, clock).tick(),
  ])
  assert.deepEqual(runs.map((r) => r.ran).sort(), [false, true])
  assert.deepEqual(
    runs.find((r) => !r.ran),
    { ran: false, reason: 'locked', source: 'claim' },
  )
  // both sent a claim; the node refused the second: AccountAlreadyInUse
  const claims = connection.attempts.filter(
    (a) => kindOf(VersionedTransaction.deserialize(a.bytes)) === 'claim',
  )
  assert.equal(claims.length, 2)
  assert.equal(connection.sent.filter((tx) => kindOf(tx) === 'claim').length, 1)
  assert.equal(payoutsIn(connection).length, 25, 'one run’s transfers')
})

test('two instances that build the hour’s claim in the same slot make one run: each claim is its own', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  // the same blockhash and fee for both (the stub's are fixed), and nothing lands until both
  // claims are out, so each passes preflight: only the chain can refuse one
  const claims = () =>
    connection.attempts.filter(
      (a) =>
        !a.options.skipPreflight && kindOf(VersionedTransaction.deserialize(a.bytes)) === 'claim',
    )
  connection.defer = () => claims().length < 2
  const runs = await Promise.all([
    engineOn(connection, store, clock).tick(),
    engineOn(connection, store, clock).tick(),
  ])
  assert.deepEqual(runs.map((r) => r.ran).sort(), [false, true])
  assert.deepEqual(
    runs.find((r) => !r.ran),
    { ran: false, reason: 'locked', source: 'claim' },
  )
  // two claims, two signatures: one landed, and the other failed on-chain at its account
  assert.equal(new Set(claims().map((a) => a.signature)).size, 2)
  assert.deepEqual(
    connection.history.filter((s) => s.err).map((s) => s.err),
    [{ InstructionError: [2, { Custom: 0 }] }],
  )
  assert.equal(payoutsIn(connection).length, 25, 'one run’s transfers')
})

test('with the store down and back up mid-hour with no record, the chain says the hour ran', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  assert.equal((await engineOn(connection, store, clock).tick()).ran, true)
  store.down = false // back, without the record it could not take
  clock.t += 60_000
  const fresh = await engineOn(connection, store, clock).tick()
  assert.deepEqual([fresh.ran, fresh.reason, fresh.source], [false, 'not-due', 'chain'])
  // what the chain said is recorded for every instance
  assert.equal(store.values.get(LAST), HALF_PAST)
  const next = await engineOn(connection, store, clock).tick()
  assert.deepEqual([next.reason, next.source], ['not-due', 'store'])
  assert.equal(connection.sent.length, 3)
})

test('with the store up and then down, another instance still sees the hour ran, and runs the next', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  const connection = stubChain({ holders: MANY, clock })
  const a = engineOn(connection, store, clock)
  assert.equal((await a.tick()).ran, true)
  store.down = true
  clock.t += 60_000
  const b = engineOn(connection, store, clock)
  assert.deepEqual((await b.tick()).source, 'chain')
  assert.deepEqual((await a.tick()).source, 'local')
  assert.equal(connection.sent.length, 3)
  clock.t = HOUR0 + 3_600_000 + 60_000 // 1:01
  assert.equal((await b.tick()).ran, true)
  assert.equal(connection.sent.length, 6)
})

test('a stranger’s transactions in the hour never hold off its run, whatever their memo says', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true
  const stranger = wallet(99)
  // dust a minute ago, one with a forged engine memo, and more of it than the check reads
  const history = Array.from({ length: 10 }, (_, i) => ({
    signature: bs58.encode(Buffer.alloc(64, i + 1)),
    blockTime: HALF_PAST / 1000 - 60 - i,
    err: null,
    memo: i === 0 ? '[34] qp-engine:v1 h=500000 pot=1 H=1' : null,
    payer: stranger,
  }))
  const connection = stubChain({ holders: MANY, clock, history })
  const run = await engineOn(connection, store, clock).tick()
  assert.equal(run.ran, true)
  assert.equal(payoutsIn(connection).length, 25)
})

test('a run that starts at :59:59 and lands after the hour turns leaves the new hour due', async () => {
  const clock = { t: HOUR0 + 3_599_000 } // 0:59:59, hour 500,000
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  // its transactions land at 1:00:02
  connection.onLand = () => {
    clock.t = HOUR0 + 3_602_000
  }
  assert.equal((await engineOn(connection, store, clock).tick()).ran, true)
  assert.ok(connection.history.every((s) => s.blockTime === (HOUR0 + 3_602_000) / 1000))
  assert.ok(connection.history.every((s) => memoHour(s.memo) === 500_000))
  connection.onLand = null
  clock.t = HOUR0 + 3_630_000 // 1:00:30, another instance
  const next = await engineOn(connection, store, clock).tick()
  assert.equal(next.ran, true, 'hour 500,001 runs')
  assert.match(memosOf(connection.sent[3])[0], /^qp-engine:v1 h=500001 claim /)
})

test('a late run of an hour never claims it once the hour is over, so the hour is paid once', async () => {
  // the store down and nothing landed yet when the late run checked the chain: the claim decides
  const clock = { t: HOUR0 + 3_590_000 } // 0:59:50, hour 500,000
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  // one instance ticks first, and its read is slow
  let answer
  const gate = new Promise((r) => (answer = r))
  const slow = {
    snapshot: async () => {
      await gate
      return feed.snapshot()
    },
  }
  const late = engineOn(connection, store, clock, { feed: slow }).tick()
  await new Promise((r) => setImmediate(r))
  // another runs the hour meanwhile; the hour turns, and a third runs hour 500,001
  assert.equal((await engineOn(connection, store, clock).tick()).ran, true)
  clock.t = HOUR0 + 3_602_000
  assert.equal((await engineOn(connection, store, clock).tick()).ran, true)
  // the slow read answers within its tick's 25 s, but in the next hour: nothing is signed
  answer()
  assert.deepEqual(await late, { ran: false, reason: 'time limit' })
  const paid = (hour) =>
    connection.sent
      .filter((tx) => memosOf(tx).some((m) => m.startsWith(`qp-engine:v1 h=${hour} pot=`)))
      .flatMap(transfersIn).length
  assert.deepEqual([paid(500_000), paid(500_001)], [25, 25])
  assert.equal(connection.attempts.length, 6)
  // and hour 500,000's account is still there, so a claim of that hour would be refused
  const account = await hourAccount(ENGINE, hourSeed(KEY.secretKey, 500_000))
  assert.ok(connection.created.has(account.toBase58()))
})

test('a run with too little time left to claim its hour records nothing, and a later tick runs it', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  const connection = stubChain({ holders: MANY, clock })
  // the read takes 18 of the tick's 25 s: 7 left, under the 8 a claim is given
  const slow = {
    snapshot: async () => {
      clock.t += 18_000
      return feed.snapshot()
    },
  }
  const warned = []
  const log = { error() {}, warn: (...m) => warned.push(m.join(' ')) }
  const run = await engineOn(connection, store, clock, { feed: slow, log }).tick()
  assert.deepEqual(run, { ran: false, reason: 'time limit' })
  assert.deepEqual([connection.attempts.length, store.values.has(LAST)], [0, false])
  assert.equal(warned.length, 1)
  clock.t += 300_000 // the next tick, quicker
  assert.equal((await engineOn(connection, store, clock).tick()).ran, true)
  assert.equal(payoutsIn(connection).length, 25)
})

test('a claim that cannot be signed in time after all is not sent, and its recorded hour is skipped', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  // the store takes 20 s to record the run
  const set = store.set.bind(store)
  store.set = async (name, value, options) => {
    if (name === LAST) clock.t += 20_000
    return set(name, value, options)
  }
  const connection = stubChain({ holders: MANY, clock })
  const run = await engineOn(connection, store, clock).tick()
  assert.deepEqual(
    [run.ran, run.stopped, run.payouts, run.buyback],
    [true, 'time limit before claim', [], null],
  )
  assert.equal(connection.attempts.length, 0)
  clock.t += 60_000
  assert.equal((await engineOn(connection, store, clock).tick()).reason, 'not-due')
})

test('when the wallet’s history cannot be read, a due tick does not run: unverified', async () => {
  const clock = { t: HALF_PAST }
  const store = memoryStore()
  store.down = true
  const connection = stubChain({ holders: MANY, clock })
  connection.signaturesFail = true
  const run = await engineOn(connection, store, clock).tick()
  assert.deepEqual([run.ran, run.reason], [false, 'unverified'])
  assert.match(run.detail, /429/)
  assert.deepEqual([connection.attempts.length, connection.sent.length], [0, 0])
})

test('holders a transfer cannot pay are left out: programs, accounts with data; an empty wallet is paid', async () => {
  const clock = { t: HALF_PAST }
  const [program, data, empty] = [wallet(60), wallet(61), wallet(62)]
  const connection = stubChain({
    holders: [...MANY.slice(0, 3), [program, 9n * MIN], [data, 8n * MIN], [empty, 30n * MIN]],
    clock,
    accounts: {
      [program]: {
        lamports: 1_141_440,
        owner: new PublicKey(wallet(63)),
        executable: true,
        data: Buffer.alloc(36),
      },
      [data]: { lamports: 2_000_000, owner: SYSTEM, executable: false, data: Buffer.alloc(8) },
      [empty]: null, // no account yet: paid if its share covers rent
    },
  })
  const engine = engineOn(connection, memoryStore(), clock)
  const status = await engine.status()
  assert.equal(status.eligible, 6)
  assert.deepEqual(
    status.holders.map((h) => [h.wallet, h.reason]),
    [
      [empty, null],
      [MANY[0][0], null],
      [MANY[1][0], null],
      [MANY[2][0], null],
      [program, 'not-payable'],
      [data, 'not-payable'],
    ],
  )
  assert.deepEqual(status.next.skipped, { belowMin: 0, noSol: 0, notPayable: 2 })
  const run = await engine.tick()
  assert.deepEqual([run.ran, run.eligible, run.paying], [true, 6, 4])
  const paid = new Set(payoutsIn(connection).map(([, to]) => to))
  assert.ok(paid.has(empty) && !paid.has(program) && !paid.has(data))
})

test('a recipient preflight refuses is left out, its batch sent again, and the rest of the run goes on', async () => {
  const clock = { t: HOUR0 }
  const hostile = MANY[1][0] // the second transfer of the first batch: instruction 3
  const connection = stubChain({
    holders: MANY,
    clock,
    readonly: [hostile],
    venue: true,
  })
  const run = await engineOn(connection, memoryStore(), clock, { policy: PINNED }).tick()
  assert.equal(run.ran, true)
  assert.deepEqual(run.skipped, [{ wallet: hostile, reason: 'ReadonlyLamportChange' }])
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [17, 7],
  )
  assert.ok(run.buyback?.signature, 'the buyback still went out')
  assert.equal(run.failed, undefined)
  assert.equal(run.error, undefined)
  assert.deepEqual(connection.sent.map(kindOf), ['claim', 'payout', 'payout', 'buyback'])
  assert.ok(!payoutsIn(connection).some(([, to]) => to === hostile))
})

test('a payout batch that fails for another reason is recorded, and the next batch and the buyback go out', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY, clock, venue: true })
  const rentErr = { InsufficientFundsForRent: { account_index: 3 } }
  const first = (tx) => kindOf(tx) === 'payout' && transfersIn(tx).length === 18
  const message =
    'Transaction simulation failed: Transaction results in an account (3) with insufficient funds for rent'
  connection.refuse = (tx) =>
    first(tx) ? refusal(message, ['Program 11111111111111111111111111111111 invoke [1]']) : null
  connection.simulate = (tx) =>
    first(tx) ? { err: rentErr, logs: ['Program 11111111111111111111111111111111 success'] } : null
  const run = await engineOn(connection, memoryStore(), clock, { policy: PINNED }).tick()
  assert.equal(run.ran, true)
  assert.equal(run.failed.length, 1)
  const [failed] = run.failed
  assert.equal(failed.recipients, 18)
  assert.equal(failed.error, message)
  assert.equal(failed.rpcMessage, message)
  assert.equal(failed.stage, 'preflight')
  assert.equal(failed.simErr, JSON.stringify(rentErr))
  assert.equal(failed.unitsConsumed, 1_234)
  assert.equal(failed.signature, null)
  assert.equal(run.error, message)
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [7],
  )
  assert.ok(run.buyback?.signature)
  assert.deepEqual(connection.sent.map(kindOf), ['claim', 'payout', 'buyback'])
})

test('a refusal from a node that is behind is answered with the same signed bytes, never new ones', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY, clock })
  connection.refuse = (tx, n) =>
    n === 1 ? refusal('Transaction simulation failed: Blockhash not found', []) : null
  const run = await engineOn(connection, memoryStore(), clock).tick()
  assert.equal(run.ran, true)
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [18, 7],
  )
  const [refused, resent] = connection.attempts
  assert.equal(refused.signature, resent.signature)
  assert.deepEqual(refused.bytes, resent.bytes)
  assert.equal(run.claim, refused.signature)
  // sent against the blockhash's slot, preflight at confirmed
  assert.deepEqual(refused.options, { minContextSlot: 100, preflightCommitment: 'confirmed' })
})

test('a transaction refused to the end says why: the node’s message, the simulated error, no signature', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY.slice(0, 5), clock, venue: true, held: 5n })
  const message = 'Transaction simulation failed: Blockhash not found'
  connection.refuse = (tx) => (kindOf(tx) === 'buyback' ? refusal(message, []) : null)
  connection.simulate = (tx) => (kindOf(tx) === 'buyback' ? { err: 'BlockhashNotFound' } : null)
  const run = await engineOn(connection, memoryStore(), clock, { policy: PINNED }).tick()
  assert.equal(run.ran, true)
  assert.deepEqual(
    run.payouts.map((p) => p.recipients),
    [5],
  )
  assert.equal(run.buyback, null)
  assert.equal(run.error, message)
  assert.equal(run.rpcMessage, message)
  assert.equal(run.stage, 'preflight')
  assert.equal(run.simErr, '"BlockhashNotFound"')
  assert.deepEqual(run.logs, [])
  assert.equal(run.signature, null)
  // the same bytes four times (three resends), then one simulation on its own blockhash
  const buys = connection.attempts.filter(
    (a) => kindOf(VersionedTransaction.deserialize(a.bytes)) === 'buyback',
  )
  assert.equal(buys.length, 4)
  assert.equal(new Set(buys.map((a) => a.signature)).size, 1)
  assert.deepEqual(connection.simulations.at(-1).config, {
    sigVerify: false,
    commitment: 'confirmed',
  })
})

test('a payout sent and not confirmed in time stops the payouts and is reported with its signature', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY, clock })
  // the first batch's send times out: it may be out, so the engine waits on it
  connection.refuse = (tx) =>
    kindOf(tx) === 'payout' && transfersIn(tx).length === 18 ? Error('fetch failed') : null
  const run = await engineOn(connection, memoryStore(), clock).tick({ deadline: HOUR0 + 25_000 })
  assert.equal(run.stopped, 'payout not confirmed')
  assert.equal(run.failed.length, 1)
  const [lost] = run.failed
  assert.equal(lost.unknown, true)
  assert.equal(lost.stage, 'confirm')
  assert.equal(lost.recipients, 18)
  const sent = connection.attempts.filter((a) => !a.options.skipPreflight)
  assert.equal(lost.signature, sent.at(-1).signature)
  // it was sent again, the same bytes, while it waited
  const again = connection.attempts.filter((a) => a.options.skipPreflight)
  assert.ok(again.length >= 5 && again.every((a) => a.signature === lost.signature))
  assert.deepEqual(run.payouts, [])
  assert.deepEqual(connection.sent.map(kindOf), ['claim'])
})

test('a claim the node refuses for another reason skips the hour: nothing is paid, and nothing repeats', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY, clock })
  const message = 'Transaction simulation failed: Attempt to debit an account but found no record'
  connection.refuse = (tx) => (kindOf(tx) === 'claim' ? refusal(message, ['log']) : null)
  const engine = engineOn(connection, memoryStore(), clock)
  const run = await engine.tick()
  assert.deepEqual(
    [run.ran, run.stopped, run.error, run.signature],
    [true, 'claim failed', message, null],
  )
  assert.deepEqual(connection.sent, [])
  clock.t += 60_000
  assert.equal((await engine.tick()).reason, 'not-due')
})

test('the buyback through a tick: the third transaction swaps in the DAMM v2 pool and burns, memo last', async () => {
  const clock = { t: HOUR0 }
  const held = 3_070_967_498_088n
  const connection = stubChain({ holders: MANY.slice(0, 5), clock, venue: true, held })
  const warned = []
  const engine = engineOn(connection, memoryStore(), clock, {
    policy: PINNED, // QUANTP.engine as it is, pinned to the test key
    log: { error() {}, warn: (...m) => warned.push(m.join(' ')) },
  })
  const run = await engine.tick()
  assert.equal(run.ran, true)
  assert.equal(run.plannedBuyback, '3333334')
  assert.deepEqual(connection.sent.map(kindOf), ['claim', 'payout', 'buyback'])
  const buyback = connection.sent[2]
  const ixs = instructionsOf(buyback)
  assert.ok(ixs.some((ix) => ix.programId.toBase58() === network.dammV2Program))
  assert.equal(ixs.at(-1).programId.toBase58(), MEMO)
  assert.deepEqual(memosOf(buyback), ['qp-engine:v1 h=500000 bb=3333334'])
  const burn = decodeBurnCheckedInstruction(ixs.at(-2), TOKEN_2022_PROGRAM_ID)
  assert.ok(burn.data.amount > held, 'it burns what it bought plus what it held')
  assert.deepEqual(run.buyback, {
    signature: signatureOf(buyback),
    lamports: '3333334',
    burned: burn.data.amount.toString(),
  })
  const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ixs[0])
  assert.ok(units >= 100_000 && units <= 200_000)
  // its priority fee is read for the pool, its vaults and the wallet
  const damm = decodeDammPool(DAMM)
  assert.deepEqual(connection.feeQueries.at(-1), [
    DAMM_POOL,
    damm.tokenAVault,
    damm.tokenBVault,
    ENGINE,
  ])
  assert.deepEqual(warned, [])
})

test('a run says why its buyback did not go out: no DAMM v2 pool, or the time ran out after the payouts', async () => {
  const clock = { t: HOUR0 }
  const warned = []
  const log = { error() {}, warn: (...m) => warned.push(m.join(' ')) }
  const nopool = stubChain({ holders: MANY.slice(0, 5), clock }) // the pool is not found
  const run = await engineOn(nopool, memoryStore(), clock, { policy: PINNED, log }).tick()
  assert.deepEqual([run.ran, run.stopped, run.buyback], [true, 'no DAMM v2 pool', null])
  assert.equal(run.payouts.length, 1)
  assert.deepEqual(warned, ['[quantp-engine] stopped: no DAMM v2 pool'])

  const late = { t: HOUR0 }
  const slow = stubChain({ holders: MANY.slice(0, 5), clock: late, venue: true })
  slow.onLand = (tx) => {
    if (kindOf(tx) === 'payout') late.t += 30_000 // the payout took the rest of the time
  }
  const timed = await engineOn(slow, memoryStore(), late, { policy: PINNED, log }).tick({
    deadline: HOUR0 + 25_000,
  })
  assert.deepEqual(
    [timed.ran, timed.stopped, timed.buyback, timed.plannedBuyback],
    [true, 'time limit before buyback', null, '3333334'],
  )
  assert.deepEqual(slow.sent.map(kindOf), ['claim', 'payout'])
})

test('a read that fails is tried once more, then reported without anything sent', async () => {
  const clock = { t: HOUR0 }
  const connection = stubChain({ holders: MANY, clock })
  let reads = 0
  const flaky = {
    snapshot: async () => {
      if (++reads === 1) throw Error('429 Too Many Requests')
      return feed.snapshot()
    },
  }
  const run = await engineOn(connection, memoryStore(), clock, { feed: flaky }).tick()
  assert.equal(run.ran, true)
  assert.equal(clock.t, HOUR0 + 2_500, 'it waited 2.5 s')
  const down = { snapshot: async () => ({ supply: null }) }
  const failed = await engineOn(stubChain({ holders: MANY, clock }), memoryStore(), clock, {
    feed: down,
  }).tick()
  assert.deepEqual(failed, { ran: false, error: 'The $QUANTP supply could not be read.' })
})

test('status says what the next run would release, to whom, and whether it is live', async () => {
  const clock = { t: HOUR0 }
  const store = memoryStore()
  store.values.set(LAST, clock.t - 1_200_000)
  const status = await createQuantpEngine({
    connection: stubChain({ holders: MANY, clock }),
    store,
    feed,
    policy: PINNED, // no key on this server
    now: () => clock.t,
  }).status()
  assert.equal(status.configured, true)
  assert.equal(status.wallet, ENGINE)
  assert.deepEqual([status.live, status.reason], [false, 'no-key'])
  assert.equal(status.minHold, MIN.toString())
  assert.equal(status.dailyBps, 2000)
  assert.equal(status.balance, '1020000000')
  assert.equal(status.rentExemptLamports, '890880')
  assert.deepEqual(status.next, {
    release: '8333333',
    holders: '4999975',
    buyback: '3333334',
    buybackPot: '3333334',
    paying: 25,
    skipped: { belowMin: 0, noSol: 0, notPayable: 0 },
  })
  assert.equal(status.eligible, 25)
  assert.equal(status.heldEligible, MANY_HELD.toString())
  assert.equal(status.holders.length, 25)
  assert.deepEqual(status.holders[0], {
    wallet: MANY[0][0],
    amount: MANY[0][1].toString(),
    lamports: ((4_999_999n * MANY[0][1]) / MANY_HELD).toString(),
    reason: null,
  })
  assert.equal(
    status.holders.reduce((s, h) => s + BigInt(h.lamports), 0n),
    4_999_975n,
  )
  assert.equal(status.lastRunAt, (clock.t - 1_200_000) / 1000)
  assert.equal(status.lastRunSource, 'store')
  assert.equal(status.nextAt, clock.t / 1000) // the run 20 minutes ago was last hour's
  assert.deepEqual([status.lastPaidAt, status.lastBurnAt, status.lastRun], [null, null, null])
  assert.equal(status.state, 'ok')
})

test('status counts who is skipped and why, and the ledger says when the wallet last paid', async () => {
  const clock = { t: HALF_PAST }
  const [x, y, z] = [wallet(70), wallet(71), wallet(72)]
  const connection = stubChain({
    holders: [
      [D, 300_000_000_000_000n],
      [C, 80_000_000_000_000n],
      [z, 15_000_000_000_000n], // an empty wallet whose share is under rent
      [A, MIN], // a share under the minimum transfer
      [x, 5_000_000_000_000n], // a program
      [y, 4_000_000_000_000n], // a program's account
    ],
    clock,
    accounts: {
      [z]: null,
      [x]: { lamports: 1, owner: SYSTEM, executable: true, data: Buffer.alloc(0) },
      [y]: {
        lamports: 1,
        owner: new PublicKey(wallet(73)),
        executable: false,
        data: Buffer.alloc(0),
      },
    },
  })
  const paidAt = HALF_PAST / 1000 - 300
  const ledger = {
    async ledger() {
      return {
        payouts: [
          { wallet: ENGINE, transactions: [{ timestamp: paidAt - 1 }, { timestamp: paidAt }] },
        ],
        burns: [
          { wallet: ENGINE, timestamp: paidAt - 3_600 },
          { wallet: A, timestamp: paidAt + 9 },
        ],
      }
    },
  }
  const store = memoryStore()
  store.values.set(LAST, HALF_PAST - 3_600_000)
  const status = await engineOn(connection, store, clock, { ledger }).status()
  assert.equal(status.eligible, 6)
  assert.equal(status.next.paying, 2)
  assert.deepEqual(status.next.skipped, { belowMin: 1, noSol: 1, notPayable: 2 })
  assert.deepEqual(
    status.holders.map((h) => [h.wallet, h.reason, h.lamports == null]),
    [
      [D, null, false],
      [C, null, false],
      [z, 'no-sol', true],
      [x, 'not-payable', true],
      [y, 'not-payable', true],
      [A, 'below-minimum', true],
    ],
  )
  assert.deepEqual([status.lastPaidAt, status.lastBurnAt], [paidAt, paidAt - 3_600])
  assert.deepEqual([status.lastRunAt, status.lastRunSource], [paidAt, 'ledger'])
  assert.equal(status.nextAt, HOUR0 / 1000 + 3_600)
})

test('the keeper tick runs the engine first, and GET /api/quantp/engine shows its status', async () => {
  const calls = []
  const quantpEngine = {
    async tick({ deadline }) {
      calls.push(['engine', deadline])
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
  app.indexer.sync = async () => {
    calls.push(['sync'])
    return { synced: 0 }
  }
  app.keeper.tick = async () => {
    calls.push(['keeper'])
    return { enabled: false }
  }
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
    // the engine before the index pass and the keeper, within its 25 s
    assert.deepEqual(
      calls.map(([step]) => step),
      ['engine', 'sync', 'keeper'],
    )
    assert.ok(calls[0][1] >= started + 25_000 - 1_000 && calls[0][1] <= Date.now() + 25_000)
  } finally {
    process.env.CRON_SECRET = previous
    if (previous === undefined) delete process.env.CRON_SECRET
    await new Promise((r) => server.close(r))
    app.close()
  }
})
