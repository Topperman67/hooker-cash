import { defaultDraft, validateDraft } from './protocolDraft.js'

export const draftKey = 'hookbrew:launch-draft:v1'
export const stepKey = 'hookbrew:launch-step:v2'
export const legacyStepKey = 'hookbrew:launch-step:v1'
export function restoreDraft(storage = localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(draftKey))
    return {
      ...defaultDraft,
      ...saved,
      vesting: saved?.vesting || defaultDraft.vesting,
      splits: Array.isArray(saved?.splits)
        ? saved.splits.map((s) => {
            if (!('cliffDays' in s || 'durationDays' in s)) return s
            const { cliffDays = '0', durationDays = '0', ...rest } = s
            return {
              ...rest,
              vesting: {
                cliff: String(cliffDays),
                cliffUnit: 'days',
                duration: String(durationDays),
                durationUnit: 'days',
              },
            }
          })
        : [],
    }
  } catch {
    return { ...defaultDraft }
  }
}
export function restoreStep(draft, storage = localStorage) {
  try {
    const current = storage.getItem(stepKey)
    const legacy = storage.getItem(legacyStepKey)
    const requested =
      current !== null ? Number(current) : legacy !== null ? [2, 0, 1, 3, 4][Number(legacy)] : 0
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
