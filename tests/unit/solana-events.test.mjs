import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extractEvents, normalizeCreate, tradesFrom, poolFor } from '../../server/solana.mjs'

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'))

test('decodes a real pump.fun curve trade from mainnet', () => {
  const { signature, tx } = fixture('pump-trade')
  const events = extractEvents(tx)
  assert.ok(events.some((e) => e.name === 'TradeEvent'))
  const mint = events.find((e) => e.name === 'TradeEvent').event.mint.toBase58()
  const [trade] = tradesFrom(tx, { signature, mint, pool: null })
  assert.equal(trade.venue, 'curve')
  assert.match(trade.side, /^(buy|sell)$/)
  assert.ok(BigInt(trade.solAmount) > 0n)
  assert.ok(BigInt(trade.tokenAmount) > 0n)
  assert.ok(trade.price > 0 && trade.price < 1, 'price is SOL per whole token')
  assert.equal(trade.id, `${signature}:0`)
  assert.ok(trade.timestamp > 1_700_000_000)
})

test('falls back to log lines when inner event instructions are absent', () => {
  const { signature, tx } = fixture('pump-trade')
  const stripped = { ...tx, meta: { ...tx.meta, innerInstructions: [] } }
  const fromLogs = extractEvents(stripped).map((e) => e.name)
  assert.ok(fromLogs.includes('TradeEvent'))
  const mint = extractEvents(tx)
    .find((e) => e.name === 'TradeEvent')
    .event.mint.toBase58()
  assert.deepEqual(
    tradesFrom(stripped, { signature, mint, pool: null }).map((t) => t.solAmount),
    tradesFrom(tx, { signature, mint, pool: null }).map((t) => t.solAmount),
  )
})

test('normalizes a real create_v2 launch', () => {
  const { signature, tx } = fixture('pump-create')
  const create = extractEvents(tx).find((e) => e.name === 'CreateEvent')
  assert.ok(create)
  const coin = normalizeCreate(create.event, { signature, slot: tx.slot })
  assert.match(coin.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  assert.ok(coin.name.length > 0 && coin.symbol.length > 0)
  assert.equal(coin.totalSupply, '1000000000000000')
  assert.equal(coin.signature, signature)
})

test('decodes a real PumpSwap trade only for the matching pool', () => {
  const { signature, tx } = fixture('pumpswap-trade')
  const event = extractEvents(tx).find((e) => e.name === 'BuyEvent' || e.name === 'SellEvent')
  assert.ok(event)
  const pool = event.event.pool.toBase58()
  const trades = tradesFrom(tx, { signature, mint: 'irrelevant', pool })
  assert.equal(trades[0].venue, 'pool')
  assert.ok(trades[0].price > 0)
  assert.equal(
    tradesFrom(tx, {
      signature,
      mint: 'irrelevant',
      pool: poolFor('So11111111111111111111111111111111111111112'),
    }).length,
    0,
  )
})

test('ignores trades of other mints in the same transaction', () => {
  const { signature, tx } = fixture('pump-trade')
  assert.equal(
    tradesFrom(tx, { signature, mint: '11111111111111111111111111111111', pool: null }).length,
    0,
  )
})
