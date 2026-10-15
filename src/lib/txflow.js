// Transaction plumbing without module-level RPC, shared by solana.js, WalletContext and the unit
// tests: packing instruction groups, classifying RPC failures, polling for confirmation, loading
// lookup tables and the send-then-confirm loop.
import { MESSAGES, explainError, isTransientRpcError } from './txerrors.js'

// Lives in txerrors.js (friendlyWalletError uses it too); re-exported for solana.js and tests.
export { isTransientRpcError }

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ordered instruction groups → as few transactions as fit. A group is never split or reordered; it
 * joins the previous transaction only when the merged message `fits`. Returns
 * `[{ instructions, groups }]`, where `groups` lists the indexes of the groups each transaction
 * carries. Throws `{ code: 'too_large', group }` when a single group cannot fit on its own.
 */
export function packGroups(groups, fits) {
  const out = []
  let current = null
  groups.forEach((group, index) => {
    if (!group?.length) return
    if (current) {
      const merged = [...current.instructions, ...group]
      if (fits(merged)) {
        current = { instructions: merged, groups: [...current.groups, index] }
        return
      }
      out.push(current)
    }
    if (!fits(group))
      throw Object.assign(Error('This transaction is too large for Solana.'), {
        code: 'too_large',
        group: index,
      })
    current = { instructions: group, groups: [index] }
  })
  if (current) out.push(current)
  return out
}

export const unknownStatusError = (signature, cause) =>
  Object.assign(
    Error(
      'Quant Pad could not confirm this transaction yet. It may still land: check it in the explorer before trying again.',
    ),
    { signature, unknown: true, friendly: true, cause },
  )
const expiredError = (signature) =>
  Object.assign(Error(MESSAGES.confirmExpired), { signature, expired: true, friendly: true })
const failedError = (signature, err, programIds) =>
  Object.assign(Error(explainError(err, { programIds })), {
    signature,
    failed: true,
    friendly: true,
    transactionError: err,
  })

/**
 * Polls `getSignatureStatuses` until the transaction confirms, fails or its blockhash expires.
 * Transient RPC failures (see isTransientRpcError) do not abort: polling continues, with backoff,
 * until the block height passes `lastValidBlockHeight`. Before declaring the transaction expired it
 * re-checks with `searchTransactionHistory: true`. When the outcome cannot be determined it throws
 * `{ unknown: true, signature }` rather than a failure that would invite a second attempt.
 */
export async function confirmWith(
  connection,
  signature,
  lastValidBlockHeight,
  {
    onStatus,
    programIds,
    sleep = pause,
    now = Date.now,
    interval = 1200,
    maxWaitMs = 180_000,
    finalChecks = 4,
  } = {},
) {
  const started = now()
  let failures = 0
  const settle = (status) => {
    if (status?.err) throw failedError(signature, status.err, programIds)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      onStatus?.('confirmed')
      return true
    }
    if (status) onStatus?.('processed')
    return false
  }
  for (let attempt = 0; ; attempt++) {
    let polled = false
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: attempt > 10,
      })
      polled = true
      failures = 0
      if (settle(value?.[0] ?? null)) return signature
    } catch (e) {
      if (e?.failed) throw e
      if (!isTransientRpcError(e)) throw unknownStatusError(signature, e)
      failures++
    }
    if (attempt % 4 === 3 || failures >= 3) {
      let height = null
      try {
        height = await connection.getBlockHeight('confirmed')
      } catch {}
      if (height != null && lastValidBlockHeight != null && height > lastValidBlockHeight)
        return finalCheck(connection, signature, { settle, sleep, interval, finalChecks })
    }
    if (now() - started > maxWaitMs) throw unknownStatusError(signature)
    await sleep(polled ? interval : Math.min(interval * 2 ** failures, 8000))
  }
}

// The blockhash has expired, so the transaction can no longer be included. Look it up once more in
// the full history before saying it expired.
async function finalCheck(connection, signature, { settle, sleep, interval, finalChecks }) {
  let lastError
  let processed = false
  for (let i = 0; i < finalChecks; i++) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
      const status = value?.[0] ?? null
      if (settle(status)) return signature
      if (!status) {
        if (!processed) throw expiredError(signature)
      } else processed = true
    } catch (e) {
      if (e?.failed || e?.expired) throw e
      lastError = e
    }
    await sleep(interval)
  }
  throw unknownStatusError(signature, lastError)
}

/**
 * Lookup-table loader. Only successful loads are cached (for `ttlMs`); a failed or empty fetch is
 * retried with backoff and never cached, so one transient error does not disable the table for
 * the session. Returns `{ tables, missing }` (`missing` = requested addresses that did not load).
 */
export function createLookupTableLoader(
  fetchTable,
  { attempts = 3, backoffMs = 400, ttlMs = 600_000, sleep = pause, now = Date.now } = {},
) {
  const cache = new Map()
  return async function load(addresses = []) {
    const tables = []
    const missing = []
    for (const address of addresses.filter(Boolean)) {
      const cached = cache.get(address)
      if (cached && now() - cached.at < ttlMs) {
        tables.push(cached.table)
        continue
      }
      let table = null
      for (let i = 0; i < attempts && !table; i++) {
        if (i) await sleep(backoffMs * 2 ** (i - 1))
        try {
          table = (await fetchTable(address)) || null
        } catch {}
      }
      if (table) {
        cache.set(address, { table, at: now() })
        tables.push(table)
      } else {
        cache.delete(address)
        missing.push(address)
      }
    }
    return { tables, missing }
  }
}

// Rent-exempt minimum of a 0-byte system account. A transfer that leaves the receiver between 0 and
// this amount fails with InsufficientFundsForRent.
export const RENT_EXEMPT_MINIMUM = 890_880n

/** Whether sending `amount` lamports to an account holding `balance` (null = unknown) can land. */
export function transferKeepsRentExempt(balance, amount) {
  if (amount >= RENT_EXEMPT_MINIMUM) return true
  if (balance == null) return false
  return BigInt(balance) + amount >= RENT_EXEMPT_MINIMUM
}

/**
 * Sends already-signed transactions in order, confirming each before the next. Resolves to the
 * signatures, all confirmed. On failure it throws with `completed` = only the signatures that
 * confirmed, plus `failedIndex` and `failedSignature` for the one that did not; `unknown` is set
 * when that transaction may still land.
 */
export async function sendAndConfirmAll(count, { send, confirm, onStatus }) {
  const confirmed = []
  for (let index = 0; index < count; index++) {
    onStatus?.({ phase: 'send', index, total: count })
    let signature
    try {
      signature = await send(index)
    } catch (e) {
      throw Object.assign(e, {
        completed: [...confirmed],
        failedIndex: index,
        failedSignature: e.signature ?? e.failedSignature,
      })
    }
    onStatus?.({ phase: 'confirm', index, total: count, signature })
    try {
      await confirm(signature, index)
    } catch (e) {
      throw Object.assign(e, {
        completed: [...confirmed],
        failedIndex: index,
        failedSignature: signature,
      })
    }
    confirmed.push(signature)
  }
  return confirmed
}

/** Re-sends the same signed bytes on transient RPC failures (same signature, so it cannot double). */
export async function sendWithRetry(
  sendRaw,
  { attempts = 3, backoffMs = 600, sleep = pause } = {},
) {
  for (let i = 0; ; i++) {
    try {
      return await sendRaw()
    } catch (e) {
      if (!isTransientRpcError(e) || i + 1 >= attempts) throw e
      await sleep(backoffMs * 2 ** i)
    }
  }
}

/**
 * Whether a send was refused because the cluster already has these exact bytes ("This transaction
 * has already been processed", AlreadyProcessed): an earlier send of them got through, so the
 * transaction is in flight or has landed (successfully or not).
 */
export function isAlreadyProcessedError(e) {
  for (let x = e, depth = 0; x && depth < 4; x = x.cause, depth++) {
    const text = [x.message, x.transactionMessage, x.data?.err, x.transactionError]
      .filter((part) => typeof part === 'string')
      .join(' ')
    if (/already been processed|\bAlreadyProcessed\b/i.test(text)) return true
  }
  return false
}

/**
 * Sends signed bytes whose `signature` is already known and resolves to that signature for
 * confirmation polling. Transient RPC failures re-send the same bytes. A send refused as "already
 * processed" means an earlier send of these bytes reached the cluster, so it also resolves to the
 * signature and polling reports the real outcome (never a failure for a trade that landed). A send
 * that stays transient throws `unknown` with the signature; anything else is a failure worded by
 * `explain`.
 */
export async function sendSigned(
  signature,
  sendRaw,
  { explain = (e) => e.message, ...retry } = {},
) {
  try {
    await sendWithRetry(sendRaw, retry)
    return signature
  } catch (e) {
    if (isAlreadyProcessedError(e)) return signature
    if (isTransientRpcError(e)) throw unknownStatusError(signature, e)
    throw Object.assign(Error(explain(e)), { friendly: true, cause: e })
  }
}
