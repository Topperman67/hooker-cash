// Entanglement claim timing for the coin page. An epoch's claims open at its claimStart (unix
// seconds: when it was posted plus the config's claim delay); until then the program refuses
// claims and the Quant Pad authority may cancel the epoch, returning its SOL to the holder reserve.
// The keeper lists a wallet's claim only once its epoch is open, and its epoch summaries say when
// each epoch opens. Pure, so the unit tests can drive it with any clock.

// The keeper offers a claim 30 s after claimStart (the chain's clock can trail the server's), so an
// epoch counts as "opening" until this long after claimStart, and the page re-reads claims then.
export const OPEN_SLACK = 45

const start = (entry) => Number(entry?.claimStart)

/**
 * Whether `entry` (a claim item or an epoch summary) can be claimed at `now` (unix seconds):
 * `{ state: 'open' }`, `{ state: 'pending', opensIn }` (seconds until claimStart) or
 * `{ state: 'expired' }`. An entry without claimStart predates the claim delay and is open.
 */
export function claimTiming(entry, now) {
  const expires = Number(entry?.expiresAt)
  if (expires > 0 && now >= expires) return { state: 'expired' }
  if (start(entry) > now) return { state: 'pending', opensIn: start(entry) - now }
  return { state: 'open' }
}

/** Posted epochs whose claims are not offered yet, soonest first. */
export function upcomingEpochs(epochs, now) {
  return (Array.isArray(epochs) ? epochs : [])
    .filter((e) => e && !e.closed && !e.cancelled && start(e) + OPEN_SLACK > now)
    .filter((e) => !(Number(e.expiresAt) > 0 && now >= Number(e.expiresAt)))
    .sort((a, b) => start(a) - start(b))
}

/**
 * When the page should next re-read claims (unix seconds): just after the soonest of `entries`
 * opens, or null when nothing is waiting.
 */
export function nextRefresh(entries, now) {
  let next = null
  for (const entry of entries || []) {
    const at = start(entry) + OPEN_SLACK
    if (at > now && (next === null || at < next)) next = at
  }
  return next
}
