import { useCallback, useSyncExternalStore } from 'react'

// Light (pearl studio) or dark (night studio). The site opens in light unless the visitor has
// switched to dark before; public/theme-init.js applies the saved choice before first paint (the
// CSP has no 'unsafe-inline', so it cannot be an inline script). The theme lives on <html> as
// data-theme, which every themed stylesheet keys off.
export const THEME_KEY = 'quantpad:theme'
export const THEMES = ['light', 'dark']
const EVENT = 'quantpad:theme'
const THEME_COLOR = { light: '#e9ecf0', dark: '#07080c' }

export function readTheme(storage) {
  try {
    return storage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function saveTheme(storage, theme) {
  try {
    storage?.setItem(THEME_KEY, theme)
  } catch {}
}

export function applyTheme(theme, doc = globalThis.document) {
  if (!doc) return
  const root = doc.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
}

export function currentTheme(doc = globalThis.document) {
  return doc?.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light'
  saveTheme(globalThis.localStorage, next)
  applyTheme(next)
  globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }))
}

function subscribe(onChange) {
  // Another tab switching the theme switches this one too.
  const onStorage = (e) => {
    if (e.key !== THEME_KEY) return
    applyTheme(readTheme(localStorage))
    onChange()
  }
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** [theme, setTheme, toggle]: re-renders whenever the theme changes, in this tab or another. */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light')
  const toggle = useCallback(() => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'), [])
  return [theme, setTheme, toggle]
}
