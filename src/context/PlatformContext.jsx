import { createContext, useContext } from 'react'
import { useResource } from '../lib/api.js'

const PlatformContext = createContext(null)

// Server-side configuration (platform fee, Quantum Hooks program state, SOL price) loaded once and
// refreshed every minute.
export function PlatformProvider({ children }) {
  const status = useResource('/api/status', 60000)
  const data = status.data
  const value = {
    loading: status.loading && !data,
    error: status.error,
    platform: data?.platform || { treasury: null, feeBps: 0 },
    quantum: data?.quantum || { available: false },
    keeper: data?.keeper || { enabled: false },
    solUsd: data?.solUsd ?? null,
    storage: data?.storage,
    lookupTable: data?.lookupTable || null,
    // Quant Pad's Meteora DBC launch config (null until the operator sets QUANTPAD_DBC_CONFIG).
    dbcConfig: data?.dbcConfig || null,
    explorerUrl: data?.network?.explorerUrl || 'https://solscan.io',
    refresh: status.refresh,
  }
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

export const usePlatform = () => useContext(PlatformContext)
