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

// Large accounts (10 MiB merkle trees, wallets with thousands of token accounts) make some calls
// return hundreds of megabytes. The proxy stops reading past this cap instead of buffering it all.
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_KEYS = 100
const MIB = 1024 * 1024

const fail = (status, message) => Object.assign(Error(message), { status })

// Rate-limit weight of one call: getMultipleAccounts counts each account it asks for.
export function callCost(call) {
  if (call.method !== 'getMultipleAccounts') return 1
  const keys = call.params?.[0]
  if (!Array.isArray(keys)) return 1
  if (keys.length > MAX_KEYS)
    throw fail(400, `getMultipleAccounts takes at most ${MAX_KEYS} accounts.`)
  return Math.max(1, keys.length)
}

// Seconds to wait after an upstream 429: the provider's Retry-After when it is sane, else 2.
function retryAfter(value) {
  const seconds = /^\d+$/.test(value?.trim() || '')
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return String(Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) : 2)
}

// Reads the body up to `limit` bytes. Returns null (and drops the connection) when it is larger.
async function readCapped(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks, bytes).toString('utf8'), bytes }
}

function result(status, body, text = JSON.stringify(body), headers = {}) {
  return { status, body, text, headers }
}

// The route sends `text` as is (no parse and re-serialize of large payloads) with `headers`.
export function writeRpcResponse(res, { status, text, headers = {} }) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

// Resolves to { status, body, text, headers }: 200 with the upstream JSON, 429 with Retry-After when
// the provider rate limits, 502 for any other upstream failure. Client mistakes throw a 4xx error.
export function createRpcProxy({
  rpcUrl,
  limiter,
  request = fetch,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  return async function proxy(req, payload) {
    if (!sameOrigin(req)) throw fail(403, 'Open this action from the Quant Pad app.')
    const calls = Array.isArray(payload) ? payload : [payload]
    if (!calls.length || calls.length > 25) throw fail(400, 'Send between 1 and 25 RPC calls.')
    let cost = 0
    for (const call of calls) {
      if (!call || call.jsonrpc !== '2.0' || typeof call.method !== 'string')
        throw fail(400, 'Invalid JSON-RPC request.')
      if (!ALLOWED_METHODS.has(call.method))
        throw fail(403, `RPC method ${call.method} is not available.`)
      cost += callCost(call)
    }
    await limiter(req, { bucket: 'rpc', limit: 900, cost })
    const unavailable = result(502, { error: 'Solana RPC is unreachable. Try again shortly.' })
    let response, read
    try {
      response = await request(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      })
      read = await readCapped(response, maxResponseBytes)
    } catch {
      return unavailable
    }
    // Bandwidth counts too: every full MiB relayed (or refused as oversized) costs one more call.
    const megabytes = Math.floor((read ? read.bytes : maxResponseBytes) / MIB)
    if (megabytes)
      await limiter(req, { bucket: 'rpc', limit: 900, cost: megabytes }).catch(() => {})
    if (!read) return result(502, { error: 'Solana RPC response is too large.' })
    // Upstream error bodies can echo the provider URL (and key); only JSON bodies pass.
    let body = null
    if (/^\s*[[{]/.test(read.text)) {
      try {
        body = JSON.parse(read.text)
      } catch {}
    }
    if (response.status === 429) {
      const headers = { 'Retry-After': retryAfter(response.headers.get('retry-after')) }
      return body
        ? result(429, body, read.text, headers)
        : result(429, { error: 'Solana RPC is busy. Try again shortly.' }, undefined, headers)
    }
    if (!body) return result(502, { error: `Solana RPC returned ${response.status}.` })
    return result(response.ok ? 200 : 502, body, read.text)
  }
}
