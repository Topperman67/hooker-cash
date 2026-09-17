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
export function restoreStep(draft, { resumeReview = false } = {}) {
  // Saved field values may be reused, but opening the studio always starts at Pool.
  // Only the explicit return from deployment setup can resume a valid review.
  if (!resumeReview) return 0
  try {
    validateDraft(draft)
    return 4
  } catch {
    return 0
  }
}
