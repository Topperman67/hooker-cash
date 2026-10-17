// $QUANTP's payouts and burns (server/quantp.mjs ledgerEntries, quantpLedger, createQuantpLedger)
// and GET /api/quantp/ledger while Redis refuses every command: payouts in bursts, buys before a
// burn counted as its buyback (the launch dev buy aside), the payout wallet's balance. The payouts
// are mainnet transactions of round 1 (tests/fixtures/quantp-ledger.json, read with
// getTransaction in jsonParsed encoding, logs dropped): two of its three batches from the payout
// wallet, the creator wallet's transfer that funded it, the payout wallet's first two buybacks, and
// a version 1 dust transaction a stranger sent it. No burn has happened yet, so burns are built in
// the same shape.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createQuantpLedger,
  ledgerEntries,
  ledgerSummary,
  quantpLedger,
  teamWallets,
} from '../../server/quantp.mjs'
import { createRedisStore } from '../../server/storage.mjs'
import { createApplication, QUANTP_LEDGER_CACHE } from '../../server/application.mjs'
import { QUANTP, network } from '../../shared/network.mjs'

const REAL = JSON.parse(
  readFileSync(new URL('../fixtures/quantp-ledger.json', import.meta.url), 'utf8'),
)
const PAYOUT = QUANTP.payoutWallet
const CREATOR = QUANTP.creator
const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
const HOLDER = '57uMvKGYH1xcrwPSXHjtQFbzApmDGhQi1RVa6pzvXb2u' // paid in round 1
const NEW_HOLDER = 'NewHo1der1111111111111111111111111111111111'
const OWN_ATA = 'BurnerQuantpAta11111111111111111111111111111'
const WSOL_ATA = 'BurnerWsolAta111111111111111111111111111111'
const VAULT_A = 'PoolVaultA111111111111111111111111111111111'
const VAULT_B = 'PoolVaultB111111111111111111111111111111111'
const INCINERATOR_ATA = 'IncineratorAta11111111111111111111111111111'
const COMPUTE = 'ComputeBudget111111111111111111111111111111'
const SYSTEM = '11111111111111111111111111111111'
const T22 = network.token2022Program
const RENT = 2_074_080 // a Token-2022 account's rent

let sigCounter = 0
const sig = (label) => `${label}${String(++sigCounter).padStart(4, '0')}`.padEnd(88, '1')
const transfer = (source, destination, lamports) => ({
  program: 'system',
  programId: SYSTEM,
  parsed: { type: 'transfer', info: { source, destination, lamports } },
})
const balance = (accountIndex, owner, amount, mint = QUANTP.mint) => ({
  accountIndex,
  mint,
  owner,
  programId: T22,
  uiTokenAmount: { amount: String(amount), decimals: 6 },
})
/** A parsed transaction as getParsedTransaction returns it (keys as strings, as JSON gives). */
function tx({
  signature = sig('tx'),
  slot = 457_600_000,
  blockTime = 1_792_200_000,
  keys,
  instructions,
  inner = [],
  pre,
  post,
  preTokens = [],
  postTokens = [],
  fee = 5000,
  err = null,
}) {
  return {
    slot,
    blockTime,
    meta: {
      err,
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: preTokens,
      postTokenBalances: postTokens,
      innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })),
        instructions,
      },
    },
  }
}

/** The payout wallet buys 2M $QUANTP for 0.5 SOL in the DAMM v2 pool and burns them, in one go. */
function buyAndBurn({ burn = 2_000_000_000_000n, signature, slot } = {}) {
  const bought = 2_000_000_000_000n
  return tx({
    signature,
    slot,
    keys: [PAYOUT, OWN_ATA, WSOL_ATA, VAULT_A, VAULT_B, network.dammV2Program, T22, COMPUTE],
    instructions: [
      { programId: COMPUTE, data: 'K1FDJ7', accounts: [] },
      // wrapping SOL is a system transfer too: this is no payout
      transfer(PAYOUT, WSOL_ATA, 500_000_000 + RENT),
      { programId: network.dammV2Program, data: 'swap', accounts: [VAULT_A, VAULT_B] },
      {
        program: 'spl-token-2022',
        programId: T22,
        parsed: {
          type: 'burnChecked',
          info: {
            account: OWN_ATA,
            authority: PAYOUT,
            mint: QUANTP.mint,
            tokenAmount: { amount: String(burn), decimals: 6 },
          },
        },
      },
    ],
    // the wallet pays the swap, its new $QUANTP account's rent and the fee; the WSOL account
    // opens and closes inside the transaction
    pre: [2_000_000_000, 0, 0, 2_000_000, 60_000_000_000, 1, 1, 1],
    post: [2_000_000_000 - 500_000_000 - RENT - 5000, RENT, 0, 2_000_000, 60_500_000_000, 1, 1, 1],
    preTokens: [balance(3, 'PoolAuthority', 300_000_000_000_000n)],
    postTokens: [
      balance(1, PAYOUT, bought - burn),
      balance(3, 'PoolAuthority', 300_000_000_000_000n - bought),
    ],
  })
}

test('round 1 batches are payouts to every wallet they pay, the creator wallet included', () => {
  const [first] = ledgerEntries(REAL.payout1)
  assert.equal(first.kind, 'payout')
  assert.equal(first.wallet, PAYOUT)
  assert.equal(first.recipients.length, 20)
  assert.equal(first.lamports, 358_024_234n)
  assert.equal(first.signature, REAL.payout1.transaction.signatures[0])
  assert.equal(first.timestamp, 1792126586)
  // the last batch paid the creator wallet as a holder, beside 10 others: all 11 count
  const [last] = ledgerEntries(REAL.payout3)
  assert.equal(last.recipients.length, 11)
  assert.ok(last.recipients.includes(CREATOR))
  assert.equal(last.lamports, 15_232_167n)
  // the creator wallet funding the payout wallet is neither
  assert.deepEqual(ledgerEntries(REAL.funding), [])
})

test('only plain SOL transfers out of the payout wallet are payouts', () => {
  const plain = (instructions) =>
    tx({ keys: [PAYOUT, HOLDER, CREATOR], instructions, pre: [9, 0, 0], post: [9, 0, 0] })
  const [one] = ledgerEntries(
    plain([{ programId: COMPUTE, data: 'x', accounts: [] }, transfer(PAYOUT, HOLDER, 1_000_000)]),
  )
  assert.equal(one.recipients.length, 1)
  assert.equal(one.lamports, 1_000_000n)
  // SOL moved back to the creator wallet on its own is not a payout
  assert.deepEqual(ledgerEntries(plain([transfer(PAYOUT, CREATOR, 50_000_000)])), [])
  // nor is SOL sent from another wallet, a transaction that failed, or one that does more
  assert.deepEqual(ledgerEntries(plain([transfer(CREATOR, HOLDER, 1_000_000)])), [])
  const failed = plain([transfer(PAYOUT, HOLDER, 1_000_000)])
  failed.meta.err = { InstructionError: [0, 'Custom'] }
  assert.deepEqual(ledgerEntries(failed), [])
  assert.deepEqual(
    ledgerEntries(buyAndBurn()).filter((e) => e.kind === 'payout'),
    [],
  )
})

/** `wallet` buys `tokens` for `lamports` in the DAMM v2 pool, into the $QUANTP account it has. */
function buy({
  wallet = CREATOR,
  lamports = 100_000_000,
  tokens = 1_000_000_000_000n,
  held = 0n,
  slot,
  blockTime,
} = {}) {
  return tx({
    slot,
    blockTime,
    keys: [wallet, OWN_ATA, VAULT_A, VAULT_B, network.dammV2Program, T22],
    instructions: [
      { programId: network.dammV2Program, data: 'swap', accounts: [VAULT_A, VAULT_B] },
    ],
    pre: [2_000_000_000, RENT, 2_000_000, 60_000_000_000, 1, 1],
    post: [2_000_000_000 - lamports - 5000, RENT, 2_000_000, 60_000_000_000 + lamports, 1, 1],
    preTokens: [balance(1, wallet, held), balance(2, 'PoolAuthority', 300_000_000_000_000n)],
    postTokens: [
      balance(1, wallet, held + tokens),
      balance(2, 'PoolAuthority', 300_000_000_000_000n - tokens),
    ],
  })
}

/** `wallet` burns `amount` of the $QUANTP it holds. */
function burnHeld({
  wallet = CREATOR,
  amount = 1_000_000_000_000n,
  held = 5_000_000_000_000n,
  slot,
  blockTime,
} = {}) {
  return tx({
    slot,
    blockTime,
    keys: [wallet, OWN_ATA, T22],
    instructions: [
      {
        program: 'spl-token-2022',
        programId: T22,
        parsed: {
          type: 'burn',
          info: { account: OWN_ATA, authority: wallet, mint: QUANTP.mint, amount: String(amount) },
        },
      },
    ],
    pre: [1_000_000_000, RENT, 1],
    post: [1_000_000_000 - 5000, RENT, 1],
    preTokens: [balance(1, wallet, held)],
    postTokens: [balance(1, wallet, held - amount)],
  })
}

test('a buy and burn in one transaction: the SOL its swap spent, fee and kept rent aside', () => {
  const entries = ledgerEntries(buyAndBurn())
  assert.deepEqual(
    entries.map((e) => [e.kind, e.wallet, e.amount, e.lamports]),
    [
      ['buy', PAYOUT, 2_000_000_000_000n, 500_000_000n],
      ['burn', PAYOUT, 2_000_000_000_000n, undefined],
    ],
  )
  assert.equal(entries[1].method, 'burn')
  assert.equal(quantpLedger(entries).burns[0].solSpent, '500000000')
  // burning half of what it bought spends half of the SOL on the burn; the rest waits
  const half = quantpLedger(ledgerEntries(buyAndBurn({ burn: 1_000_000_000_000n })))
  assert.equal(half.burns[0].amount, '1000000000000')
  assert.equal(half.burns[0].solSpent, '250000000')
  assert.deepEqual(half.totals.unburned, { lamports: '250000000', amount: '1000000000000' })
})

test('small buys before a burn are its buyback; the launch dev buy is not', () => {
  const t = QUANTP.launchedAt
  const devBuy = buy({ lamports: 118_128_240, tokens: 3_500_001_616_770n, slot: 1, blockTime: t })
  const entries = [
    devBuy,
    buy({ lamports: 100_000_000, slot: 10, blockTime: t + 3600 }),
    // the payout wallet buys too: the team's buys are pooled
    buy({ wallet: PAYOUT, lamports: 200_000_000, slot: 11, blockTime: t + 3700 }),
    burnHeld({ slot: 12, blockTime: t + 3800 }),
  ].flatMap((x) => ledgerEntries(x))
  const ledger = quantpLedger(entries)
  // 2M bought for 0.3 SOL, 1M burned: half of it
  assert.equal(ledger.burns[0].solSpent, '150000000')
  assert.deepEqual(ledger.totals.unburned, { lamports: '150000000', amount: '1000000000000' })

  const more = [
    ...entries,
    ...ledgerEntries(burnHeld({ slot: 13, blockTime: t + 3900 })),
    ...ledgerEntries(burnHeld({ slot: 14, blockTime: t + 4000 })),
  ]
  const after = quantpLedger(more)
  assert.deepEqual(
    after.burns.map((b) => b.solSpent),
    [null, '150000000', '150000000'],
  )
  assert.equal(after.totals.burnedAmount, '3000000000000')
  assert.equal(after.totals.buybackLamports, '300000000')
  assert.deepEqual(after.totals.unburned, { lamports: '0', amount: '0' })
  // with only the dev buy before it, a burn bought nothing
  assert.equal(
    quantpLedger(
      [devBuy, burnHeld({ slot: 2, blockTime: t + 60 })].flatMap((x) => ledgerEntries(x)),
    ).burns[0].solSpent,
    null,
  )
})

test('burning tokens already held, by Burn or into the incinerator, is a burn and no buy', () => {
  assert.deepEqual(
    ledgerEntries(burnHeld()).map((e) => [e.kind, e.wallet, e.amount, e.method]),
    [['burn', CREATOR, 1_000_000_000_000n, 'burn']],
  )
  // sent to the incinerator from inside a wallet app's instruction, rent for its account paid
  const incinerated = ledgerEntries(
    tx({
      keys: [CREATOR, OWN_ATA, INCINERATOR_ATA, T22],
      instructions: [{ programId: 'WalletApp1111111111111111111111111111111111', accounts: [] }],
      inner: [
        {
          program: 'spl-token-2022',
          programId: T22,
          parsed: {
            type: 'transferChecked',
            info: {
              source: OWN_ATA,
              destination: INCINERATOR_ATA,
              authority: CREATOR,
              mint: QUANTP.mint,
              tokenAmount: { amount: '500000000000', decimals: 6 },
            },
          },
        },
      ],
      pre: [1_000_000_000, RENT, 0, 1],
      post: [1_000_000_000 - RENT - 5000, RENT, RENT, 1],
      preTokens: [balance(1, CREATOR, 4_500_000_000_000n)],
      postTokens: [
        balance(1, CREATOR, 4_000_000_000_000n),
        balance(2, INCINERATOR, 500_000_000_000n),
      ],
    }),
  )
  assert.deepEqual(
    incinerated.map((e) => [e.kind, e.amount, e.method]),
    [['burn', 500_000_000_000n, 'incinerator']],
  )
  // someone else's burn, or another mint's, is not the team's (nor is the buy then)
  const other = buyAndBurn()
  other.transaction.message.instructions[3].parsed.info.authority = HOLDER
  assert.deepEqual(
    ledgerEntries(other).map((e) => e.kind),
    [],
  )
  const otherMint = buyAndBurn()
  otherMint.transaction.message.instructions[3].parsed.info.mint = network.wsolMint
  assert.deepEqual(
    ledgerEntries(otherMint).map((e) => e.kind),
    [],
  )
})

test('payouts come in bursts: transactions sent together are one, newest first', () => {
  const later = tx({
    slot: 457_800_000,
    blockTime: REAL.payout3.blockTime + 7200,
    keys: [PAYOUT, NEW_HOLDER],
    instructions: [transfer(PAYOUT, NEW_HOLDER, 1_000_000)],
    pre: [9, 0],
    post: [9, 0],
  })
  const entries = [REAL.payout3, REAL.funding, later, REAL.payout1].flatMap((t) => ledgerEntries(t))
  const ledger = quantpLedger(entries, { payoutLamports: 1_580_000_000n })
  // the payout engine signs with the payout wallet
  assert.deepEqual(ledger.wallets, { payout: PAYOUT, creator: CREATOR, engine: PAYOUT })
  assert.equal(ledger.payoutLamports, '1580000000')
  assert.equal(ledger.payouts.length, 2)
  // the later one, to a single holder
  assert.deepEqual(
    [ledger.payouts[0].lamports, ledger.payouts[0].recipients, ledger.payouts[0].recipient],
    ['1000000', 1, NEW_HOLDER],
  )
  // round 1: its batches 9 s apart, in the order sent
  const round = ledger.payouts[1]
  assert.equal(round.timestamp, REAL.payout1.blockTime)
  assert.equal(round.lamports, '373256401')
  assert.equal(round.recipients, 31)
  assert.equal(round.recipient, null)
  assert.deepEqual(
    round.transactions.map((x) => [x.signature, x.lamports, x.recipients]),
    [
      [REAL.payout1.transaction.signatures[0], '358024234', 20],
      [REAL.payout3.transaction.signatures[0], '15232167', 11],
    ],
  )
  assert.deepEqual(ledger.totals, {
    paidLamports: '374256401',
    payoutTxs: 3,
    recipients: 32,
    burnedAmount: '0',
    buybackLamports: '0',
    unburned: { lamports: '0', amount: '0' },
  })
  assert.equal(quantpLedger([]).payoutLamports, null)
  assert.deepEqual(teamWallets().all, [PAYOUT, CREATOR])
})

// ---- the cached reader --------------------------------------------------------------------------

/** A connection answering the two wallets' histories (newest first) and their transactions. */
function historyConnection(histories, transactions, lamports = 1_580_000_000) {
  const calls = { signatures: [], transactions: [], options: [], balances: 0 }
  return {
    calls,
    histories,
    async getSignaturesForAddress(address, { limit, before, until } = {}) {
      const wallet = address.toBase58()
      calls.signatures.push({ wallet, before, until })
      let list = histories[wallet] || []
      if (until)
        list = list.slice(
          0,
          Math.max(
            0,
            list.findIndex((s) => s.signature === until),
          ),
        )
      if (before) list = list.slice(list.findIndex((s) => s.signature === before) + 1)
      return list.slice(0, limit)
    },
    async getParsedTransaction(signature, options) {
      calls.transactions.push(signature)
      calls.options.push(options)
      const t = transactions[signature]
      if (t instanceof Error) throw t
      return t ?? null
    },
    async getBalance(address) {
      calls.balances++
      assert.equal(address.toBase58(), PAYOUT)
      if (lamports instanceof Error) throw lamports
      return lamports
    },
  }
}
const listing = (t, err = null) => ({ signature: t.transaction.signatures[0], err })

test('each transaction is read once; refreshes list only what is newer, one call per wallet', async () => {
  const clock = { t: 1_000_000 }
  const s = (t) => t.transaction.signatures[0]
  const failedSwap = buyAndBurn()
  const txs = Object.fromEntries(
    [REAL.payout1, REAL.payout3, REAL.funding, failedSwap].map((t) => [s(t), t]),
  )
  const connection = historyConnection(
    {
      [PAYOUT]: [listing(REAL.payout3), listing(REAL.payout1), listing(REAL.funding)],
      [CREATOR]: [listing(REAL.payout3), listing(REAL.funding), listing(failedSwap, { err: 1 })],
    },
    txs,
  )
  const ledger = createQuantpLedger({ connection, now: () => clock.t, ttl: 120_000 })
  const first = await ledger.ledger()
  assert.equal(first.state, 'ok')
  assert.equal(first.updatedAt, 1000)
  assert.equal(first.payouts.length, 1)
  assert.equal(first.payouts[0].transactions.length, 2)
  assert.equal(first.totals.paidLamports, '373256401')
  assert.equal(first.payoutLamports, '1580000000')
  // a transaction in both histories is read once, a failed one never
  assert.equal(connection.calls.signatures.length, 2)
  assert.deepEqual(
    connection.calls.transactions.sort(),
    [s(REAL.payout1), s(REAL.payout3), s(REAL.funding)].sort(),
  )
  assert.equal(connection.calls.balances, 1)

  // within the TTL: no calls
  await ledger.ledger()
  assert.equal(connection.calls.signatures.length, 2)
  assert.equal(connection.calls.balances, 1)

  // after it: one listing per wallet from the newest seen, and only the new burn is read
  clock.t += 121_000
  const burn = buyAndBurn({ slot: 457_700_000 })
  txs[s(burn)] = burn
  connection.histories[PAYOUT].unshift(listing(burn))
  const second = await ledger.ledger()
  assert.deepEqual(
    connection.calls.signatures.slice(2).map((c) => [c.wallet, c.until]),
    [
      [PAYOUT, s(REAL.payout3)],
      [CREATOR, s(REAL.payout3)],
    ],
  )
  assert.deepEqual(connection.calls.transactions.slice(3), [s(burn)])
  assert.equal(second.burns.length, 1)
  assert.equal(second.totals.buybackLamports, '500000000')
  assert.equal(second.payouts.length, 1)
})

test('a transaction the node cannot return yet is read again; a failed refresh serves the last lists', async () => {
  const clock = { t: 5_000_000 }
  const s = REAL.payout1.transaction.signatures[0]
  const txs = {}
  const connection = historyConnection(
    { [PAYOUT]: [listing(REAL.payout1)], [CREATOR]: [] },
    txs,
    Error('balance unavailable'),
  )
  const ledger = createQuantpLedger({ connection, now: () => clock.t, ttl: 60_000 })
  const empty = await ledger.ledger()
  assert.equal(empty.payouts.length, 0)
  // the balance could not be read: unknown, and the lists still answer
  assert.equal(empty.payoutLamports, null)
  clock.t += 61_000
  txs[s] = REAL.payout1
  assert.equal((await ledger.ledger()).payouts.length, 1)
  assert.equal(connection.calls.transactions.filter((x) => x === s).length, 2)

  // the RPC fails: the last lists, marked stale once the TTL has passed
  connection.getSignaturesForAddress = async () => {
    throw Error('429 Too Many Requests')
  }
  clock.t += 61_000
  const stale = await ledger.ledger()
  assert.equal(stale.state, 'stale')
  assert.equal(stale.payouts.length, 1)
})

test('nothing read yet on this instance: a 503 the page can show', async () => {
  const connection = {
    getSignaturesForAddress: async () => {
      throw Error('fetch failed')
    },
  }
  const ledger = createQuantpLedger({ connection })
  await assert.rejects(() => ledger.ledger(), { status: 503, code: 'LEDGER_UNAVAILABLE' })
})

test('GET /api/quantp/ledger answers from the chain while Redis refuses every command', async () => {
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 't',
    request: async () =>
      new Response(JSON.stringify({ error: 'ERR max requests limit exceeded.' }), { status: 400 }),
    log: () => {},
  })
  const connection = historyConnection(
    { [PAYOUT]: [listing(REAL.payout3), listing(REAL.payout1)], [CREATOR]: [] },
    Object.fromEntries([REAL.payout1, REAL.payout3].map((t) => [t.transaction.signatures[0], t])),
  )
  const app = await createApplication({
    dataDir: mkdtempSync(join(tmpdir(), 'qp-ledger-')),
    store,
    serverless: true,
    quantum: null,
    background: false,
    connection,
    priceFeed: async () => ({ usd: 150 }),
  })
  const server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await fetch(base + '/api/quantp/ledger')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('cache-control'), QUANTP_LEDGER_CACHE)
    assert.equal(QUANTP_LEDGER_CACHE, 'public, max-age=0, s-maxage=60, stale-while-revalidate=300')
    const body = await r.json()
    assert.equal(body.mint, QUANTP.mint)
    assert.equal(body.payouts.length, 1)
    assert.equal(body.payouts[0].transactions.length, 2)
    assert.equal(body.totals.recipients, 31)
    assert.equal(body.payoutLamports, '1580000000')
    assert.deepEqual(body.burns, [])
    assert.equal((await fetch(base + '/api/quantp/ledger', { method: 'POST' })).status, 405)
  } finally {
    await new Promise((r) => server.close(r))
    app.close()
  }
})

// ---- the team's real buybacks, and dust sent to its wallets -------------------------------------

test('the payout wallet’s two buybacks are read from the chain; the dust sent to it is nothing', () => {
  // two aggregator buys into the DAMM v2 pool on 2026-10-16, fee and kept rent aside
  assert.deepEqual(
    [REAL.buy1, REAL.buy2].map((t) =>
      ledgerEntries(t).map((e) => [e.kind, e.wallet, e.lamports, e.amount]),
    ),
    [
      [['buy', PAYOUT, 320_013_872n, 1_432_024_251_739n]],
      [['buy', PAYOUT, 232_546_000n, 1_638_943_246_349n]],
    ],
  )
  // a version 1 transaction from a stranger, 1 lamport to each of 62 wallets (address poisoning)
  assert.equal(REAL.dust.version, 1)
  assert.equal(REAL.dust.transaction.message.instructions.length, 62)
  assert.deepEqual(ledgerEntries(REAL.dust), [])
  // together: what the payout wallet bought and holds, not burned yet
  const ledger = quantpLedger(Object.values(REAL).flatMap((t) => ledgerEntries(t)))
  assert.deepEqual(ledger.totals.unburned, { lamports: '552559872', amount: '3070967498088' })
  assert.equal(ledger.payouts.length, 1)
})

test('a transaction the node refuses is left for the next refresh and counted; the rest still list', async () => {
  const clock = { t: 9_000_000 }
  const s = (t) => t.transaction.signatures[0]
  const txs = {
    [s(REAL.dust)]: Error('Transaction version (1) is not supported by the requesting client.'),
    [s(REAL.payout3)]: REAL.payout3,
    [s(REAL.payout1)]: REAL.payout1,
  }
  const connection = historyConnection(
    { [PAYOUT]: [listing(REAL.dust), listing(REAL.payout3), listing(REAL.payout1)], [CREATOR]: [] },
    txs,
  )
  const ledger = createQuantpLedger({ connection, now: () => clock.t, ttl: 60_000 })
  const first = await ledger.ledger()
  assert.equal(first.state, 'ok')
  assert.equal(first.unread, 1)
  assert.equal(first.payouts.length, 1)
  assert.equal(first.totals.paidLamports, '373256401')
  // every read asks for the newest transaction version
  assert.ok(connection.calls.options.every((o) => o.maxSupportedTransactionVersion === 1))

  // next refresh: only the one left is read again
  clock.t += 61_000
  txs[s(REAL.dust)] = REAL.dust
  const second = await ledger.ledger()
  assert.equal(second.unread, 0)
  assert.deepEqual(connection.calls.transactions.slice(3), [s(REAL.dust)])
  assert.equal(second.payouts.length, 1)
})

test('/api/quantp’s `payouts`: what was really paid, bought back, burned and is waiting', () => {
  assert.equal(ledgerSummary(null), null)
  // round 1 and the payout wallet's two buybacks, from mainnet, with its balance then
  const ledger = {
    ...quantpLedger(
      Object.values(REAL).flatMap((t) => ledgerEntries(t)),
      {
        payoutLamports: 1_021_862_399n,
      },
    ),
    updatedAt: 1792204456,
  }
  assert.deepEqual(ledgerSummary(ledger), {
    paidLamports: '373256401', // the two round 1 batches in the fixtures
    wallets: 31,
    boughtLamports: '552559872', // 0.320 + 0.2325 SOL, none burned yet
    burnedAmount: '0',
    waitingLamports: '1021862399',
    updatedAt: 1792204456,
  })
})
