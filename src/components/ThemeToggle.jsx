import { flushSync } from 'react-dom'
import { setTheme, useTheme } from '../lib/theme.js'
import { warmLockup } from './Logo.jsx'

// Eight sun rays, two per light line: on hover they catch the four studio colours.
const RAYS = [
  [0, 'var(--yellow)'],
  [45, 'var(--pink)'],
  [90, 'var(--green)'],
  [135, 'var(--blue)'],
  [180, 'var(--yellow)'],
  [225, 'var(--pink)'],
  [270, 'var(--green)'],
  [315, 'var(--blue)'],
]

const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
// The reveal in flight: a second click starts a new one (the browser skips the old), and only the
// newest may take the reveal styles off when it ends.
let reveal = null

// The night studio spreads out from the switch as a circle (View Transitions API). Browsers
// without it get a short fade from the old page colour; reduced motion switches instantly.
function switchTheme(next, button) {
  if (reducedMotion()) return setTheme(next)
  const doc = document
  const root = doc.documentElement
  const box = button.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  // the liquid press: the lens squashes and springs back
  button.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(0.86, 0.9)', offset: 0.3 },
      { transform: 'scale(1.08, 1.05)', offset: 0.6 },
      { transform: 'scale(1)' },
    ],
    { duration: 560, easing: 'ease-out' },
  )
  if (typeof doc.startViewTransition !== 'function') {
    const veil = doc.createElement('div')
    veil.className = 'theme-veil'
    veil.style.background = getComputedStyle(root).getPropertyValue('--pearl')
    doc.body.append(veil)
    setTheme(next)
    const remove = () => veil.remove()
    veil
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' })
      .finished.then(remove, remove)
    return
  }
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  root.classList.add('theme-vt')
  // The new view is held (briefly) until the other lockup has decoded, so the reveal never
  // uncovers the old logo on the new bar. flushSync: the new theme must be committed (logo,
  // lenses, scenes) before the browser captures the new view.
  const vt = doc.startViewTransition(async () => {
    await Promise.race([warmLockup(next), new Promise((done) => setTimeout(done, 300))])
    flushSync(() => setTheme(next))
  })
  reveal = vt
  vt.ready
    .then(() =>
      root.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
        },
        {
          duration: 720,
          easing: 'cubic-bezier(0.22, 0.75, 0.2, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      ),
    )
    .catch(() => {})
  const done = () => {
    if (reveal !== vt) return
    reveal = null
    root.classList.remove('theme-vt')
  }
  vt.finished.then(done, done)
}

/** The header's light/dark switch: a glass lens holding a sun that sets into a moon. */
export default function ThemeToggle() {
  const [theme] = useTheme()
  const dark = theme === 'dark'
  const next = dark ? 'light' : 'dark'
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode'
  // a pointer over the switch or focus on it: start loading the other theme's lockup
  const warm = () => warmLockup(next)
  return (
    <button
      type="button"
      className="btn icon-btn theme-toggle"
      aria-label={label}
      title={label}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={(e) => switchTheme(next, e.currentTarget)}
    >
      <span className="theme-lens" aria-hidden="true" />
      <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient
            id="theme-icon-metal"
            className="theme-icon-metal"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop className="theme-icon-metal-hi" offset="0" />
            <stop className="theme-icon-metal-mid" offset="0.55" />
            <stop className="theme-icon-metal-lo" offset="1" />
          </linearGradient>
          {/* the bite that turns the sun's disc into a crescent slides in from the top right */}
          <mask
            id="theme-icon-bite"
            maskUnits="userSpaceOnUse"
            x="-4"
            y="-4"
            width="32"
            height="32"
          >
            <rect x="-4" y="-4" width="32" height="32" fill="#fff" />
            <circle className="theme-icon-bite" cx="26.4" cy="-2.4" r="6.2" fill="#000" />
          </mask>
        </defs>
        <g className="theme-icon-rays">
          {RAYS.map(([angle, color]) => (
            <line
              key={angle}
              x1="12"
              y1="1.6"
              x2="12"
              y2="3.9"
              transform={`rotate(${angle} 12 12)`}
              style={{ '--c': color }}
            />
          ))}
        </g>
        <g mask="url(#theme-icon-bite)">
          <circle className="theme-icon-core" cx="12" cy="12" r="4.6" />
        </g>
        <g className="theme-icon-stars">
          <path d="M19.4 2.6l.55 1.5 1.5.55-1.5.55-.55 1.5-.55-1.5-1.5-.55 1.5-.55z" />
          <circle cx="21.6" cy="9.4" r="0.9" />
        </g>
      </svg>
    </button>
  )
}
