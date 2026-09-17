import { createContext, useContext, useEffect, useState } from 'react'
import { readNetwork, readableError } from '../lib/chain'

const ChainContext = createContext(null)

export function ChainProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', network: null, error: '' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    let timer
    async function refresh() {
      try {
        const network = await readNetwork()
        if (active) setState({ status: 'ready', network, error: '' })
      } catch (error) {
        if (active)
          setState((previous) => ({ ...previous, status: 'error', error: readableError(error) }))
      } finally {
        if (active) timer = setTimeout(refresh, 30000)
      }
    }
    refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [revision])
  return (
    <ChainContext.Provider value={{ ...state, retry: () => setRevision((value) => value + 1) }}>
      {children}
    </ChainContext.Provider>
  )
}

export function useChain() {
  return useContext(ChainContext)
}
