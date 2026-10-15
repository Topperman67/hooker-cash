// While the index is still reading a coin's last 24 hours (`statsPartial`), its 24h volume and
// trade count only cover the trades read so far: show them as lower bounds, and an empty count as
// unknown rather than zero.
export const PARTIAL_NOTE = 'Partial: some of the last 24 hours is still being indexed'

export function lowerBound(value, text, partial) {
  if (!partial) return text
  return Number(value) > 0 ? `≥ ${text}` : '—'
}

// What a keeper log row (server/keeper.mjs `record`) reads as in a coin's hook activity.
export const ACTIVITY_LABELS = {
  pulse: 'Pulse',
  burn: 'Quantum Burn',
  fusion: 'Fusion',
  entangle: 'Entanglement epoch',
  'cancel-epoch': 'Epoch cancelled',
  'close-epoch': 'Epoch closed',
  // The keeper ran Meteora's migration of a full curve into its DAMM v2 pool.
  migrate: 'Graduated to DAMM v2',
  // `sync` recorded that pool and the well's position, so the hooks now run on DAMM v2.
  sync: 'Hooks moved to DAMM v2',
}

export function activityLabel(action) {
  if (Object.hasOwn(ACTIVITY_LABELS, action)) return ACTIVITY_LABELS[action]
  const words = String(action ?? '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Hook action'
}
