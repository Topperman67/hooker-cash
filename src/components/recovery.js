import { createElement, lazy } from 'react'

// Recovery from pages that fail to render, most often a lazy route chunk that no longer exists
// because the site was redeployed while this tab was open.

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i

export function isChunkLoadError(error) {
  if (!error) return false
  if (error.name === 'ChunkLoadError') return true
  return CHUNK_ERROR.test(String(error.message || error))
}

const RELOAD_KEY = 'quantpad:chunk-reload'
let reloading = false

// One automatic reload per window of time, so a chunk that is really gone cannot loop the tab.
export function claimReload(storage, now = Date.now(), windowMs = 30_000) {
  try {
    const last = Number(storage.getItem(RELOAD_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < windowMs) return false
    storage.setItem(RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}

// Vite dispatches `vite:preloadError` when a built chunk (or its CSS) fails to load. Reload once
// to pick up the new deployment's index.html; otherwise let the error reach the ErrorBoundary.
export function installChunkReload(win = window) {
  const onError = (event) => {
    let storage
    try {
      storage = win.sessionStorage
    } catch {
      return
    }
    if (!claimReload(storage)) return
    reloading = true
    event.preventDefault()
    win.location.reload()
  }
  win.addEventListener('vite:preloadError', onError)
  return () => win.removeEventListener('vite:preloadError', onError)
}

// The module URL a browser names in its failed-import message (Chromium, Firefox), if any.
export function failedModuleUrl(error) {
  const urls = String(error?.message || '').match(/https?:\/\/[^\s'"]+/g)
  return urls ? urls[urls.length - 1].replace(/[.,;)]+$/, '') : null
}

// Browsers remember a failed module fetch for the life of the page, so importing the same URL
// again fails without even making a request. A retry asks for the chunk under a fresh query.
export const retryUrl = (url, attempt) => `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`

// React.lazy caches a rejected import for good, so retrying would rethrow the same error. Pages
// made with lazyPage remember their failure, and retryFailedPages() (called by the ErrorBoundary
// on "Try again" and on navigation) swaps in a fresh lazy component that imports the chunk again.
// The reset must not happen inside the failing render itself, or React's retry would loop.
const failed = new Set()

export function retryFailedPages() {
  for (const reset of failed) reset()
  failed.clear()
}

const nativeImport = (url) => import(/* @vite-ignore */ url)

export function lazyPage(load, reimport = nativeImport) {
  let Page = null
  let attempts = 0
  let url = null
  const reset = () => {
    Page = null
  }
  const fresh = () =>
    lazy(async () => {
      let mod
      try {
        mod = await (url ? reimport(retryUrl(url, attempts)) : load())
      } catch (error) {
        attempts += 1
        url = failedModuleUrl(error) ?? url
        failed.add(reset)
        throw error
      }
      if (mod?.default) return mod
      // Vite resolves to undefined after a preload error that triggered a reload: wait for it.
      if (reloading) return new Promise(() => {})
      failed.add(reset)
      throw Object.assign(new Error('Failed to fetch dynamically imported module'), {
        name: 'ChunkLoadError',
      })
    })
  function LazyPage(props) {
    Page ??= fresh()
    return createElement(Page, props)
  }
  return LazyPage
}
