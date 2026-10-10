// Read-only Solana access for the server: transaction/event decoding and pump.fun state reads.
import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda } from '#pump-sdk'
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
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

// Normalized trades for one coin from one confirmed transaction.
export function tradesFrom(tx, { signature, mint, pool }) {
  const trades = []
  extractEvents(tx).forEach(({ name, event }, index) => {
    const base = {
      id: `${signature}:${index}`,
      signature,
      slot: tx.slot,
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
      const quoteReserves =
        BigInt(event.poolQuoteTokenReserves.toString()) +
        BigInt(event.virtualQuoteReserves?.toString() || '0')
      trades.push({
        ...base,
        venue: 'pool',
        side: buy ? 'buy' : 'sell',
        trader: event.user.toBase58(),
        solAmount: str(buy ? event.quoteAmountIn : event.quoteAmountOut),
        tokenAmount: str(buy ? event.baseAmountOut : event.baseAmountIn),
        price: priceFromReserves(quoteReserves, event.poolBaseTokenReserves),
        creatorFee: str(event.coinCreatorFee),
      })
    } else if (name === 'CompleteEvent' && event.mint.toBase58() === mint) {
      trades.push({ ...base, venue: 'curve', side: 'complete' })
    }
  })
  return trades
}

// Raw JSON-RPC: mainnet carries version-1 transactions that web3.js v1 cannot deserialize, and
// the indexer only needs logs, inner instructions and account keys from the JSON encoding.
// Missing transactions (not yet visible to this RPC node) are returned in `missing` so callers
// never advance a cursor past them.
const rateLimited = (status, error) =>
  status === 429 || /too many requests|rate limit/i.test(error?.message || '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function fetchTransactions(connection, signatures) {
  // The free public endpoint throttles getTransaction hard; a provider endpoint takes batches.
  const publicRpc = connection.rpcEndpoint.includes('api.mainnet-beta.solana.com')
  const chunk = publicRpc ? 2 : 10
  const out = []
  for (let i = 0; i < signatures.length; i += chunk) {
    const batch = signatures.slice(i, i + chunk)
    const body = JSON.stringify(
      batch.map((signature, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'getTransaction',
        params: [
          signature,
          { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
        ],
      })),
    )
    let results
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(connection.rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      })
      const parsed =
        response.ok || response.status === 429 ? await response.json().catch(() => null) : null
      const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
      const limited =
        rateLimited(response.status, null) || items.some((x) => rateLimited(0, x?.error))
      if (!limited && response.ok) {
        results = items
        break
      }
      if (!limited || attempt >= 5)
        throw Object.assign(
          Error(
            limited
              ? 'Solana RPC is rate limiting requests.'
              : `Solana RPC returned ${response.status}.`,
          ),
          { status: 502 },
        )
      await sleep(800 * 2 ** attempt)
    }
    for (const item of results.sort((a, b) => a.id - b.id)) {
      if (item?.error)
        throw Object.assign(Error(item.error.message || 'RPC error'), { status: 502 })
      const tx = item?.result
      if (!tx) out.push({ signature: batch[item.id], tx: null })
      else if (!tx.meta?.err) out.push({ signature: batch[item.id], tx })
    }
    if (publicRpc) await sleep(350)
  }
  return out
}

// New signatures for an address since `until` (newest first), bounded to `max`.
export async function newSignatures(connection, address, until, max = 600) {
  const out = []
  let before
  while (out.length < max) {
    const page = await connection.getSignaturesForAddress(new PublicKey(address), {
      until: until || undefined,
      before,
      limit: Math.min(200, max - out.length),
    })
    out.push(...page.filter((s) => !s.err))
    if (page.length < Math.min(200, max - out.length + page.length)) break
    before = page.at(-1).signature
  }
  return out
}

export async function readCurve(connection, mint) {
  const info = await connection.getAccountInfo(bondingCurvePda(new PublicKey(mint)))
  if (!info) return null
  const curve = PUMP_SDK.decodeBondingCurveNullable(info)
  if (!curve) return null
  return {
    complete: curve.complete,
    creator: curve.creator.toBase58(),
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

export async function readTokenIdentity(connection, mint) {
  const meta = await getTokenMetadata(
    connection,
    new PublicKey(mint),
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  ).catch(() => null)
  return meta ? { name: meta.name, symbol: meta.symbol, uri: meta.uri } : null
}

export const poolFor = (mint) => canonicalPumpPoolPda(new PublicKey(mint)).toBase58()
export const curveFor = (mint) => bondingCurvePda(new PublicKey(mint)).toBase58()
export const isSolQuote = (quoteMint) => SOL_QUOTE.has(quoteMint)
