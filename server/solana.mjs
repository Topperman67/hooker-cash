// Read-only Solana access for the server: transaction/event decoding and Meteora state reads (the
// Dynamic Bonding Curve a coin launches on, and the DAMM v2 pool it migrates into).
import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  ExtensionType,
  getExtensionData,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { network, priceFromSqrtPrice, curveProgress } from '../shared/network.mjs'
import * as meteora from '../shared/meteora.mjs'
import quantumIdl from '../shared/idl/quantum_hooks.json' with { type: 'json' }

export const DBC = network.dbcProgram
export const DAMM = network.dammV2Program
const QUANTUM = quantumIdl.address
const SOL_QUOTE = new Set([network.wsolMint])

// The events the indexer reads, by program. Anchor camel-cases the IDL's names; they are
// capitalised again here, as the IDLs spell them.
const CODERS = { [DBC]: meteora.dbcCoder, [DAMM]: meteora.dammCoder }
const WANTED = {
  [DBC]: new Set([
    'EvtInitializePool',
    'EvtSwap',
    'EvtSwap2',
    'EvtCurveComplete',
    'EvtUpdatePoolCreator',
  ]),
  [DAMM]: new Set(['EvtSwap2']),
}
// Anchor `emit_cpi!` prefixes self-CPI event data with this tag.
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
// The payer account of the instructions whose events name no trader or launcher.
const PAYER = {
  [DBC]: {
    swap: 9,
    swap2: 9,
    initializeVirtualPoolWithSplToken: 10,
    initializeVirtualPoolWithToken2022: 8,
  },
  [DAMM]: { swap: 8, swap2: 8 },
}

// A Connection to `rpcUrl`. With `timeoutMs`, each RPC request is aborted after that long (web3.js
// sets no timeout of its own), and `disableRetryOnRateLimit` makes a 429 fail at once instead of
// being retried with backoff for up to 7.5 s: for callers working to a deadline of their own.
export function createConnection(
  rpcUrl = process.env.QUANTPAD_RPC_URL || network.publicRpcUrl,
  { timeoutMs = 0, disableRetryOnRateLimit = false } = {},
) {
  const timed =
    timeoutMs > 0
      ? (url, init = {}) => {
          const timeout = AbortSignal.timeout(timeoutMs)
          const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
          return fetch(url, { ...init, signal })
        }
      : null
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit,
    ...(timed ? { fetch: timed } : {}),
  })
}

function decode(program, bytes) {
  const coder = CODERS[program]
  if (!coder || bytes.length < 8) return null
  try {
    const decoded = coder.events.decode(bytes.toString('base64'))
    if (!decoded) return null
    const name = decoded.name[0].toUpperCase() + decoded.name.slice(1)
    return WANTED[program].has(name) ? { program, name, event: decoded.data } : null
  } catch {
    return null
  }
}

// The transaction's instructions in execution order: each outer instruction, then its inner ones,
// with account keys resolved and the CPI depth (1 = outer).
function instructionsOf(tx) {
  const keys = accountKeys(tx)
  const inner = new Map((tx?.meta?.innerInstructions || []).map((g) => [g.index, g.instructions]))
  const out = []
  ;(tx?.transaction?.message?.instructions || []).forEach((ix, i) => {
    out.push({ ...ix, stackHeight: 1 })
    for (const x of inner.get(i) || []) out.push({ ...x, stackHeight: x.stackHeight || 2 })
  })
  return out.map((ix) => ({
    program: keys[ix.programIdIndex],
    accounts: (ix.accounts || []).map((a) => keys[a]),
    data: ix.data,
    stackHeight: ix.stackHeight,
  }))
}

// The decoded name and arguments of a Meteora instruction (base58 data, as the JSON encoding has
// it), or null.
function decodeInstruction(ix) {
  const coder = CODERS[ix?.program]
  if (!coder) return null
  try {
    return coder.instruction.decode(Buffer.from(bs58.decode(ix.data)))
  } catch {
    return null
  }
}

// Meteora events from Anchor event-CPI inner instructions (robust to log truncation), each with the
// instruction that emitted it (`emitter`) and the one that invoked that (`caller`, null for an
// outer instruction), falling back to "Program data:" log lines attributed to the program on top
// of the invoke stack (both null there).
export function extractEvents(tx) {
  const out = []
  const parents = []
  for (const ix of instructionsOf(tx)) {
    parents[ix.stackHeight] = ix
    if (!CODERS[ix.program]) continue
    let data
    try {
      data = Buffer.from(bs58.decode(ix.data))
    } catch {
      continue
    }
    if (data.length > 16 && data.subarray(0, 8).equals(EVENT_IX_TAG)) {
      const event = decode(ix.program, data.subarray(8))
      if (event)
        out.push({
          ...event,
          emitter: parents[ix.stackHeight - 1] || null,
          caller: parents[ix.stackHeight - 2] || null,
        })
    }
  }
  if (out.length) return out
  const stack = []
  for (const line of tx?.meta?.logMessages || []) {
    const invoke = line.match(/^Program (\w+) invoke \[\d+\]$/)
    if (invoke) {
      stack.push(invoke[1])
      continue
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop()
      continue
    }
    const program = stack.at(-1)
    if (CODERS[program] && line.startsWith('Program data: ')) {
      const event = decode(program, Buffer.from(line.slice(14), 'base64'))
      if (event) out.push({ ...event, emitter: null, caller: null })
    }
  }
  return out
}

function accountKeys(tx) {
  const message = tx?.transaction?.message
  if (!message) return []
  const statics = (message.staticAccountKeys || message.accountKeys || []).map((k) => k.toString())
  const loaded = tx.meta?.loadedAddresses
  return loaded
    ? [...statics, ...loaded.writable.map(String), ...loaded.readonly.map(String)]
    : statics
}

const str = (v) => (v === undefined || v === null ? null : v.toString())
const b58 = (v) => (v?.toBase58 ? v.toBase58() : str(v))
const text = (v) =>
  String(v || '')
    .replace(/\0+$/, '')
    .trim()

// Who made a swap: the payer account of the instruction that emitted its event when that signed
// the transaction. A payer that did not sign is a program's account: a router's (Titan, aggregator
// bots), so the trade is the fee payer's, or the coin's well when Quantum Hooks swapped for it (a
// burn or a fusion buy), which is kept. Without a known payer, the fee payer.
function payerOf(tx, { emitter, caller }) {
  const name = emitter && decodeInstruction(emitter)?.name
  const index = name ? PAYER[emitter.program]?.[name] : undefined
  const payer = index !== undefined ? emitter.accounts[index] : null
  const keys = accountKeys(tx)
  const signed = keys.slice(0, tx?.transaction?.message?.header?.numRequiredSignatures || 1)
  if (payer && (signed.includes(payer) || caller?.program === QUANTUM)) return payer
  return keys[0] || payer || null
}

/**
 * The coin a DBC create transaction launched: from its EvtInitializePool (the first, or the one for
 * `mint`) and the create instruction's arguments. `creator` is the pool creator at the end of the
 * transaction (a Quantum launch hands it to the coin's well in the same transaction); `launcher` is
 * the creator it was created with. Null when the transaction created no DBC pool.
 */
export function createFrom(tx, { signature, mint } = {}) {
  const events = extractEvents(tx)
  const init = events.find(
    (e) =>
      e.program === DBC &&
      e.name === 'EvtInitializePool' &&
      (!mint || b58(e.event.baseMint) === mint),
  )
  if (!init) return null
  const pool = b58(init.event.pool)
  let creator = b58(init.event.creator)
  for (const e of events)
    if (e.program === DBC && e.name === 'EvtUpdatePoolCreator' && b58(e.event.pool) === pool)
      creator = b58(e.event.newCreator)
  const ix = decodeInstruction(init.emitter)
  const params = ix?.data?.params || {}
  const t22 = ix?.name === 'initializeVirtualPoolWithToken2022'
  const accounts = init.emitter?.accounts || []
  const baseMint = b58(init.event.baseMint)
  // The pool's vaults as the transaction left them: the base vault gives the coin's decimals (DBC
  // configs set them, 6 or 9) and token program, the quote vault the quote mint.
  const vaults = (tx.meta?.postTokenBalances || []).filter(
    (b) => b.owner === meteora.DBC_POOL_AUTHORITY.toBase58(),
  )
  const baseVault = vaults.find((b) => b.mint === baseMint)
  const decimals = Number(baseVault?.uiTokenAmount?.decimals)
  return {
    mint: baseMint,
    name: text(params.name),
    symbol: text(params.symbol),
    uri: text(params.uri),
    creator,
    launcher: b58(init.event.creator),
    dbcPool: pool,
    dbcConfig: b58(init.event.config),
    decimals: Number.isInteger(decimals) ? decimals : null,
    tokenProgram:
      accounts[t22 ? 10 : 12] ||
      baseVault?.programId ||
      (t22 ? TOKEN_2022_PROGRAM_ID.toBase58() : TOKEN_PROGRAM_ID.toBase58()),
    quoteMint: accounts[4] || vaults.find((b) => b.mint !== baseMint)?.mint || null,
    createdAt: tx.blockTime || null,
    signature,
    slot: tx.slot,
  }
}

// Normalized trades for one coin from one confirmed transaction: swaps on its DBC pool (`dbcPool`,
// venue 'curve') and on its DAMM v2 pool (`pool`, venue 'pool'). `index` is the event's position in
// the transaction, so trades sort in execution order within a transaction. The coin's create and
// its curve completion come back as markers (`side: 'create'` / `'complete'`) without a price.
// Prices are SOL per whole token, from the sqrt price each swap left behind.
export function tradesFrom(
  tx,
  { signature, mint, dbcPool, pool, decimals = network.tokenDecimals },
) {
  const trades = []
  const events = extractEvents(tx)
  // DBC's legacy `swap` may emit EvtSwap next to EvtSwap2: each swap counts once.
  const swap2 = events.filter((e) => e.program === DBC && e.name === 'EvtSwap2')
  const swap2By = new Set(swap2.map((e) => e.emitter))
  events.forEach(({ program, name, event, emitter, caller }, index) => {
    const base = {
      id: `${signature}:${index}`,
      signature,
      slot: tx.slot,
      index,
      timestamp: Number(event.currentTimestamp) || tx.blockTime || 0,
    }
    const at = b58(event.pool)
    if (program === DBC && at === dbcPool && (name === 'EvtSwap2' || name === 'EvtSwap')) {
      if (name === 'EvtSwap' && (emitter ? swap2By.has(emitter) : swap2.length > 0)) return
      const r = event.swapResult
      const buy = Number(event.tradeDirection) === 1 // QuoteToBase
      const input = name === 'EvtSwap2' ? r.includedFeeInputAmount : event.amountIn
      trades.push({
        ...base,
        venue: 'curve',
        side: buy ? 'buy' : 'sell',
        trader: payerOf(tx, { emitter, caller }),
        solAmount: str(buy ? input : r.outputAmount),
        tokenAmount: str(buy ? r.outputAmount : input),
        price: priceFromSqrtPrice(r.nextSqrtPrice, decimals),
        fee: str(r.tradingFee),
        ...(name === 'EvtSwap2'
          ? {
              quoteReserve: str(event.quoteReserveAmount),
              migrationThreshold: str(event.migrationThreshold),
            }
          : {}),
      })
    } else if (program === DAMM && name === 'EvtSwap2' && pool && at === pool) {
      const r = event.swapResult
      const buy = Number(event.tradeDirection) === 1 // BtoA: SOL in, the coin out
      trades.push({
        ...base,
        venue: 'pool',
        side: buy ? 'buy' : 'sell',
        trader: payerOf(tx, { emitter, caller }),
        solAmount: str(buy ? r.includedFeeInputAmount : r.outputAmount),
        tokenAmount: str(buy ? r.outputAmount : r.includedFeeInputAmount),
        price: priceFromSqrtPrice(r.nextSqrtPrice, decimals),
        fee: str(r.claimingFee),
      })
    } else if (program === DBC && name === 'EvtCurveComplete' && at === dbcPool) {
      trades.push({ ...base, venue: 'curve', side: 'complete' })
    } else if (program === DBC && name === 'EvtInitializePool' && b58(event.baseMint) === mint) {
      trades.push({ ...base, venue: 'curve', side: 'create', createdAt: tx.blockTime || null })
    }
  })
  return trades
}

// Raw JSON-RPC: mainnet carries version-1 transactions that web3.js v1 cannot deserialize, and
// the indexer only needs logs, inner instructions and account keys from the JSON encoding.
const rateLimited = (status, error) =>
  status === 429 || /too many requests|rate limit/i.test(error?.message || '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rpcError = (message, status, code) => Object.assign(Error(message), { status, code })

// Largest getTransaction batch per endpoint. The free public endpoint throttles hard and providers
// take batches, but some cap them (PublicNode allows one call per batch) or refuse them: the first
// refusal drops that endpoint to single requests for the life of the process.
const BATCH = Math.max(1, Math.floor(Number(process.env.QUANTPAD_RPC_BATCH) || 10))
const batchLimits = new Map()
const batchSize = (endpoint) =>
  batchLimits.get(endpoint) || (endpoint.includes('api.mainnet-beta.solana.com') ? 2 : BATCH)

// One request for `batch`, retried with backoff (and Retry-After) while rate limited, but never past
// `deadline`. A single signature goes out as a plain request, so endpoints without batches work.
async function requestTransactions(endpoint, batch, deadline) {
  const calls = batch.map((signature, id) => ({
    jsonrpc: '2.0',
    id,
    method: 'getTransaction',
    params: [
      signature,
      { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
    ],
  }))
  const body = JSON.stringify(calls.length === 1 ? calls[0] : calls)
  for (let attempt = 0; ; attempt++) {
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.max(2000, Math.min(20000, deadline - Date.now()))),
      })
    } catch {
      throw rpcError('Solana RPC did not respond. Try again shortly.', 502, 'rpc_unavailable')
    }
    const parsed = await response.json().catch(() => null)
    const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    if (!(rateLimited(response.status, null) || items.some((x) => rateLimited(0, x?.error)))) {
      if (
        calls.length > 1 &&
        (response.status === 400 ||
          response.status === 413 ||
          (response.ok && !Array.isArray(parsed)) ||
          items.some((x) => /batch/i.test(x?.error?.message || '')))
      )
        throw Object.assign(rpcError('Solana RPC refused a batch.', 502, 'rpc_batch'), {
          batchRefused: true,
        })
      if (!response.ok)
        throw rpcError(`Solana RPC returned ${response.status}.`, 502, 'rpc_unavailable')
      return items
    }
    const retryAfter = Number(response.headers.get('retry-after')) * 1000
    const wait = Math.min(20000, Math.max(800 * 2 ** attempt, retryAfter || 0))
    if (attempt >= 5 || Date.now() + wait > deadline)
      throw rpcError(
        'Solana RPC is rate limiting requests. Try again shortly.',
        429,
        'rpc_rate_limited',
      )
    await sleep(wait)
  }
}

// getTransaction for each signature, in order, as { signature, tx }. `tx` is null when this RPC
// node cannot see the transaction yet; failed transactions are left out. Callers advance cursors
// only over the entries before the first null. When the RPC keeps rate limiting, an item errors,
// or `deadline` (ms since epoch) passes, reading stops and what was read so far comes back with
// `partial: true` (and `error`), so a throttled pass still makes progress. It throws only when
// nothing at all could be read.
export async function fetchTransactions(connection, signatures, { deadline = Infinity } = {}) {
  const endpoint = connection.rpcEndpoint
  const publicRpc = endpoint.includes('api.mainnet-beta.solana.com')
  const out = []
  out.partial = false
  const stop = (error) => {
    if (!out.length && error) throw error
    out.partial = true
    if (error) out.error = error
    return out
  }
  for (let i = 0; i < signatures.length;) {
    if (Date.now() >= deadline) return stop(null)
    const batch = signatures.slice(i, i + batchSize(endpoint))
    let items
    try {
      items = await requestTransactions(endpoint, batch, deadline)
    } catch (error) {
      if (!error.batchRefused) return stop(error)
      batchLimits.set(endpoint, 1)
      continue
    }
    const byId = new Map(items.map((item) => [item?.id, item]))
    for (let k = 0; k < batch.length; k++) {
      const item = byId.get(k)
      if (item?.error)
        return stop(rpcError(item.error.message || 'Solana RPC error.', 502, 'rpc_error'))
      const tx = item?.result || null
      if (!tx) out.push({ signature: batch[k], tx: null })
      else if (!tx.meta?.err) out.push({ signature: batch[k], tx })
    }
    i += batch.length
    if (publicRpc && i < signatures.length) await sleep(350)
  }
  return out
}

const PAGE = 1000 // getSignaturesForAddress maximum
const succeeded = (s) => !s.err

/**
 * Unread signatures of `address`, oldest first, without ever skipping any.
 *
 * getSignaturesForAddress pages newest-first from the tip. When more than a page accumulated after
 * `cursor` (the newest signature already read), this pages back toward it with `before`, at most
 * `pages` requests per call, and returns an `anchor` to persist: the next call resumes from the
 * anchor instead of the tip. Once the cursor is reached, `window` holds the oldest page of the
 * backlog and `anchor` the boundary above it, so later calls read the rest of that window with one
 * request each until it drains, then return to the tip.
 *
 * Without a cursor, `fromStart` pages back to the address's first signature (complete history).
 * Otherwise a first read takes the newest `initial` signatures, and `historyFrom` says where the
 * history starts: 0 when complete, else the block time of the oldest signature read.
 *
 * `last` is the newest signature of the window's range, failed or not. Failed transactions are
 * never read, so once every signature in `window` is, the caller moves its cursor to `last`:
 * otherwise failed signatures above the newest successful one would come back as an empty window
 * under the same anchor on every call, and the address would never be read past them.
 *
 * Returns { window, anchor, reached, last, historyFrom? }; `reached` is false while still paging
 * back.
 */
export async function pendingSignatures(
  connection,
  address,
  { cursor = null, anchor = null, fromStart = false, pages = 3, initial = 200 } = {},
) {
  const key = new PublicKey(address)
  const list = (options) => connection.getSignaturesForAddress(key, options)
  if (!cursor && !anchor && !fromStart) {
    const page = await list({ limit: initial })
    return {
      window: page.filter(succeeded).reverse(),
      anchor: null,
      reached: true,
      last: page[0]?.signature || null,
      historyFrom: page.length < initial ? 0 : (page.at(-1).blockTime ?? null),
    }
  }
  const found = (page, above) => ({
    window: page.filter(succeeded).reverse(),
    anchor: above || null,
    reached: true,
    last: page[0]?.signature || null,
    ...(cursor ? {} : { historyFrom: 0 }),
  })
  let before = anchor || undefined
  let previous = null // the last full page read by this call, and the boundary above it
  for (let n = 0; n < Math.max(2, pages); n++) {
    const page = await list({ until: cursor || undefined, before, limit: PAGE })
    if (page.length >= PAGE) {
      previous = { page, above: before }
      before = page.at(-1).signature
      continue
    }
    if (page.length) return found(page, before)
    if (previous) return found(previous.page, previous.above)
    if (!before) return found([], null)
    before = undefined // nothing left between the cursor and the anchor: back to the tip
  }
  // Resume above the last full page, so it is read again rather than assumed.
  return { window: [], anchor: previous?.above || null, reached: false, last: null }
}

// The first successful signature of `address` (for a DBC pool, the coin's create transaction),
// paging back at most `pages` pages: { signature } (null when there is no history yet), or
// { signature: null, tooDeep: true } when the history is longer than that.
export async function firstSignature(connection, address, { pages = 5 } = {}) {
  const key = new PublicKey(address)
  let before
  let oldest = null
  for (let n = 0; n < pages; n++) {
    const page = await connection.getSignaturesForAddress(key, { before, limit: PAGE })
    oldest = page.filter(succeeded).at(-1)?.signature || oldest
    if (page.length < PAGE) return { signature: oldest }
    before = page.at(-1).signature
  }
  return { signature: null, tooDeep: true }
}

// ---- Meteora state ----------------------------------------------------------------------------

// A DBC VirtualPool account: its discriminator, then pool_state with base_mint at byte 136.
const POOL_DISCRIMINATOR = bs58.encode(
  Buffer.from(meteora.dbcCoder.accounts.accountDiscriminator('virtualPool')),
)
const BASE_MINT_OFFSET = 136

// DBC configs cannot change once created: each is read once per process.
const configs = new Map()
async function readConfig(connection, address) {
  if (configs.has(address)) return configs.get(address)
  const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed')
  const config = info?.owner?.toBase58() === DBC ? meteora.decodeDbcConfig(info.data) : null
  if (config) {
    if (configs.size > 500) configs.clear()
    configs.set(address, config)
  }
  return config
}

/**
 * The DBC pool of `mint`: derived under each of `launchConfigs` (Quant Pad's own; one read), else
 * found by its base mint with getProgramAccounts. Resolves to the pool address or null.
 */
export async function findDbcPool(connection, mint, launchConfigs = []) {
  const key = new PublicKey(mint)
  if (launchConfigs.length) {
    const pdas = launchConfigs.map((c) => meteora.dbcPoolPda(c, key))
    const infos = await connection.getMultipleAccountsInfo(pdas, 'confirmed')
    const i = infos.findIndex((x) => x?.owner?.toBase58() === DBC)
    if (i >= 0) return pdas[i].toBase58()
  }
  const found = await connection.getProgramAccounts(meteora.DBC_PROGRAM_ID, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 0, bytes: POOL_DISCRIMINATOR } },
      { memcmp: { offset: BASE_MINT_OFFSET, bytes: key.toBase58() } },
    ],
  })
  return found[0]?.pubkey?.toBase58() || null
}

// SPL and Token-2022 share the base layouts: a mint's supply is at byte 36, its decimals at 44.
const mintFacts = (data) =>
  data?.length >= 45
    ? { supply: Buffer.from(data).readBigUInt64LE(36).toString(), decimals: Buffer.from(data)[44] }
    : { supply: null, decimals: null }

/**
 * Live market state: the coin's DBC pool (`curve`) and, once Meteora migrated it, its DAMM v2 pool
 * (`pool`). `dbcPool` skips the pool lookup (see findDbcPool). With `supply`, also the mint's raw
 * supply (burns reduce it) and decimals. `curve.complete` is a full curve (nothing trades until it
 * is migrated), `curve.migrated` that the DAMM v2 pool exists. `curve` is null for a mint without
 * a DBC pool.
 */
export async function readMarket(
  connection,
  mint,
  { dbcPool = null, supply = true, launchConfigs = [] } = {},
) {
  const key = new PublicKey(mint)
  const poolKey = dbcPool || (await findDbcPool(connection, key, launchConfigs))
  const keys = [...(poolKey ? [new PublicKey(poolKey)] : []), ...(supply ? [key] : [])]
  const infos = keys.length ? await connection.getMultipleAccountsInfo(keys, 'confirmed') : []
  const poolInfo = poolKey ? infos[0] : null
  const facts = supply ? mintFacts(infos.at(-1)?.data) : { supply: null, decimals: null }
  const state = poolInfo?.owner?.toBase58() === DBC ? meteora.decodeDbcPool(poolInfo.data) : null
  if (!state || state.baseMint !== key.toBase58()) return { curve: null, pool: null, ...facts }
  const config = await readConfig(connection, state.config)
  const decimals = config?.tokenDecimal ?? facts.decimals ?? network.tokenDecimals
  const complete = state.migrationProgress > meteora.PROGRESS.PRE
  const migrated = state.migrationProgress === meteora.PROGRESS.MIGRATED || state.isMigrated
  const threshold = config?.migrationQuoteThreshold ?? null
  const curve = {
    dbcPool: poolKey,
    dbcConfig: state.config,
    creator: state.creator,
    quoteMint: config?.quoteMint || null,
    decimals,
    complete,
    migrated,
    quoteReserve: state.quoteReserve.toString(),
    migrationThreshold: str(threshold),
    price: priceFromSqrtPrice(state.sqrtPrice, decimals),
    progress: complete ? 100 : curveProgress(state.quoteReserve, threshold),
  }
  let pool = null
  if (migrated && config) {
    const address = meteora.migratedPoolFor(config, key)
    const info = await connection.getAccountInfo(address, 'confirmed')
    const damm = info?.owner?.toBase58() === DAMM ? meteora.decodeDammPool(info.data) : null
    if (damm && damm.tokenAMint === key.toBase58())
      pool = {
        address: address.toBase58(),
        liquidity: damm.liquidity.toString(),
        status: damm.poolStatus,
        price: priceFromSqrtPrice(damm.sqrtPrice, decimals),
      }
  }
  return { curve, pool, ...facts }
}

export const METAPLEX_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const METAPLEX = new PublicKey(METAPLEX_METADATA)
export const metaplexMetadataPda = (mint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()],
    METAPLEX,
  )[0]

// Borsh strings (u32 length, then UTF-8), as both metadata layouts store them. Metaplex pads its
// fixed-size fields with NULs.
function readStrings(data, offset, count) {
  const out = []
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.length) return null
    const length = data.readUInt32LE(offset)
    offset += 4
    if (offset + length > data.length) return null
    out.push(
      data
        .subarray(offset, offset + length)
        .toString('utf8')
        .replace(/\0+$/, '')
        .trim(),
    )
    offset += length
  }
  return out
}
const identityOf = ([name, symbol, uri] = []) =>
  name || symbol || uri
    ? { name: name.slice(0, 64), symbol: symbol.slice(0, 16), uri: uri.slice(0, 512) }
    : null

// Token-2022 metadata stored in the mint (DBC's Token-2022 coins): update authority, mint, then
// name, symbol and uri.
function token2022Identity(key, info) {
  try {
    const data = getExtensionData(
      ExtensionType.TokenMetadata,
      unpackMint(key, info, TOKEN_2022_PROGRAM_ID).tlvData,
    )
    return data ? identityOf(readStrings(Buffer.from(data), 64, 3) || []) : null
  } catch {
    return null
  }
}

// A Metaplex metadata account (DBC's SPL Token coins, Quant Pad's included): key 4 (MetadataV1),
// update authority, mint, then name, symbol and uri.
function metaplexIdentity(key, info) {
  if (!info || !info.owner?.equals?.(METAPLEX)) return null
  const data = Buffer.from(info.data)
  if (data.length < 65 || data[0] !== 4 || !data.subarray(33, 65).equals(key.toBuffer()))
    return null
  return identityOf(readStrings(data, 65, 3) || [])
}

/**
 * A coin's name, symbol and metadata URI, with the token program that owns its mint: from the
 * Token-2022 metadata extension, else the Metaplex metadata account (SPL Token coins).
 * One RPC read. Resolves to null when the mint has neither; throws when the RPC fails or the mint
 * is not visible (a lagging node), so a caller never mistakes a failed read for "no metadata".
 */
export async function readTokenIdentity(connection, mint) {
  const key = new PublicKey(mint)
  const [mintInfo, metaInfo] = await connection.getMultipleAccountsInfo(
    [key, metaplexMetadataPda(key)],
    'confirmed',
  )
  if (!mintInfo)
    throw Object.assign(Error('The mint is not visible on Solana yet.'), { code: 'mint_missing' })
  const owner = mintInfo.owner?.toBase58?.() || null
  const identity =
    (owner === TOKEN_2022_PROGRAM_ID.toBase58() && token2022Identity(key, mintInfo)) ||
    metaplexIdentity(key, metaInfo)
  if (!identity) return null
  return {
    ...identity,
    tokenProgram:
      owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58()
        ? owner
        : null,
  }
}

export const isSolQuote = (quoteMint) => SOL_QUOTE.has(quoteMint)
/** The DAMM v2 pool a DBC coin under `config` (a decoded DBC config) migrates into. */
export const dammPoolFor = (config, mint) =>
  meteora.migratedPoolFor(config, new PublicKey(mint)).toBase58()
