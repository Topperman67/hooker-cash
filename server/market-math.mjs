import { formatUnits } from 'viem'
export function priceFromSqrt(sqrtPriceX96, token, quote, decimals = 18) {
  const ratio = Number(sqrtPriceX96) ** 2 / 2 ** 192
  const price =
    token.toLowerCase() < quote.toLowerCase()
      ? ratio * 10 ** (decimals - 6)
      : 10 ** (decimals - 6) / ratio
  return Number.isFinite(price) && price > 0 ? price : null
}
export function candlesFor(trades, interval = 60) {
  const candles = new Map()
  for (const t of [...trades].sort(
    (a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )) {
    if (!(t.price > 0)) continue
    const time = Math.floor(t.timestamp / interval) * interval
    const current = candles.get(time)
    if (!current)
      candles.set(time, {
        time,
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: Number(t.quoteAmount),
      })
    else {
      current.high = Math.max(current.high, t.price)
      current.low = Math.min(current.low, t.price)
      current.close = t.price
      current.volume += Number(t.quoteAmount)
    }
  }
  return [...candles.values()]
}
export function decodeTrade(log, token, quote, timestamp, trader) {
  const a = log.args,
    token0 = token.address.toLowerCase() < quote.toLowerCase()
  const tokenDelta = token0 ? a.amount0 : a.amount1,
    quoteDelta = token0 ? a.amount1 : a.amount0
  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    hash: log.transactionHash,
    transactionHash: log.transactionHash,
    blockNumber: Number(log.blockNumber),
    logIndex: log.logIndex,
    timestamp,
    side: tokenDelta > 0n ? 'buy' : 'sell',
    tokenAmount: formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18),
    quoteAmount: formatUnits(quoteDelta < 0n ? -quoteDelta : quoteDelta, 6),
    price: priceFromSqrt(a.sqrtPriceX96, token.address, quote),
    trader: trader || null,
    sender: a.sender,
    poolId: a.id,
  }
}
