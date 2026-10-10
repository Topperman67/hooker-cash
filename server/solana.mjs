// Read-only Solana access for the server: transaction/event decoding and pump.fun state reads.
import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } from '#pump-sdk'
import { PUMP_AMM_SDK } from '#pump-swap-sdk'
import {
  ExtensionType,
  getExtensionData,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { network, priceFromReserves, curveProgress } from '../shared/network.mjs'

export const PUMP = network.pumpProgram
export const PUMP_AMM = network.pumpAmmProgram
const SOL_QUOTE = new Set(['11111111111111111111111111111111', network.wsolMint])

const discriminator = (name) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
const EVENTS = {
  [PUMP]: {
    CreateEvent: (d) => PUMP_SDK.decodeCreateEventBc(d),
    TradeEvent: (d) => PUMP_SDK.decodeTradeEventBc(d),
    CompleteEvent: (d) => PUMP_SDK.decodeCompleteEventBc(d),
  },
  [PUMP_AMM]: {
    BuyEvent: (d) => PUMP_SDK.decodeBuyEventAmm(d),
    SellEvent: (d) => PUMP_SDK.decodeSellEventAmm(d),
  },
}
const BY_DISCRIMINATOR = new Map()
for (const [program, events] of Object.entries(EVENTS))
  for (const [name, decode] of Object.entries(events))
    BY_DISCRIMINATOR.set(`${program}:${discriminator(name).toString('hex')}`, { name, decode })
// Anchor `emit_cpi!` prefixes self-CPI event data with this tag.
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')

export function createConnection(rpcUrl = process.env.QUANTPAD_RPC_URL || network.publicRpcUrl) {
  return new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: false })
}

function decode(program, bytes) {
  const entry = BY_DISCRIMINATOR.get(`${program}:${bytes.subarray(0, 8).toString('hex')}`)
  if (!entry) return null
  try {
    return { program, name: entry.name, event: entry.decode(bytes.subarray(8)) }
  } catch {
    return null
  }
}

// Events from Anchor event-CPI inner instructions (robust to log truncation), falling back to
// "Program data:" log lines attributed to the program on top of the invoke stack.
export function extractEvents(tx) {
  const keys = accountKeys(tx)
  const out = []
  for (const group of tx?.meta?.innerInstructions || [])
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex]
      if (program !== PUMP && program !== PUMP_AMM) continue
      let data
      try {
        data = Buffer.from(bs58.decode(ix.data))
      } catch {
        continue
      }
      if (data.length > 16 && data.subarray(0, 8).equals(EVENT_IX_TAG)) {
        const event = decode(program, data.subarray(8))
        if (event) out.push(event)
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
    if ((program === PUMP || program === PUMP_AMM) && line.startsWith('Program data: ')) {
      const event = decode(program, Buffer.from(line.slice(14), 'base64'))
      if (event) out.push(event)
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
const big = (v) => BigInt(v?.toString() || '0')

export function normalizeCreate(event, { signature, slot }) {
  return {
    mint: event.mint.toBase58(),
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    creator: event.creator.toBase58(),
    launcher: event.user.toBase58(),
    bondingCurve: event.bondingCurve.toBase58(),
    tokenProgram: event.tokenProgram?.toBase58() || network.token2022Program,
    quoteMint: event.quoteMint?.toBase58() || '11111111111111111111111111111111',
    mayhem: !!event.isMayhemMode,
    holderReward: !!event.isHolderReward,
    createdAt: Number(event.timestamp),
    signature,
    slot,
    virtualSolReserves: str(event.virtualSolReserves),
    virtualTokenReserves: str(event.virtualTokenReserves),
    realTokenReserves: str(event.realTokenReserves),
    totalSupply: str(event.tokenTotalSupply),
  }
}

// Normalized trades for one coin from one confirmed transaction. `index` is the event's position in
// the transaction, so trades sort in execution order within a transaction. The coin's CreateEvent
// and CompleteEvent come back as markers (`side: 'create'` / `'complete'`) without a price.
export function tradesFrom(tx, { signature, mint, pool }) {
  const trades = []
  extractEvents(tx).forEach(({ name, event }, index) => {
    const base = {
      id: `${signature}:${index}`,
      signature,
      slot: tx.slot,
      index,
      timestamp: Number(event.timestamp) || tx.blockTime || 0,
    }
    if (name === 'TradeEvent' && event.mint.toBase58() === mint) {
      const quoteMint = event.quoteMint?.toBase58()
      if (quoteMint && !SOL_QUOTE.has(quoteMint)) return
      const sol =
        event.quoteAmount && !event.quoteAmount.isZero?.() ? event.quoteAmount : event.solAmount
      const vSol =
        event.virtualQuoteReserves && !event.virtualQuoteReserves.isZero?.()
          ? event.virtualQuoteReserves
          : event.virtualSolReserves
      trades.push({
        ...base,
        venue: 'curve',
        side: event.isBuy ? 'buy' : 'sell',
        trader: event.user.toBase58(),
        solAmount: str(sol),
        tokenAmount: str(event.tokenAmount),
        price: priceFromReserves(vSol, event.virtualTokenReserves),
        virtualSolReserves: str(vSol),
        virtualTokenReserves: str(event.virtualTokenReserves),
        realTokenReserves: str(event.realTokenReserves),
        creatorFee: str(event.creatorFee),
      })
    } else if (
      (name === 'BuyEvent' || name === 'SellEvent') &&
      pool &&
      event.pool.toBase58() === pool
    ) {
      const buy = name === 'BuyEvent'
      // PumpSwap events carry the pool reserves from BEFORE the swap (curve TradeEvents carry them
      // after). Price the trade from the reserves it left behind: the LP fee stays in the pool,
      // the protocol and creator fees do not count as liquidity.
      const baseReserves = buy
        ? big(event.poolBaseTokenReserves) - big(event.baseAmountOut)
        : big(event.poolBaseTokenReserves) + big(event.baseAmountIn)
      const lpFee = big(event.lpFee)
      const quoteReserves =
        (buy
          ? big(event.poolQuoteTokenReserves) +
            (event.quoteAmountInWithLpFee
              ? big(event.quoteAmountInWithLpFee)
              : big(event.quoteAmountIn) + lpFee)
          : big(event.poolQuoteTokenReserves) -
            (event.quoteAmountOutWithoutLpFee
              ? big(event.quoteAmountOutWithoutLpFee)
              : big(event.quoteAmountOut) - lpFee)) + big(event.virtualQuoteReserves)
      trades.push({
        ...base,
        venue: 'pool',
        side: buy ? 'buy' : 'sell',
        trader: event.user.toBase58(),
        solAmount: str(buy ? event.quoteAmountIn : event.quoteAmountOut),
        tokenAmount: str(buy ? event.baseAmountOut : event.baseAmountIn),
        price: priceFromReserves(quoteReserves, baseReserves),
        creatorFee: str(event.coinCreatorFee),
      })
    } else if (name === 'CompleteEvent' && event.mint.toBase58() === mint) {
      trades.push({ ...base, venue: 'curve', side: 'complete' })
    } else if (name === 'CreateEvent' && event.mint.toBase58() === mint) {
      trades.push({ ...base, venue: 'curve', side: 'create', createdAt: Number(event.timestamp) })
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
 * Returns { window, anchor, reached, historyFrom? }; `reached` is false while still paging back.
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
      historyFrom: page.length < initial ? 0 : (page.at(-1).blockTime ?? null),
    }
  }
  const found = (page, above) => ({
    window: page.filter(succeeded).reverse(),
    anchor: above || null,
    reached: true,
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
  return { window: [], anchor: previous?.above || null, reached: false }
}

// The first successful signature of `address` (for a bonding curve, the coin's create transaction),
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

// Legacy curves (created before pump.fun recorded creators) decode with the zero key as creator:
// that is "unknown", not the system program.
function decodeCurve(info) {
  const curve = PUMP_SDK.decodeBondingCurveNullable(info)
  if (!curve) return null
  return {
    complete: curve.complete,
    creator: curve.creator.equals(PublicKey.default) ? null : curve.creator.toBase58(),
    quoteMint: curve.quoteMint?.toBase58() || '11111111111111111111111111111111',
    mayhem: !!curve.isMayhemMode,
    virtualSolReserves: curve.virtualQuoteReserves.toString(),
    virtualTokenReserves: curve.virtualTokenReserves.toString(),
    realTokenReserves: curve.realTokenReserves.toString(),
    realSolReserves: curve.realQuoteReserves.toString(),
    totalSupply: curve.tokenTotalSupply.toString(),
    price: priceFromReserves(curve.virtualQuoteReserves, curve.virtualTokenReserves),
    progress: curve.complete ? 100 : curveProgress(curve.realTokenReserves),
  }
}

export async function readCurve(connection, mint) {
  const info = await connection.getAccountInfo(bondingCurvePda(new PublicKey(mint)))
  return info ? decodeCurve(info) : null
}

// SPL and Token-2022 share the base layouts: a mint's supply is at byte 36, an account's amount at 64.
const u64At = (data, offset) => Buffer.from(data).readBigUInt64LE(offset)

/**
 * Live market state in one or two account reads: the bonding curve and, once it has completed, the
 * canonical PumpSwap pool priced from its vaults (fee buckets excluded, virtual quote included).
 * With `supply`, also the mint's current raw supply: mayhem coins mint 2B, and burns reduce it.
 * `poolMissing` is true when the curve has completed but no canonical PumpSwap pool exists: coins
 * that graduated before PumpSwap migrated to Raydium (and a new graduate is briefly in between).
 */
export async function readMarket(connection, mint, { supply = true } = {}) {
  const key = new PublicKey(mint)
  const poolKey = canonicalPumpPoolPda(key)
  const [curveInfo, poolInfo, mintInfo] = await connection.getMultipleAccountsInfo(
    [bondingCurvePda(key), poolKey, ...(supply ? [key] : [])],
    'confirmed',
  )
  const curve = curveInfo ? decodeCurve(curveInfo) : null
  let pool = null
  if (poolInfo && (!curve || curve.complete)) {
    const decoded = PUMP_AMM_SDK.decodePool(poolInfo)
    const [baseInfo, quoteInfo] = await connection.getMultipleAccountsInfo(
      [decoded.poolBaseTokenAccount, decoded.poolQuoteTokenAccount],
      'confirmed',
    )
    if (baseInfo && quoteInfo) {
      const base = u64At(baseInfo.data, 64)
      const real = u64At(quoteInfo.data, 64) - big(decoded.protocolFees) - big(decoded.creatorFees)
      const quote = (real > 0n ? real : 0n) + big(decoded.virtualQuoteReserves)
      pool = {
        address: poolKey.toBase58(),
        baseReserves: base.toString(),
        quoteReserves: quote.toString(),
        price: priceFromReserves(quote, base),
      }
    }
  }
  return {
    curve,
    pool,
    poolMissing: !!curve?.complete && !poolInfo,
    supply: mintInfo?.data?.length >= 44 ? u64At(mintInfo.data, 36).toString() : null,
  }
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

// Token-2022 metadata stored in the mint (pump.fun's current coins): update authority, mint, then
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

// A Metaplex metadata account (pump.fun's legacy SPL Token coins): key 4 (MetadataV1), update
// authority, mint, then name, symbol and uri.
function metaplexIdentity(key, info) {
  if (!info || !info.owner?.equals?.(METAPLEX)) return null
  const data = Buffer.from(info.data)
  if (data.length < 65 || data[0] !== 4 || !data.subarray(33, 65).equals(key.toBuffer()))
    return null
  return identityOf(readStrings(data, 65, 3) || [])
}

/**
 * A coin's name, symbol and metadata URI, with the token program that owns its mint: from the
 * Token-2022 metadata extension, else the Metaplex metadata account (legacy SPL Token coins).
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

export const poolFor = (mint) => canonicalPumpPoolPda(new PublicKey(mint)).toBase58()
export const curveFor = (mint) => bondingCurvePda(new PublicKey(mint)).toBase58()
export const isSolQuote = (quoteMint) => SOL_QUOTE.has(quoteMint)
