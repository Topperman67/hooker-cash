import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreDraft, restoreStep, draftKey, stepKey } from '../../src/lib/launchDraft.js'
const storage = (draft, step) => ({
  getItem: (key) => (key === draftKey ? JSON.stringify(draft) : String(step)),
})
test('restores review only when earlier steps are valid, without trusting corrupted storage', () => {
  const saved = storage({ name: 'Brew', symbol: 'BREW' }, 4)
  const draft = restoreDraft(saved)
  assert.equal(restoreStep(draft, saved), 4)
  assert.equal(restoreStep({ ...draft, targetMcap: '100' }, saved), 1)
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
