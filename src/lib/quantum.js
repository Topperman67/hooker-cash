// The Quantum Hooks client is shared with the server keeper; load it only on pages that need it.
let client = null
export function loadQuantum() {
  client ||= import('../../shared/quantum.mjs')
  return client
}
