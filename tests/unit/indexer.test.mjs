import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { createIndexer, issuedUriKey, stats, summarize } from '../../server/indexer.mjs'
import { createFrom } from '../../server/solana.mjs'
import { createFileStore } from '../../server/storage.mjs'
import { candlesFor } from '../../server/market-math.mjs'

const now = 1_800_000_000
const trade = (i, price, sol, timestamp, side = 'buy') => ({
  id: `sig${i}:0`,
  slot: i,
  timestamp,
  side,
  price,
  solAmount: String(sol * 1e9),
  tokenAmount: '1000000',
})

test('24h stats use only the window and compare against the last pre-window price', () => {
  const trades = [
    trade(4, 0.0003, 2, now - 60),
    trade(3, 0.0002, 1, now - 3600, 'sell'),
    trade(2, 0.0001, 5, now - 90000),
    trade(1, 0.00005, 9, now - 100000),
  ]
  const s = stats(trades, now)
  assert.equal(s.volume24h, 3)
  assert.equal(s.trades24h, 2)
  assert.equal(s.buys24h, 1)
  assert.equal(s.sells24h, 1)
  assert.ok(Math.abs(s.change24h - 200) < 1e-9)
  assert.ok(Math.abs(s.marketCap - 300000) < 1e-6)
})

test('candles bucket by interval with OHLC and SOL volume', () => {
  const candles = candlesFor(
    [trade(1, 1, 1, 120), trade(2, 3, 2, 130), trade(3, 2, 1, 179), trade(4, 5, 1, 181)],
    60,
  )
  assert.deepEqual(candles, [
    { time: 120, open: 1, high: 3, low: 1, close: 2, volume: 4 },
    { time: 180, open: 5, high: 5, low: 5, close: 5, volume: 1 },
  ])
})

test('market filters, searches, hides and sorts the stored list', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-index-')))
  const coin = (mint, extra) =>
    summarize({ mint, name: mint, symbol: mint.slice(0, 3), createdAt: 1, ...extra })
  await store.set('coins:list', [
    coin('AAAquantum1111111111111111111111111', {
      quantum: true,
      volume24h: 5,
      createdAt: 3,
      launcher: 'L1',
    }),
    coin('BBBgraduated11111111111111111111111', { complete: true, volume24h: 9, createdAt: 2 }),
    coin('CCCexternal111111111111111111111111', { external: true, volume24h: 99 }),
  ])
  const indexer = createIndexer({ connection: null, store })
  assert.deepEqual(
    (await indexer.market({ sort: 'volume' })).items.map((c) => c.symbol),
    ['BBB', 'AAA'],
  )
  assert.deepEqual(
    (await indexer.market({ filter: 'quantum' })).items.map((c) => c.symbol),
    ['AAA'],
  )
  assert.deepEqual(
    (await indexer.market({ filter: 'graduated' })).items.map((c) => c.symbol),
    ['BBB'],
  )
  assert.deepEqual(
    (await indexer.market({ filter: 'tracked' })).items.map((c) => c.symbol),
    ['CCC'],
  )
  assert.deepEqual(
    (await indexer.market({ q: 'bbbgrad' })).items.map((c) => c.symbol),
    ['BBB'],
  )
  assert.deepEqual(
    (await indexer.market({ launcher: 'L1' })).items.map((c) => c.symbol),
    ['AAA'],
  )
  assert.deepEqual(
    (await indexer.market({ hidden: new Set(['AAAquantum1111111111111111111111111']) })).items.map(
      (c) => c.symbol,
    ),
    ['BBB'],
  )
})

test('registerLaunch indexes a real Quant Pad launch and its dev buy', async () => {
  const { signature, tx } = JSON.parse(
    readFileSync(new URL('../fixtures/dbc-create.json', import.meta.url), 'utf8'),
  )
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-launch-')))
  // A fake connection: the create transaction is served by the raw JSON-RPC fetch, and
  // signature listings return just that signature.
  const rpcEndpoint = 'http://fixture.invalid'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url, rpcEndpoint)
    const body = JSON.parse(init.body)
    const answer = (c) => ({
      jsonrpc: '2.0',
      id: c.id,
      result: c.params[0] === signature ? tx : null,
    })
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)))
  }
  const connection = {
    rpcEndpoint,
    getSignaturesForAddress: async () => [{ signature, err: null }],
  }
  // A standard launch (no Quantum Hooks): native only because this server issued its metadata URI
  // (C2).
  const quantum = { wellPda: () => Keypair.generate().publicKey }
  const create = createFrom(tx, { signature })
  try {
    const indexer = createIndexer({ connection, store, quantum })
    await assert.rejects(() => indexer.registerLaunch(signature), {
      status: 400,
      code: 'not_quantpad',
    })
    await store.set(issuedUriKey(create.uri), { at: Date.now() })
    const coin = await indexer.registerLaunch(signature)
    assert.equal(coin.signature, signature)
    assert.equal(coin.external, false)
    assert.deepEqual(
      [coin.mint, coin.name, coin.symbol, coin.dbcPool, coin.dbcConfig, coin.quantum],
      [create.mint, 'test1', 'TEST', create.dbcPool, create.dbcConfig, false],
    )
    assert.equal(coin.launcher, create.creator)
    assert.equal(coin.provenance, 'issued-uri')
    const list = await indexer.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].mint, coin.mint)
    const trades = await indexer.trades(coin.mint)
    assert.equal(trades.total, 1, 'the dev buy in the create transaction is indexed')
    assert.deepEqual(
      [trades.items[0].side, trades.items[0].solAmount, trades.items[0].trader],
      ['buy', '100000000', create.creator],
    )
    assert.ok(list[0].price > 0)
    // The curve's fill comes from the swap: 0.099 SOL of an 85 SOL threshold.
    assert.ok(Math.abs(list[0].progress - (0.099 / 85) * 100) < 1e-9)
    assert.equal(list[0].createdAt, tx.blockTime)
    // Registering twice is idempotent.
    assert.equal((await indexer.registerLaunch(signature)).mint, coin.mint)
    assert.equal((await indexer.list()).length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('registerLaunch rejects signatures that are not coin creations', async () => {
  const { signature, tx } = JSON.parse(
    readFileSync(new URL('../fixtures/dbc-swap.json', import.meta.url), 'utf8'),
  )
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-launch-')))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init.body)
    const answer = (c) => ({ jsonrpc: '2.0', id: c.id, result: tx })
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)))
  }
  try {
    const indexer = createIndexer({ connection: { rpcEndpoint: 'http://x.invalid' }, store })
    await assert.rejects(() => indexer.registerLaunch(signature), {
      status: 400,
      code: 'not_create',
      message: 'That transaction did not create a Meteora coin.',
    })
    await assert.rejects(() => indexer.registerLaunch('not-a-signature'), /signature/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
