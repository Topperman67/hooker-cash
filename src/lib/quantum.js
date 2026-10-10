// The Quantum Hooks client is shared with the server keeper; load it only on pages that need it.
// Loading it also installs the program's error table for error messages. A failed load (say, a
// chunk that did not download) is not cached, so the next call tries again.
import { registerQuantumIdl } from './txerrors.js'

let client = null
export function loadQuantum() {
  client ||= import('../../shared/quantum.mjs').then(
    (module) => {
      registerQuantumIdl(module.QUANTUM_IDL)
      return module
    },
    (error) => {
      client = null
      throw error
    },
  )
  return client
}
