import { createContext, useContext } from 'react'
import { useResource } from '../lib/api.js'
import { QUANTP } from '../../shared/network.mjs'

// Live $QUANTP figures from GET /api/quantp (server/quantp.mjs), polled once for the whole app so
// the tape pin, menu row, home showcase, flywheel, footer and /quantp page share one request.
// The route reads the chain and DexScreener and never the store, so it keeps working while Redis
// is down. Each source can fail on its own: its fields are then null (or the last good value, with
// `stale` set in `sources`).
//
// Response (amounts in lamports and raw token units are integer strings; others are numbers):
// {
//   mint, symbol, name, decimals, pool, config,
//   priceSol, priceUsd,                  // SOL / USD per whole token
//   change24h,                           // fraction (0.12 = +12%), from DexScreener; null if unknown
//   marketCapSol, marketCapUsd, volume24hUsd, txns24h: { buys, sells } | null,
//   supply, burned,                      // raw units; burned = 1e15 - supply (plus known burn wallets)
//   holders,                             // wallets holding any, or null
//   curveProgress, migrated, dammPool,   // 0..1 of the graduation threshold; DAMM v2 pool once migrated
//   feeBps, postGradFeeBps,              // the fee charged now (200 on the curve, 500 after graduation)
//   fees: { lifetimeSol, creatorLifetimeSol, holdersSol, buybackSol } | null,
//                                        // estimates of the fees so far; not shown as payouts
//   payouts: { paidLamports, wallets, boughtLamports, burnedAmount, waitingLamports } | null,
//                                        // what the payout wallet really paid holders, spent on
//                                        // buybacks and burned, and holds now (server/quantp.mjs
//                                        // ledgerSummary); null until the chain has been read
//   launchedAt, updatedAt,               // unix seconds
//   sources: { chain: 'ok'|'stale'|'down', dex: 'ok'|'stale'|'down' }
// }
const QuantpContext = createContext(null)

export function QuantpProvider({ children }) {
  const live = useResource('/api/quantp', 20000)
  const value = {
    ...QUANTP,
    data: live.data,
    loading: live.loading && !live.data,
    error: live.error,
    refresh: live.refresh,
  }
  return <QuantpContext.Provider value={value}>{children}</QuantpContext.Provider>
}

/** QUANTP's constants (shared/network.mjs) plus `data`, `loading`, `error` and `refresh`. */
export const useQuantp = () => useContext(QuantpContext)
