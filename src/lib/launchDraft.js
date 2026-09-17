import { defaultDraft, validateDraft } from './protocolDraft.js'

export const draftKey = 'hookbrew:launch-draft:v1'
export const stepKey = 'hookbrew:launch-step:v1'
export function restoreDraft(storage = localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(draftKey))
    return { ...defaultDraft, ...saved, splits: Array.isArray(saved?.splits) ? saved.splits : [] }
  } catch {
    return { ...defaultDraft }
  }
}
export function restoreStep(draft, storage = localStorage) {
  try {
    const requested = Number(storage.getItem(stepKey))
    if (!Number.isInteger(requested) || requested < 0 || requested > 4) return 0
    for (let step = 0; step < requested; step++) {
      try {
        validateDraft(draft, step)
      } catch {
        return step
      }
    }
    return requested
  } catch {
    return 0
  }
}
