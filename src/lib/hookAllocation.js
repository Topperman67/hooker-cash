export const valueModuleKeys = ['burnBps', 'rewardBps', 'buybackBps', 'liquidityBps']
export const allocationTotal = (recipe) =>
  valueModuleKeys.reduce((total, key) => total + Number(recipe[key] || 0), 0)

// Work in integer basis points so rounding never creates an extra allocation.
// Keep the edited slider fixed. Share excess equally, redistributing any amount
// a smaller allocation cannot cover among the remaining positive allocations.
export function balanceAllocations(recipe, editedKey, value) {
  const next = { ...recipe }
  for (const key of valueModuleKeys) {
    const amount = Number(key === editedKey ? value : recipe[key])
    next[key] = Number.isFinite(amount) ? Math.max(0, Math.min(10000, Math.round(amount))) : 0
  }
  let excess = allocationTotal(next) - 10000
  while (excess > 0) {
    const others = valueModuleKeys.filter((key) => key !== editedKey && next[key] > 0)
    const each = Math.floor(excess / others.length)
    const remainder = excess % others.length
    for (let i = 0; i < others.length; i++) {
      const key = others[i]
      const reduction = Math.min(next[key], each + (i < remainder ? 1 : 0))
      next[key] -= reduction
      excess -= reduction
    }
  }
  return next
}

// Selection is UI state: a module reduced to 0% keeps its slider, but has no
// allocation in the on-chain recipe until the creator increases it again.
export function installedValueModules(hook) {
  return valueModuleKeys.filter(
    (key) => hook?.recipe?.[key] > 0 || hook?.valueModules?.includes(key),
  )
}

export function restoreHookAllocations(hook) {
  if (hook?.mode !== 'custom' || !hook.recipe || hook.deployment) return hook
  const recipe = balanceAllocations(hook.recipe)
  if (valueModuleKeys.every((key) => recipe[key] === hook.recipe[key])) return hook
  return { ...hook, recipe, valueModules: installedValueModules(hook), allocationRepaired: true }
}
