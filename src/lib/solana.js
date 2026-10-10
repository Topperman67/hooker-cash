import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

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

const tables = new Map()
export async function lookupTables(addresses = []) {
  const out = []
  for (const address of addresses.filter(Boolean)) {
    if (!tables.has(address))
      tables.set(
        address,
        connection
          .getAddressLookupTable(new PublicKey(address))
          .then((r) => r.value)
          .catch(() => null),
      )
    const table = await tables.get(address)
    if (table) out.push(table)
  }
  return out
}

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

// Ordered instruction groups → as few transactions as fit (groups are never split or reordered).
export async function packTransactions(
  payer,
  groups,
  { units = 400_000, lookupTableAddresses = [] } = {},
) {
  const payerKey = new PublicKey(payer)
  const [microLamports, { blockhash, lastValidBlockHeight }, alts] = await Promise.all([
    priorityFee(),
    connection.getLatestBlockhash('confirmed'),
    lookupTables(lookupTableAddresses),
  ])
  const transactions = []
  let current = []
  for (const group of groups.filter((g) => g.length)) {
    const merged = [...current, ...group]
    if (current.length && fits(compile(payerKey, blockhash, merged, microLamports, units, alts))) {
      current = merged
      continue
    }
    if (current.length) transactions.push(current)
    if (!fits(compile(payerKey, blockhash, group, microLamports, units, alts)))
      throw Error(
        alts.length
          ? 'This launch is too large for one Solana transaction. Shorten the name or links.'
          : 'This launch needs the Quant Pad lookup table. Ask the operator to configure QUANTPAD_LOOKUP_TABLE.',
      )
    current = group
  }
  if (current.length) transactions.push(current)
  return {
    transactions: transactions.map(
      (ixs) =>
        new VersionedTransaction(compile(payerKey, blockhash, ixs, microLamports, units, alts)),
    ),
    lastValidBlockHeight,
  }
}

// Polls signature status instead of websockets (the RPC proxy is HTTP-only).
export async function confirmSignature(signature, lastValidBlockHeight, { onStatus } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: attempt > 10,
    })
    const status = value[0]
    if (status?.err) throw Object.assign(Error(explainError(status.err)), { signature })
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      onStatus?.('confirmed')
      return signature
    }
    if (status) onStatus?.('processed')
    if (attempt % 4 === 3) {
      const height = await connection.getBlockHeight('confirmed').catch(() => 0)
      if (height > lastValidBlockHeight)
        throw Object.assign(
          Error('The transaction expired before it confirmed. Nothing was spent; try again.'),
          {
            signature,
            expired: true,
          },
        )
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
}

const PROGRAM_ERRORS = {
  6002: 'Price moved beyond your slippage limit. Raise slippage or try a smaller amount.',
  6003: 'Price moved beyond your slippage limit. Raise slippage or try a smaller amount.',
  6005: 'This coin has graduated to PumpSwap. Refresh to trade on the pool.',
  6020: 'Not enough tokens left on the curve for that amount.',
  6021: 'Not enough tokens left on the curve for that amount.',
}
export function explainError(err) {
  const custom = err?.InstructionError?.[1]?.Custom
  if (custom !== undefined && PROGRAM_ERRORS[custom]) return PROGRAM_ERRORS[custom]
  if (
    err?.InstructionError?.[1] === 'InsufficientFunds' ||
    JSON.stringify(err).includes('InsufficientFunds')
  )
    return 'Your wallet does not have enough SOL for this transaction and its fees.'
  return `The transaction failed on-chain (${JSON.stringify(err)}).`
}

export function friendlyWalletError(e) {
  const message = String(e?.message || e)
  if (/reject|denied|cancel/i.test(message)) return 'You declined the request in your wallet.'
  if (/insufficient|0x1\b/i.test(message))
    return 'Your wallet does not have enough SOL for this transaction and its fees.'
  if (/blockhash not found|expired/i.test(message))
    return 'The transaction expired before it was sent. Try again.'
  if (/custom program error: 0x177[0-9a-f]/i.test(message) || /slippage/i.test(message))
    return 'Price moved beyond your slippage limit. Raise slippage or try a smaller amount.'
  return message.length > 220 ? message.slice(0, 220) + '…' : message
}

export function platformFeeInstruction(from, platform, lamports) {
  if (!platform?.treasury || !platform.feeBps || lamports <= 0n) return null
  const fee = (lamports * BigInt(platform.feeBps)) / 10_000n
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
