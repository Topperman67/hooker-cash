import { network } from '../../shared/network.mjs'

// Whole tokens a coin's market cap counts, matching the server's capSupply(): the mint's live raw
// supply when the record has it (burns lower it), else Quant Pad's fixed 1B, or
// 2B for a mayhem coin. Candle prices are SOL per whole token, so price × this is the market cap.
export function capTokens({ supply, mayhem } = {}) {
  const live = Number(supply)
  const raw = live > 0 ? live : Number(network.totalSupply) * (mayhem ? 2 : 1)
  return raw / 10 ** network.tokenDecimals
}

// Candles as series points: OHLC for the candle style, closes for the line style, each price
// multiplied by `k` (1 for price, capTokens() for market cap).
export function chartPoints(items, { mode = 'candles', k = 1 } = {}) {
  return mode === 'candles'
    ? items.map(({ time, open, high, low, close }) => ({
        time,
        open: open * k,
        high: high * k,
        low: low * k,
        close: close * k,
      }))
    : items.map(({ time, close }) => ({ time, value: close * k }))
}
