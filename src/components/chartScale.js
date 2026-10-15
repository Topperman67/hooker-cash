import { network } from '../../shared/network.mjs'

// Whole tokens a coin's market cap counts, matching the server's capSupply(): the mint's live raw
// supply when the record has it (burns lower it), else 1B whole tokens. `decimals` is the coin's
// (6 for Quant Pad launches, 9 for some other Meteora launchpads). Candle prices are SOL per whole
// token, so price × this is the market cap.
export function capTokens({ supply, decimals } = {}) {
  const d = Number.isInteger(decimals) ? decimals : network.tokenDecimals
  const live = Number(supply)
  return live > 0 ? live / 10 ** d : Number(network.totalSupply) / 10 ** network.tokenDecimals
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
