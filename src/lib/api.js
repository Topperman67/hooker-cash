import { useCallback, useEffect, useRef, useState } from 'react'
export async function api(path, body, signal) {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 30000)
  try {
    const response = await fetch(path, {
      signal: controller.signal,
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    let data
    try {
      data = await response.json()
    } catch (e) {
      if (controller.signal.aborted) throw e
      throw Error('Hookbrew returned an unreadable response. Retry shortly.')
    }
    if (!response.ok)
      throw Object.assign(Error(data?.error || 'The server could not complete this request.'), {
        status: response.status,
        data,
      })
    return data
  } catch (e) {
    if (timedOut) throw Error('Hookbrew took too long to respond. Check your connection and retry.')
    if (e instanceof TypeError && !controller.signal.aborted)
      throw Error('Hookbrew could not be reached. Check your connection and retry.')
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
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
