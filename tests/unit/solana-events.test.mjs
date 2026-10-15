import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import {
  extractEvents,
  createFrom,
  tradesFrom,
  dammPoolFor,
  DBC,
  DAMM,
} from '../../server/solana.mjs'
import { dbcCoder, dammCoder, dbcPoolPda } from '../../shared/meteora.mjs'
import { launchTiers, network, priceFromSqrtPrice } from '../../shared/network.mjs'
import {
  address,
  buildTx,
  createIx,
  swapIx,
  transferCreatorIx,
  dbcPoolFor,
} from './meteora-chain.mjs'

// Mainnet transactions (tests/fixtures/fetch-meteora.mjs): a Quant Pad launch with its dev buy, a
// DBC curve swap routed through Jupiter, and a DAMM v2 pool swap.
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))
const TAG = 'e445a52e51cb9a1d' // Anchor's event-CPI instruction tag
const keysOf = (tx) => tx.transaction.message.accountKeys
// The instruction `name` of `program` in the transaction (outer or inner), decoded.
function findIx(tx, program, name) {
  const keys = keysOf(tx)
  const coder = program === DBC ? dbcCoder : dammCoder
  const all = [
    ...tx.transaction.message.instructions,
    ...tx.meta.innerInstructions.flatMap((g) => g.instructions),
  ]
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== program) continue
    const decoded = (() => {
      try {
        return coder.instruction.decode(Buffer.from(bs58.decode(ix.data)))
      } catch {
        return null
      }
    })()
    if (decoded?.name === name) return { ...decoded, accounts: ix.accounts.map((i) => keys[i]) }
  }
  return null
}

test('decodes a real DBC curve swap from mainnet, counting the swap once', () => {
  const { signature, tx } = fixture('dbc-swap')
  const events = extractEvents(tx)
  // swap2 emits the legacy EvtSwap next to EvtSwap2; both decode, the trade counts once.
  assert.deepEqual(
    events.map((e) => e.name),
    ['EvtSwap', 'EvtSwap2'],
  )
  const { event } = events[1]
  const dbcPool = event.pool.toBase58()
  const trades = tradesFrom(tx, { signature, mint: 'irrelevant', dbcPool, pool: null })
  assert.equal(trades.length, 1)
  const [trade] = trades
  assert.equal(trade.venue, 'curve')
  assert.equal(trade.side, Number(event.tradeDirection) === 1 ? 'buy' : 'sell')
  assert.equal(trade.id, `${signature}:1`, 'the EvtSwap2 event, in execution order')
  const r = event.swapResult
  const [sol, tokens] =
    trade.side === 'buy'
      ? [r.includedFeeInputAmount, r.outputAmount]
      : [r.outputAmount, r.includedFeeInputAmount]
  assert.equal(trade.solAmount, sol.toString())
  assert.equal(trade.tokenAmount, tokens.toString())
  assert.ok(BigInt(trade.solAmount) > 0n && BigInt(trade.tokenAmount) > 0n)
  assert.equal(trade.price, priceFromSqrtPrice(r.nextSqrtPrice))
  assert.ok(trade.price > 0 && trade.price < 1, 'price is SOL per whole token')
  assert.equal(trade.quoteReserve, event.quoteReserveAmount.toString())
  assert.equal(trade.migrationThreshold, event.migrationThreshold.toString())
  assert.equal(trade.timestamp, Number(event.currentTimestamp))
  assert.ok(Math.abs(trade.timestamp - tx.blockTime) < 60)
  // Routed through Jupiter: the trader is swap2's payer account, the CPI's own signer.
  const swap2 = findIx(tx, DBC, 'swap2')
  assert.equal(trade.trader, swap2.accounts[9])
  assert.equal(events[1].emitter.program, DBC)
})

test('falls back to "Program data:" log lines when inner event instructions are absent', () => {
  const { signature, tx } = fixture('dbc-swap')
  const stripped = { ...tx, meta: { ...tx.meta, innerInstructions: [] } }
  // DBC emits its events through self-CPI only: mainnet logs carry no "Program data:" for them.
  assert.deepEqual(extractEvents(stripped), [])
  // Older programs logged them: those lines are read, attributed to the program invoking.
  const data = tx.meta.innerInstructions
    .flatMap((g) => g.instructions)
    .filter((ix) => keysOf(tx)[ix.programIdIndex] === DBC)
    .map((ix) => Buffer.from(bs58.decode(ix.data)))
    .filter((bytes) => bytes.subarray(0, 8).toString('hex') === TAG)
    .map((bytes) => `Program data: ${bytes.subarray(8).toString('base64')}`)
  const logged = {
    ...stripped,
    meta: {
      ...stripped.meta,
      logMessages: [`Program ${DBC} invoke [1]`, ...data, `Program ${DBC} success`],
    },
  }
  const fromLogs = extractEvents(logged)
  assert.deepEqual(
    fromLogs.map((e) => [e.name, e.emitter]),
    [
      ['EvtSwap', null],
      ['EvtSwap2', null],
    ],
  )
  const dbcPool = fromLogs[1].event.pool.toBase58()
  const read = (t) => tradesFrom(t, { signature, mint: 'x', dbcPool, pool: null })
  assert.deepEqual(
    read(logged).map((t) => [t.solAmount, t.tokenAmount, t.price]),
    read(tx).map((t) => [t.solAmount, t.tokenAmount, t.price]),
  )
  // Without the emitting instruction the fee payer is the best guess at the trader.
  assert.equal(read(logged)[0].trader, keysOf(tx)[0])
  // A data line under another program is not a Meteora event.
  const foreign = {
    ...logged,
    meta: {
      ...logged.meta,
      logMessages: [`Program ${address()} invoke [1]`, ...data, `Program x success`],
    },
  }
  assert.deepEqual(extractEvents(foreign), [])
})

test('reads a real Quant Pad launch: the create and its dev buy in one transaction', () => {
  const { signature, tx } = fixture('dbc-create')
  const create = createFrom(tx, { signature })
  const init = findIx(tx, DBC, 'initializeVirtualPoolWithSplToken')
  assert.ok(init, 'launched with initialize_virtual_pool_with_spl_token')
  assert.equal(create.mint, init.accounts[3])
  assert.equal(create.name, init.data.params.name)
  assert.equal(create.symbol, init.data.params.symbol)
  assert.equal(create.uri, init.data.params.uri)
  assert.match(create.uri, /^https:\/\/quant-pad\.vercel\.app\/m\/[0-9a-f]{32}$/)
  assert.equal(create.dbcConfig, launchTiers[0].config, "on Quant Pad's 1% config")
  assert.equal(create.dbcPool, dbcPoolPda(create.dbcConfig, create.mint).toBase58())
  // A standard launch: the launcher is the pool's creator and paid for it.
  assert.equal(create.creator, init.accounts[2])
  assert.equal(create.launcher, create.creator)
  assert.equal(init.accounts[10], create.creator)
  assert.equal(create.tokenProgram, network.tokenProgram)
  assert.equal(create.quoteMint, network.wsolMint)
  assert.equal(create.createdAt, tx.blockTime)
  assert.equal(create.signature, signature)
  assert.equal(create.slot, tx.slot)
  // Asking for another mint finds nothing.
  assert.equal(createFrom(tx, { signature, mint: address() }), null)

  const trades = tradesFrom(tx, {
    signature,
    mint: create.mint,
    dbcPool: create.dbcPool,
    pool: null,
  })
  assert.deepEqual(
    trades.map((t) => t.side),
    ['create', 'buy'],
  )
  const [marker, buy] = trades
  assert.equal(marker.createdAt, tx.blockTime)
  assert.equal(marker.price, undefined, 'a marker has no price')
  const swap = extractEvents(tx).find((e) => e.name === 'EvtSwap2').event
  assert.equal(buy.trader, create.creator)
  assert.equal(buy.solAmount, swap.swapResult.includedFeeInputAmount.toString())
  assert.equal(buy.tokenAmount, swap.swapResult.outputAmount.toString())
  // The dev buy is an exact-out first swap that paid the 1% minimum fee.
  assert.equal(Number(swap.swapParameters.swapMode), 2)
  const fee = swap.swapResult.tradingFee.add(swap.swapResult.protocolFee)
  assert.equal(fee.muln(100).toString(), swap.swapResult.includedFeeInputAmount.toString())
  assert.equal(buy.quoteReserve, swap.quoteReserveAmount.toString())
  assert.equal(buy.migrationThreshold, '85000000000', 'migrates at 85 SOL')
  assert.ok(buy.price > 0 && buy.price < 1e-6)
})

test('a Quantum launch hands its pool to the well in the same transaction: creator follows it', () => {
  const mint = address()
  const launcher = address()
  const well = address()
  const tx = buildTx(
    [
      createIx(mint, { creator: launcher, uri: 'https://quant-pad.vercel.app/m/x' }),
      transferCreatorIx(mint, { creator: launcher, newCreator: well }),
      swapIx(mint, { price: 3e-8, payer: launcher }),
    ],
    { slot: 7 },
  )
  const create = createFrom(tx, { signature: 'sig' })
  assert.equal(create.creator, well, 'the pool creator at the end of the transaction')
  assert.equal(create.launcher, launcher)
  assert.equal(create.dbcPool, dbcPoolFor(mint))
  // A creator change on another pool is not this coin's.
  const other = buildTx([
    createIx(mint, { creator: launcher }),
    transferCreatorIx(address(), { creator: launcher, newCreator: well }),
  ])
  assert.equal(createFrom(other, { signature: 'sig' }).creator, launcher)
})

test('decodes a real DAMM v2 swap only for the matching pool', () => {
  const { signature, tx } = fixture('damm-swap')
  const events = extractEvents(tx)
  const swap = events.find((e) => e.program === DAMM && e.name === 'EvtSwap2')
  assert.ok(swap)
  const pool = swap.event.pool.toBase58()
  const trades = tradesFrom(tx, { signature, mint: 'irrelevant', dbcPool: null, pool })
  assert.equal(trades.length, 1)
  const [trade] = trades
  assert.equal(trade.venue, 'pool')
  // Token B is SOL: B to A (trade_direction 1) buys the coin.
  const r = swap.event.swapResult
  const buy = Number(swap.event.tradeDirection) === 1
  assert.equal(trade.side, buy ? 'buy' : 'sell')
  assert.equal(trade.solAmount, (buy ? r.includedFeeInputAmount : r.outputAmount).toString())
  assert.equal(trade.tokenAmount, (buy ? r.outputAmount : r.includedFeeInputAmount).toString())
  assert.equal(trade.price, priceFromSqrtPrice(r.nextSqrtPrice))
  assert.ok(trade.price > 0)
  assert.equal(trade.trader, findIx(tx, DAMM, 'swap2')?.accounts[8] ?? trade.trader)
  // Not this coin's pool, or no pool known yet: nothing.
  assert.equal(tradesFrom(tx, { signature, mint: 'x', dbcPool: null, pool: address() }).length, 0)
  assert.equal(tradesFrom(tx, { signature, mint: 'x', dbcPool: null, pool: null }).length, 0)
  // The migrated pool's address comes from the DBC config's migration fee option.
  const mint = address()
  assert.notEqual(
    dammPoolFor({ migrationFeeOption: 0 }, mint),
    dammPoolFor({ migrationFeeOption: 1 }, mint),
  )
})

test("a swap's trader: its signing payer, the fee payer behind a router, the well for Quantum Hooks", () => {
  const mint = address()
  const dbcPool = dbcPoolFor(mint)
  const trader = (groups) =>
    tradesFrom(buildTx(groups), { signature: 's', mint, dbcPool, pool: null })[0].trader
  // Swapped directly: the payer signed.
  const user = address()
  assert.equal(trader([swapIx(mint, { price: 3e-8, payer: user })]), user)
  // Through a router whose own account is swap2's payer: the trade is the fee payer's.
  const router = address()
  const routed = swapIx(mint, { price: 3e-8, payer: router })
  const viaRouter = {
    program: address(),
    accounts: [],
    data: Buffer.alloc(8),
    signers: [user],
    inner: [
      { ...routed, stackHeight: 2 },
      ...routed.inner.map((ix) => ({ ...ix, stackHeight: 3 })),
    ],
  }
  assert.equal(trader([viaRouter]), user)
  // A Quantum burn: the well (a PDA, never a signer) buys through the program for the coin.
  const well = address()
  const burn = swapIx(mint, { price: 3e-8, payer: well })
  const keeper = address()
  const viaQuantum = {
    program: 'FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK',
    accounts: [],
    data: Buffer.alloc(8),
    signers: [keeper],
    inner: [{ ...burn, stackHeight: 2 }, ...burn.inner.map((ix) => ({ ...ix, stackHeight: 3 }))],
  }
  assert.equal(trader([viaQuantum]), well)
})

test('ignores trades of other pools in the same transaction', () => {
  for (const name of ['dbc-swap', 'dbc-create']) {
    const { signature, tx } = fixture(name)
    assert.deepEqual(
      tradesFrom(tx, { signature, mint: address(), dbcPool: address(), pool: null }),
      [],
      name,
    )
  }
})
