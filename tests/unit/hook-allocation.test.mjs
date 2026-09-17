import test from 'node:test'
import assert from 'node:assert/strict'
import {
  allocationTotal,
  balanceAllocations,
  installedValueModules,
  restoreHookAllocations,
  valueModuleKeys,
} from '../../src/lib/hookAllocation.js'
import { emptyRecipe, normalizeRecipe } from '../../src/lib/hookRecipe.js'
import { draftKey, restoreDraft } from '../../src/lib/launchDraft.js'

test('an increased allocation keeps the chosen amount and reduces others equally', () => {
  const recipe = {
    ...emptyRecipe,
    oracle: true,
    burnBps: 2000,
    rewardBps: 4000,
    buybackBps: 2000,
    liquidityBps: 2000,
  }
  const next = balanceAllocations(recipe, 'buybackBps', 7400)
  assert.deepEqual(next, {
    ...recipe,
    burnBps: 200,
    rewardBps: 2200,
    buybackBps: 7400,
    liquidityBps: 200,
  })
  assert.equal(allocationTotal(next), 10000)
  assert.equal(recipe.buybackBps, 2000)
  assert.doesNotThrow(() => normalizeRecipe(next))
})

test('available creator budget absorbs changes before reducing other modules', () => {
  const recipe = { ...emptyRecipe, burnBps: 2000, rewardBps: 3000 }
  assert.deepEqual(balanceAllocations(recipe, 'rewardBps', 7000), { ...recipe, rewardBps: 7000 })
  assert.deepEqual(balanceAllocations(recipe, 'rewardBps', 0), { ...recipe, rewardBps: 0 })
  assert.equal(allocationTotal(balanceAllocations(recipe, 'rewardBps', 0)), 2000)
})

test('small allocations stop at zero and rounding still gives exactly 100%', () => {
  const recipe = {
    ...emptyRecipe,
    oracle: true,
    burnBps: 100,
    rewardBps: 3400,
    buybackBps: 3000,
    liquidityBps: 3500,
  }
  const next = balanceAllocations(recipe, 'buybackBps', 9000)
  assert.equal(next.buybackBps, 9000)
  assert.equal(next.burnBps, 0)
  assert.equal(next.rewardBps, 450)
  assert.equal(next.liquidityBps, 550)
  const rounded = balanceAllocations(
    { ...recipe, burnBps: 2500, rewardBps: 2500, buybackBps: 2500, liquidityBps: 2500 },
    'buybackBps',
    3333,
  )
  assert.equal(allocationTotal(rounded), 10000)
  assert.equal(rounded.buybackBps, 3333)
  assert.ok(
    Math.max(rounded.burnBps, rounded.rewardBps, rounded.liquidityBps) -
      Math.min(rounded.burnBps, rounded.rewardBps, rounded.liquidityBps) <=
      1,
  )
  assert.deepEqual(balanceAllocations(next, 'buybackBps', 10000), {
    ...next,
    rewardBps: 0,
    buybackBps: 10000,
    liquidityBps: 0,
  })
})

test('saved over-allocations recover without changing a confirmed hook or losing installed sliders', () => {
  const hook = {
    mode: 'custom',
    recipe: { ...emptyRecipe, oracle: true, rewardBps: 2700, buybackBps: 7400, liquidityBps: 5700 },
    deployment: null,
  }
  const storage = {
    getItem: (key) => (key === draftKey ? JSON.stringify({ name: 'Saved coin', hook }) : null),
  }
  const restored = restoreDraft(storage)
  assert.equal(restored.name, 'Saved coin')
  assert.equal(allocationTotal(restored.hook.recipe), 10000)
  assert.equal(restored.hook.allocationRepaired, true)
  assert.doesNotThrow(() => normalizeRecipe(restored.hook.recipe))
  const zeroed = {
    ...restored.hook,
    recipe: balanceAllocations(restored.hook.recipe, 'buybackBps', 10000),
  }
  assert.deepEqual(installedValueModules(zeroed), ['rewardBps', 'buybackBps', 'liquidityBps'])
  const confirmed = { ...restored.hook, deployment: { factory: 'confirmed' } }
  assert.equal(restoreHookAllocations(confirmed), confirmed)
})

test('repeated edits never exceed the contract budget or produce fractional basis points', () => {
  let recipe = { ...emptyRecipe, oracle: true }
  for (let i = 0; i < 2500; i++) {
    const key = valueModuleKeys[i % valueModuleKeys.length]
    const value = (i * 7919) % 10001
    recipe = balanceAllocations(recipe, key, value)
    assert.equal(recipe[key], value)
    assert.ok(allocationTotal(recipe) <= 10000)
    for (const k of valueModuleKeys) assert.ok(Number.isInteger(recipe[k]) && recipe[k] >= 0)
    assert.doesNotThrow(() => normalizeRecipe(recipe))
  }
})
