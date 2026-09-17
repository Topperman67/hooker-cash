import { useCallback, useEffect, useRef, useState } from 'react'
export async function api(path, body, signal) {
  const response = await fetch(path, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
  const data = await response.json()
  if (!response.ok) throw Error(data.error || 'The server could not complete this request.')
  return data
}
export function useResource(path, interval = 15000) {
  const [state, setState] = useState({ data: null, error: '', loading: !!path })
  const [version, setVersion] = useState(0)
  const previousPath = useRef(path)
  const refresh = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    const changed = previousPath.current !== path
    previousPath.current = path
    setState((current) => ({ data: changed ? null : current.data, error: '', loading: !!path }))
    if (!path) return
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const data = await api(path, undefined, controller.signal)
        if (!controller.signal.aborted) setState({ data, error: '', loading: false })
      } catch (e) {
        if (!controller.signal.aborted)
          setState((s) => ({ ...s, error: e.message, loading: false }))
      } finally {
        if (!controller.signal.aborted && interval) timer = setTimeout(load, interval)
      }
    }
    load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [path, interval, version])
  return { ...state, refresh }
}
export const number = (value, maximumFractionDigits = 2) =>
  value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits })
export const compact = (value) =>
  value == null
    ? '—'
    : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
export const short = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—')
export const safeLink = (value) => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
