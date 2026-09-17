import test from 'node:test'
import assert from 'node:assert/strict'
import {
  amount,
  defaultDraft,
  minimum,
  validateDraft,
  launchParams,
  nativeBudget,
} from '../../src/lib/protocolDraft.js'
import { candlesFor, priceFromSqrt, decodeTrade } from '../../server/market-math.mjs'
const draft = () => ({ ...defaultDraft, name: 'Moon Milk', symbol: 'MILK', splits: [] })
const wallet = '0x1111111111111111111111111111111111111111'
test('Arc native budget reserves purchase plus flat fee plus gas against one USDC balance', () => {
  assert.equal(nativeBudget(100000n, 1000000000n, 10n ** 18n, 25000000n), 26000120000000000000n)
  assert.equal(nativeBudget(100000n, 1000000000n), 120000000000000n)
  assert.ok(nativeBudget(100000n, 1000000000n, 0n, 1000000n) > 10n ** 18n)
})
test('rejects rounded/exponential/negative amounts and computes exact integer slippage', () => {
  assert.equal(amount('9007199254740993.123456'), 9007199254740993123456n)
  for (const value of ['1e3', '-1', 'NaN', 'Infinity', '0', '0.0000001', '.5', '1.'])
    assert.throws(() => amount(value))
  assert.equal(minimum(100000001n, '1'), 99000000n)
  assert.throws(() => minimum(100n, '100'))
})
test('launch validation enforces byte limits, exact splits, vesting dependencies and bounded guards', () => {
  validateDraft(draft())
  assert.throws(() => validateDraft({ ...draft(), name: '🧪'.repeat(9) }), /32/)
  assert.throws(() => validateDraft({ ...draft(), website: 'javascript:alert(1)' }), /http/)
  assert.throws(() => validateDraft({ ...draft(), targetMcap: '2000.0000001' }), /decimals/)
  assert.throws(() => validateDraft({ ...draft(), endCap: '0.5' }), /Guard/)
  assert.throws(
    () =>
      validateDraft({
        ...draft(),
        splits: [{ wallet, percent: '99', cliffDays: '0', durationDays: '0' }],
      }),
    /100%/,
  )
  assert.throws(
    () =>
      validateDraft({
        ...draft(),
        splits: [{ wallet, percent: '100', cliffDays: '1', durationDays: '0' }],
      }),
    /founder buy/,
  )
  assert.throws(
    () =>
      validateDraft({
        ...draft(),
        splits: [
          { wallet, percent: '50', cliffDays: '0', durationDays: '0' },
          { wallet, percent: '50', cliffDays: '0', durationDays: '0' },
        ],
      }),
    /unique/,
  )
  const p = launchParams(
    {
      ...draft(),
      initialBuy: '25.123456',
      splits: [{ wallet, percent: '100', cliffDays: '7', durationDays: '30' }],
    },
    'https://example.com/meta.json',
    '0x' + '1'.repeat(64),
    123n,
  )
  assert.equal(p.initialBuy, 25123456n)
  assert.equal(p.splits[0].cliff, 604800)
  assert.equal(p.splits[0].duration, 2592000)
  assert.equal(p.splits[0].bps, 10000)
  assert.equal(p.minTokensOut, 123n)
})
test('OHLC orders same-time swaps by log index, preserves gaps and totals actual USDC volume', () => {
  const rows = [
    { timestamp: 121, blockNumber: 8, logIndex: 2, price: 3, quoteAmount: '2.25' },
    { timestamp: 121, blockNumber: 8, logIndex: 1, price: 2, quoteAmount: '1.25' },
    { timestamp: 125, blockNumber: 9, logIndex: 0, price: 1, quoteAmount: '4' },
    { timestamp: 310, blockNumber: 20, logIndex: 0, price: 4, quoteAmount: '5' },
  ]
  assert.deepEqual(candlesFor(rows, 60), [
    { time: 120, open: 2, high: 3, low: 1, close: 1, volume: 7.5 },
    { time: 300, open: 4, high: 4, low: 4, close: 4, volume: 5 },
  ])
  assert.deepEqual(candlesFor([], 60), [])
})
test('market math accounts for quote decimals and address ordering without losing raw quantities', () => {
  const low = '0x1000000000000000000000000000000000000000',
    high = '0xf000000000000000000000000000000000000000'
  const sqrt = 2n ** 96n
  assert.equal(priceFromSqrt(sqrt, low, high), 1e12)
  const log = {
    transactionHash: '0x' + 'a'.repeat(64),
    logIndex: 2,
    blockNumber: 40n,
    args: {
      amount0: 1000000000000000001n,
      amount1: -1234567n,
      sqrtPriceX96: sqrt,
      sender: wallet,
      id: '0x' + 'b'.repeat(64),
    },
  }
  const buy = decodeTrade(log, { address: low }, high, 100, wallet)
  assert.equal(buy.side, 'buy')
  assert.equal(buy.tokenAmount, '1.000000000000000001')
  assert.equal(buy.quoteAmount, '1.234567')
  const sell = decodeTrade(
    { ...log, args: { ...log.args, amount0: 1234567n, amount1: -1000000000000000001n } },
    { address: high },
    low,
    100,
    null,
  )
  assert.equal(sell.side, 'sell')
  assert.equal(sell.trader, null)
})
