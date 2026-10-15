import { MODULES } from '../lib/hooks.js'

// "The Refractor": a white beam of creator fees enters the chrome Q and leaves its cobalt tail as
// four coloured lines, one per hook. Geometry lives in a 600×560 box; the Q image sits at
// (150,100) and is 300 wide, so its counter is at ≈(288,236) and its tail end at ≈(425,372).
const TAIL = [425, 372]
const COUNTER = [288, 236]
const SOURCE = [150, 40]
const ROUTES = [
  { key: 'creatorBps', end: [590, 286], c1: [500, 360], c2: [540, 300] },
  { key: 'burnBps', end: [590, 368], c1: [500, 380], c2: [540, 370] },
  { key: 'entangleBps', end: [560, 456], c1: [470, 410], c2: [520, 450] },
  { key: 'fusionBps', end: [470, 528], c1: [440, 420], c2: [460, 500] },
]
const EXAMPLE = { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 }

export default function Refractor({ symbol }) {
  const reduce =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const paths = ROUTES.map((r) => ({
    ...r,
    module: MODULES.find((m) => m.key === r.key),
    d: `M${TAIL[0]} ${TAIL[1]} C${r.c1.join(' ')} ${r.c2.join(' ')} ${r.end.join(' ')}`,
  }))
  const beam = `M${SOURCE.join(' ')} L${COUNTER.join(' ')}`
  return (
    <figure
      className="refractor"
      aria-label="Creator fees enter the Q and leave as four hook lines"
    >
      <svg className="refractor-lines" viewBox="0 0 600 560" aria-hidden="true">
        <defs>
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".35" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        {/* incoming white fee light, edged in steel so it reads on pearl */}
        <path d={beam} stroke="#6b7482" strokeWidth="5" opacity=".35" />
        <path d={beam} stroke="url(#beam)" strokeWidth="9" filter="url(#glow)" opacity=".9" />
        <path d={beam} stroke="#fff" strokeWidth="2.5" />
        {/* outgoing hook lines */}
        {paths.map((p) => (
          <g key={p.key}>
            <path
              d={p.d}
              fill="none"
              style={{ stroke: p.module.color }}
              strokeWidth="7"
              opacity=".28"
              filter="url(#glow)"
            />
            <path
              d={p.d}
              fill="none"
              style={{ stroke: p.module.color }}
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          </g>
        ))}
        {!reduce && (
          <g>
            <circle r="5" fill="#fff" filter="url(#glow)">
              <animateMotion dur="2.4s" repeatCount="indefinite" path={beam} />
            </circle>
            {paths.map((p, i) => (
              <circle key={p.key} r="4" style={{ fill: p.module.color }}>
                <animateMotion
                  dur="2.4s"
                  begin={`${1.1 + i * 0.12}s`}
                  repeatCount="indefinite"
                  path={p.d}
                />
              </circle>
            ))}
          </g>
        )}
      </svg>
      <div className="refractor-q">
        <img src="/brand/mark.svg" alt="" />
        <span className="refractor-glint" aria-hidden="true" />
      </div>
      <div className="refractor-source">
        <span className="refractor-dot" />
        Meteora creator fee{symbol ? <strong className="num"> · ${symbol}</strong> : null}
      </div>
      {paths.map((p) => (
        <div
          key={p.key}
          className="refractor-chip"
          style={{
            left: `${(p.end[0] / 600) * 100}%`,
            top: `${(p.end[1] / 560) * 100}%`,
            '--c': p.module.color,
          }}
        >
          <span className="chip-dot" />
          {p.module.name}
          <span className="num">{EXAMPLE[p.key] / 100}%</span>
        </div>
      ))}
      <figcaption className="refractor-caption">
        Example split. Every coin sets its own at launch.
      </figcaption>
    </figure>
  )
}
