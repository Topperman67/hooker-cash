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
test('normal entry ignores saved steps; only an explicit valid setup return resumes review', () => {
  const saved = storage({ name: 'Brew', symbol: 'BREW' }, 4)
  const draft = restoreDraft(saved)
  assert.equal(restoreStep(draft, saved), 0)
  assert.equal(restoreStep(draft, { resumeReview: true }), 4)
  assert.equal(restoreStep({ ...draft, name: '' }, { resumeReview: true }), 0)
  assert.equal(restoreStep({ ...draft, targetMcap: '100' }, saved), 0)
  assert.equal(restoreStep({ ...draft, name: '' }, saved), 0)
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

test('old step numbers never skip Pool while existing wallet vesting is preserved', () => {
  for (const oldStep of [0, 1, 2, 3, 4]) {
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
    assert.equal(restoreStep(draft, saved), 0)
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
