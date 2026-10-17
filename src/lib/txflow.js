// Transaction plumbing without module-level RPC, shared by solana.js, WalletContext and the unit
// tests: packing instruction groups, classifying RPC failures, polling for confirmation, loading
// lookup tables, the wallet approval flow and the send-then-confirm loop.
import { ComputeBudgetProgram, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  MESSAGES,
  explainError,
  explainSimulation,
  friendlyWalletError,
  isTransientRpcError,
} from './txerrors.js'

// Lives in txerrors.js (friendlyWalletError uses it too); re-exported for solana.js and tests.
export { isTransientRpcError }

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ordered instruction groups → as few transactions as fit. A group is never split or reordered; it
 * joins the previous transaction only when the merged message passes `canMerge` (by default
 * `fits`; a stricter check leaves the wallet room in shared transactions). Returns
 * `[{ instructions, groups }]`, where `groups` lists the indexes of the groups each transaction
 * carries. Throws `{ code: 'too_large', group }` when a single group cannot fit on its own.
 */
export function packGroups(groups, fits, canMerge = fits) {
  const out = []
  let current = null
  groups.forEach((group, index) => {
    if (!group?.length) return
    if (current) {
      const merged = [...current.instructions, ...group]
      if (canMerge(merged)) {
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
 * Sends transactions in order, confirming each before the next. `prepare(index)` (simulate it, have
 * the wallet sign it) runs only once the transaction before it confirmed, and its result is passed
 * to `send(index, prepared)`. Resolves to the signatures, all confirmed. On failure it throws with
 * `completed` = only the signatures that confirmed, plus `failedIndex` and, for one that was sent,
 * `failedSignature`; `unknown` is set when that transaction may still land.
 */
export async function sendAndConfirmAll(count, { prepare, send, confirm, onStatus }) {
  const confirmed = []
  for (let index = 0; index < count; index++) {
    let prepared
    if (prepare)
      try {
        prepared = await prepare(index)
      } catch (e) {
        throw Object.assign(e, { completed: [...confirmed], failedIndex: index })
      }
    onStatus?.({ phase: 'send', index, total: count })
    let signature
    try {
      signature = await send(index, prepared)
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

/** Program id (base58) of each compiled instruction, to map custom errors by program. */
export function instructionPrograms(transaction) {
  try {
    const message = transaction.message
    return message.compiledInstructions.map((ix) =>
      message.staticAccountKeys[ix.programIdIndex]?.toBase58(),
    )
  } catch {
    return []
  }
}

/**
 * Adds the signatures `transaction` needs from `signers` (a launch's mint key) after the wallet has
 * signed it. They sign the message the wallet returned, so anything the wallet added to it (Phantom's
 * Lighthouse guard instructions) is covered, and the wallet's own signature is kept.
 */
export function cosign(transaction, signers = []) {
  const { header, staticAccountKeys } = transaction.message
  const needed = staticAccountKeys.slice(0, header.numRequiredSignatures).map((k) => k.toBase58())
  const local = signers.filter((s) => needed.includes(s.publicKey.toBase58()))
  if (local.length) transaction.sign(local)
  return transaction
}

// ComputeBudget SetLoadedAccountsDataSizeLimit: instruction 4 with a u32 byte count. web3.js 1.x
// has no builder for it.
const SET_LOADED_DATA_LIMIT = 4
// The protocol ceiling, which is also the limit of a transaction that sets none.
export const MAX_LOADED_DATA_BYTES = 64 * 1024 * 1024
// Room above what the simulation loaded: the wallet's Lighthouse guard program (about 415 KiB) is
// loaded too once Phantom adds it.
export const LOADED_DATA_HEADROOM = 1024 * 1024

function loadedDataLimitData(bytes) {
  const data = Buffer.alloc(5)
  data[0] = SET_LOADED_DATA_LIMIT
  data.writeUInt32LE(bytes, 1)
  return data
}

/**
 * The instruction that sets a transaction's loaded-accounts-data limit. Phantom asks dApps to set
 * it explicitly along with the compute unit limit; walletSendAll narrows it after simulating.
 */
export const loadedDataLimitInstruction = (bytes = MAX_LOADED_DATA_BYTES) =>
  new TransactionInstruction({
    programId: ComputeBudgetProgram.programId,
    keys: [],
    data: loadedDataLimitData(bytes),
  })

/**
 * Sets the limit instruction of an unsigned `transaction` to the `loaded` bytes its simulation
 * reported plus LOADED_DATA_HEADROOM, rounded up to 32 KiB and capped at the protocol ceiling. The
 * instruction keeps its size, so the transaction does too. Without such an instruction, or without
 * a reported size, the transaction is left as it is.
 */
export function fitLoadedDataLimit(transaction, loaded) {
  if (!(Number(loaded) > 0)) return transaction
  const { compiledInstructions, staticAccountKeys } = transaction.message
  const budget = ComputeBudgetProgram.programId
  const ix = compiledInstructions.find(
    (ix) =>
      staticAccountKeys[ix.programIdIndex]?.equals(budget) &&
      ix.data.length === 5 &&
      ix.data[0] === SET_LOADED_DATA_LIMIT,
  )
  if (!ix) return transaction
  const step = 32 * 1024
  const bytes = Math.ceil((Number(loaded) + LOADED_DATA_HEADROOM) / step) * step
  ix.data = loadedDataLimitData(Math.min(bytes, MAX_LOADED_DATA_BYTES))
  return transaction
}

/**
 * Simulates a transaction before the wallet sees it (`simulate()` resolves to
 * `simulateTransaction(...).value`) and throws `{ friendly, simulated }` when it would fail: Phantom
 * answers a transaction it cannot simulate cleanly with a red "This dApp could be malicious"
 * warning. A simulation that cannot run (the RPC is busy or down) is tried `rpcAttempts` times,
 * then refused with `{ friendly, retryable }`, so the wallet never sees a transaction nobody
 * checked. With `attempts` > 1 a failure is simulated again after `delayMs`: the transaction after
 * one that just confirmed can reach an RPC node that has not seen it yet.
 */
export async function assertSimulates(
  simulate,
  { programIds, attempts = 1, rpcAttempts = 3, delayMs = 1500, sleep = pause } = {},
) {
  for (let attempt = 1, unreachable = 0; ;) {
    let result
    try {
      result = await simulate()
    } catch (e) {
      if (++unreachable >= rpcAttempts)
        throw Object.assign(Error(MESSAGES.uncheckable), {
          friendly: true,
          retryable: true,
          cause: e,
        })
      await sleep(delayMs * unreachable)
      continue
    }
    if (!result?.err) return result
    if (attempt++ >= attempts)
      throw Object.assign(Error(explainSimulation(result, { programIds })), {
        friendly: true,
        simulated: true,
        logs: result.logs,
      })
    await sleep(delayMs)
  }
}

/**
 * Asks a Wallet Standard `wallet` to approve `transactions` one at a time, in order. Each one gets
 * its own prompt, shown only after the one before it confirmed (a later transaction may depend on
 * an earlier one, so it can only simulate once that landed):
 * 1. after the first, a fresh blockhash: nothing is signed before its prompt, so a later
 *    transaction cannot expire while earlier ones are approved and confirmed;
 * 2. a simulation (assertSimulates): one that would fail, or that could not be simulated, never
 *    reaches the wallet; its loaded-accounts-data limit is narrowed to what the simulation loaded
 *    (fitLoadedDataLimit);
 * 3. the wallet signs first and `signers` add their signatures after it (cosign), the order Phantom
 *    asks dApps to use; a wallet that can only sign and send gets it already co-signed;
 * 4. send and confirm.
 * `rpc` is `{ simulate(tx), sendRaw(bytes), latestBlockhash(), confirm(signature,
 * lastValidBlockHeight, { programIds }) }`. Resolves to the confirmed signatures; a failure carries
 * `completed`, `failedIndex` and `failedSignature` (sendAndConfirmAll).
 */
export async function walletSendAll(
  transactions,
  { wallet, account, chain, signers = [], lastValidBlockHeight, rpc, onStatus, sleep = pause },
) {
  const total = transactions.length
  const programs = transactions.map(instructionPrograms)
  const expiry = transactions.map(() => lastValidBlockHeight)
  const signFeature = wallet.features['solana:signTransaction']
  const signAndSendFeature = wallet.features['solana:signAndSendTransaction']
  const friendly = (e, index) =>
    Object.assign(Error(friendlyWalletError(e, { programIds: programs[index] })), {
      friendly: true,
      cause: e,
    })
  return sendAndConfirmAll(total, {
    onStatus,
    prepare: async (index) => {
      const transaction = transactions[index]
      if (index > 0)
        try {
          const latest = await rpc.latestBlockhash()
          transaction.message.recentBlockhash = latest.blockhash
          expiry[index] = latest.lastValidBlockHeight
        } catch {}
      onStatus?.({ phase: 'check', index, total })
      const simulation = await assertSimulates(() => rpc.simulate(transaction), {
        programIds: programs[index],
        attempts: index > 0 ? 3 : 1,
        sleep,
      })
      fitLoadedDataLimit(transaction, simulation?.loadedAccountsDataSize)
      onStatus?.({ phase: 'sign', index, total })
      try {
        if (!signFeature) {
          const [output] = await signAndSendFeature.signAndSendTransaction({
            account,
            chain,
            transaction: cosign(transaction, signers).serialize(),
          })
          return bs58.encode(output.signature)
        }
        const [output] = await signFeature.signTransaction({
          account,
          chain,
          transaction: transaction.serialize(),
        })
        return cosign(VersionedTransaction.deserialize(output.signedTransaction), signers)
      } catch (e) {
        throw friendly(e, index)
      }
    },
    // The signature is known before sending, so a send whose outcome is unclear can still be looked
    // up; re-sending the same bytes cannot execute twice, and a re-send refused as "already
    // processed" is confirmed by polling like any other send (sendSigned). A wallet that signed and
    // sent hands back only the signature.
    send: (index, signed) =>
      typeof signed === 'string'
        ? signed
        : sendSigned(bs58.encode(signed.signatures[0]), () => rpc.sendRaw(signed.serialize()), {
            explain: (e) => friendlyWalletError(e, { programIds: programs[index] }),
          }),
    confirm: (signature, index) =>
      rpc.confirm(signature, expiry[index], { programIds: programs[index] }),
  })
}
