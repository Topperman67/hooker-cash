// While the index is still reading a coin's last 24 hours (`statsPartial`), its 24h volume and
// trade count only cover the trades read so far: show them as lower bounds, and an empty count as
// unknown rather than zero.
export const PARTIAL_NOTE = 'Partial: some of the last 24 hours is still being indexed'

export function lowerBound(value, text, partial) {
  if (!partial) return text
  return Number(value) > 0 ? `≥ ${text}` : '—'
}
