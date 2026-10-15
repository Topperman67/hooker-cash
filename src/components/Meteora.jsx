// Meteora, the venue every Quant Pad coin launches and trades on. Official artwork from
// github.com/MeteoraAg/brand-kit (meteora-v2), unmodified, in public/partners/meteora/.
export function MeteoraMark({ size = 20, tone = 'color', className = 'meteora-mark' }) {
  // "color" = the orange-to-violet symbol; "white" = the one-colour version for dark panels.
  const src =
    tone === 'white' ? '/partners/meteora/symbol-negative.svg' : '/partners/meteora/symbol.svg'
  return (
    <img className={className} src={src} width={size} height={size} alt="" aria-hidden="true" />
  )
}

export default function MeteoraLogo({ tone = 'light', className = 'meteora-lockup' }) {
  // "light" = for pearl backgrounds; "dark" = for graphite.
  const src =
    tone === 'dark'
      ? '/partners/meteora/full-logo-on-dark.svg'
      : '/partners/meteora/full-logo-on-white.svg'
  return <img className={className} src={src} alt="Meteora" />
}
