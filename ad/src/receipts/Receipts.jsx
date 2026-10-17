// "The receipts": the $QUANTP payout engine's first day as a printed log, in 30 seconds. Every hour
// is a line on a thermal receipt, from the real runs (runs.js); the rules are the engine's
// (shared/network.mjs). A different look from the engine film: warm paper, black ink, oversized
// type, stamps, and a page that burns away. Everything is a function of time (anim.js).
import { AbsoluteFill, Audio, Img, staticFile, useCurrentFrame } from 'remotion'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import { useFonts } from '../fonts.js'
import { ease, lerp, prog, rand } from '../anim.js'
import { BEAT, BURN_T, END_T, FACTS, FPS, RECEIPT_T, RULE_T, SCALE_T, SCENES, TITLE_T } from './timeline.js'
import './receipts.css'

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const sol = (lamports, digits = 5) => (lamports / 1e9).toFixed(digits)
const within = (t, s) => t >= s.from && t < s.to
/** 0 → 1 a moment after `at`: the snap of something landing on the beat */
const land = (t, at, d = 0.14) => ease.out(prog(t, at, at + d))
const RUNS = FACTS.runs
const INK = '#121316'
const PAPER = '#ece7dc'

// Everything that hits hard shakes the page a little.
const IMPACTS = [TITLE_T.stamp, RECEIPT_T.stamp, BURN_T.paper[0], BURN_T.supply]
function shake(t) {
  let e = 0
  for (const at of IMPACTS) if (t >= at) e += Math.exp(-(t - at) / 0.07)
  return [Math.sin(t * 97) * 9 * e, Math.cos(t * 83) * 7 * e]
}

/** film grain and a soft vignette over everything */
function Grain({ frame, dark }) {
  return (
    <svg className="rc-layer" width="1080" height="1080" style={{ mixBlendMode: dark ? 'screen' : 'multiply', pointerEvents: 'none' }}>
      <filter id="rc-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.floor(frame / 2) % 60} />
        <feColorMatrix values={dark ? '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0' : '0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.2  0 0 0 0.16 0'} />
      </filter>
      <rect width="1080" height="1080" filter="url(#rc-grain)" />
      <radialGradient id="rc-vig" cx="50%" cy="48%" r="75%">
        <stop offset="0.6" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity={dark ? 0.5 : 0.16} />
      </radialGradient>
      <rect width="1080" height="1080" fill="url(#rc-vig)" />
    </svg>
  )
}

/** the document around every scene: a ruled frame and its labels; the dot pulses on the beat */
function Chrome({ t }) {
  const pulse = Math.exp(-(t % BEAT) / 0.12)
  return (
    <>
      <div className="rc-frame" />
      <div className="rc-meta top">
        <span>Quant Pad · Payout engine log</span>
        <span>{FACTS.date} · UTC</span>
      </div>
      <div className="rc-meta bottom">
        <span className="rc-live">
          <i style={{ opacity: 0.35 + pulse * 0.65 }} /> Live on Solana
        </span>
        <span>$QUANTP · No. 001</span>
      </div>
    </>
  )
}

/** an ink stamp: speckled, rotated, slammed down at `at` */
function Stamp({ t, at, x, y, rot, color, big, small, w = 360, h = 190 }) {
  if (t < at) return null
  const p = land(t, at, 0.11)
  const s = lerp(1.9, 1, p)
  return (
    <svg className="rc-layer" width="1080" height="1080" style={{ pointerEvents: 'none' }}>
      <defs>
        <filter id={`ink-${at}`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" seed={Math.round(at * 10)} result="n" />
          <feColorMatrix in="n" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.55" result="m" />
          <feComposite in="SourceGraphic" in2="m" operator="in" />
        </filter>
      </defs>
      <g transform={`translate(${x} ${y}) rotate(${rot}) scale(${s})`} opacity={p * 0.92} filter={`url(#ink-${at})`}>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="18" fill="none" stroke={color} strokeWidth="9" />
        <rect x={-w / 2 + 14} y={-h / 2 + 14} width={w - 28} height={h - 28} rx="10" fill="none" stroke={color} strokeWidth="3" />
        <text x="0" y={small ? 8 : 26} textAnchor="middle" fill={color} style={{ font: `900 ${small ? 92 : 104}px "Hubot Sans Variable"`, fontStretch: '112%', letterSpacing: '-0.03em' }}>
          {big}
        </text>
        {small && (
          <text x="0" y="58" textAnchor="middle" fill={color} style={{ font: '700 24px "Martian Mono Variable"', letterSpacing: '0.12em' }}>
            {small}
          </text>
        )}
      </g>
    </svg>
  )
}

// ---- 1. title: EVERY / SINGLE / HOUR., then 16/16 ------------------------------------------------

function Title({ t }) {
  if (!within(t, SCENES.title)) return null
  const words = ['EVERY', 'SINGLE', 'HOUR.']
  const line = '$QUANTP payout engine — day one'
  const typed = line.slice(0, Math.max(0, Math.floor((t - TITLE_T.line) * 42)))
  return (
    <AbsoluteFill>
      {words.map((w, i) => {
        const at = TITLE_T.words[i]
        if (t < at) return null
        const p = land(t, at)
        return (
          <div key={w} style={{ position: 'absolute', left: 78, top: 128 + i * 186, transform: `scale(${1 + 0.3 * (1 - p)})`, transformOrigin: 'left center' }}>
            {i === 2 && (
              <div
                className="rc-hl"
                style={{ left: -16, right: -22, top: 30, height: 142, background: 'var(--yellow)', transform: `rotate(-1.4deg) scaleX(${land(t, at + 0.06, 0.26)})` }}
              />
            )}
            <h1 className="rc-giant" style={{ position: 'relative', fontSize: 182 }}>
              {w}
            </h1>
          </div>
        )
      })}
      {t >= TITLE_T.line && (
        <div className="rc-mono" style={{ left: 84, top: 748, fontSize: 26 }}>
          {typed}
          <span style={{ opacity: Math.floor(t * 4) % 2 ? 0 : 1 }}>▌</span>
        </div>
      )}
      <Stamp t={t} at={TITLE_T.stamp} x={812} y={880} rot={-9} color="#e3157f" big="16 / 16" small="HOURS PAID" w={420} h={200} />
    </AbsoluteFill>
  )
}

// ---- 2. the rule: 0.15% / 60% / 40% ------------------------------------------------------------

function Rule({ t }) {
  if (!within(t, SCENES.rule)) return null
  const rows = [
    {
      num: `${FACTS.minHoldPct}%`,
      color: 'var(--yellow)',
      cap: 'Hold at least this much of the supply and you are in.',
      small: `${FACTS.minHoldTokens / 1e6}M $QUANTP`,
    },
    {
      num: `${FACTS.holdersPct}%`,
      color: 'var(--green)',
      cap: 'of every hourly slice goes to holders, in SOL.',
      small: 'split by balance',
    },
    {
      num: `${FACTS.buybackPct}%`,
      color: 'var(--pink)',
      cap: 'buys $QUANTP back from its pool and burns it.',
      small: 'in the same transaction',
    },
  ]
  return (
    <AbsoluteFill>
      <div className="rc-kicker">
        <b /> The rule
      </div>
      {rows.map((r, i) => {
        const at = RULE_T.rows[i]
        if (t < at) return null
        const p = land(t, at, 0.2)
        const c = ease.out(prog(t, at + 0.1, at + 0.4))
        return (
          <div key={r.num} className="rc-row" style={{ top: 150 + i * 252, height: 230 }}>
            <div className="rc-num" style={{ transform: `translateY(${(1 - p) * 50}px)` }}>
              <em style={{ background: r.color, transform: `scaleX(${land(t, at, 0.18)})` }} />
              <span>{r.num}</span>
            </div>
            <div className="rc-cap" style={{ opacity: c, transform: `translateX(${(1 - c) * 30}px)` }}>
              {r.cap}
              <small>{r.small}</small>
            </div>
          </div>
        )
      })}
      {t >= RULE_T.note && (
        <div className="rc-mono" style={{ left: 80, top: 938, fontSize: 20, opacity: land(t, RULE_T.note, 0.2) }}>
          Automatic · on-chain · every UTC hour
        </div>
      )}
    </AbsoluteFill>
  )
}

// ---- 3. the receipt: one line per hourly run ----------------------------------------------------

const HEADER_H = 150
const ENTRY_H = 66
const TOTAL_H = 168
const THANKS_H = 64
const SLOT = 956 // where the paper leaves the printer
/** where each printed thing sits on the slip, and when it prints */
const ITEMS = [
  { at: RECEIPT_T.header, h: HEADER_H },
  ...RUNS.map((_, i) => ({ at: RECEIPT_T.runs[i], h: ENTRY_H })),
  { at: RECEIPT_T.total, h: TOTAL_H },
  { at: RECEIPT_T.total + BEAT, h: THANKS_H },
]

function Counter({ label, value, small, children }) {
  return (
    <div className="rc-count">
      <span>{label}</span>
      <b>{value}</b>
      {children}
      {small && <small>{small}</small>}
    </div>
  )
}

function Receipt({ t }) {
  if (!within(t, SCENES.receipt)) return null
  // the paper advances a little each time a line prints
  const shown = ITEMS.reduce((h, it) => h + it.h * ease.out(prog(t, it.at, it.at + 0.12)), 0)
  const printed = RECEIPT_T.runs.filter((at) => t >= at).length
  const last = printed ? RUNS[printed - 1] : null
  // counters ease from the previous run's totals to this one's
  const tween = (f) => {
    if (!printed) return 0
    const at = RECEIPT_T.runs[printed - 1]
    const before = RUNS.slice(0, printed - 1).reduce((s, r) => s + f(r), 0)
    return before + f(RUNS[printed - 1]) * ease.out(prog(t, at, at + 0.25))
  }
  const paid = tween((r) => r.lamports)
  const burned = printed === RUNS.length && t >= RECEIPT_T.total ? FACTS.totals.burned : tween((r) => r.burned)
  const totalPaid = RUNS.reduce((s, r) => s + r.lamports, 0)
  const maxWallets = Math.max(...RUNS.map((r) => r.wallets))
  const enter = land(t, SCENES.receipt.from, 0.3)
  return (
    <AbsoluteFill>
      <div className="rc-layer" style={{ inset: 42, overflow: 'hidden' }}>
        <div className="rc-slip" style={{ top: SLOT - 42 - shown, height: shown + 30, left: 34, overflow: 'hidden' }}>
          <div className="rc-slip-in">
            <div style={{ height: HEADER_H - 26 }}>
              <h4>QUANT PAD · PAYOUT ENGINE</h4>
              <div className="sub">$QUANTP · {FACTS.date} · UTC</div>
              <div className="sub">wallet GLAn…FAvn · solscan.io</div>
              <div className="rc-rule" />
            </div>
            {RUNS.map((r, i) => {
              const at = RECEIPT_T.runs[i]
              const ink = prog(t, at, at + 0.1)
              return (
                <div key={r.at} className="rc-entry" style={{ opacity: ink, clipPath: `inset(0 ${(1 - ink) * 100}% 0 0)` }}>
                  <div className="l1">
                    <span>
                      {r.at} ✓ {r.wallets} wallets
                    </span>
                    <span>{sol(r.lamports)} SOL</span>
                  </div>
                  <div className="l2">
                    <span>tx {r.tx}</span>
                    {r.burned ? <span className="burn">BURN {fmt(r.burned)}</span> : <span>—</span>}
                  </div>
                </div>
              )
            })}
            <div className="rc-total" style={{ height: TOTAL_H, opacity: t >= RECEIPT_T.total ? 1 : 0 }}>
              <div className="rc-rule" />
              <div>
                <span>RUNS</span>
                <span>{RUNS.length} / {RUNS.length}</span>
              </div>
              <div>
                <span>TO HOLDERS</span>
                <span>{sol(totalPaid, 4)} SOL</span>
              </div>
              <div style={{ color: 'var(--pink)' }}>
                <span>BURNED</span>
                <span>{fmt(FACTS.totals.burned)}</span>
              </div>
              <div className="rc-rule" />
            </div>
            <div className="rc-thanks" style={{ opacity: t >= RECEIPT_T.total + BEAT ? 1 : 0 }}>
              *** THANK YOU, HOLDERS ***
            </div>
          </div>
        </div>
      </div>
      <div className="rc-printer" style={{ top: SLOT - 8 }}>
        <i style={{ opacity: 0.4 + 0.6 * Math.exp(-(t - (RECEIPT_T.runs.findLast((a) => t >= a) ?? 0)) / 0.15) }} />
      </div>
      <div className="rc-counters" style={{ opacity: enter, transform: `translateX(${(1 - enter) * 40}px)` }}>
        <Counter label="Hours run" value={printed} small={printed === RUNS.length ? 'none missed · since 06:00 utc' : 'since 06:00 utc'} />
        <Counter label="Wallets paid this hour" value={last ? last.wallets : '—'}>
          <svg width="360" height="46" style={{ display: 'block', marginTop: 8 }}>
            {RUNS.map((r, i) => {
              const h = 6 + (40 * r.wallets) / maxWallets
              return <rect key={r.at} x={i * 22.5} y={46 - h} width="16" height={h} rx="2" fill={i < printed ? (i === printed - 1 ? 'var(--green)' : INK) : 'rgba(18,19,22,0.12)'} />
            })}
          </svg>
        </Counter>
        <Counter label="SOL to holders" value={sol(paid, 4)} small={`in ${printed} hourly runs`} />
        <Counter label="$QUANTP burned" value={fmt(burned)} small="bought back, then burned" />
      </div>
      <Stamp t={t} at={RECEIPT_T.stamp} x={330} y={540} rot={8} color="#0a8f4f" big="PAID" w={330} h={160} />
    </AbsoluteFill>
  )
}

// ---- 4. the scale: the hourly share grows with the market cap ------------------------------------

const CH = { x0: 100, x1: 980, y0: 790, y1: 290 }
const mcX = (usd) => CH.x0 + ((Math.log10(usd) - 3) / 4) * (CH.x1 - CH.x0) // $1K … $10M
const STEP_COLORS = ['var(--yellow)', 'var(--green)', 'var(--blue)']

function Scale({ t }) {
  if (!within(t, SCENES.scale)) return null
  const tiers = FACTS.tiers
  const [m0, m1] = SCALE_T.marker
  const mp = ease.inOut(prog(t, m0, m1))
  const mc = 10 ** lerp(Math.log10(FACTS.engine.marketCapMorningUsd), Math.log10(FACTS.engine.marketCapUsd), mp)
  const mx = mcX(mc)
  const ghost = mcX(FACTS.engine.marketCapMorningUsd)
  const k = (usd) => (usd >= 1e6 ? `$${usd / 1e6}M` : `$${Math.round(usd / 1e3)}K`)
  return (
    <AbsoluteFill>
      <div className="rc-kicker">
        <b /> It scales with the market cap
      </div>
      <div className="rc-mono" style={{ left: 80, top: 150, fontSize: 18, color: 'var(--ink-2)' }}>
        Share of the payout wallet released every hour
      </div>
      <svg className="rc-layer" width="1080" height="1080">
        {tiers.map((tier, i) => {
          const from = i === 0 ? 1e3 : tiers[i - 1].belowUsd
          const to = tier.belowUsd ?? 1e7
          const hourly = tier.dailyBps / 24 / 100 // percent of the wallet each hour
          const top = CH.y0 - (CH.y0 - CH.y1) * (hourly / 4.5)
          const g = land(t, SCALE_T.steps[i], 0.22)
          const x = mcX(from)
          const w = mcX(to) - x
          return (
            <g key={tier.dailyBps}>
              <rect x={x} y={CH.y0 - (CH.y0 - top) * g} width={w} height={(CH.y0 - top) * g} fill={STEP_COLORS[i]} stroke={INK} strokeWidth="3" />
              <text x={x + 18} y={CH.y0 - top > 130 ? top + 62 : top - 46} opacity={g} fill={i === 2 ? '#fff' : INK} style={{ font: '900 50px "Hubot Sans Variable"', fontStretch: '112%', letterSpacing: '-0.03em' }}>
                {hourly.toFixed(2)}%
              </text>
              <text x={x + 20} y={CH.y0 - top > 130 ? top + 92 : top - 16} opacity={g} fill={i === 2 ? '#fff' : INK} style={{ font: '600 15px "Martian Mono Variable"', letterSpacing: '0.06em' }}>
                {i === 0 ? `UNDER ${k(to)}` : tier.belowUsd ? `${k(from)} – ${k(to)}` : `OVER ${k(from)}`}
              </text>
            </g>
          )
        })}
        <line x1={CH.x0} y1={CH.y0} x2={CH.x1} y2={CH.y0} stroke={INK} strokeWidth="4" />
        {[1e3, 1e4, 1e5, 1e6, 1e7].map((v) => (
          <g key={v}>
            <line x1={mcX(v)} y1={CH.y0} x2={mcX(v)} y2={CH.y0 + 12} stroke={INK} strokeWidth="3" />
            <text x={mcX(v)} y={CH.y0 + 42} textAnchor="middle" fill={INK} style={{ font: '600 19px "Martian Mono Variable"' }}>
              {k(v)}
            </text>
          </g>
        ))}
        {t >= m0 && (
          <g>
            <line x1={ghost} y1={CH.y1 - 24} x2={ghost} y2={CH.y0} stroke={INK} strokeWidth="2" strokeDasharray="6 8" opacity={0.45 * mp} />
            <line x1={mx} y1={CH.y1 - 24} x2={mx} y2={CH.y0} stroke={INK} strokeWidth="4" />
            <circle cx={mx} cy={CH.y0} r="10" fill="var(--pink)" stroke={INK} strokeWidth="3" />
          </g>
        )}
      </svg>
      {t >= m0 && (
        <div
          className="rc-mono"
          style={{
            left: Math.min(mx - 20, 660),
            top: CH.y1 - 80,
            fontSize: 20,
            padding: '10px 16px',
            background: INK,
            color: PAPER,
            borderRadius: 10,
            whiteSpace: 'nowrap',
          }}
        >
          {mp < 1 ? 'Market cap' : 'Now'} ${fmt(mc)}
          <span style={{ color: 'var(--pink)' }}>{mp >= 1 ? ` · ×${(FACTS.engine.marketCapUsd / FACTS.engine.marketCapMorningUsd).toFixed(1)} since this morning` : ''}</span>
        </div>
      )}
      {t >= SCALE_T.line && (
        <h2 className="rc-giant" style={{ left: 80, top: 884, fontSize: 50, fontStretch: '100%', opacity: land(t, SCALE_T.line, 0.15), transform: `translateY(${(1 - land(t, SCALE_T.line, 0.2)) * 20}px)` }}>
          Small now. Bigger as it grows.
        </h2>
      )}
    </AbsoluteFill>
  )
}

// ---- 5. the burn: the page burns away; the count runs up -----------------------------------------

function Burn({ t, frame }) {
  if (!within(t, SCENES.burn)) return null
  const [c0, c1] = BURN_T.count
  const n = FACTS.totals.burned * ease.out(prog(t, c0, c1))
  const s = land(t, BURN_T.supply, 0.2)
  return (
    <AbsoluteFill className="rc-black">
      {/* embers */}
      <svg className="rc-layer" width="1080" height="1080">
        {Array.from({ length: 70 }, (_, i) => {
          const life = 1.4 + rand(i * 3) * 1.6
          const age = (t - SCENES.burn.from + rand(i * 5) * 4) % life
          const p = age / life
          const x = rand(i * 7) * 1080 + Math.sin(t * 2.3 + i) * 18
          const y = 1100 - p * (500 + rand(i * 11) * 600)
          return <circle key={i} cx={x} cy={y} r={1.5 + rand(i * 13) * 3.5} fill={i % 3 ? '#ffb23a' : '#ff3ea5'} opacity={(1 - p) * 0.85} />
        })}
      </svg>
      <Chrome t={t} />
      <div className="rc-mono" style={{ left: 0, right: 0, top: 250, textAlign: 'center', fontSize: 22, letterSpacing: '0.14em' }}>
        Bought back and burned · day one
      </div>
      <div
        className="rc-burned"
        style={{ top: 310, fontFamily: 'var(--display)', fontWeight: 900, fontStretch: '112%', fontSize: 168, letterSpacing: '-0.05em', color: 'var(--pink)', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 60px rgba(255,62,165,0.45)' }}
      >
        {fmt(n)}
      </div>
      <div className="rc-burned" style={{ top: 500, fontFamily: 'var(--display)', fontWeight: 900, fontStretch: '125%', fontSize: 92, letterSpacing: '-0.04em' }}>
        $QUANTP
      </div>
      <div className="rc-burned" style={{ top: 640, fontFamily: 'var(--display)', fontWeight: 800, fontSize: 46, opacity: land(t, c1 - 0.3, 0.3) }}>
        Gone for good.
      </div>
      {t >= BURN_T.supply && (
        <div className="rc-mono" style={{ left: 0, right: 0, top: 790, textAlign: 'center', fontSize: 28, opacity: s, transform: `scale(${1 + 0.15 * (1 - s)})` }}>
          Supply <s style={{ opacity: 0.55 }}>1,000,000,000</s> → <b style={{ color: 'var(--yellow)' }}>{fmt(FACTS.totals.supply)}</b>
        </div>
      )}
      <PaperBurn t={t} frame={frame} />
    </AbsoluteFill>
  )
}

/** the paper of the scene before, burning away from the bottom with a glowing edge */
function PaperBurn({ t, frame }) {
  const [b0, b1] = BURN_T.paper
  if (t > b1 + 0.05) return null
  const p = ease.in(prog(t, b0, b1))
  const front = lerp(1150, -120, p)
  const pts = Array.from({ length: 56 }, (_, i) => {
    const x = (i / 55) * 1080
    const y = front + Math.sin(i * 1.7 + t * 9) * 16 + (rand(i * 19) - 0.5) * 70
    return [x, y]
  })
  const edge = pts.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <svg className="rc-layer" width="1080" height="1080">
      <defs>
        <clipPath id="rc-paper-left">
          <polygon points={`0,0 1080,0 ${[...pts].reverse().map(([x, y]) => `${x},${y}`).join(' ')}`} />
        </clipPath>
        <filter id="rc-flame" x="-10%" y="-50%" width="120%" height="200%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>
      <g clipPath="url(#rc-paper-left)">
        <rect width="1080" height="1080" fill={PAPER} />
        <rect x="40" y="40" width="1000" height="1000" fill="none" stroke={INK} strokeWidth="2" />
      </g>
      <polyline points={edge} fill="none" stroke="#ff7a1a" strokeWidth="26" filter="url(#rc-flame)" opacity="0.95" />
      <polyline points={edge} fill="none" stroke="#ffd23a" strokeWidth="6" opacity="0.95" />
      <polyline points={edge} fill="none" stroke="#3a1a08" strokeWidth="3" transform="translate(0 -10)" opacity="0.6" />
    </svg>
  )
}

// ---- 6. the end ---------------------------------------------------------------------------------

function End({ t }) {
  if (!within(t, { from: SCENES.end.from, to: SCENES.end.to + 1 })) return null
  const lines = ['Every payout.', 'Every burn.', 'Listed.']
  const u = land(t, END_T.url, 0.2)
  const l = land(t, END_T.lockup, 0.3)
  return (
    <AbsoluteFill>
      {lines.map((w, i) => {
        const at = END_T.lines[i]
        if (t < at) return null
        const p = land(t, at)
        return (
          <div key={w} style={{ position: 'absolute', left: 78, top: 130 + i * 128, transform: `scale(${1 + 0.22 * (1 - p)})`, transformOrigin: 'left center' }}>
            {i === 2 && <div className="rc-hl" style={{ left: -14, right: -18, top: 6, height: 112, background: 'var(--blue)', transform: `rotate(-1deg) scaleX(${land(t, at + 0.05, 0.24)})` }} />}
            <h2 className="rc-giant" style={{ position: 'relative', fontSize: 110, fontStretch: '100%', color: i === 2 ? '#fff' : undefined }}>
              {w}
            </h2>
          </div>
        )
      })}
      {t >= END_T.url && (
        <div className="rc-url" style={{ top: 580, opacity: u, transform: `translateY(${(1 - u) * 24}px)` }}>
          {FACTS.url} <span aria-hidden="true">→</span>
        </div>
      )}
      {t >= END_T.lockup && <Img src={staticFile('lockup-light.svg')} style={{ position: 'absolute', left: 80, top: 730, width: 420, opacity: l }} />}
      <div className="rc-fine" style={{ opacity: land(t, END_T.lockup, 0.4) }}>
        Snapshot {FACTS.takenAt.replace('T', ' ')}. The engine runs on Quant Pad’s server from a wallet the team funds; nothing on-chain enforces it. Memecoins are extremely risky. Not financial advice.
      </div>
    </AbsoluteFill>
  )
}

export function Receipts() {
  useFonts()
  const frame = useCurrentFrame()
  const t = frame / FPS
  const dark = within(t, { from: BURN_T.paper[1], to: SCENES.burn.to })
  const [dx, dy] = shake(t)
  return (
    <AbsoluteFill className="rc">
      <AbsoluteFill style={{ transform: `translate(${dx}px, ${dy}px)` }}>
        {!within(t, SCENES.burn) && <Chrome t={t} />}
        <Title t={t} />
        <Rule t={t} />
        <Receipt t={t} />
        <Scale t={t} />
        <Burn t={t} frame={frame} />
        <End t={t} />
      </AbsoluteFill>
      <Grain frame={frame} dark={dark} />
      <Audio src={staticFile('receipts-soundtrack.wav')} />
    </AbsoluteFill>
  )
}
