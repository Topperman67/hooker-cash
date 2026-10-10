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

export default function Logo({ tone = 'light', className = 'brand-lockup' }) {
  // "light" = for pearl backgrounds (black chrome); "dark" = for graphite (silver chrome).
  const src = tone === 'dark' ? '/brand/lockup-dark.svg' : '/brand/lockup-light.svg'
  return <img className={className} src={src} alt="Quant Pad" width="1078" height="200" />
}
