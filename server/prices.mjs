// SOL/USD for display only. Never used for transaction amounts; unavailable stays unavailable.
const SOURCES = [
  async (request) => {
    const r = await request(
      'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
      { signal: AbortSignal.timeout(5000) },
    )
    const value = (await r.json())?.So11111111111111111111111111111111111111112?.usdPrice
    return Number(value)
  },
  async (request) => {
    const r = await request('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
      signal: AbortSignal.timeout(5000),
    })
    return Number((await r.json())?.data?.amount)
  },
]

export function createPriceFeed({ request = fetch, ttl = 60000, now = Date.now } = {}) {
  let cached = null,
    pending = null
  return async function solUsd() {
    if (cached && now() - cached.at < ttl) return cached
    pending ||= (async () => {
      for (const source of SOURCES) {
        try {
          const usd = await source(request)
          if (Number.isFinite(usd) && usd > 0) return (cached = { usd, at: now() })
        } catch {}
      }
      return cached ? { ...cached, stale: true } : { usd: null, at: now() }
    })().finally(() => (pending = null))
    return pending
  }
}
