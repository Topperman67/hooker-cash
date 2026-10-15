// Turns wallet, RPC and on-chain errors into short messages for people. Custom program errors are
// mapped by the program that raised them (Meteora DBC, DAMM v2, Quantum Hooks, System, Token), never
// by number alone, and raw simulation logs are never shown. Pure: no RPC, safe to unit test.

// Quantum Hooks' error table comes from its IDL, registered when the Quantum client loads (see
// quantum.js) so the main bundle does not carry the whole IDL. Every Quantum transaction is built
// with that client, so the table is there before one can fail.
let quantumErrors = []

export const PROGRAMS = {
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  damm: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  quantum: 'FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK', // shared/idl/quantum_hooks.json address
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
}
const PROGRAM_NAMES = {
  [PROGRAMS.dbc]: 'Meteora',
  [PROGRAMS.damm]: 'Meteora DAMM v2',
  [PROGRAMS.quantum]: 'Quantum Hooks',
  [PROGRAMS.system]: 'the System Program',
  [PROGRAMS.token]: 'the Token Program',
  [PROGRAMS.token2022]: 'the Token-2022 Program',
  [PROGRAMS.associatedToken]: 'the Associated Token Program',
}

export const MESSAGES = {
  slippage: 'Price moved beyond your slippage limit. Raise slippage or try a smaller amount.',
  graduated:
    'The bonding curve is full. Trading resumes once Meteora opens the coin’s DAMM v2 pool.',
  noSol: 'Your wallet does not have enough SOL for this transaction and its fees.',
  walletRent:
    'This would leave your wallet below Solana’s minimum balance (about 0.0009 SOL). Use a slightly smaller amount.',
  accountRent:
    'An account receiving SOL in this transaction would be left below Solana’s rent-exempt minimum (about 0.0009 SOL). Try a larger amount; if this keeps happening, tell the Quant Pad operator.',
  sendExpired: 'The transaction expired before it was sent. Try again.',
  confirmExpired: 'The transaction expired before it confirmed. Nothing was spent; try again.',
  declined: 'You declined the request in your wallet.',
  compute: 'The transaction ran out of compute budget. Try again.',
  tokens: 'Your token balance is too low for this transaction.',
  busy: 'The Solana network is busy right now. Wait a moment and try again.',
}

const TOO_LARGE = 'That amount is too large for this pool. Try a smaller amount.'
// Codes from shared/idl/meteora_dbc.json and meteora_damm_v2.json.
const DBC_ERRORS = {
  6000: TOO_LARGE, // MathOverflow
  6002: MESSAGES.slippage, // ExceededSlippage
  6005: 'That amount is too small to trade.', // AmountIsZero
  6012: 'Not enough tokens left on the curve for that amount.', // NotEnoughLiquidity
  6013: MESSAGES.graduated, // PoolIsCompleted
  6033: 'Not enough liquidity on the curve for that amount.', // InsufficientLiquidity
}
const DAMM_ERRORS = {
  6000: TOO_LARGE, // MathOverflow
  6002: MESSAGES.slippage, // ExceededSlippage
  6003: 'Meteora has paused trading in this pool.', // PoolDisabled
  6006: 'That amount is too small to trade.', // AmountIsZero
  6015: 'That trade would move the price past this pool’s range. Try a smaller amount.', // PriceRangeViolation
  6023: 'Not enough liquidity in the pool for that amount.', // InsufficientLiquidity
  6069: 'That amount is too small to trade.', // TransferFeeExcludedAmountIsZero
}
// Quantum Hooks: user-facing wording for the errors people can hit; the rest use the IDL message.
const QUANTUM_MESSAGES = {
  Paused: 'Quant Pad is paused right now. Try again later.',
  LockTermsMismatch:
    'The lock terms differ from the ones registered for this coin. Finish with the original cliff and vesting.',
  MintNotFresh: 'This mint address is already in use. Start the launch again.',
  NotLauncher: 'Only this coin’s launcher can do that.',
  AlreadyLocked: 'The dev tokens for this coin are already locked.',
  ZeroAmount: 'The amount must be greater than zero.',
  NothingToRelease: 'Nothing new has vested yet.',
  NothingToPulse: 'Less than 0.001 SOL of creator fees is waiting. Try again later.',
  KeeperOnly: 'Only the Quant Pad keeper can do this until its grace period ends.',
  TooSoon: 'Too soon since the last action. Try again in a little while.',
  EpochExpired: 'This Entanglement epoch has expired, so it can no longer be claimed.',
  EpochNotExpired: 'This Entanglement epoch has not expired yet.',
  ClaimNotOpen:
    'Claims for this Entanglement epoch are not open yet. Try again when the countdown ends.',
  AlreadyClaimed: 'You already claimed this reward.',
  InvalidProof: 'This claim’s proof is not valid for the epoch. Refresh and try again.',
}
const SYSTEM_ERRORS = {
  0: 'An account this transaction creates already exists.',
  1: MESSAGES.noSol, // ResultWithNegativeLamports
}
const TOKEN_ERRORS = { 1: MESSAGES.tokens }

const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`)

/** Installs the Quantum Hooks IDL's error codes (and its address, should it ever differ). */
export function registerQuantumIdl(idl) {
  if (!idl) return
  if (idl.address && idl.address !== PROGRAMS.quantum) {
    delete PROGRAM_NAMES[PROGRAMS.quantum]
    PROGRAMS.quantum = idl.address
    PROGRAM_NAMES[idl.address] = 'Quantum Hooks'
  }
  quantumErrors = Array.isArray(idl.errors) ? idl.errors : []
}

/** Message for custom error `code` raised by `programId` (base58). */
export function explainCustomError(programId, code) {
  code = Number(code)
  const name = programId ? PROGRAM_NAMES[programId] : null
  let message
  if (programId === PROGRAMS.dbc) message = DBC_ERRORS[code]
  else if (programId === PROGRAMS.damm) message = DAMM_ERRORS[code]
  else if (programId === PROGRAMS.system) message = SYSTEM_ERRORS[code]
  else if (programId === PROGRAMS.token || programId === PROGRAMS.token2022)
    message = TOKEN_ERRORS[code]
  else if (programId === PROGRAMS.quantum) {
    const error = quantumErrors.find((e) => e.code === code)
    if (error) message = QUANTUM_MESSAGES[error.name] || sentence(error.msg || error.name)
  }
  if (message) return message
  if (programId === PROGRAMS.quantum && code >= 2000 && code < 6000)
    return `Quantum Hooks rejected the accounts in this transaction (error ${code}). Refresh and try again.`
  return name
    ? `The transaction failed in ${name} (error ${code}).`
    : `The transaction failed on-chain (program error ${code}).`
}

/**
 * The innermost failing program in simulation or transaction logs: the first
 * `Program <id> failed: <reason>` line (outer programs repeat the error as it propagates).
 */
export function failingProgram(logs) {
  for (const line of logs || []) {
    const m = /^Program (\w{32,44}) failed: (.*)$/.exec(String(line).trim())
    if (!m) continue
    const custom = /custom program error: 0x([0-9a-f]+)/i.exec(m[2])
    return { programId: m[1], code: custom ? parseInt(custom[1], 16) : null, reason: m[2] }
  }
  return null
}

function explainFailure({ programId, code, reason }) {
  if (code != null) return explainCustomError(programId, code)
  if (/insufficient funds for rent/i.test(reason)) return MESSAGES.accountRent
  if (/insufficient (funds|lamports)/i.test(reason)) return MESSAGES.noSol
  if (/exceeded cus meter|computational budget exceeded|compute budget/i.test(reason))
    return MESSAGES.compute
  const name = PROGRAM_NAMES[programId]
  return `The transaction failed in ${name || 'a Solana program'} (${reason.slice(0, 80)}).`
}

function rentMessage(accountIndex) {
  return Number(accountIndex) === 0 ? MESSAGES.walletRent : MESSAGES.accountRent
}

/**
 * Message for a transaction status error (`getSignatureStatuses(...).value[i].err`). `programIds`
 * lists the program of each compiled instruction, so a custom error is mapped by the program that
 * raised it.
 */
export function explainError(err, { programIds } = {}) {
  if (!err) return 'The transaction failed on-chain.'
  if (typeof err === 'string') {
    if (/InsufficientFundsForFee|AccountNotFound/.test(err)) return MESSAGES.noSol
    if (/BlockhashNotFound/.test(err)) return MESSAGES.confirmExpired
    return `The transaction failed on-chain (${err}).`
  }
  const rent = err.InsufficientFundsForRent
  if (rent) return rentMessage(rent.account_index ?? rent.accountIndex)
  const instruction = err.InstructionError
  if (Array.isArray(instruction)) {
    const [index, detail] = instruction
    if (detail && typeof detail === 'object' && 'Custom' in detail)
      return explainCustomError(programIds?.[index], detail.Custom)
    if (detail === 'InsufficientFunds') return MESSAGES.noSol
    if (detail === 'ComputationalBudgetExceeded' || detail === 'ProgramFailedToComplete')
      return MESSAGES.compute
    const name = PROGRAM_NAMES[programIds?.[index]]
    const what = typeof detail === 'string' ? detail : Object.keys(detail || {})[0] || 'error'
    return `The transaction failed${name ? ` in ${name}` : ' on-chain'} (${what}).`
  }
  return `The transaction failed on-chain (${Object.keys(err)[0] || 'unknown error'}).`
}

function logsOf(e, message) {
  for (const key of ['logs', 'transactionLogs'])
    try {
      if (Array.isArray(e?.[key])) return e[key]
    } catch {}
  const block = /Logs: \s*(\[[\s\S]*?\])/.exec(message)
  if (block)
    try {
      return JSON.parse(block[1])
    } catch {}
  return []
}

// The human part of a web3.js error message, without the logs dump and the getLogs() hint.
function headline(e, message) {
  const fromError = typeof e?.transactionMessage === 'string' ? e.transactionMessage : null
  const fromMessage = /Message: ([^\n]*)/.exec(message)?.[1]
  return (fromError || fromMessage || message.split(/\s*Logs:/)[0])
    .replace(/Catch the `SendTransactionError`[\s\S]*$/, '')
    .trim()
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504])
/**
 * Whether an RPC call failed in a way worth retrying: HTTP 429/502/503/504 (web3.js reports these
 * as "<status> <text>: <body>"), the same codes in a JSON-RPC error, a node that is behind, or a
 * network failure.
 */
export function isTransientRpcError(e) {
  if (!e) return false
  const status = Number(e.status ?? e.statusCode)
  if (TRANSIENT_STATUS.has(status)) return true
  if (typeof e.code === 'number' && (TRANSIENT_STATUS.has(e.code) || e.code === -32005)) return true
  const message = String(e.message ?? e)
  if (/^(?:[\w ]+:\s*)?(429|502|503|504)\b/.test(message)) return true
  if (e.name === 'TypeError' && /fetch|network|load failed/i.test(message)) return true
  return /failed to fetch|fetch failed|networkerror|network error|network request failed|load failed|econnreset|econnrefused|etimedout|socket hang up|too many requests|bad gateway|service unavailable|gateway time-?out/i.test(
    message,
  )
}

/**
 * Message for anything thrown while signing, sending or confirming. Errors that already carry a
 * user-facing message (`friendly`, `unknown`, `expired`) pass through unchanged.
 */
export function friendlyWalletError(e, { programIds } = {}) {
  if (e == null) return 'Something went wrong. Try again.'
  if (e.friendly || e.unknown || e.expired) return String(e.message)
  const message = String(e.message ?? e)
  const logs = logsOf(e, message)
  const head = headline(e, message)
  const simulated = logs.length > 0 || /simulation failed|resulted in an error/i.test(message)
  if (
    e.code === 4001 ||
    (!simulated &&
      /user rejected|rejected the request|request rejected|denied|declined|cancel/i.test(head))
  )
    return MESSAGES.declined

  const failure = failingProgram(logs)
  if (failure) return explainFailure(failure)
  const instruction =
    /Error processing Instruction (\d+): custom program error: 0x([0-9a-f]+)/i.exec(head)
  if (instruction)
    return explainCustomError(programIds?.[Number(instruction[1])], parseInt(instruction[2], 16))
  const rent = /insufficient funds for rent/i.test(head)
  if (rent) return rentMessage(/account \((\d+)\)/i.exec(head)?.[1])
  if (
    /attempt to debit an account but found no record of a prior credit|insufficient funds for fee|insufficient lamports|insufficient funds/i.test(
      head,
    )
  )
    return MESSAGES.noSol
  if (/blockhash not found|block height exceeded/i.test(head)) return MESSAGES.sendExpired
  if (/computational budget exceeded|exceeded cus meter/i.test(head)) return MESSAGES.compute
  // A rate-limited or unreachable RPC (the public mainnet RPC answers 429 under load).
  if (!simulated && isTransientRpcError(e)) return MESSAGES.busy
  const text = simulated
    ? head.replace(/^Transaction simulation failed:\s*/i, 'Rejected in simulation: ')
    : head
  return text.length > 220 ? text.slice(0, 220) + '…' : text
}
