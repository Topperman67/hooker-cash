// Quantum Hook catalog. Each module owns one spectral colour used everywhere it appears.
export const MODULES = [
  {
    key: 'creatorBps',
    name: 'Creator share',
    color: 'var(--hook-creator)',
    short: 'Paid to you every pulse',
    body: 'The part of each fee pulse sent straight to the launcher wallet. Superposition can split it across up to four more wallets.',
  },
  {
    key: 'burnBps',
    name: 'Quantum Burn',
    color: 'var(--hook-burn)',
    short: 'Buys the coin and burns it',
    body: 'Fees build a reserve that market-buys the coin on the Meteora curve or its DAMM v2 pool and burns every token bought, shrinking supply.',
  },
  {
    key: 'entangleBps',
    name: 'Entanglement',
    color: 'var(--hook-entangle)',
    short: 'Shares SOL with holders',
    body: 'Fees accumulate for holders. Each epoch snapshots balances and posts a claim list; holders claim their SOL from the coin page.',
  },
  {
    key: 'fusionBps',
    name: 'Fusion',
    color: 'var(--hook-fusion)',
    short: 'Adds locked liquidity',
    body: 'After graduation, fees buy the coin and both sides are added to the coin’s locked Meteora DAMM v2 position. That liquidity can never be withdrawn.',
  },
]

export const EXTRAS = [
  {
    key: 'superposition',
    name: 'Superposition',
    color: 'var(--hook-super)',
    body: 'Split the creator share across up to four extra wallets — a co-founder, an artist, a community treasury.',
  },
  {
    key: 'dilation',
    name: 'Time Dilation',
    color: 'var(--hook-dilation)',
    body: 'Lock part of your dev buy with a cliff and linear vesting. Locked tokens can only be released to you on schedule.',
  },
]

export const PRESETS = [
  {
    id: 'deflation',
    name: 'Deflationary',
    hooks: { creatorBps: 3000, burnBps: 7000, entangleBps: 0, fusionBps: 0 },
  },
  {
    id: 'holders',
    name: 'Holder yield',
    hooks: { creatorBps: 2500, burnBps: 0, entangleBps: 7500, fusionBps: 0 },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    hooks: { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 },
  },
  {
    id: 'creator',
    name: 'Creator max',
    hooks: { creatorBps: 10000, burnBps: 0, entangleBps: 0, fusionBps: 0 },
  },
]

export const MODULE_KEYS = MODULES.map((m) => m.key)
export const total = (hooks) => MODULE_KEYS.reduce((sum, key) => sum + Number(hooks[key] || 0), 0)

// Integer basis points; the edited value stays fixed and the creator share absorbs the rest so
// the allocation always sums to exactly 10 000.
export function setAllocation(hooks, key, value) {
  const next = { ...hooks, [key]: Math.max(0, Math.min(10000, Math.round(Number(value) || 0))) }
  if (key === 'creatorBps') {
    let excess = total(next) - 10000
    for (const other of ['fusionBps', 'entangleBps', 'burnBps']) {
      if (excess <= 0) break
      const cut = Math.min(next[other], excess)
      next[other] -= cut
      excess -= cut
    }
    if (excess < 0) {
      // Lowering the creator share hands the freed basis points to the largest other hook.
      const target = ['burnBps', 'entangleBps', 'fusionBps'].reduce((a, b) =>
        next[b] > next[a] ? b : a,
      )
      next[target] -= excess
    }
    return next
  }
  const others = MODULE_KEYS.filter((k) => k !== key && k !== 'creatorBps')
  let creator = 10000 - next[key] - others.reduce((s, k) => s + next[k], 0)
  if (creator < 0) {
    let excess = -creator
    for (const other of others) {
      const cut = Math.min(next[other], excess)
      next[other] -= cut
      excess -= cut
    }
    creator = 10000 - next[key] - others.reduce((s, k) => s + next[k], 0)
  }
  next.creatorBps = creator
  return next
}

export const MAX_SPLITS = 4
