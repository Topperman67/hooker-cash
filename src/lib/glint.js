import { useEffect } from 'react'

// The pointer is the studio light: its horizontal position slides the four light lines across
// every chrome surface (via the --lx custom property on <html>). Off under reduced motion.
export function useGlobalGlint() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0,
      x = 0.5
    const root = document.documentElement
    const apply = () => {
      frame = 0
      root.style.setProperty('--lx', `${(110 - x * 90).toFixed(1)}%`)
    }
    const onMove = (e) => {
      x = e.clientX / window.innerWidth
      if (!frame) frame = requestAnimationFrame(apply)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
    }
  }, [])
}

// Per-element tilt + glint for holographic cards: sets --gx/--gy (0–100%) and --rx/--ry (deg).
export function tiltHandlers() {
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) return {}
  return {
    onPointerMove(e) {
      const el = e.currentTarget
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width,
        py = (e.clientY - r.top) / r.height
      el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`)
      el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`)
      el.style.setProperty('--ry', `${((px - 0.5) * 10).toFixed(2)}deg`)
      el.style.setProperty('--rx', `${((0.5 - py) * 8).toFixed(2)}deg`)
    },
    onPointerLeave(e) {
      const el = e.currentTarget
      el.style.setProperty('--ry', '0deg')
      el.style.setProperty('--rx', '0deg')
    },
  }
}
