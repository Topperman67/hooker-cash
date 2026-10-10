// OHLC candles from normalized trades. Prices are SOL per whole token; volume is SOL.
export function candlesFor(trades, interval = 60) {
  const candles = new Map()
  for (const t of [...trades].sort(
    (a, b) => a.timestamp - b.timestamp || a.slot - b.slot || a.id.localeCompare(b.id),
  )) {
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
  return [...candles.values()]
}
