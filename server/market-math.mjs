// Trade ordering, market cap and OHLC candles. Prices are SOL per whole token; volume is SOL.
import { network } from '../shared/network.mjs'

const eventIndex = (t) => t.index ?? (Number(String(t.id).split(':').at(-1)) || 0)

// Execution order, oldest first: slot, then the transaction's position in the RPC's signature
// listing (`seq`, assigned by the indexer as it reads), then the event's position in the
// transaction. Signature strings are random, so they only break exact ties.
export function compareTrades(a, b) {
  return (
    a.slot - b.slot ||
    (a.seq ?? 0) - (b.seq ?? 0) ||
    eventIndex(a) - eventIndex(b) ||
    (a.timestamp || 0) - (b.timestamp || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// Raw supply the market cap counts. The mint's live supply when known (mayhem coins mint 2B and
// burns reduce it), else pump.fun's 1B (2B for mayhem coins).
export function capSupply({ supply, mayhem } = {}) {
  if (supply && Number(supply) > 0) return String(supply)
  return mayhem ? String(2n * BigInt(network.totalSupply)) : network.totalSupply
}

export function marketCap(price, supply = network.totalSupply) {
  return price > 0 ? (price * Number(supply)) / 1e6 : null
}

// Candle buckets of `size` seconds in time order: [time, open, high, low, close, lamports, first,
// last], where first and last are the execution-order positions of the bucket's first and last
// trades. Buckets merge into the candles of any interval that is a multiple of `size` exactly as
// candlesFor builds them from the trades (the indexer stores 15-second buckets for that).
export function candleBuckets(trades, size = 60) {
  const buckets = new Map()
  const ordered = [...trades].sort(compareTrades)
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i]
    if (!(t.price > 0) || !t.timestamp) continue
    const time = Math.floor(t.timestamp / size) * size
    const lamports = Number(t.solAmount || 0)
    const b = buckets.get(time)
    if (!b) buckets.set(time, [time, t.price, t.price, t.price, t.price, lamports, i, i])
    else {
      b[2] = Math.max(b[2], t.price)
      b[3] = Math.min(b[3], t.price)
      b[4] = t.price
      b[5] += lamports
      b[7] = i
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0])
}

// OHLC candles of `interval` seconds from candleBuckets output; volume is SOL.
export function candlesFromBuckets(buckets, interval = 60) {
  const candles = new Map()
  for (const [start, open, high, low, close, lamports, first, last] of buckets) {
    const time = Math.floor(start / interval) * interval
    const c = candles.get(time)
    if (!c) {
      candles.set(time, { time, open, high, low, close, lamports, first, last })
      continue
    }
    if (first < c.first) [c.open, c.first] = [open, first]
    if (last > c.last) [c.close, c.last] = [close, last]
    c.high = Math.max(c.high, high)
    c.low = Math.min(c.low, low)
    c.lamports += lamports
  }
  return [...candles.values()]
    .sort((a, b) => a.time - b.time)
    .map(({ time, open, high, low, close, lamports }) => ({
      time,
      open,
      high,
      low,
      close,
      volume: lamports / 1e9,
    }))
}

export function candlesFor(trades, interval = 60) {
  return candlesFromBuckets(candleBuckets(trades, interval), interval)
}
