import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
const Context = createContext(null)
export function PlatformProvider({ children }) {
  const [resource, setResource] = useState({ data: null, loading: true, error: '' })
  const latest = useRef(null)
  const generation = useRef(0)
  const pending = useRef(null)
  const acceptDeployment = useCallback((deployment) => {
    generation.current++
    latest.current = { ...latest.current, deployment }
    setResource({ data: latest.current, loading: false, error: '' })
  }, [])
  const refresh = useCallback(() => {
    if (pending.current) return pending.current
    const version = ++generation.current
    const request = (async () => {
      try {
        const data = await api('/api/status')
        if (version !== generation.current) return latest.current
        if (latest.current?.deployment && !data.deployment)
          throw Error(
            'The server temporarily lost its deployment record. Your draft is saved. Retry status; do not redeploy the contracts.',
          )
        latest.current = data
        setResource({ data, loading: false, error: '' })
        return data
      } catch (error) {
        if (version === generation.current)
          setResource((current) => ({ ...current, loading: false, error: error.message }))
        return null
      }
    })()
    pending.current = request
    void request.finally(() => {
      if (pending.current === request) pending.current = null
    })
    return request
  }, [])
  useEffect(() => {
    let stopped = false,
      timer
    async function poll() {
      await refresh()
      if (!stopped) timer = setTimeout(poll, 15000)
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
      generation.current++
      pending.current = null
    }
  }, [refresh])
  const serialized = JSON.stringify(resource.data?.deployment || null)
  const deployment = useMemo(() => JSON.parse(serialized), [serialized])
  return (
    <Context.Provider
      value={{ ...resource, ...resource.data, deployment, refresh, acceptDeployment }}
    >
      {children}
    </Context.Provider>
  )
}
export const usePlatform = () => useContext(Context)
