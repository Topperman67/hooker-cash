import test from 'node:test'
import assert from 'node:assert/strict'
import {
  restoreDraft,
  restoreStep,
  draftKey,
  stepKey,
  legacyStepKey,
} from '../../src/lib/launchDraft.js'
const storage = (draft, step) => ({
  getItem: (key) =>
    key === draftKey ? JSON.stringify(draft) : key === stepKey ? String(step) : null,
})
test('restores review only when earlier steps are valid, without trusting corrupted storage', () => {
  const saved = storage({ name: 'Brew', symbol: 'BREW' }, 4)
  const draft = restoreDraft(saved)
  assert.equal(restoreStep(draft, saved), 4)
  assert.equal(restoreStep({ ...draft, targetMcap: '100' }, saved), 0)
  assert.equal(restoreStep({ ...draft, name: '' }, saved), 2)
  assert.equal(restoreStep(draft, storage(draft, 99)), 0)
  assert.equal(
    restoreStep(draft, {
      getItem() {
        throw Error('denied')
      },
    }),
    0,
  )
})

test('migrates the old step order and preserves existing wallet vesting', () => {
  for (const [oldStep, expected] of [
    [0, 2],
    [1, 0],
    [2, 1],
    [3, 3],
    [4, 4],
  ]) {
    const saved = {
      getItem: (key) =>
        key === legacyStepKey
          ? String(oldStep)
          : key === draftKey
            ? JSON.stringify({
                name: 'Saved Brew',
                symbol: 'SAVE',
                targetMcap: '4000',
                fee: '20000',
                initialBuy: '25',
                splits: [
                  {
                    wallet: '0x1111111111111111111111111111111111111111',
                    percent: '100',
                    cliffDays: '7',
                    durationDays: '30',
                  },
                ],
              })
            : null,
    }
    const draft = restoreDraft(saved)
    assert.equal(restoreStep(draft, saved), expected)
    assert.equal(draft.targetMcap, '4000')
    assert.equal(draft.fee, '20000')
    assert.deepEqual(draft.splits[0].vesting, {
      cliff: '7',
      cliffUnit: 'days',
      duration: '30',
      durationUnit: 'days',
    })
  }
})
