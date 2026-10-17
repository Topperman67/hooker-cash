import { memo, useId, useRef } from 'react'
import { useInView, usePageVisible, useReducedMotion } from '../three/support.js'

// The payout engine, drawn: SOL leaves the payout wallet's tank, turns the engine's hour wheel, and
// leaves it as two lines, green to the holders' wallets and pink into the burn. The wheel's outer
// ring is the UTC day (the hour now lit in yellow), its inner ring the hour so far, which fills
// towards the next run. Inline SVG, animated with CSS (styles/engine.css): it stops off screen, in
// hidden tabs and when the engine is paused, and stands still under reduced motion. Decoration
// only (aria-hidden): every figure on it is real text elsewhere on the page.

const W = 760
const H = 440
const CORE = { x: 372, y: 224, r: 130 }
const TANK = { x: 40, y: 74, w: 112, h: 300 }
const HUB = { x: 556, y: 140 }
const CLUSTER = { x: 668, y: 128, r: 80 }
const BURN = { x: 660, y: 352, r: 50 }
// the most holder wallets drawn; more than this still draws this many
export const MAX_NODES = 60
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

const FEED = `M${TANK.x + TANK.w} 314 C204 314 200 ${CORE.y} ${CORE.x - CORE.r} ${CORE.y}`
const TO_HOLDERS = `M489 167 C512 158 532 146 ${HUB.x} ${HUB.y}`
const TO_BURN = `M489 281 C530 300 568 336 ${BURN.x - BURN.r + 2} 346`
const FLAME = 'M0 0C-17 0-21-15-12-27C-8-33-5-39 0-48C5-39 8-33 12-27C21-15 17 0 0 0Z'
const BLADE = 'M20-5C34-16 52-18 64-8C58-2 44 2 20 7Z'
const BUBBLES = [
  [66, 0.2],
  [118, 1.4],
  [90, 2.3],
  [104, 0.9],
  [78, 3.1],
]
const EMBERS = [-22, -8, 6, 18, -14, 12]

/** The holder wallets, as a sunflower: the biggest balance in the middle, smaller further out. */
export function holderNodes(count) {
  const n = Math.max(1, Math.min(MAX_NODES, Math.round(count) || 1))
  const radius = Math.min(CLUSTER.r, 13 * Math.sqrt(n))
  return Array.from({ length: n }, (_, i) => {
    const r = radius * Math.sqrt((i + 0.5) / n)
    const a = i * GOLDEN + 2.4
    const x = CLUSTER.x + r * Math.cos(a)
    const y = CLUSTER.y + r * Math.sin(a)
    // the ray leaves the hub flat, then bends up or down to its wallet
    const ray = `M${HUB.x} ${HUB.y}Q${HUB.x + (x - HUB.x) * 0.55} ${HUB.y + (y - HUB.y) * 0.18} ${x.toFixed(1)} ${y.toFixed(1)}`
    const far = Math.hypot(x - HUB.x, y - HUB.y)
    return {
      x,
      y,
      size: 2.2 + 4.8 * (1 - i / n) ** 1.8,
      ray,
      delay: -((i * 0.53) % 2.8) - far / 400,
    }
  })
}

const polar = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180
  return [CORE.x + r * Math.cos(a), CORE.y + r * Math.sin(a)]
}

function EngineArt({ mode = 'idle', holders = 24, share = 0.6, level = 0.5, now, tags }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const box = useRef(null)
  const reduce = useReducedMotion()
  const near = useInView(box, '100px')
  const visible = usePageVisible()
  const motion = mode !== 'run' || reduce ? 'still' : near && visible ? 'on' : 'paused'

  const nodes = holderNodes(holders)
  const g = Math.max(0.15, Math.min(0.85, share))
  const fill = Math.max(0.06, Math.min(0.92, level))
  const surface = TANK.y + 8 + (1 - fill) * (TANK.h - 16)
  const date = new Date((now ?? Date.now() / 1000) * 1000)
  const hour = date.getUTCHours()
  const minutes = date.getUTCMinutes() + date.getUTCSeconds() / 60
  const [tipX, tipY] = polar(84, (minutes / 60) * 360)
  const url = (name) => `url(#${id}-${name})`

  return (
    <div className="eg-art" ref={box} data-motion={motion} data-mode={mode}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-chrome`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.38" stopColor="#c8cfd9" />
            <stop offset="0.5" stopColor="#5b6372" />
            <stop offset="0.66" stopColor="#d3d9e2" />
            <stop offset="1" stopColor="#ffffff" />
          </linearGradient>
          <linearGradient id={`${id}-liquid`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#b9c6ff" />
            <stop offset="0.3" stopColor="#5a73ff" />
            <stop offset="0.75" stopColor="#2e4bff" />
            <stop offset="1" stopColor="#1529c4" />
          </linearGradient>
          <linearGradient id={`${id}-blade`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#5b6372" />
            <stop offset="0.45" stopColor="#f4f6fa" />
            <stop offset="0.7" stopColor="#9aa3b1" />
            <stop offset="1" stopColor="#e3e8ef" />
          </linearGradient>
          <radialGradient id={`${id}-bezel`}>
            <stop offset="0" stopColor="#252b37" />
            <stop offset="0.72" stopColor="#14171e" />
            <stop offset="1" stopColor="#0a0c10" />
          </radialGradient>
          <radialGradient id={`${id}-hub`} cx="0.36" cy="0.3" r="0.75">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.22" stopColor="#d4dcff" />
            <stop offset="0.6" stopColor="#4a66ff" />
            <stop offset="1" stopColor="#0f1430" />
          </radialGradient>
          <radialGradient id={`${id}-pit`}>
            <stop offset="0" stopColor="#4d1030" />
            <stop offset="0.6" stopColor="#1b0b15" />
            <stop offset="1" stopColor="#0b0d10" />
          </radialGradient>
          <radialGradient id={`${id}-blue`}>
            <stop offset="0" stopColor="#2e4bff" stopOpacity="0.34" />
            <stop offset="1" stopColor="#2e4bff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-green`}>
            <stop offset="0" stopColor="#12c26e" stopOpacity="0.3" />
            <stop offset="1" stopColor="#12c26e" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-pink`}>
            <stop offset="0" stopColor="#ff3ea5" stopOpacity="0.42" />
            <stop offset="1" stopColor="#ff3ea5" stopOpacity="0" />
          </radialGradient>
          <pattern id={`${id}-grid`} width="22" height="22" patternUnits="userSpaceOnUse">
            <path d="M22 0H0V22" fill="none" stroke="#fff" strokeOpacity="0.06" />
          </pattern>
          <radialGradient id={`${id}-fade`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0.35" stopColor="#fff" />
            <stop offset="1" stopColor="#000" />
          </radialGradient>
          <mask id={`${id}-vignette`}>
            <rect width={W} height={H} fill={url('fade')} />
          </mask>
          <clipPath id={`${id}-tank`}>
            <rect
              x={TANK.x + 8}
              y={TANK.y + 8}
              width={TANK.w - 16}
              height={TANK.h - 16}
              rx={(TANK.w - 16) / 2}
            />
          </clipPath>
        </defs>

        {/* the drafting table: a faint grid and the wheel's guide circles */}
        <rect width={W} height={H} fill={url('grid')} mask={url('vignette')} />
        <circle cx={CORE.x} cy={CORE.y} r="176" fill={url('blue')} />
        <circle cx={CLUSTER.x} cy={CLUSTER.y} r="120" fill={url('green')} />
        <circle cx={BURN.x} cy={BURN.y} r="92" fill={url('pink')} />
        <circle cx={CORE.x} cy={CORE.y} r="156" className="eg-guide" />
        <circle cx={CORE.x} cy={CORE.y} r="168" className="eg-guide eg-guide-dash" />

        {/* the payout wallet: a glass tank of SOL */}
        <g className="eg-tank">
          <rect
            x={TANK.x + 36}
            y={TANK.y - 10}
            width={TANK.w - 72}
            height="14"
            rx="4"
            fill={url('chrome')}
          />
          <rect
            x={TANK.x}
            y={TANK.y}
            width={TANK.w}
            height={TANK.h}
            rx={TANK.w / 2}
            className="eg-glass"
          />
          <g clipPath={url('tank')}>
            <rect
              x={TANK.x}
              y={surface}
              width={TANK.w}
              height={TANK.h}
              fill={url('liquid')}
              opacity="0.92"
            />
            <path
              className="eg-wave eg-wave-back"
              d={`M-80 ${surface}${' q30 -7 60 0 t60 0'.repeat(5)}V${TANK.y + TANK.h}H-80Z`}
            />
            <path
              className="eg-wave eg-wave-front"
              d={`M-80 ${surface + 3}${' q30 6 60 0 t60 0'.repeat(5)}V${TANK.y + TANK.h}H-80Z`}
              fill={url('liquid')}
            />
            {BUBBLES.map(([x, d]) => (
              <circle
                key={x}
                className="eg-bubble"
                cx={x}
                cy={TANK.y + TANK.h - 18}
                r={x % 3 ? 2.6 : 3.6}
                style={{ '--rise': `${surface - (TANK.y + TANK.h - 18)}px`, '--d': `${d}s` }}
              />
            ))}
          </g>
          <rect
            x={TANK.x}
            y={TANK.y}
            width={TANK.w}
            height={TANK.h}
            rx={TANK.w / 2}
            fill="none"
            stroke={url('chrome')}
            strokeWidth="3"
          />
          <rect
            x={TANK.x + 14}
            y={TANK.y + 34}
            width="7"
            height={TANK.h - 92}
            rx="3.5"
            className="eg-shine"
          />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <line
              key={i}
              x1={TANK.x + TANK.w - 24}
              x2={TANK.x + TANK.w - (i % 3 ? 16 : 10)}
              y1={TANK.y + 62 + i * 38}
              y2={TANK.y + 62 + i * 38}
              className="eg-gauge"
            />
          ))}
        </g>

        {/* SOL out of the tank into the wheel, through the hourly valve */}
        <path d={FEED} className="eg-pipe" />
        <path d={FEED} className="eg-pipe-core" />
        <path d={FEED} className="eg-flow eg-flow-sol" />
        <g transform="translate(201 269)">
          <circle r="13" fill={url('bezel')} stroke={url('chrome')} strokeWidth="2.5" />
          <g className="eg-valve">
            <rect x="-8" y="-1.5" width="16" height="3" rx="1.5" fill="#c8cfd9" />
          </g>
        </g>

        {/* the two lines out of the wheel: green to holders, pink to the burn */}
        <path
          d={TO_HOLDERS}
          className="eg-beam eg-beam-holders"
          style={{ strokeWidth: 3 + 9 * g }}
        />
        <path
          d={TO_BURN}
          className="eg-beam eg-beam-burn"
          style={{ strokeWidth: 3 + 9 * (1 - g) }}
        />
        <path d={TO_HOLDERS} className="eg-flow eg-flow-holders" />
        <path d={TO_BURN} className="eg-flow eg-flow-burn" />

        {/* the holders' wallets, each paid along its own ray, by balance */}
        <g className="eg-art-holders">
          {nodes.map((n, i) => (
            <path key={`r${i}`} d={n.ray} className="eg-ray" />
          ))}
          {nodes.map((n, i) => (
            <path
              key={`p${i}`}
              d={n.ray}
              pathLength="100"
              className="eg-ray-dot"
              style={{ '--d': `${n.delay.toFixed(2)}s` }}
            />
          ))}
          <circle cx={HUB.x} cy={HUB.y} r="7" className="eg-hub" />
          {nodes.map((n, i) => (
            <circle
              key={`n${i}`}
              cx={n.x.toFixed(1)}
              cy={n.y.toFixed(1)}
              r={n.size.toFixed(1)}
              className="eg-node"
              style={{ '--d': `${n.delay.toFixed(2)}s` }}
            />
          ))}
        </g>

        {/* the burn: bought-back tokens fall into a furnace of crisp flame lines */}
        <g className="eg-burn">
          <circle cx={BURN.x} cy={BURN.y} r={BURN.r} fill={url('pit')} className="eg-pit" />
          <g transform={`translate(${BURN.x} ${BURN.y})`}>
            <g className="eg-burn-ring">
              <circle r={BURN.r - 7} className="eg-burn-dash" />
            </g>
          </g>
          <g transform={`translate(${BURN.x} ${BURN.y + 30})`}>
            <path d={FLAME} className="eg-flame eg-flame-1" />
            <g transform="scale(0.7)">
              <path d={FLAME} className="eg-flame eg-flame-2" />
            </g>
            <g transform="scale(0.42)">
              <path d={FLAME} className="eg-flame eg-flame-3" />
            </g>
          </g>
          {EMBERS.map((x, i) => (
            <circle
              key={i}
              cx={BURN.x + x}
              cy={BURN.y - 34}
              r={i % 2 ? 1.6 : 2.2}
              className={`eg-ember ${i % 3 ? 'eg-ember-pink' : ''}`}
              style={{ '--d': `${(i * 0.41).toFixed(2)}s` }}
            />
          ))}
        </g>

        {/* the engine: the UTC day around the hour so far, around a chrome rotor */}
        <g className="eg-core">
          <circle
            cx={CORE.x}
            cy={CORE.y}
            r={CORE.r}
            fill={url('bezel')}
            stroke={url('chrome')}
            strokeWidth="4"
          />
          <circle cx={CORE.x} cy={CORE.y} r={CORE.r - 13} className="eg-day-band" />
          {Array.from({ length: 24 }, (_, h) => {
            const major = h % 6 === 0
            const [x1, y1] = polar(major ? 104 : 109, (h / 24) * 360)
            const [x2, y2] = polar(121, (h / 24) * 360)
            const cls = h === hour ? 'is-now' : h < hour ? 'is-past' : ''
            return (
              <line
                key={h}
                x1={x1.toFixed(1)}
                y1={y1.toFixed(1)}
                x2={x2.toFixed(1)}
                y2={y2.toFixed(1)}
                className={`eg-tick ${cls}`}
              />
            )
          })}
          {[0, 6, 12, 18].map((h) => {
            const [x, y] = polar(94, (h / 24) * 360)
            return (
              <text key={h} x={x} y={y} className="eg-hour">
                {String(h).padStart(2, '0')}
              </text>
            )
          })}
          <circle cx={CORE.x} cy={CORE.y} r="84" className="eg-minute-track" />
          <circle
            cx={CORE.x}
            cy={CORE.y}
            r="84"
            pathLength="100"
            className="eg-minute"
            transform={`rotate(-90 ${CORE.x} ${CORE.y})`}
            style={{ strokeDasharray: `${((minutes / 60) * 100).toFixed(2)} 100` }}
          />
          <circle cx={tipX} cy={tipY} r="4.5" className="eg-minute-tip" />
          <path
            d={`M${CORE.x - 6} ${CORE.y - CORE.r - 15}L${CORE.x + 6} ${CORE.y - CORE.r - 15}L${CORE.x} ${CORE.y - CORE.r - 5}Z`}
            className="eg-next-notch"
          />
          <g transform={`translate(${CORE.x} ${CORE.y})`}>
            <g className="eg-rotor">
              <circle r="66" fill="none" />
              {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                <path key={a} d={BLADE} transform={`rotate(${a})`} fill={url('blade')} />
              ))}
            </g>
            <circle r="23" fill={url('hub')} stroke={url('chrome')} strokeWidth="2" />
            <circle r="7" className="eg-spark" />
          </g>
        </g>
      </svg>
      {tags && (
        <div className="eg-tags" aria-hidden="true">
          {Object.entries(tags).map(([key, [title, value]]) => (
            <span key={key} className={`eg-tag eg-tag-${key}`}>
              <b>{title}</b>
              {value != null && <span className="num">{value}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default memo(EngineArt)
