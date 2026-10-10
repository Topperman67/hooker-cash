import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  RENT_EXEMPT_MINIMUM,
  confirmWith,
  createLookupTableLoader,
  isTransientRpcError,
  packGroups,
  transferKeepsRentExempt,
} from './txflow.js'
import { explainError, friendlyWalletError } from './txerrors.js'

export { explainError, friendlyWalletError, isTransientRpcError }

// All browser RPC goes through the server proxy; provider keys never reach the page.
export const connection = new Connection(new URL('/api/rpc', window.location.origin).href, {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
})

let feeCache = { at: 0, value: 50_000 }
export async function priorityFee() {
  if (Date.now() - feeCache.at < 20000) return feeCache.value
  try {
    const fees = (await connection.getRecentPrioritizationFees())
      .map((f) => f.prioritizationFee)
      .sort((a, b) => a - b)
    const p75 = fees[Math.floor(fees.length * 0.75)] || 0
    feeCache = { at: Date.now(), value: Math.min(Math.max(p75, 20_000), 3_000_000) }
  } catch {
    feeCache.at = Date.now()
  }
  return feeCache.value
}

// Failed or empty fetches are retried and never cached (see createLookupTableLoader).
const loadLookupTables = createLookupTableLoader((address) =>
  connection.getAddressLookupTable(new PublicKey(address)).then((r) => r.value),
)
export async function lookupTables(addresses = []) {
  return (await loadLookupTables(addresses)).tables
}

const lookupTableUnavailable = () =>
  Object.assign(
    Error('Could not load the Quant Pad lookup table. Check your connection and try again.'),
    { code: 'lookup_table_unavailable', friendly: true, retryable: true },
  )

const MAX_TX_BYTES = 1232
function compile(payer, blockhash, instructions, microLamports, units, alts) {
  return new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...instructions,
    ],
  }).compileToV0Message(alts)
}
function fits(message) {
  try {
    const signatures = message.header.numRequiredSignatures
    return message.serialize().length + 1 + signatures * 64 <= MAX_TX_BYTES
  } catch {
    return false
  }
}

export async function buildTransaction(
  payer,
  instructions,
  { units = 400_000, lookupTableAddresses = [] } = {},
) {
  const { transactions, lastValidBlockHeight } = await packTransactions(payer, [instructions], {
    units,
    lookupTableAddresses,
  })
  if (transactions.length !== 1) throw Error('This transaction is too large for Solana.')
  return { transaction: transactions[0], lastValidBlockHeight }
}

/**
 * Ordered instruction groups → as few transactions as fit. Groups are never split or reordered,
 * so a group that cannot fit on its own fails with `{ code: 'too_large', group, lookupTable }`.
 * `groupIndexes[i]` lists the groups carried by `transactions[i]`.
 * With `requireLookupTables`, a requested lookup table that cannot be loaded is an error instead
 * of a silent fallback; without it, it only becomes an error when a group needs the table to fit.
 */
export async function packTransactions(
  payer,
  groups,
  { units = 400_000, lookupTableAddresses = [], requireLookupTables = false } = {},
) {
  const payerKey = new PublicKey(payer)
  const [microLamports, { blockhash, lastValidBlockHeight }, { tables: alts, missing }] =
    await Promise.all([
      priorityFee(),
      connection.getLatestBlockhash('confirmed'),
      loadLookupTables(lookupTableAddresses),
    ])
  if (missing.length && requireLookupTables) throw lookupTableUnavailable()
  let packed
  try {
    packed = packGroups(groups, (ixs) =>
      fits(compile(payerKey, blockhash, ixs, microLamports, units, alts)),
    )
  } catch (e) {
    if (e.code !== 'too_large') throw e
    if (missing.length) throw lookupTableUnavailable()
    throw Object.assign(
      Error(
        alts.length
          ? 'This transaction is too large for Solana, even with the Quant Pad lookup table.'
          : 'This transaction is too large for Solana without the Quant Pad lookup table. Ask the operator to configure QUANTPAD_LOOKUP_TABLE.',
      ),
      { code: 'too_large', group: e.group, lookupTable: alts.length > 0, friendly: true },
    )
  }
  return {
    transactions: packed.map(
      ({ instructions }) =>
        new VersionedTransaction(
          compile(payerKey, blockhash, instructions, microLamports, units, alts),
        ),
    ),
    groupIndexes: packed.map(({ groups: indexes }) => indexes),
    lastValidBlockHeight,
  }
}

// Polls signature status instead of websockets (the RPC proxy is HTTP-only). Transient RPC errors
// keep polling until the blockhash expires; see confirmWith.
export function confirmSignature(signature, lastValidBlockHeight, options = {}) {
  return confirmWith(connection, signature, lastValidBlockHeight, options)
}

// The treasury only ever receives, so once it is rent-exempt it stays that way.
const fundedTreasuries = new Set()
async function treasuryCanReceive(treasury, fee) {
  if (fee >= RENT_EXEMPT_MINIMUM || fundedTreasuries.has(treasury)) return true
  try {
    const balance = BigInt(await connection.getBalance(new PublicKey(treasury), 'confirmed'))
    if (balance >= RENT_EXEMPT_MINIMUM) fundedTreasuries.add(treasury)
    return transferKeepsRentExempt(balance, fee)
  } catch {
    return false
  }
}

/**
 * The platform fee transfer for a trade or dev buy of `lamports`, or null. A fee smaller than the
 * rent-exempt minimum is left out while the treasury is unfunded (or its balance cannot be read):
 * that transfer would fail with InsufficientFundsForRent and take the whole trade down with it.
 */
export async function platformFeeInstruction(from, platform, lamports) {
  if (!platform?.treasury || !platform.feeBps || lamports <= 0n) return null
  const fee = (lamports * BigInt(platform.feeBps)) / 10_000n
  if (fee <= 0n) return null
  if (!(await treasuryCanReceive(platform.treasury, fee))) return null
  return SystemProgram.transfer({
    fromPubkey: new PublicKey(from),
    toPubkey: new PublicKey(platform.treasury),
    lamports: fee,
  })
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

export async function solBalance(owner) {
  return BigInt(await connection.getBalance(new PublicKey(owner), 'confirmed'))
}
