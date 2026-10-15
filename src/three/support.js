import { useEffect, useState } from 'react'

// Gates for the live WebGL scenes. Kept free of three.js so the page can decide whether to load a
// scene at all before downloading it; the static art stays as the fallback.

// Software rasterisers run the glass at a few frames a second: they get the static art instead.
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i

let webgl
/** True when the browser can create a hardware WebGL2 context (checked once per page). */
export function supportsWebGL() {
  if (webgl !== undefined) return webgl
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = gl
      ? String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
      : ''
    webgl = !!gl && !SOFTWARE.test(renderer)
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    webgl = false
  }
  return webgl
}

/** Tracks prefers-reduced-motion live. */
export function useReducedMotion() {
  const [reduce, setReduce] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/** True while the element is on screen (with a margin), so off-screen scenes stop rendering. */
export function useInView(ref, rootMargin = '200px') {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin,
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootMargin])
  return inView
}

/** True while the tab is visible. */
export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}
