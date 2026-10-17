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
  instructionPrograms,
  isTransientRpcError,
  loadedDataLimitInstruction,
  packGroups,
} from './txflow.js'
import { explainError, friendlyWalletError } from './txerrors.js'
import { chargedPlatformFee } from './amounts.js'

export { explainError, friendlyWalletError, instructionPrograms, isTransientRpcError }

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
// Bytes left free when groups share a transaction. Phantom adds Lighthouse guard instructions before
// it signs, and its guidance for the "This dApp could be malicious" warning is to split a
// transaction near the size limit into separate prompts (Phantom publishes no exact margin). A
// single group (the create + dev buy) may still use the whole limit, since it is never split.
const WALLET_HEADROOM = 150
// Phantom asks for the compute unit and loaded-accounts-data limits to be set explicitly. The data
// limit starts at the ceiling and walletSendAll narrows it to what the simulation loaded.
function compile(payer, blockhash, instructions, microLamports, units, alts) {
  return new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      loadedDataLimitInstruction(),
      ...instructions,
    ],
  }).compileToV0Message(alts)
}
function fits(message, reserve = 0) {
  try {
    const signatures = message.header.numRequiredSignatures
    return message.serialize().length + 1 + signatures * 64 + reserve <= MAX_TX_BYTES
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
 * Groups share a transaction only when it keeps WALLET_HEADROOM bytes free for the wallet.
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
    const message = (ixs) => compile(payerKey, blockhash, ixs, microLamports, units, alts)
    packed = packGroups(
      groups,
      (ixs) => fits(message(ixs)),
      (ixs) => fits(message(ixs), WALLET_HEADROOM),
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

/**
 * The treasury's balance for the platform-fee rule: read from the chain until it is rent-exempt
 * (then remembered, with no further reads), null when it cannot be read.
 */
export async function treasuryBalance(treasury) {
  if (fundedTreasuries.has(treasury)) return RENT_EXEMPT_MINIMUM
  try {
    const balance = BigInt(await connection.getBalance(new PublicKey(treasury), 'confirmed'))
    if (balance >= RENT_EXEMPT_MINIMUM) fundedTreasuries.add(treasury)
    return balance
  } catch {
    return null
  }
}

/**
 * The platform fee a trade or dev buy of `lamports` will be charged (see chargedPlatformFee). A
 * fee at or above the rent-exempt minimum needs no balance read.
 */
export async function platformFeeCharged(platform, lamports) {
  const most = chargedPlatformFee(platform, lamports, RENT_EXEMPT_MINIMUM)
  if (most === 0n || most >= RENT_EXEMPT_MINIMUM) return most
  return chargedPlatformFee(platform, lamports, await treasuryBalance(platform.treasury))
}

/**
 * The platform fee transfer for a trade or dev buy of `lamports`, or null. A fee smaller than the
 * rent-exempt minimum is left out while the treasury is unfunded (or its balance cannot be read):
 * that transfer would fail with InsufficientFundsForRent and take the whole trade down with it.
 */
export async function platformFeeInstruction(from, platform, lamports) {
  const fee = await platformFeeCharged(platform, lamports)
  if (fee <= 0n) return null
  return SystemProgram.transfer({
    fromPubkey: new PublicKey(from),
    toPubkey: new PublicKey(platform.treasury),
    lamports: fee,
  })
}

export async function solBalance(owner) {
  return BigInt(await connection.getBalance(new PublicKey(owner), 'confirmed'))
}
