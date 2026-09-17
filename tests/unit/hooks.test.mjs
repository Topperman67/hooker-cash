import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyRecipe, normalizeRecipe, recipeHash } from '../../src/lib/hookRecipe.js'
import { defaultDraft, validateDraft, launchParams } from '../../src/lib/protocolDraft.js'
test('recipe validation rejects over-allocation, missing dependencies and malformed guards', () => {
  for (const c of [
    { burnBps: 10001 },
    { rewardBps: 7000, burnBps: 4000 },
    { buybackBps: 1 },
    { liquidityBps: 1 },
    { window: 3601, interval: 1 },
    { interval: 1 },
    { window: 1 },
    { window: 1, startCapBps: 200, endCapBps: 100 },
    { window: 1, startCapBps: 0, endCapBps: 100 },
    { window: 1, interval: 61 },
    { burnBps: -1 },
    { burnBps: 1.2 },
  ])
    assert.throws(() => normalizeRecipe({ ...emptyRecipe, ...c }))
  assert.equal(recipeHash(emptyRecipe), recipeHash({ ...emptyRecipe, unknown: 999 }))
  assert.notEqual(recipeHash(emptyRecipe), recipeHash({ ...emptyRecipe, rewardBps: 100 }))
})
test('a custom launch requires a built matching recipe and encodes its immutable guards', () => {
  const recipe = { ...emptyRecipe, window: 300, interval: 10 },
    hash = recipeHash(recipe)
  const d = {
    ...defaultDraft,
    name: 'Modular',
    symbol: 'MOD',
    hook: { mode: 'custom', recipe, deployment: { recipeHash: hash } },
  }
  assert.doesNotThrow(() => validateDraft(d))
  assert.throws(
    () => validateDraft({ ...d, hook: { ...d.hook, deployment: null } }, 1),
    /Build or select/,
  )
  assert.throws(
    () => validateDraft({ ...d, hook: { ...d.hook, recipe: { ...recipe, interval: 5 } } }, 1),
    /Build or select/,
  )
  assert.deepEqual(launchParams(d, 'https://example.com', `0x${'11'.repeat(32)}`).guard, {
    window: 300,
    interval: 10,
    startCapBps: 0,
    endCapBps: 0,
  })
})
