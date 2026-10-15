import { useTheme } from '../lib/theme.js'

// The Q-Pad: a polished-chrome squircle Q whose cobalt slab tail is where fees leave the coin.
// Light rakes across it at 45° as four lines — blue, pink, green, yellow — one per main hook.
export function LogoMark({ size = 32, tone = 'black', className = 'brand-mark' }) {
  const src =
    tone === 'silver'
      ? '/brand/mark.svg'
      : tone === 'mono'
        ? '/brand/mark-mono.svg'
        : '/brand/mark-black.svg'
  return (
    <img className={className} src={src} width={size} height={size} alt="" aria-hidden="true" />
  )
}

const LOCKUP = { light: '/brand/lockup-light.svg', dark: '/brand/lockup-dark.svg' }
const warm = new Map()

/** Loads and decodes a theme's lockup ahead of a theme switch, so the swap is instant. */
export function warmLockup(theme) {
  const src = LOCKUP[theme === 'dark' ? 'dark' : 'light']
  if (typeof Image === 'undefined') return Promise.resolve()
  if (!warm.has(src)) {
    const img = new Image()
    img.src = src
    // keep the element: it holds the decoded image in the browser's list of available images
    warm.set(src, { img, ready: img.decode().catch(() => {}) })
  }
  return warm.get(src).ready
}

export default function Logo({ tone = 'auto', className = 'brand-lockup' }) {
  // "light" = for pearl backgrounds (black chrome); "dark" = for graphite (silver chrome); "auto"
  // follows the page: black chrome in the pearl studio, silver in the night studio.
  const [theme] = useTheme()
  const dark = tone === 'dark' || (tone === 'auto' && theme === 'dark')
  return (
    <img
      className={className}
      src={dark ? LOCKUP.dark : LOCKUP.light}
      alt="Quant Pad"
      width="1078"
      height="200"
    />
  )
}
