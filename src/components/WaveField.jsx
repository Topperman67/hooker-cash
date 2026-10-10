import { useEffect, useRef } from 'react'
import { MODULES } from '../lib/hooks.js'

// A double-slit experiment drawn as the product: creator-fee quanta leave the source, pass two
// slits and land on a detector screen split into the four hook bands. Landing positions follow
// the interference intensity, so the screen builds real fringes over time.
const BANDS = MODULES.map((m) => ({ name: m.name, color: getComputedColor(m.key) }))

function getComputedColor(key) {
  return {
    creatorBps: '#d9d4ff',
    burnBps: '#ffc857',
    entangleBps: '#6be8ff',
    fusionBps: '#ff8ad8',
  }[key]
}

function intensity(u) {
  // u in [-1, 1] across the screen. Two-slit fringes under a single-slit envelope.
  const fringe = Math.cos(u * 9.5) ** 2
  const x = u * 3.2
  const envelope = x === 0 ? 1 : (Math.sin(x) / x) ** 2
  return fringe * envelope
}
function sampleLanding() {
  for (;;) {
    const u = Math.random() * 2 - 1
    if (Math.random() < intensity(u)) return u
  }
}

export default function WaveField({ className = '' }) {
  const canvas = useRef(null)
  useEffect(() => {
    const el = canvas.current
    const ctx = el.getContext('2d')
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const BINS = 120
    const hist = new Float32Array(BINS)
    let particles = []
    let w = 0,
      h = 0,
      dpr = 1,
      raf = 0,
      visible = true,
      phase = 0,
      last = performance.now()

    const geometry = () => {
      const sourceX = w * 0.06,
        barrierX = w * 0.36,
        screenX = w * 0.9
      const gap = Math.min(h * 0.16, 56)
      return {
        sourceX,
        barrierX,
        screenX,
        cy: h / 2,
        slits: [h / 2 - gap / 2, h / 2 + gap / 2],
        span: h * 0.42,
      }
    }
    const bandFor = (u) =>
      BANDS[Math.min(BANDS.length - 1, Math.floor(((u + 1) / 2) * BANDS.length))]

    function resize() {
      const rect = el.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = rect.width
      h = rect.height
      el.width = Math.round(w * dpr)
      el.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function spawn() {
      const g = geometry()
      const slit = g.slits[Math.random() < 0.5 ? 0 : 1]
      const u = sampleLanding()
      particles.push({ t: 0, slit, u, band: bandFor(u), speed: 0.55 + Math.random() * 0.25 })
    }

    function land(u) {
      const i = Math.max(0, Math.min(BINS - 1, Math.floor(((u + 1) / 2) * BINS)))
      hist[i] += 1
    }

    function draw(dt) {
      const g = geometry()
      ctx.clearRect(0, 0, w, h)

      // Wavefronts from each slit, drifting outward.
      phase = (phase + dt * 0.035) % 26
      ctx.lineWidth = 1
      for (const sy of g.slits) {
        for (let r = phase; r < g.screenX - g.barrierX + 40; r += 26) {
          const alpha = 0.16 * (1 - r / (g.screenX - g.barrierX + 40))
          ctx.strokeStyle = `rgba(182,156,255,${alpha})`
          ctx.beginPath()
          ctx.arc(g.barrierX, sy, r, -Math.PI / 2.4, Math.PI / 2.4)
          ctx.stroke()
        }
      }
      // Incoming plane waves.
      for (let x = g.sourceX + ((phase * 0.9) % 22); x < g.barrierX; x += 22) {
        ctx.strokeStyle = 'rgba(124,247,255,0.12)'
        ctx.beginPath()
        ctx.moveTo(x, g.cy - g.span * 0.55)
        ctx.lineTo(x, g.cy + g.span * 0.55)
        ctx.stroke()
      }

      // Barrier with two slits.
      ctx.fillStyle = '#2a2550'
      const slitHalf = 5
      ctx.fillRect(g.barrierX - 2, 0, 4, g.slits[0] - slitHalf)
      ctx.fillRect(g.barrierX - 2, g.slits[0] + slitHalf, 4, g.slits[1] - g.slits[0] - slitHalf * 2)
      ctx.fillRect(g.barrierX - 2, g.slits[1] + slitHalf, 4, h - g.slits[1] - slitHalf)

      // Source.
      const glow = ctx.createRadialGradient(g.sourceX, g.cy, 0, g.sourceX, g.cy, 26)
      glow.addColorStop(0, 'rgba(255,224,138,0.9)')
      glow.addColorStop(1, 'rgba(255,224,138,0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(g.sourceX, g.cy, 26, 0, Math.PI * 2)
      ctx.fill()

      // Detector screen: hook bands and the accumulated fringe histogram.
      const top = g.cy - g.span,
        height = g.span * 2
      BANDS.forEach((band, i) => {
        const y0 = top + (height * i) / BANDS.length
        ctx.fillStyle = band.color
        ctx.globalAlpha = 0.85
        ctx.fillRect(g.screenX, y0 + 2, 3, height / BANDS.length - 4)
        ctx.globalAlpha = 1
      })
      const max = Math.max(1, ...hist)
      const barMax = w - g.screenX - 18
      for (let i = 0; i < BINS; i++) {
        if (!hist[i]) continue
        const u = (i / BINS) * 2 - 1
        const y = top + (i / BINS) * height
        const len = (hist[i] / max) * barMax
        ctx.fillStyle = bandFor(u).color
        ctx.globalAlpha = 0.25 + 0.6 * (hist[i] / max)
        ctx.fillRect(g.screenX + 6, y, len, Math.max(1, height / BINS - 0.5))
      }
      ctx.globalAlpha = 1

      // Quanta in flight.
      const next = []
      for (const p of particles) {
        p.t += dt * 0.00055 * p.speed
        let x, y
        if (p.t < 0.5) {
          const k = p.t / 0.5
          x = g.sourceX + (g.barrierX - g.sourceX) * k
          y = g.cy + (p.slit - g.cy) * k
        } else {
          const k = (p.t - 0.5) / 0.5
          x = g.barrierX + (g.screenX - g.barrierX) * k
          y = p.slit + (g.cy + p.u * g.span - p.slit) * k
        }
        if (p.t >= 1) {
          land(p.u)
          continue
        }
        ctx.fillStyle = p.t < 0.5 ? '#ffe08a' : p.band.color
        ctx.beginPath()
        ctx.arc(x, y, 2.2, 0, Math.PI * 2)
        ctx.fill()
        next.push(p)
      }
      particles = next
    }

    function frame(now) {
      // rAF timestamps can precede the performance.now() taken when resuming.
      const dt = Math.max(0, Math.min(64, now - last))
      last = now
      if (visible && particles.length < 70 && Math.random() < 0.45) spawn()
      draw(dt)
      raf = requestAnimationFrame(frame)
    }

    resize()
    if (reduce) {
      for (let i = 0; i < 2600; i++) land(sampleLanding())
      draw(0)
    } else {
      for (let i = 0; i < 260; i++) land(sampleLanding())
      raf = requestAnimationFrame(frame)
    }
    const ro = new ResizeObserver(() => {
      resize()
      if (reduce) draw(0)
    })
    ro.observe(el)
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (reduce) return
      cancelAnimationFrame(raf)
      if (visible) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    })
    io.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
    }
  }, [])

  return (
    <div className={`wavefield ${className}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <ul className="wavefield-bands" aria-label="Quantum Hook detectors">
        {BANDS.map((b) => (
          <li key={b.name} style={{ '--c': b.color }}>
            {b.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
