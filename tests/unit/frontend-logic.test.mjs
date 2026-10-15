import test from 'node:test'
import assert from 'node:assert/strict'
import { setAllocation, total, PRESETS, MODULE_KEYS } from '../../src/lib/hooks.js'
import { formatUnits, parseUnits, price, pct, sol } from '../../src/lib/format.js'
import {
  curveProgress,
  priceFromReserves,
  priceFromSqrtPrice,
  isAddress,
} from '../../shared/network.mjs'

test('hook allocation always sums to exactly 100% and keeps the edited value', () => {
  let hooks = { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 }
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 2000; i++) {
    const key = MODULE_KEYS[Math.floor(rand() * MODULE_KEYS.length)]
    const value = Math.round(rand() * 10000)
    hooks = setAllocation(hooks, key, value)
    assert.equal(total(hooks), 10000)
    assert.equal(hooks[key], value)
    for (const k of MODULE_KEYS) assert.ok(hooks[k] >= 0 && Number.isInteger(hooks[k]))
  }
  for (const p of PRESETS) assert.equal(total(p.hooks), 10000)
})

test('decimal parsing never uses floating point', () => {
  assert.equal(parseUnits('0.1', 9), 100_000_000n)
  assert.equal(parseUnits('1.000000001', 9), 1_000_000_001n)
  assert.equal(parseUnits('.5', 6), 500_000n)
  assert.equal(parseUnits('1.0000001', 6), null)
  assert.equal(parseUnits('abc', 9), null)
  assert.equal(parseUnits('', 9), null)
  assert.equal(formatUnits(1_234_567_890n, 9, 4), '1.2345')
  assert.equal(formatUnits(5_000_000n, 6), '5')
})

test('tiny token prices keep significant digits', () => {
  // Plain text is the full decimal; the Price component draws the zero count (frontend-r2 tests).
  assert.equal(price(0.00000002796), '0.00000002796')
  assert.equal(price(0.05), '0.05')
  assert.equal(price(null), '—')
  assert.equal(pct(12.345), '+12.3%')
  assert.equal(pct(-0.5), '-0.50%')
  assert.equal(sol(0.00001234), '0.0000123 SOL')
})

test('curve maths match Meteora pools', () => {
  // Raw quote per raw base is (sqrtPrice / 2^64)^2: a Q64.64 sqrt price of 2^64 / 10^4 is
  // 1e-8 lamports per raw token, i.e. 1e-8 * 1e6 / 1e9 = 1e-11 SOL per whole token.
  const p = priceFromSqrtPrice(2n ** 64n / 10_000n)
  assert.ok(Math.abs(p / 1e-11 - 1) < 1e-9, String(p))
  assert.ok(Math.abs(priceFromSqrtPrice(2n ** 64n, 9) - 1) < 1e-12, 'equal decimals: 1 SOL')
  assert.equal(priceFromSqrtPrice(0n), null)
  // Reserves still price a pool: 30 SOL against 1.073B tokens.
  assert.ok(Math.abs(priceFromReserves(30_000_000_000n, 1_073_000_000_000_000n) - 2.796e-8) < 1e-10)
  // Curve progress: SOL in the DBC pool against its migration threshold.
  const threshold = '85000000000'
  assert.equal(curveProgress('0', threshold), 0)
  assert.equal(curveProgress('42500000000', threshold), 50)
  assert.equal(curveProgress(threshold, threshold), 100)
  assert.equal(curveProgress('90000000000', threshold), 100, 'capped')
  assert.equal(curveProgress('1000', null), 0, 'unknown threshold')
  assert.equal(isAddress('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), true)
  assert.equal(isAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951'), false)
})
