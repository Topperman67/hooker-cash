// The $QUANTP payout engine, in 38 seconds: the team sends SOL from the creator's fee claims to
// the payout wallet, every hour a slice is released, 60% goes in SOL, by balance, to the wallets
// holding 0.15% of the supply whose share is worth sending, 40% is bought back and burned, and
// every transaction shows on the site. Everything is a function of time (anim.js), so any frame
// renders on its own. The holders are mainnet's (holders.js); the rules are the engine's
// (shared/network.mjs); the burn and the site's figures are the chain's (timeline.js FACTS).
import { AbsoluteFill, Audio, staticFile, useCurrentFrame, Img } from 'remotion'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import { useFonts } from '../fonts.js'
import { clamp01, ease, lerp, prog, rand } from '../anim.js'
import {
  BEAM_FLIGHT,
  BURN_COIN_FLIGHT,
  BURN_COINS,
  BURN_T,
  BURN_TOKEN_FLIGHT,
  BURN_TOKENS,
  COIN_FLIGHT,
  CUES,
  ELIGIBLE,
  FACTS,
  FPS,
  HEIGHT,
  HOLDERS_T,
  PAID,
  SCENES,
  SWEEPS,
  TRADE_FLIGHT,
  TRADES,
  WIDTH,
  beamAt,
  beamLandsAt,
  feeLandsAt,
  lightAt,
  sweepAt,
} from './timeline.js'
import { HOLDERS, SUPPLY } from './holders.js'
import './engine.css'

const TAU = Math.PI * 2
const fmt = (n) => Math.round(n).toLocaleString('en-US')

/** 0→1 over [a, a + d], eased */
const rise = (t, a, d = 0.5, fn = ease.out) => fn(prog(t, a, a + d))
/** how present a scene is: fades in at its start and out at its end */
function presence(t, { from, to }, fadeIn = 0.35, fadeOut = 0.35) {
  if (t < from || t > to) return 0
  return Math.min(ease.out(prog(t, from, from + fadeIn)), 1 - ease.in(prog(t, to - fadeOut, to)))
}
/** a point on a quadratic Bézier */
const quad = (p0, p1, p2, s) => [
  (1 - s) ** 2 * p0[0] + 2 * (1 - s) * s * p1[0] + s * s * p2[0],
  (1 - s) ** 2 * p0[1] + 2 * (1 - s) * s * p1[1] + s * s * p2[1],
]
/** a short-lived pulse: 1 at `at`, decaying over `tau` seconds */
const pulse = (t, at, tau = 0.25) => (t < at ? 0 : Math.exp(-(t - at) / tau))

// ================================================================================================
// the stage
// ================================================================================================

function Backdrop({ t }) {
  const drift = Math.sin(t * 0.25) * 4
  return (
    <AbsoluteFill
      style={{
        background: `
          radial-gradient(55% 60% at ${32 + drift}% ${42 - drift}%, rgba(46, 75, 255, 0.42), transparent 70%),
          radial-gradient(45% 50% at ${88 - drift}% ${92 + drift}%, rgba(255, 62, 165, 0.2), transparent 70%),
          radial-gradient(40% 45% at ${8 + drift}% 104%, rgba(18, 194, 110, 0.16), transparent 70%),
          radial-gradient(120% 90% at 50% 50%, #0a0e1c 0%, #05070d 70%, #020306 100%)`,
      }}
    >
      {/* a faint dot grid, drifting */}
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0, opacity: 0.22 }}>
        <defs>
          <pattern id="dots" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform={`translate(${(t * 6) % 48} ${(t * 3) % 48})`}>
            <circle cx="2" cy="2" r="1.4" fill="#8fa4ff" />
          </pattern>
          <radialGradient id="dotfade" cx="50%" cy="50%" r="60%">
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="dotmask">
            <rect width={WIDTH} height={HEIGHT} fill="url(#dotfade)" />
          </mask>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="url(#dots)" mask="url(#dotmask)" />
      </svg>
      {/* the brand's four light lines, raking the top-right corner */}
      <div
        style={{
          position: 'absolute',
          right: -260 + Math.sin(t * 0.3) * 30,
          top: -320,
          width: 900,
          height: 900,
          transform: 'rotate(-28deg)',
          opacity: 0.55,
          filter: 'blur(0.4px) drop-shadow(0 0 18px rgba(143,164,255,0.35))',
        }}
      >
        {['#ff3ea5', '#ffc21a', '#12c26e', '#2e4bff'].map((c, i) => (
          <div
            key={c}
            style={{
              position: 'absolute',
              left: 360 + i * 34,
              top: 0,
              width: 12,
              height: 900,
              borderRadius: 6,
              background: `linear-gradient(180deg, transparent, ${c} 30%, ${c} 70%, transparent)`,
            }}
          />
        ))}
      </div>
      {/* vignette */}
      <AbsoluteFill style={{ background: 'radial-gradient(90% 80% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)' }} />
    </AbsoluteFill>
  )
}

/** the brand lines sweep across the frame at each cut */
function Wipe({ t }) {
  const cuts = Object.values(SCENES)
    .map((s) => s.from)
    .filter((x) => x > 0)
  const at = cuts.find((c) => Math.abs(t - c) < 0.5)
  if (at == null) return null
  const p = prog(t, at - 0.5, at + 0.5)
  const x = lerp(-900, WIDTH + 900, ease.inOut(p))
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: x - 450, top: -300, width: 900, height: HEIGHT + 600, transform: 'rotate(18deg)' }}>
        {['#ff3ea5', '#ffc21a', '#12c26e', '#2e4bff'].map((c, i) => (
          <div
            key={c}
            style={{
              position: 'absolute',
              left: 300 + i * 70,
              top: 0,
              width: 46,
              height: '100%',
              background: c,
              opacity: 0.85,
              boxShadow: `0 0 60px ${c}`,
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  )
}

function Caption({ t, scene, kicker, num, color, title }) {
  const k = rise(t, scene.from + 0.15, 0.45)
  const h = rise(t, scene.from + 0.3, 0.55)
  const out = 1 - ease.in(prog(t, scene.to - 0.4, scene.to))
  return (
    <div className="eng-caption" style={{ opacity: out }}>
      <span className="eng-kicker" style={{ opacity: k, transform: `translateY(${(1 - k) * 18}px)` }}>
        <i style={{ background: color }}>{num}</i>
        {kicker}
      </span>
      <h2 className="eng-title" style={{ opacity: h, transform: `translateY(${(1 - h) * 26}px)`, filter: `blur(${(1 - h) * 8}px)` }}>
        {title}
      </h2>
    </div>
  )
}

function Sub({ t, from, to, children }) {
  const o = Math.min(rise(t, from, 0.5), 1 - ease.in(prog(t, to - 0.4, to)))
  return (
    <div className="eng-sub" style={{ opacity: o, transform: `translateY(${(1 - o) * 14}px)` }}>
      {children}
    </div>
  )
}

/** SVG defs shared by every scene */
function Defs() {
  return (
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="8" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="softglow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="18" />
      </filter>
      <linearGradient id="sol" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#9945ff" />
        <stop offset="1" stopColor="#14f195" />
      </linearGradient>
      <linearGradient id="chromeCoin" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.45" stopColor="#c5ccd6" />
        <stop offset="0.5" stopColor="#5d6573" />
        <stop offset="0.62" stopColor="#aab3c0" />
        <stop offset="1" stopColor="#f2f5f9" />
      </linearGradient>
      <linearGradient id="liquid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#8fa4ff" />
        <stop offset="1" stopColor="#2e4bff" />
      </linearGradient>
      <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="rgba(255,255,255,0.22)" />
        <stop offset="0.5" stopColor="rgba(255,255,255,0.06)" />
        <stop offset="1" stopColor="rgba(255,255,255,0.12)" />
      </linearGradient>
      <linearGradient id="barGreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#5cf0aa" />
        <stop offset="1" stopColor="#0c9c57" />
      </linearGradient>
      <linearGradient id="barDim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#4a5468" />
        <stop offset="1" stopColor="#262c38" />
      </linearGradient>
      <radialGradient id="fireCore" cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#fff6c8" />
        <stop offset="0.3" stopColor="#ffc21a" />
        <stop offset="0.62" stopColor="#ff5a8c" stopOpacity="0.9" />
        <stop offset="1" stopColor="#ff3ea5" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="fire" cx="50%" cy="55%" r="55%">
        <stop offset="0" stopColor="#fff6c8" />
        <stop offset="0.25" stopColor="#ffc21a" />
        <stop offset="0.55" stopColor="#ff5a8c" />
        <stop offset="0.85" stopColor="#ff3ea5" stopOpacity="0.55" />
        <stop offset="1" stopColor="#ff3ea5" stopOpacity="0" />
      </radialGradient>
    </defs>
  )
}

/** a SOL coin */
function SolCoin({ x, y, r = 15, o = 1 }) {
  return (
    <g transform={`translate(${x} ${y})`} opacity={o}>
      <circle r={r + 6} fill="#14f195" opacity="0.18" filter="url(#softglow)" />
      <circle r={r} fill="url(#sol)" stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
      {[-0.42, 0, 0.42].map((dy) => (
        <rect key={dy} x={-r * 0.48} y={r * dy - r * 0.1} width={r * 0.96} height={r * 0.2} rx={r * 0.06} fill="#fff" transform={`skewX(-18)`} />
      ))}
    </g>
  )
}

/** a $QUANTP coin: chrome, with the Q */
function QCoin({ x, y, r = 18, o = 1, spin = 0 }) {
  const sx = Math.max(0.15, Math.abs(Math.cos(spin)))
  return (
    <g transform={`translate(${x} ${y}) scale(${sx} 1)`} opacity={o}>
      <circle r={r} fill="url(#chromeCoin)" stroke="rgba(255,255,255,0.8)" strokeWidth="1.5" />
      <image href={staticFile('mark.svg')} x={-r * 0.7} y={-r * 0.7} width={r * 1.4} height={r * 1.4} />
    </g>
  )
}

/** the payout wallet: a glass vault that fills with SOL */
function Vault({ x, y, w = 230, h = 270, fill = 0.4, t, glow = 0 }) {
  const top = y - h / 2
  const level = top + h * (1 - clamp01(fill)) + 6
  const wave = Array.from({ length: 25 }, (_, i) => {
    const px = x - w / 2 + (i / 24) * w
    const py = level + Math.sin(i * 0.7 + t * 4) * 5
    return `${px},${py}`
  })
  const path = `M${x - w / 2},${y + h / 2} L${wave.join(' L')} L${x + w / 2},${y + h / 2} Z`
  return (
    <g>
      <rect x={x - w / 2 - 30} y={top - 30} width={w + 60} height={h + 60} rx="60" fill="#2e4bff" opacity={0.18 + glow * 0.4} filter="url(#softglow)" />
      <clipPath id={`vault-${x}-${y}`}>
        <rect x={x - w / 2} y={top} width={w} height={h} rx="40" />
      </clipPath>
      <rect x={x - w / 2} y={top} width={w} height={h} rx="40" fill="rgba(12,16,30,0.7)" />
      <g clipPath={`url(#vault-${x}-${y})`}>
        <path d={path} fill="url(#liquid)" opacity="0.9" />
        <path d={path} fill="none" stroke="#c9d3ff" strokeWidth="3" opacity="0.7" transform="translate(0 0)" />
      </g>
      <rect x={x - w / 2} y={top} width={w} height={h} rx="40" fill="url(#glass)" stroke="rgba(255,255,255,0.45)" strokeWidth="2" />
      <rect x={x - w / 2 + 14} y={top + 12} width={w * 0.5} height={10} rx="5" fill="#fff" opacity="0.35" />
    </g>
  )
}

/** a DAMM v2 pool: a glass disc with a turning swirl */
function Pool({ x, y, r = 120, t, kick = 0 }) {
  const s = 1 + kick * 0.07
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <circle r={r + 40} fill="#2e4bff" opacity={0.16 + kick * 0.3} filter="url(#softglow)" />
      <circle r={r} fill="rgba(10,14,28,0.75)" stroke="rgba(255,255,255,0.4)" strokeWidth="2" />
      {[0, 1, 2].map((i) => (
        <path
          key={i}
          d={`M${r * 0.75},0 A${r * 0.75},${r * 0.75} 0 0 1 ${-r * 0.75 * 0.5},${r * 0.75 * 0.866}`}
          fill="none"
          stroke={['#8fa4ff', '#12c26e', '#ff3ea5'][i]}
          strokeWidth="6"
          strokeLinecap="round"
          opacity="0.85"
          transform={`rotate(${t * 70 + i * 120}) scale(${1 - i * 0.18})`}
          filter="url(#glow)"
        />
      ))}
      <circle r={r} fill="url(#glass)" opacity="0.6" />
    </g>
  )
}

/** a clock ring: 60 ticks, drawn to `p`, with a sweeping hand and trail */
function HourRing({ x, y, r, p = 1, hand = null, color = '#8fa4ff' }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r} fill="none" stroke="rgba(143,164,255,0.18)" strokeWidth="2" />
      {Array.from({ length: 60 }, (_, i) => {
        if (i / 60 >= p) return null
        const a = (i / 60) * TAU - Math.PI / 2
        const major = i % 5 === 0
        const r0 = r - (major ? 26 : 14)
        return (
          <line
            key={i}
            x1={Math.cos(a) * r0}
            y1={Math.sin(a) * r0}
            x2={Math.cos(a) * r}
            y2={Math.sin(a) * r}
            stroke={major ? '#fff' : color}
            strokeWidth={major ? 4 : 2}
            strokeLinecap="round"
            opacity={major ? 0.9 : 0.55}
          />
        )
      })}
      {hand != null && (
        <g>
          {Array.from({ length: 18 }, (_, i) => {
            const a = hand - (i / 18) * 1.1
            const a0 = a - Math.PI / 2
            return (
              <line
                key={i}
                x1={Math.cos(a0) * (r - 30)}
                y1={Math.sin(a0) * (r - 30)}
                x2={Math.cos(a0) * (r + 6)}
                y2={Math.sin(a0) * (r + 6)}
                stroke={color}
                strokeWidth="10"
                opacity={(1 - i / 18) * 0.35}
              />
            )
          })}
          <line
            x1={0}
            y1={0}
            x2={Math.cos(hand - Math.PI / 2) * (r + 8)}
            y2={Math.sin(hand - Math.PI / 2) * (r + 8)}
            stroke="#fff"
            strokeWidth="5"
            strokeLinecap="round"
            filter="url(#glow)"
          />
        </g>
      )}
    </g>
  )
}

// ================================================================================================
// the scenes
// ================================================================================================

function Title({ t }) {
  const s = SCENES.title
  const o = presence(t, s, 0.01, 0.5)
  const ringP = ease.out(prog(t, 0.15, 1.5))
  const q = rise(t, 0.45, 0.9, ease.outBack)
  const hand = ease.inOut(prog(t, 0.6, 3.6)) * TAU
  const h1 = rise(t, 1.0, 0.6)
  const sub = rise(t, 1.45, 0.6)
  const hit = pulse(t, CUES.titleHit, 0.4)
  const scale = 1 + prog(t, 3.3, 4) * 0.05
  return (
    <AbsoluteFill style={{ opacity: o, transform: `scale(${scale})` }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        <circle cx={960} cy={400} r={300} fill="#2e4bff" opacity={0.22 + hit * 0.25} filter="url(#softglow)" />
        <HourRing x={960} y={400} r={240} p={ringP} hand={t > 0.6 ? hand : null} />
      </svg>
      <Img
        src={staticFile('mark.svg')}
        style={{
          position: 'absolute',
          left: 960 - 105,
          top: 400 - 105,
          width: 210,
          height: 210,
          opacity: clamp01(q * 1.2),
          transform: `scale(${q})`,
          filter: `drop-shadow(0 0 ${30 + hit * 40}px rgba(143,164,255,0.7))`,
        }}
      />
      <div className="eng-hero">
        <span className="eng-kicker" style={{ opacity: h1 }}>
          <i style={{ background: '#8fa4ff' }}>$</i>QUANTP
        </span>
        <h1 className="eng-chrome" style={{ opacity: h1, transform: `translateY(${(1 - h1) * 30}px)`, filter: `blur(${(1 - h1) * 10}px)` }}>
          The Payout Engine
        </h1>
        <p style={{ opacity: sub, transform: `translateY(${(1 - sub) * 20}px)` }}>
          Holders paid. Supply burned. <b style={{ color: '#fff' }}>Hourly, from a team-funded wallet.</b>
        </p>
      </div>
    </AbsoluteFill>
  )
}

function Fees({ t }) {
  const s = SCENES.fees
  const o = presence(t, s)
  if (!o) return null
  const pool = [700, 610]
  const vault = [1390, 610]
  const landed = TRADES.filter((_, i) => t >= feeLandsAt(i)).length
  const kick = Math.max(0, ...TRADES.map((a) => pulse(t, a, 0.18)))
  const vaultKick = Math.max(0, ...TRADES.map((_, i) => pulse(t, feeLandsAt(i), 0.2)))
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        {/* the path the fees take, by the team's hand */}
        <path id="feeArc" d={`M${pool[0] + 130},${pool[1]} Q${(pool[0] + vault[0]) / 2},${pool[1] - 230} ${vault[0] - 130},${vault[1]}`} fill="none" stroke="rgba(143,164,255,0.25)" strokeWidth="3" strokeDasharray="4 14" strokeDashoffset={-t * 40} />
        <text dy={34} fill="#b8c0cc" opacity={rise(t, s.from + 1.2, 0.6)} style={{ font: '500 21px "Martian Mono Variable"' }}>
          <textPath href="#feeArc" startOffset="50%" textAnchor="middle">
            sent by the team
          </textPath>
        </text>
        <Pool x={pool[0]} y={pool[1]} t={t} kick={kick} />
        <Vault x={vault[0]} y={vault[1]} t={t} fill={0.12 + 0.55 * (landed / TRADES.length)} glow={vaultKick} />
        {TRADES.map((arrive, i) => {
          const start = arrive - TRADE_FLIGHT
          const p = prog(t, start, arrive)
          if (p <= 0 || p >= 1) return null
          const buy = rand(i * 7 + 1) > 0.42
          const y0 = 400 + ((i * 3) % 7) * 70 // seven lanes, three apart from one trade to the next
          const [x, y] = quad([-70, y0], [360, y0], [pool[0] - 60, pool[1]], ease.in(p))
          const fade = 1 - prog(p, 0.8, 1)
          const c = buy ? '#12c26e' : '#ff3ea5'
          return (
            <g key={i} transform={`translate(${x} ${y}) scale(${0.6 + 0.4 * fade})`} opacity={fade}>
              <rect x={-52} y={-19} width={104} height={38} rx={19} fill="rgba(10,14,26,0.85)" stroke={c} strokeWidth="2" />
              <text x={0} y={7} textAnchor="middle" fill={c} style={{ font: '600 18px "Martian Mono Variable"' }}>
                {buy ? '▲ BUY' : '▼ SELL'}
              </text>
            </g>
          )
        })}
        {TRADES.map((arrive, i) => {
          const p = prog(t, arrive, arrive + COIN_FLIGHT)
          if (p <= 0 || p >= 1) return null
          const [x, y] = quad([pool[0] + 100, pool[1] - 40], [(pool[0] + vault[0]) / 2, pool[1] - 300], [vault[0], vault[1] - 120], ease.inOut(p))
          return <SolCoin key={i} x={x} y={y} r={16} o={1 - prog(p, 0.85, 1)} />
        })}
      </svg>
      <div className="eng-label" style={{ left: pool[0], top: pool[1] + 160 }}>
        <strong>DAMM v2 pool</strong>
        <span>{FACTS.poolFee}% fee on every trade</span>
      </div>
      <div className="eng-label" style={{ left: vault[0], top: vault[1] + 165 }}>
        <strong>Payout wallet</strong>
        <span>{FACTS.walletShort}</span>
      </div>
      <Caption t={t} scene={s} num="1" color="#8fa4ff" kicker="FEES" title={`Every trade pays a ${FACTS.poolFee}% fee`} />
      <Sub t={t} from={5.0} to={s.to}>
        The team sends SOL from the creator’s fee claims to the <b>payout wallet</b>.
      </Sub>
    </AbsoluteFill>
  )
}

// The market cap tiers, as the engine runs them: each run releases the tier's daily share over the
// day's 24 runs, so a 24th of it each hour.
const usdShort = (n) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}k`)
const TIER_ROWS = FACTS.tiers.map(({ belowUsd, dailyBps }, i, all) => {
  const label = i === 0 ? `Below ${usdShort(belowUsd)}` : belowUsd == null ? `Above ${usdShort(all[i - 1].belowUsd)}` : `${usdShort(all[i - 1].belowUsd)} to ${usdShort(belowUsd)}`
  const share = `1/${(24 * 10_000) / dailyBps}`
  return [label, i === 0 ? `${share} of the wallet each hour` : `${share} each hour`, `${(dailyBps / 2400).toFixed(2)}%`]
})

function Hourly({ t }) {
  const s = SCENES.hourly
  const o = presence(t, s)
  if (!o) return null
  const vault = [690, 600]
  const ringP = ease.out(prog(t, s.from + 0.1, s.from + 0.9))
  const sweep = sweepAt(t)
  const hand = sweep ? sweep.angle : 0
  const active = sweep ? sweep.tier : t >= SWEEPS.at(-1).to ? 2 : 0
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        <HourRing x={vault[0]} y={vault[1]} r={258} p={ringP} hand={sweep ? hand : null} color="#8fa4ff" />
        <Vault x={vault[0]} y={vault[1]} w={210} h={250} t={t} fill={0.7 - prog(t, s.from, s.to) * 0.18} glow={Math.max(...SWEEPS.map((w) => pulse(t, w.to, 0.3)))} />
        {/* the slices: one per sweep, as big as its tier, split 60/40 as they fly */}
        {SWEEPS.map((w, i) => {
          const p = prog(t, w.to, w.to + 1.2)
          if (p <= 0 || p >= 1) return null
          const size = [0.18, 0.4, 0.8][w.tier]
          const base = 34 + size * 46
          const fly = ease.in(p)
          const x0 = vault[0] + 20
          const y0 = vault[1] - 140
          const parts = [
            { c: '#12c26e', dy: -80, share: 0.6 },
            { c: '#ff3ea5', dy: 80, share: 0.4 },
          ]
          return (
            <g key={i}>
              {parts.map((part) => {
                const x = lerp(x0, 1240, fly)
                const y = lerp(y0, y0 + part.dy, ease.out(p))
                const r = base * Math.sqrt(part.share)
                return (
                  <g key={part.c} transform={`translate(${x} ${y})`} opacity={1 - prog(p, 0.75, 1)}>
                    <circle r={r + 14} fill={part.c} opacity="0.35" filter="url(#softglow)" />
                    <path d={`M0,0 L${r},0 A${r},${r} 0 0 0 ${r * Math.cos(-1.1)},${r * Math.sin(-1.1)} Z`} fill={part.c} transform={`rotate(${-20 + i * 15})`} />
                    <circle r={r * 0.55} fill={part.c} />
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <div className="eng-label" style={{ left: vault[0], top: vault[1] + 278 }}>
        <span style={{ fontSize: 22 }}>one sweep = one hour</span>
      </div>
      <div className="eng-tiers" style={{ opacity: rise(t, s.from + 0.6, 0.6), transform: `translateX(${(1 - rise(t, s.from + 0.6, 0.6)) * 60}px)` }}>
        <h3>Released each hour, by market cap</h3>
        {TIER_ROWS.map(([label, hint, pct], i) => {
          const on = i === active
          const glow = on ? 1 : 0
          return (
            <div
              key={label}
              className="eng-tier"
              style={{
                borderColor: on ? 'rgba(143,164,255,0.7)' : 'transparent',
                background: on ? 'rgba(46,75,255,0.22)' : 'rgba(255,255,255,0.03)',
                boxShadow: on ? '0 0 40px rgba(46,75,255,0.35), inset 0 0 0 1px rgba(143,164,255,0.3)' : 'none',
                opacity: 0.55 + glow * 0.45,
              }}
            >
              <p>
                {label}
                {i === 0 && <span className="eng-now">NOW</span>}
                <small>{hint}</small>
              </p>
              <b>{pct}</b>
            </div>
          )
        })}
        <p className="eng-tiers-cap">at most {FACTS.maxRunSol} SOL a run</p>
      </div>
      <Caption t={t} scene={s} num="2" color="#8fa4ff" kicker="EVERY HOUR" title="A slice of the wallet goes out" />
      <Sub t={t} from={s.from + 0.8} to={s.to}>
        One run an hour: <b>small now, more as the market cap grows.</b>
      </Sub>
    </AbsoluteFill>
  )
}

// The holders, biggest first, without the pools and the team (they are never paid). ELIGIBLE are
// over the 0.15% line; PAID, those of them whose share of the run is worth sending (timeline.js).
const PAID_KINDS = HOLDERS.filter((h) => h.kind === 'eligible' || h.kind === 'below')
const MAX_TOKENS = PAID_KINDS[0].tokens
const MIN_HOLD = (SUPPLY * FACTS.minHoldPct) / 100
const BAR = { x0: 150, x1: 1470, base: 914, max: 520 }
const barH = (tokens) => Math.max(5, BAR.max * Math.sqrt(tokens / MAX_TOKENS))
const pitch = (BAR.x1 - BAR.x0) / PAID_KINDS.length

function Holders({ t }) {
  const s = SCENES.holders
  const o = presence(t, s)
  if (!o) return null
  const [r0, r1] = HOLDERS_T.rise
  const [l0, l1] = HOLDERS_T.line
  const [b0, b1] = HOLDERS_T.beams
  const thY = BAR.base - barH(MIN_HOLD)
  const lineX = lerp(BAR.x0 - 40, BAR.x1 + 60, ease.inOut(prog(t, l0, l1)))
  const vault = [1530, 300]
  const paid = PAID.filter((_, i) => t >= beamLandsAt(i, PAID.length)).length
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        <line x1={BAR.x0 - 30} y1={BAR.base + 2} x2={BAR.x1 + 30} y2={BAR.base + 2} stroke="rgba(255,255,255,0.25)" strokeWidth="2" />
        {/* the beams of SOL to the wallets paid, by balance: thicker for bigger holders */}
        {PAID.map((h, i) => {
          const start = beamAt(i, PAID.length)
          const p = prog(t, start, start + BEAM_FLIGHT)
          if (p <= 0) return null
          const j = PAID_KINDS.indexOf(h)
          const x = BAR.x0 + j * pitch + pitch / 2
          const top = BAR.base - barH(h.tokens)
          const width = 2 + 14 * (h.tokens / ELIGIBLE[0].tokens)
          const from = [vault[0] - 30, vault[1] + 60]
          const ctrl = [lerp(from[0], x, 0.55), Math.min(from[1], top) - 95] // under the two-line title
          const to = [x, top - 6]
          const head = ease.inOut(p)
          const pts = Array.from({ length: 24 }, (_, k) => quad(from, ctrl, to, (k / 23) * head))
          const fadeOut = 1 - prog(t, start + 1.6, start + 2.4)
          const [px, py] = quad(from, ctrl, to, head)
          return (
            <g key={i} opacity={Math.max(0.25, fadeOut)}>
              <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none" stroke="#3ee592" strokeWidth={width} strokeLinecap="round" opacity="0.28" filter="url(#glow)" />
              <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none" stroke="#c9ffe4" strokeWidth={Math.max(1.5, width * 0.35)} strokeLinecap="round" opacity="0.8" />
              {p < 1 && <SolCoin x={px} y={py} r={9 + width * 0.4} />}
            </g>
          )
        })}
        {PAID_KINDS.map((h, j) => {
          const x = BAR.x0 + j * pitch + (pitch - 22) / 2
          const grow = ease.out(prog(t, r0 + (j / PAID_KINDS.length) * (r1 - r0), r0 + (j / PAID_KINDS.length) * (r1 - r0) + 0.5))
          const hgt = barH(h.tokens) * grow
          const eligible = h.kind === 'eligible'
          const on = eligible && t >= lightAt(ELIGIBLE.indexOf(h), ELIGIBLE.length)
          const dim = !eligible && t > l0 + (lineX > x ? 0 : 99)
          // a wallet whose share is too small to send stays lit, without a beam
          const k = PAID.indexOf(h)
          const flash = k < 0 ? 0 : pulse(t, beamLandsAt(k, PAID.length), 0.35)
          return (
            <g key={j}>
              {on && <rect x={x - 6} y={BAR.base - hgt - 6} width={34} height={hgt + 6} rx={10} fill="#12c26e" opacity={0.25 + flash * 0.5} filter="url(#softglow)" />}
              <rect x={x} y={BAR.base - hgt} width={22} height={hgt} rx={7} fill={on ? 'url(#barGreen)' : 'url(#barDim)'} opacity={dim ? 0.45 : 1} stroke={on ? 'rgba(220,255,236,0.7)' : 'rgba(255,255,255,0.18)'} strokeWidth="1.2" />
              {flash > 0.05 && <circle cx={x + 11} cy={BAR.base - hgt - 4} r={8 + (1 - flash) * 30} fill="none" stroke="#c9ffe4" strokeWidth={3 * flash} opacity={flash} />}
            </g>
          )
        })}
        {/* the 0.15% line */}
        {t >= l0 && (
          <g>
            <rect x={BAR.x0 - 40} y={thY - 6} width={Math.max(0, lineX - BAR.x0 + 40)} height={12} fill="#ffc21a" opacity="0.35" filter="url(#softglow)" />
            <line x1={BAR.x0 - 40} y1={thY} x2={lineX} y2={thY} stroke="#ffc21a" strokeWidth="3" strokeDasharray="14 10" />
            <circle cx={lineX} cy={thY} r="8" fill="#ffc21a" filter="url(#glow)" />
          </g>
        )}
        <Vault x={vault[0]} y={vault[1]} w={150} h={170} t={t} fill={0.62 - prog(t, b0, b1) * 0.12} glow={prog(t, b0, b0 + 0.3) * (1 - prog(t, b1, b1 + 0.5))} />
      </svg>
      {t >= l0 && (
        <div style={{ position: 'absolute', left: BAR.x1 + 86, top: thY - 30, opacity: rise(t, l1 - 0.2, 0.4), fontFamily: 'var(--mono)', fontSize: 21, color: '#ffd76a', lineHeight: 1.35 }}>
          {FACTS.minHoldPct}% of supply
          <br />
          = {MIN_HOLD / 1e6}M $QUANTP
        </div>
      )}
      <div className="eng-count" style={{ left: vault[0], top: vault[1] + 130, transform: 'translateX(-50%)', justifyItems: 'center', opacity: rise(t, b0 - 0.2, 0.4) }}>
        <span>Wallets paid</span>
        <b style={{ color: '#5cf0aa' }}>{paid}</b>
      </div>
      <div className="eng-label" style={{ left: vault[0], top: vault[1] - 132 }}>
        <span>payout wallet</span>
      </div>
      <Caption t={t} scene={s} num={`${FACTS.holdersPct}%`} color="#12c26e" kicker="TO HOLDERS" title={`Every wallet with ${FACTS.minHoldPct}% or more, once its share is worth sending`} />
      <Sub t={t} from={HOLDERS_T.beams[0]} to={s.to}>
        Paid in SOL, <b>by balance</b>. Pools and team wallets are never paid.
      </Sub>
    </AbsoluteFill>
  )
}

// The first burn's day ('17 Oct') and the round-1 tokens in it ('3.07M').
const BURN_DAY = FACTS.firstBurn.at.split(' ').slice(0, 2).join(' ')
const ROUND1 = `${(FACTS.firstBurn.fromRound1 / 1e6).toFixed(2)}M`

function Burn({ t }) {
  const s = SCENES.burn
  const o = presence(t, s)
  if (!o) return null
  const vault = [300, 600]
  const pool = [800, 600]
  const fire = [1380, 640]
  const kick = Math.max(0, ...BURN_COINS.map((a) => pulse(t, a + BURN_COIN_FLIGHT, 0.2)))
  const burnKick = Math.max(0, ...BURN_TOKENS.map((a) => pulse(t, a + BURN_TOKEN_FLIGHT, 0.25)))
  const count = ease.inOut(prog(t, BURN_T.count[0], BURN_T.count[1]))
  const supply = SUPPLY - FACTS.firstBurn.amount * count
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        {/* the fire: a pink-gold core with tongues of flame and rising embers */}
        <g transform={`translate(${fire[0]} ${fire[1]})`}>
          <circle r={230 + burnKick * 30} fill="#ff3ea5" opacity={0.2 + burnKick * 0.25} filter="url(#softglow)" />
          {Array.from({ length: 9 }, (_, i) => {
            const a = (i / 9) * TAU + t * 0.6
            const len = 120 + Math.sin(t * 6 + i * 1.7) * 30 + burnKick * 30
            return (
              <ellipse
                key={i}
                cx={Math.cos(a) * 30}
                cy={-len * 0.45 + Math.sin(a) * 18}
                rx={34 + Math.sin(t * 5 + i) * 6}
                ry={len * 0.6}
                fill="url(#fire)"
                opacity="0.55"
                transform={`rotate(${Math.sin(t * 2 + i) * 14})`}
              />
            )
          })}
          <circle r={150 + burnKick * 14} fill="url(#fireCore)" />
          {Array.from({ length: 46 }, (_, i) => {
            const life = 1.6 + rand(i * 3) * 1.4
            const age = (t * 1 + rand(i * 5) * 10) % life
            const p = age / life
            const x = (rand(i * 7) - 0.5) * 220 + Math.sin(t * 3 + i) * 14
            const y = -p * (260 + rand(i * 11) * 120)
            return <circle key={i} cx={x} cy={y} r={1.5 + rand(i * 13) * 3} fill={i % 3 ? '#ffc21a' : '#ff7fc4'} opacity={(1 - p) * 0.9} />
          })}
        </g>
        <Vault x={vault[0]} y={vault[1]} w={170} h={200} t={t} fill={0.55 - prog(t, BURN_T.coins[0], BURN_T.coins[1]) * 0.15} />
        <Pool x={pool[0]} y={pool[1]} r={120} t={t} kick={kick} />
        {BURN_COINS.map((a, i) => {
          const p = prog(t, a, a + BURN_COIN_FLIGHT)
          if (p <= 0 || p >= 1) return null
          const [x, y] = quad([vault[0] + 80, vault[1] - 30], [(vault[0] + pool[0]) / 2, vault[1] - 200], [pool[0] - 90, pool[1] - 30], ease.inOut(p))
          return <SolCoin key={i} x={x} y={y} r={15} />
        })}
        {BURN_TOKENS.map((a, i) => {
          const p = prog(t, a, a + BURN_TOKEN_FLIGHT)
          if (p <= 0) return null
          if (p >= 1) {
            // burst into embers on arrival
            const q = prog(t, a + BURN_TOKEN_FLIGHT, a + BURN_TOKEN_FLIGHT + 0.6)
            if (q >= 1) return null
            return (
              <g key={i}>
                {Array.from({ length: 8 }, (_, k) => {
                  const ang = (k / 8) * TAU + i
                  const d = ease.out(q) * 70
                  return <circle key={k} cx={fire[0] - 40 + Math.cos(ang) * d} cy={fire[1] - 20 + Math.sin(ang) * d} r={3} fill="#ffc21a" opacity={1 - q} />
                })}
              </g>
            )
          }
          const [x, y] = quad([pool[0] + 100, pool[1] - 20], [(pool[0] + fire[0]) / 2, pool[1] - 230 - rand(i) * 80], [fire[0] - 40, fire[1] - 20], ease.in(p))
          return <QCoin key={i} x={x} y={y} r={22} spin={t * 7 + i} o={1 - prog(p, 0.9, 1)} />
        })}
      </svg>
      <div className="eng-label" style={{ left: vault[0], top: vault[1] + 125 }}>
        <span>payout wallet</span>
      </div>
      <div className="eng-label" style={{ left: pool[0], top: pool[1] + 160 }}>
        <strong>Buys $QUANTP</strong>
        <span>in its DAMM v2 pool</span>
      </div>
      <div className="eng-label" style={{ left: fire[0], top: fire[1] + 175 }}>
        <strong>Burns it</strong>
        <span>in the same transaction</span>
      </div>
      <div className="eng-count" style={{ left: 1040, top: 112, opacity: rise(t, BURN_T.count[0] - 0.3, 0.4) }}>
        <span>$QUANTP supply</span>
        <b>{fmt(supply)}</b>
        <em style={{ background: 'rgba(255,62,165,0.18)', border: '1px solid rgba(255,127,196,0.5)', borderRadius: 18, lineHeight: 1.45, color: '#ffb3dc', opacity: rise(t, BURN_T.count[1] - 0.4, 0.4) }}>
          −{fmt(FACTS.firstBurn.amount)} · first engine burn, {BURN_DAY}
          <br />
          (incl. {ROUND1} from the round-1 buyback)
        </em>
      </div>
      <Caption t={t} scene={s} num={`${FACTS.buybackPct}%`} color="#ff3ea5" kicker="BUYBACK & BURN" title="Bought back. Burned." />
      <Sub t={t} from={s.from + 0.9} to={s.to}>
        Every burn lowers the supply <b>for good</b>.
      </Sub>
    </AbsoluteFill>
  )
}

function Site({ t }) {
  const s = SCENES.site
  const o = presence(t, s)
  if (!o) return null
  const win = rise(t, s.from + 0.2, 0.7, ease.outBack)
  const rows = (i) => rise(t, s.from + 0.9 + i * 0.25, 0.4)
  const facts = [
    ['⏱', 'Runs every hour, on its own'],
    ['⛓', 'Every payout and burn read from the chain'],
    ['↗', 'Each one links to Solscan'],
  ]
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <div className="eng-facts">
        {facts.map(([icon, text], i) => {
          const r = rise(t, s.from + 0.6 + i * 0.3, 0.5)
          return (
            <div key={text} className="eng-fact" style={{ opacity: r, transform: `translateX(${(1 - r) * -30}px)` }}>
              <i>{icon}</i>
              {text}
            </div>
          )
        })}
      </div>
      <div className="eng-shot" style={{ opacity: clamp01(win), transform: `translateY(${(1 - win) * 60}px) scale(${0.94 + 0.06 * win})` }}>
        <div className="eng-browser">
          <div className="eng-browser-bar">
            <i />
            <i />
            <i />
            <span>{FACTS.url}</span>
          </div>
          <div className="eng-panel">
            <div className="eng-panel-head">
              <h4>Payouts &amp; burns</h4>
              <div className="eng-seg">
                <span>Payouts</span>
                <span>Burns</span>
              </div>
            </div>
            <div className="eng-auto" style={{ opacity: rows(0) }}>
              <div className="eng-auto-head">
                <b>Automatic payouts</b>
                <em>Running hourly</em>
              </div>
              Each hour the engine wallet {FACTS.walletShort} releases {FACTS.site.hourly} of its SOL: {FACTS.holdersPct}% to wallets
              holding at least {FACTS.site.minHold} $QUANTP, by balance, and {FACTS.buybackPct}% to buy back and burn.
            </div>
            <dl className="eng-totals" style={{ opacity: rows(1), margin: 0 }}>
              {[
                ['Paid out', FACTS.site.paid],
                ['Wallets paid', FACTS.site.wallets],
                ['Wallets eligible now', FACTS.site.eligible],
                ['In the payout wallet', FACTS.site.waiting],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="eng-rows" style={{ opacity: rows(2) }}>
              <div>
                <span>Age</span>
                <span className="r">SOL</span>
                <span>&nbsp;&nbsp;Paid to</span>
                <span className="r">Tx</span>
              </div>
              {FACTS.site.rows.map((row) => (
                <div key={row.age}>
                  <span className="m">{row.age}</span>
                  <span className="r m">{row.sol}</span>
                  <span>&nbsp;&nbsp;{row.wallets} wallets</span>
                  <span className="r">{row.txs} txs ⌄</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="eng-stamp">As of {FACTS.site.at}</p>
      </div>
      <Caption t={t} scene={s} num="✓" color="#ffc21a" kicker="ALL ON-CHAIN" title="Every payout and burn, listed" />
      <Sub t={t} from={s.from + 0.7} to={s.to}>
        See them all at <b>{FACTS.url}</b>
      </Sub>
    </AbsoluteFill>
  )
}

function End({ t }) {
  const s = SCENES.end
  const o = presence(t, s, 0.4, 0.01)
  if (!o) return null
  const a = rise(t, s.from + 0.1, 0.8, ease.outBack)
  const b = rise(t, s.from + 0.5, 0.6)
  const c = rise(t, s.from + 0.9, 0.6)
  const fine = rise(t, s.from + 0.2, 0.6)
  return (
    <AbsoluteFill style={{ opacity: o }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <Defs />
        <HourRing x={960} y={470} r={430} p={1} hand={((t - s.from) / 4) * TAU} color="#8fa4ff" />
      </svg>
      <div className="eng-end">
        <Img src={staticFile('lockup-dark.svg')} style={{ opacity: clamp01(a), transform: `scale(${0.9 + 0.1 * a})` }} />
        <h2 className="eng-chrome" style={{ opacity: b, transform: `translateY(${(1 - b) * 20}px)` }}>
          $QUANTP Payout Engine
        </h2>
        <span className="eng-url" style={{ opacity: c }}>
          {FACTS.engineUrl}
        </span>
      </div>
      <p className="eng-fine" style={{ opacity: fine }}>
        Runs on Quant Pad’s server from a wallet the team funds; nothing on-chain enforces it.
        <br />
        Memecoins are extremely risky. Not financial advice.
      </p>
    </AbsoluteFill>
  )
}

export function Engine() {
  useFonts()
  const frame = useCurrentFrame()
  const t = frame / FPS
  return (
    <AbsoluteFill className="eng">
      <Backdrop t={t} />
      <Title t={t} />
      <Fees t={t} />
      <Hourly t={t} />
      <Holders t={t} />
      <Burn t={t} />
      <Site t={t} />
      <End t={t} />
      <Wipe t={t} />
      {/* on every frame, above the cuts: what the engine is, for anyone who sees only a moment */}
      <p className="eng-bug">Off-chain · team-funded · not financial advice</p>
      <Audio src={staticFile('engine-soundtrack.wav')} />
    </AbsoluteFill>
  )
}
