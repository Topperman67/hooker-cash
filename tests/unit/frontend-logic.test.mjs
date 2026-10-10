import test from 'node:test'
import assert from 'node:assert/strict'
import { setAllocation, total, PRESETS, MODULE_KEYS } from '../../src/lib/hooks.js'
import { formatUnits, parseUnits, price, pct, sol } from '../../src/lib/format.js'
import { curveProgress, priceFromReserves, isAddress } from '../../shared/network.mjs'

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
  assert.equal(price(0.00000002796), '0.0₇2796')
  assert.equal(price(0.05), '0.05')
  assert.equal(price(null), '—')
  assert.equal(pct(12.345), '+12.3%')
  assert.equal(pct(-0.5), '-0.50%')
  assert.equal(sol(0.00001234), '0.0000123 SOL')
})

test('curve maths match pump.fun reserves', () => {
  // Fresh curve: 30 SOL virtual / 1.073B tokens virtual.
  const p = priceFromReserves(30_000_000_000n, 1_073_000_000_000_000n)
  assert.ok(Math.abs(p - 2.796e-8) < 1e-10)
  assert.equal(curveProgress('793100000000000'), 0)
  assert.equal(curveProgress('0'), 100)
  assert.ok(Math.abs(curveProgress('396550000000000') - 50) < 1e-9)
  assert.equal(isAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), true)
  assert.equal(isAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951'), false)
})
