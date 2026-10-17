// $QUANTP's payouts and burns (server/quantp.mjs ledgerEntries, quantpLedger, createQuantpLedger)
// and GET /api/quantp/ledger while Redis refuses every command: payouts in bursts, each wallet's
// buys before its burn counted as its buyback (the launch dev buy aside), the payout wallet's
// balance, and the histories listed and read a part at a time. The fixtures are mainnet
// transactions (tests/fixtures/quantp-ledger.json, read with getParsedTransaction,
// maxSupportedTransactionVersion 1, logs dropped): two of round 1's three batches from the payout
// wallet, the creator wallet's transfer that funded it, the payout wallet's first two buybacks, a
// version 1 dust transaction a stranger sent it, and the payout engine's run at 07:00 UTC on
// 2026-10-17 (two payout batches, then its buyback, which burned everything bought so far) with
// the next hour's buyback.
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
// round 1 and what came before the payout engine
const BEFORE_ENGINE = ['payout1', 'payout3', 'funding', 'dust', 'buy1', 'buy2'].map((k) => REAL[k])
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
  // what each wallet got, beside who
  assert.equal(first.paid.length, 20)
  assert.deepEqual(
    first.paid.map(([to]) => to),
    first.recipients,
  )
  assert.equal(
    first.paid.reduce((s, [, lamports]) => s + lamports, 0n),
    first.lamports,
  )
  assert.deepEqual(
    first.paid.find(([to]) => to === HOLDER),
    [HOLDER, 25_330_962n],
  )
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
  // two transfers to one wallet: one recipient, paid both
  const [twice] = ledgerEntries(
    plain([transfer(PAYOUT, HOLDER, 1_000_000), transfer(PAYOUT, HOLDER, 500_000)]),
  )
  assert.deepEqual(twice.recipients, [HOLDER])
  assert.deepEqual(twice.paid, [[HOLDER, 1_500_000n]])
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

test('SOL moved to another wallet the team keeps is no payout; it is never a payer', () => {
  const OPS = 'OpsWa11et111111111111111111111111111111111'
  const token = { ...QUANTP, otherWallets: [OPS] }
  const wallets = teamWallets(token)
  assert.deepEqual(wallets.all, [PAYOUT, CREATOR, OPS])
  assert.deepEqual(wallets.payers, [PAYOUT])
  const send = (instructions) =>
    ledgerEntries(
      tx({ keys: [PAYOUT, OPS, HOLDER], instructions, pre: [9, 0, 0], post: [9, 0, 0] }),
      {
        token,
      },
    )
  assert.deepEqual(send([transfer(PAYOUT, OPS, 500_000_000)]), [])
  // beside a holder, it was paid as one
  assert.equal(
    send([transfer(PAYOUT, OPS, 1_000), transfer(PAYOUT, HOLDER, 1_000)])[0].recipients.length,
    2,
  )
  // its own transfers out are not payouts
  assert.deepEqual(send([transfer(OPS, HOLDER, 1_000_000)]), [])
  assert.deepEqual(teamWallets().all, [PAYOUT, CREATOR])
})

const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const memo = (text) => ({ parsed: text, program: 'spl-memo', programId: MEMO, stackHeight: null })
// The UTC hour of the 07:00 run, as the engine numbers its runs (hours since 1970).
const RUN = Math.floor(REAL.engine1.blockTime / 3600)

test('the engine’s 07:00 run: two payout batches, then a buyback that burned all it held', () => {
  const [a] = ledgerEntries(REAL.engine1)
  const [b] = ledgerEntries(REAL.engine2)
  assert.deepEqual(
    [a, b].map((e) => [e.kind, e.wallet, e.lamports, e.recipients.length]),
    [
      ['payout', PAYOUT, 3_607_526n, 18],
      ['payout', PAYOUT, 1_358_663n, 12],
    ],
  )
  // its buyback wraps SOL with a system transfer to its WSOL account: no payout
  const wrap = REAL.buyback.transaction.message.instructions.find(
    (ix) => ix.program === 'system' && ix.parsed.type === 'transfer',
  )
  assert.equal(wrap.parsed.info.source, PAYOUT)
  assert.equal(wrap.parsed.info.lamports, 3_322_871)
  const entries = ledgerEntries(REAL.buyback)
  assert.deepEqual(
    entries.map((e) => [e.kind, e.wallet, e.lamports, e.amount]),
    [
      ['buy', PAYOUT, 3_322_871n, 49_758_399_868n],
      ['burn', PAYOUT, undefined, 3_119_233_145_959n],
    ],
  )
  // what it burned was bought by it and by the payout wallet's first two buybacks
  const ledger = quantpLedger([REAL.buy1, REAL.buy2, REAL.buyback].flatMap((t) => ledgerEntries(t)))
  assert.equal(ledger.burns.length, 1)
  assert.equal(ledger.burns[0].amount, '3119233145959')
  assert.equal(ledger.burns[0].solSpent, '555616844')
  assert.deepEqual(ledger.totals.unburned, { lamports: '265899', amount: '1492751997' })
  assert.deepEqual(ledger.totals.unburnedByWallet, {
    [PAYOUT]: { lamports: '265899', amount: '1492751997' },
  })
  // the next hour's buyback spent what that one left, and its own buy
  const next = quantpLedger(
    [REAL.buy1, REAL.buy2, REAL.buyback, REAL.buyback2].flatMap((t) => ledgerEntries(t)),
  )
  assert.deepEqual(
    next.burns.map((x) => [x.amount, x.solSpent]),
    [
      ['49346601807', '3457386'],
      ['3119233145959', '555616844'],
    ],
  )

  // one payout of 2 transactions at 07:00, apart from the 06:06 run's
  const earlier = structuredClone(REAL.engine1)
  earlier.transaction.signatures = [sig('run0606')]
  earlier.slot -= 8_000
  earlier.blockTime = REAL.engine1.blockTime - 3246 // 06:06:16
  const run = quantpLedger(
    [earlier, REAL.engine1, REAL.engine2, REAL.buyback].flatMap((t) => ledgerEntries(t)),
  )
  assert.equal(run.payouts.length, 2)
  assert.deepEqual(
    run.payouts[0].transactions.map((x) => x.signature),
    [REAL.engine1.transaction.signatures[0], REAL.engine2.transaction.signatures[0]],
  )
  assert.equal(run.payouts[0].lamports, '4966189')
  assert.equal(run.payouts[0].recipients, 30)
  assert.equal(run.payouts[0].timestamp, 1792220422)
  assert.equal(run.payouts[0].lastTimestamp, 1792220423)
  assert.equal(run.payouts[1].transactions.length, 1)
})

test('the engine’s memo names its run on every entry; its hourly claim is no entry at all', () => {
  const ENGINE = PAYOUT
  // a payout batch ending with its memo
  const batch = tx({
    keys: [ENGINE, HOLDER, NEW_HOLDER, SYSTEM, MEMO],
    instructions: [
      { programId: COMPUTE, data: 'x', accounts: [] },
      transfer(ENGINE, HOLDER, 300_000),
      transfer(ENGINE, NEW_HOLDER, 200_000),
      memo(`qp-engine:v1 h=${RUN} pot=500000 H=12345`),
    ],
    pre: [9, 0, 0, 1, 1],
    post: [9, 0, 0, 1, 1],
  })
  const [payout] = ledgerEntries(batch)
  assert.equal(payout.kind, 'payout')
  assert.equal(payout.run, RUN)
  assert.equal(payout.lamports, 500_000n)
  // the buyback with its memo: the buy and the burn both carry the run
  const buyback = buyAndBurn()
  buyback.transaction.message.instructions.push(memo(`qp-engine:v1 h=${RUN} bb=500000000`))
  assert.deepEqual(
    ledgerEntries(buyback).map((e) => [e.kind, e.run]),
    [
      ['buy', RUN],
      ['burn', RUN],
    ],
  )
  // a memo of anything else names no run
  const other = tx({
    keys: [ENGINE, HOLDER],
    instructions: [transfer(ENGINE, HOLDER, 1_000), memo('gm')],
    pre: [9, 0],
    post: [9, 0],
  })
  assert.equal('run' in ledgerEntries(other)[0], false)

  // the hourly claim: a 0-byte account made from the engine's wallet with a seed, last hour's
  // swept back into it, and its memo. The wallet pays the new account's rent and the fee.
  const MARKER = 'C1aimMarker11111111111111111111111111111111'
  const OLD_MARKER = 'C1aimMarker22222222222222222222222222222222'
  const claim = tx({
    keys: [ENGINE, MARKER, OLD_MARKER, SYSTEM, MEMO, COMPUTE],
    instructions: [
      { programId: COMPUTE, data: 'x', accounts: [] },
      {
        program: 'system',
        programId: SYSTEM,
        parsed: {
          type: 'createAccountWithSeed',
          info: {
            source: ENGINE,
            newAccount: MARKER,
            base: ENGINE,
            seed: `qp${RUN}`,
            lamports: 890_880,
            space: 0,
            owner: SYSTEM,
          },
        },
      },
      {
        program: 'system',
        programId: SYSTEM,
        parsed: {
          type: 'transferWithSeed',
          info: {
            source: OLD_MARKER,
            sourceBase: ENGINE,
            destination: ENGINE,
            lamports: 890_880,
            sourceSeed: `qp${RUN - 1}`,
            sourceOwner: SYSTEM,
          },
        },
      },
      memo(`qp-engine:v1 h=${RUN} claim`),
    ],
    pre: [1_000_000_000, 0, 890_880, 1, 1, 1],
    post: [1_000_000_000 - 5_000, 890_880, 0, 1, 1, 1],
  })
  assert.deepEqual(ledgerEntries(claim), [])
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

test('a wallet’s small buys before its burn are the burn’s buyback; the launch dev buy is not', () => {
  const t = QUANTP.launchedAt
  const devBuy = buy({ lamports: 118_128_240, tokens: 3_500_001_616_770n, slot: 1, blockTime: t })
  const entries = [
    devBuy,
    buy({ lamports: 100_000_000, slot: 10, blockTime: t + 3600 }),
    buy({ lamports: 200_000_000, slot: 11, blockTime: t + 3650 }),
    // the payout wallet buys too: its buys are its own burns' buyback, not the creator's
    buy({ wallet: PAYOUT, lamports: 50_000_000, slot: 12, blockTime: t + 3700 }),
    burnHeld({ slot: 13, blockTime: t + 3800 }),
  ].flatMap((x) => ledgerEntries(x))
  const ledger = quantpLedger(entries)
  // the creator bought 2M for 0.3 SOL and burned 1M: half of it
  assert.equal(ledger.burns[0].solSpent, '150000000')
  assert.deepEqual(ledger.totals.unburned, { lamports: '200000000', amount: '2000000000000' })
  assert.deepEqual(ledger.totals.unburnedByWallet, {
    [CREATOR]: { lamports: '150000000', amount: '1000000000000' },
    [PAYOUT]: { lamports: '50000000', amount: '1000000000000' },
  })

  const more = [
    ...entries,
    ...ledgerEntries(burnHeld({ slot: 14, blockTime: t + 3900 })),
    // nothing the creator bought is left: the payout wallet's buy is not this burn's
    ...ledgerEntries(burnHeld({ slot: 15, blockTime: t + 4000 })),
    ...ledgerEntries(burnHeld({ wallet: PAYOUT, slot: 16, blockTime: t + 4100 })),
  ]
  const after = quantpLedger(more)
  assert.deepEqual(
    after.burns.map((b) => [b.wallet, b.solSpent]),
    [
      [PAYOUT, '50000000'],
      [CREATOR, null],
      [CREATOR, '150000000'],
      [CREATOR, '150000000'],
    ],
  )
  assert.equal(after.totals.burnedAmount, '4000000000000')
  assert.equal(after.totals.buybackLamports, '350000000')
  assert.deepEqual(after.totals.unburned, { lamports: '0', amount: '0' })
  assert.deepEqual(after.totals.unburnedByWallet, {})
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
  assert.equal(round.lastTimestamp, REAL.payout3.blockTime)
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
    unburnedByWallet: {},
  })
  assert.equal(quantpLedger([]).payoutLamports, null)
  assert.deepEqual(teamWallets().all, [PAYOUT, CREATOR])
})

/** A payout of `lamports` from `wallet` at `at` (seconds), with the engine's memo for `run`. */
function payoutAt(at, { run, wallet = PAYOUT, to = NEW_HOLDER, lamports = 1_000_000 } = {}) {
  return tx({
    signature: sig(`p${at}`),
    slot: at, // one slot a second, enough to keep them in order
    blockTime: at,
    keys: [wallet, to],
    instructions: [
      transfer(wallet, to, lamports),
      ...(run == null ? [] : [memo(`qp-engine:v1 h=${run} pot=${lamports} H=1`)]),
    ],
    pre: [9, 0],
    post: [9, 0],
  })
}
const DAY = 1_792_195_200 // 2026-10-17 00:00 UTC
const at = (h, m, s = 0) => DAY + h * 3600 + m * 60 + s
const rows = (txs) =>
  quantpLedger(txs.flatMap((t) => ledgerEntries(t)))
    .payouts.map((p) => p.transactions.length)
    .reverse()

test('a payout row is one run: hours apart, memos apart, or a burn between split them', () => {
  // a late run and the next hour's early one, 4 and 25 minutes apart, are two payouts
  assert.deepEqual(rows([payoutAt(at(6, 58)), payoutAt(at(7, 2))]), [1, 1])
  assert.deepEqual(rows([payoutAt(at(6, 40)), payoutAt(at(7, 5))]), [1, 1])
  // three batches paid by hand 9 s apart are one, even across the hour
  assert.deepEqual(
    rows([payoutAt(at(6, 59, 55)), payoutAt(at(7, 0, 4)), payoutAt(at(7, 0, 13))]),
    [3],
  )
  // within the hour, 25 minutes apart (a round resumed by hand) is still one
  assert.deepEqual(rows([payoutAt(at(7, 5)), payoutAt(at(7, 30))]), [2])
  // the engine's memos: two runs a second apart are two payouts, one run's batches one
  assert.deepEqual(
    rows([
      payoutAt(at(7, 59, 58), { run: RUN }),
      payoutAt(at(7, 59, 59), { run: RUN }),
      payoutAt(at(8, 0, 0), { run: RUN + 1 }),
      payoutAt(at(8, 0, 1)),
    ]),
    [2, 1, 1],
  )
  // the wallet's burn ends its run's payout; another wallet's does not
  assert.deepEqual(
    rows([
      payoutAt(at(9, 0, 0)),
      burnHeld({ wallet: PAYOUT, slot: at(9, 0, 5), blockTime: at(9, 0, 5) }),
      payoutAt(at(9, 0, 10)),
      burnHeld({ slot: at(9, 0, 12), blockTime: at(9, 0, 12) }),
      payoutAt(at(9, 0, 15)),
    ]),
    [1, 2],
  )
  // and two paying wallets' payouts are never one
  const ENGINE = 'EngineWa11et1111111111111111111111111111111'
  const token = { ...QUANTP, engine: { ...QUANTP.engine, wallet: ENGINE } }
  const two = quantpLedger(
    [payoutAt(at(10, 0)), payoutAt(at(10, 0, 1), { wallet: ENGINE })].flatMap((t) =>
      ledgerEntries(t, { token }),
    ),
    { token },
  )
  assert.deepEqual(
    two.payouts.map((p) => p.wallet),
    [ENGINE, PAYOUT],
  )
  const last = quantpLedger(
    [payoutAt(at(7, 5)), payoutAt(at(7, 30))].flatMap((t) => ledgerEntries(t)),
  )
  assert.deepEqual(
    [last.payouts[0].timestamp, last.payouts[0].lastTimestamp],
    [at(7, 5), at(7, 30)],
  )
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
const listing = (t, err = null) => ({
  signature: t.transaction.signatures[0],
  slot: t.slot,
  blockTime: t.blockTime,
  err,
})

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
  const ledger = quantpLedger(BEFORE_ENGINE.flatMap((t) => ledgerEntries(t)))
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
  assert.equal(first.state, 'partial')
  assert.equal(first.complete, false)
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
  assert.equal(second.state, 'ok')
  assert.equal(second.complete, true)
  assert.deepEqual(connection.calls.transactions.slice(3), [s(REAL.dust)])
  assert.equal(second.payouts.length, 1)
})

test('/api/quantp’s `payouts`: what was really paid, bought back, burned and is waiting', () => {
  assert.equal(ledgerSummary(null), null)
  // round 1 and the payout wallet's two buybacks, from mainnet, with its balance then
  const ledger = {
    ...quantpLedger(
      BEFORE_ENGINE.flatMap((t) => ledgerEntries(t)),
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
    complete: true,
    since: null,
  })
  // older history still being read: the figures are at least these, counted since `since`
  assert.deepEqual(
    Object.entries(ledgerSummary({ ...ledger, complete: false, since: 1792126586 })).slice(-2),
    [
      ['complete', false],
      ['since', 1792126586],
    ],
  )
})

// ---- reading a long history a part at a time ----------------------------------------------------

/** `count` payouts from the payout wallet a minute apart, newest first, as listed and as read. */
function payoutHistory(count, startAt = at(12, 0)) {
  const txs = Array.from({ length: count }, (_, i) =>
    payoutAt(startAt + 60 * i, { lamports: 1_000 + i }),
  ).reverse()
  return {
    list: txs.map((t) => listing(t)),
    byId: Object.fromEntries(txs.map((t) => [t.transaction.signatures[0], t])),
  }
}

test('histories are listed page by page; one cut off at the page cap is finished on later refreshes', async () => {
  const clock = { t: 20_000_000 }
  const options = { now: () => clock.t, pageLimit: 2, maxPages: 2, ttl: 60_000 }
  const pages = (connection) =>
    connection.calls.signatures
      .filter((c) => c.wallet === PAYOUT)
      .map((c) => [c.before ?? null, c.until ?? null])

  // 3 signatures: two pages on the first load, nothing left over
  const three = payoutHistory(3)
  const small = historyConnection({ [PAYOUT]: three.list, [CREATOR]: [] }, three.byId)
  const whole = await createQuantpLedger({ connection: small, ...options }).ledger()
  assert.deepEqual(pages(small), [
    [null, null],
    [three.list[1].signature, null],
  ])
  assert.equal(whole.totals.payoutTxs, 3)
  assert.equal(whole.complete, true)
  assert.equal(whole.state, 'ok')
  assert.equal(whole.since, three.list[2].blockTime)

  // 5: the cap is reached with more to list, so the lists say they are not complete
  const five = payoutHistory(5)
  const connection = historyConnection({ [PAYOUT]: five.list, [CREATOR]: [] }, five.byId)
  const ledger = createQuantpLedger({ connection, ...options })
  const first = await ledger.ledger()
  assert.equal(first.totals.payoutTxs, 4)
  assert.equal(first.complete, false)
  assert.equal(first.state, 'partial')
  assert.equal(first.unread, 0)
  assert.equal(first.since, five.list[3].blockTime)
  assert.equal(ledgerSummary(first).complete, false)
  // the next refresh, soon after, lists from the tip and one more page of the older history
  clock.t += 10_000
  const second = await ledger.ledger()
  assert.deepEqual(pages(connection).slice(2), [
    [null, five.list[0].signature],
    [five.list[3].signature, null],
  ])
  assert.equal(second.totals.payoutTxs, 5)
  assert.equal(second.complete, true)
  assert.equal(second.since, five.list[4].blockTime)

  // more than a page arrives between two refreshes: the gap below the new ones is listed after
  // them, never skipped
  const more = payoutHistory(5, at(13, 0))
  connection.histories[PAYOUT] = [...more.list, ...five.list]
  Object.assign(five.byId, more.byId)
  clock.t += 60_000
  const third = await ledger.ledger()
  assert.equal(third.totals.payoutTxs, 9)
  assert.equal(third.complete, false)
  clock.t += 10_000
  const fourth = await ledger.ledger()
  assert.deepEqual(pages(connection).slice(4), [
    [null, five.list[0].signature],
    [more.list[1].signature, five.list[0].signature],
    [null, more.list[0].signature],
    [more.list[3].signature, five.list[0].signature],
  ])
  assert.equal(fourth.totals.payoutTxs, 10)
  assert.equal(fourth.complete, true)
  assert.equal(fourth.state, 'ok')
  // each signature was read once
  assert.equal(connection.calls.transactions.length, 10)
  assert.equal(new Set(connection.calls.transactions).size, 10)
})

test('a long history is read newest first, a budget per refresh, and shown as it goes', async () => {
  const clock = { t: 30_000_000 }
  const six = payoutHistory(6)
  const connection = historyConnection({ [PAYOUT]: six.list, [CREATOR]: [] }, six.byId)
  const read = connection.getParsedTransaction
  // every read takes 600 ms
  connection.getParsedTransaction = async (...args) => {
    clock.t += 600
    return read(...args)
  }
  const ledger = createQuantpLedger({
    connection,
    now: () => clock.t,
    concurrency: 1,
    maxReads: 3,
    readMs: 1_000,
  })
  const first = await ledger.ledger()
  // the time budget stops it after two reads (one batch always goes)
  assert.deepEqual(
    connection.calls.transactions,
    six.list.slice(0, 2).map((s) => s.signature),
  )
  assert.equal(first.state, 'partial')
  assert.equal(first.complete, false)
  assert.equal(first.unread, 4)
  assert.equal(first.totals.payoutTxs, 2)
  assert.equal(first.payouts[0].lastTimestamp, six.list[0].blockTime)
  assert.equal(first.since, six.list[1].blockTime)

  // not due yet: what is cached
  clock.t += 5_000
  await ledger.ledger()
  assert.equal(connection.calls.transactions.length, 2)
  // soon after, the next part, which the read budget caps at 3
  clock.t += 5_000
  connection.getParsedTransaction = read
  const second = await ledger.ledger()
  assert.deepEqual(
    connection.calls.transactions.slice(2),
    six.list.slice(2, 5).map((s) => s.signature),
  )
  assert.equal(second.unread, 1)
  // one the node does not return yet is read again on the next refresh
  const last = six.list[5].signature
  const kept = six.byId[last]
  delete six.byId[last]
  clock.t += 10_000
  assert.equal((await ledger.ledger()).unread, 1)
  six.byId[last] = kept
  clock.t += 10_000
  const done = await ledger.ledger()
  assert.equal(done.unread, 0)
  assert.equal(done.complete, true)
  assert.equal(done.state, 'ok')
  assert.equal(done.totals.payoutTxs, 6)
})

test('a transaction that failed to read waits behind the others', async () => {
  const three = payoutHistory(3)
  const connection = historyConnection({ [PAYOUT]: three.list, [CREATOR]: [] }, three.byId)
  const newest = three.list[0].signature
  const kept = three.byId[newest]
  three.byId[newest] = Error('Transaction version (2) is not supported by the requesting client.')
  const clock = { t: 35_000_000 }
  const ledger = createQuantpLedger({
    connection,
    now: () => clock.t,
    concurrency: 1,
    maxReads: 1,
  })
  await ledger.ledger()
  clock.t += 10_000
  await ledger.ledger()
  // the refused one was not tried again before the one after it
  assert.deepEqual(connection.calls.transactions, [newest, three.list[1].signature])
  three.byId[newest] = kept
  clock.t += 10_000
  await ledger.ledger()
  clock.t += 10_000
  assert.equal((await ledger.ledger()).unread, 0)
})

test('one that fails 3 reads is still asked for, but no longer every 10 s, and the lists stay partial', async () => {
  const clock = { t: 37_000_000 }
  const three = payoutHistory(3)
  const connection = historyConnection({ [PAYOUT]: three.list, [CREATOR]: [] }, three.byId)
  const newest = three.list[0].signature
  const kept = three.byId[newest]
  three.byId[newest] = Error('Transaction version (2) is not supported by the requesting client.')
  const reads = () => connection.calls.transactions.filter((s) => s === newest).length
  const ledger = createQuantpLedger({ connection, now: () => clock.t, ttl: 120_000 })
  const first = await ledger.ledger()
  assert.deepEqual(
    [first.unread, first.unreadable, first.newestUnreadAt],
    [1, 0, three.list[0].blockTime],
  )
  // tried again soon, twice more
  clock.t += 10_000
  await ledger.ledger()
  clock.t += 10_000
  const given = await ledger.ledger()
  assert.equal(reads(), 3)
  // given up: still unread, so the lists are not complete, but it no longer says a newer
  // transaction is waiting
  assert.deepEqual(
    [given.unread, given.unreadable, given.newestUnreadAt, given.complete, given.state],
    [1, 1, null, false, 'partial'],
  )
  assert.equal(given.totals.payoutTxs, 2)
  // not refreshed again before ttl
  clock.t += 10_000
  await ledger.ledger()
  clock.t += 100_000
  await ledger.ledger()
  assert.equal(reads(), 3)
  // then asked for once more, on each refresh
  clock.t += 10_000
  await ledger.ledger()
  assert.equal(reads(), 4)
  // and read once the node returns it
  three.byId[newest] = kept
  clock.t += 120_000
  const done = await ledger.ledger()
  assert.deepEqual(
    [done.unread, done.unreadable, done.newestUnreadAt, done.complete, done.state],
    [0, 0, null, true, 'ok'],
  )
  assert.equal(done.totals.payoutTxs, 3)
})

test('on the public RPC, reads pause between batches', async () => {
  const four = payoutHistory(4)
  const connection = historyConnection({ [PAYOUT]: four.list, [CREATOR]: [] }, four.byId)
  connection.rpcEndpoint = 'https://api.mainnet-beta.solana.com'
  const pauses = []
  const sleep = async (ms) => pauses.push(ms)
  const ledger = createQuantpLedger({ connection, concurrency: 2, sleep })
  assert.equal((await ledger.ledger()).totals.payoutTxs, 4)
  assert.deepEqual(pauses, [250])
  // a provider's RPC: no pauses
  const provider = historyConnection({ [PAYOUT]: four.list, [CREATOR]: [] }, four.byId)
  provider.rpcEndpoint = 'https://rpc.provider.invalid'
  await createQuantpLedger({ connection: provider, concurrency: 2, sleep }).ledger()
  assert.deepEqual(pauses, [250])
})

test('peek() answers at once with what is cached, and refreshes behind it', async () => {
  const clock = { t: 40_000_000 }
  const two = payoutHistory(2)
  const connection = historyConnection({ [PAYOUT]: two.list, [CREATOR]: [] }, two.byId)
  const list = connection.getSignaturesForAddress
  let release
  let asked = 0
  const gate = new Promise((r) => (release = r))
  connection.getSignaturesForAddress = async (...args) => {
    asked++
    await gate
    return list(...args)
  }
  const tick = () => new Promise((r) => setImmediate(r))
  const ledger = createQuantpLedger({ connection, now: () => clock.t, ttl: 60_000 })
  // nothing yet: null, at once, and the first load has started
  assert.equal(ledger.loading(), false)
  assert.equal(ledger.peek(), null)
  assert.equal(ledger.loading(), true)
  await tick()
  assert.equal(asked, 2) // both wallets, waiting at the gate
  // asked again while it loads: still null, and no second load
  assert.equal(ledger.peek(), null)
  release()
  let value = null
  for (let i = 0; i < 50 && !value; i++) {
    await tick()
    value = ledger.peek()
  }
  assert.equal(value.state, 'ok')
  assert.equal(value.totals.payoutTxs, 2)
  assert.equal(asked, 2)
  assert.equal(ledger.loading(), false)
  // past its lifetime: the old lists at once, marked stale, while a refresh runs
  clock.t += 61_000
  const old = ledger.peek()
  assert.equal(old.state, 'stale')
  assert.equal(old.totals.payoutTxs, 2)
  await tick()
  assert.equal(asked, 4)
})

test('forWallet: what the payouts read so far sent one wallet, newest first', async () => {
  const PAID_TWICE = '3rkwX6jPuVs5iCBJMEUJu2Ch7qKE7Gm8B5U5qYW8TBK6' // in round 1 and at 07:00
  const txs = [REAL.engine2, REAL.engine1, REAL.payout3, REAL.payout1]
  const connection = historyConnection(
    { [PAYOUT]: txs.map((t) => listing(t)), [CREATOR]: [] },
    Object.fromEntries(txs.map((t) => [t.transaction.signatures[0], t])),
  )
  const ledger = createQuantpLedger({ connection })
  assert.deepEqual(await ledger.forWallet(PAID_TWICE), {
    lamports: String(25_971_298 + 233_072),
    payouts: 2,
    lastAt: REAL.engine1.blockTime,
    items: [
      {
        signature: REAL.engine1.transaction.signatures[0],
        timestamp: REAL.engine1.blockTime,
        lamports: '233072',
      },
      {
        signature: REAL.payout1.transaction.signatures[0],
        timestamp: REAL.payout1.blockTime,
        lamports: '25971298',
      },
    ],
    complete: true,
    since: REAL.payout1.blockTime,
  })
  assert.equal((await ledger.forWallet(PAID_TWICE, { limit: 1 })).items.length, 1)
  assert.deepEqual(await ledger.forWallet(NEW_HOLDER), {
    lamports: '0',
    payouts: 0,
    lastAt: null,
    items: [],
    complete: true,
    since: REAL.payout1.blockTime,
  })
})
