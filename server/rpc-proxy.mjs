// Browser JSON-RPC goes through here so a paid provider key never reaches the client. Only the
// read/send methods the app uses are forwarded; heavy scans such as getProgramAccounts are refused.
import { sameOrigin } from './request-limits.mjs'

export const ALLOWED_METHODS = new Set([
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getLatestBlockhash',
  'isBlockhashValid',
  'getSignatureStatuses',
  'getTokenAccountsByOwner',
  'getTokenAccountBalance',
  'getTokenSupply',
  'getTokenLargestAccounts',
  'getMinimumBalanceForRentExemption',
  'getFeeForMessage',
  'getRecentPrioritizationFees',
  'simulateTransaction',
  'sendTransaction',
  'getSlot',
  'getBlockHeight',
  'getEpochInfo',
  'getGenesisHash',
  'getVersion',
  'getHealth',
])

export function createRpcProxy({ rpcUrl, limiter, request = fetch }) {
  return async function proxy(req, payload) {
    if (!sameOrigin(req))
      throw Object.assign(Error('Open this action from the Quant Pad app.'), { status: 403 })
    const calls = Array.isArray(payload) ? payload : [payload]
    if (!calls.length || calls.length > 25) throw Error('Send between 1 and 25 RPC calls.')
    for (const call of calls) {
      if (!call || call.jsonrpc !== '2.0' || typeof call.method !== 'string')
        throw Error('Invalid JSON-RPC request.')
      if (!ALLOWED_METHODS.has(call.method))
        throw Object.assign(Error(`RPC method ${call.method} is not available.`), { status: 403 })
    }
    await limiter(req, { bucket: 'rpc', limit: 900, cost: calls.length })
    let response
    try {
      response = await request(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      })
    } catch {
      throw Object.assign(Error('Solana RPC is unreachable. Try again shortly.'), { status: 502 })
    }
    const text = await response.text()
    // Upstream error bodies can echo the provider URL (and key); only JSON-RPC bodies pass.
    try {
      return { status: response.ok ? 200 : 502, body: JSON.parse(text) }
    } catch {
      throw Object.assign(Error(`Solana RPC returned ${response.status}.`), { status: 502 })
    }
  }
}
