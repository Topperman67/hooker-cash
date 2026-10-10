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

export function candlesFor(trades, interval = 60) {
  const candles = new Map()
  for (const t of [...trades].sort(compareTrades)) {
    if (!(t.price > 0) || !t.timestamp) continue
    const time = Math.floor(t.timestamp / interval) * interval
    const volume = Number(t.solAmount || 0) / 1e9
    const current = candles.get(time)
    if (!current)
      candles.set(time, {
        time,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume,
      })
    else {
      current.high = Math.max(current.high, t.price)
      current.low = Math.min(current.low, t.price)
      current.close = t.price
      current.volume += volume
    }
  }
  return [...candles.values()].sort((a, b) => a.time - b.time)
}
