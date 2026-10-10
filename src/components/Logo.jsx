// The mark: an orbital ring crossed by a wave — a fee stream passing through a hook.
export function LogoMark({ size = 30, className = 'brand-mark' }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="qp-foil" x1="6" y1="10" x2="58" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7cf7ff" />
          <stop offset=".38" stopColor="#b69cff" />
          <stop offset=".7" stopColor="#ff8ad8" />
          <stop offset="1" stopColor="#ffe08a" />
        </linearGradient>
      </defs>
      <circle cx="30" cy="30" r="17" fill="none" stroke="url(#qp-foil)" strokeWidth="5" />
      <path
        d="M9 31c5-9 9-9 13 0s9 9 13 0 9-9 13 0 6 9 9 13"
        fill="none"
        stroke="url(#qp-foil)"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function Logo() {
  return (
    <>
      <LogoMark />
      <span className="brand-word">Quant Pad</span>
    </>
  )
}
