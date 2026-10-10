// Risk-gate rules, kept free of React so they can be unit tested.

export const RISK_KEY = 'quantpad:risk-accepted:v1'

// Pages anyone can read before accepting: the gate links to the terms, and the docs explain them.
const OPEN_PATHS = ['/terms', '/docs']

export function gateExempt(pathname = '/') {
  const path = pathname.replace(/\/+$/, '') || '/'
  return OPEN_PATHS.includes(path.toLowerCase())
}

export function readAccepted(storage) {
  try {
    return storage.getItem(RISK_KEY) === '1'
  } catch {
    return false
  }
}

export function saveAccepted(storage) {
  try {
    storage.setItem(RISK_KEY, '1')
  } catch {}
}
