import { createContext, useContext, useMemo } from 'react'
import { useResource } from '../lib/api'
const Context = createContext(null)
export function PlatformProvider({ children }) {
  const resource = useResource('/api/status', 15000)
  const serialized = JSON.stringify(resource.data?.deployment || null)
  const deployment = useMemo(() => JSON.parse(serialized), [serialized])
  return (
    <Context.Provider value={{ ...resource, ...resource.data, deployment }}>
      {children}
    </Context.Provider>
  )
}
export const usePlatform = () => useContext(Context)
