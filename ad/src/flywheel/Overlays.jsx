// Everything typographic in the flywheel film, set in HTML over the 3D in the home page's own
// language (src/styles/flywheel.css): a silver headline, glass rows with the 60% / 40% badges, mono
// loop chips, and chart chips pinned to the scene through the film's camera. Plus grain and the
// light kisses on the big hits.
import { useCurrentFrame, staticFile } from 'remotion'
import { FPS, CUES, SUPERS, CHIPS, LOOP, URL, SPLIT, FEE } from './timeline.js'
import { HOLDERS_SLICE, BURN_SLICE, GATE, HOLDERS, polar, ROTOR } from './layout.js'
import { project } from './camera.js'
import { prog, ease, lerp } from '../anim.js'
import './film.css'

/** opacity, lift and blur for type that eases in at `from` and out at `to` */
function reveal(t, from, to, { inDur = 0.45, outDur = 0.3, lift = 24, blur = 12 } = {}) {
  const i = ease.out(prog(t, from, from + inDur))
  const o = ease.in(prog(t, to - outDur, to))
  const k = i * (1 - o)
  return { opacity: k, transform: `translateY(${(1 - i) * lift - o * lift * 0.5}px)`, filter: `blur(${(1 - k) * blur}px)` }
}

/** a label pinned to a point in the scene */
function Pin({ t, at, children, className, style }) {
  const p = project(t, at)
  if (p.behind) return null
  return (
    <div className="pin" style={{ left: p.x, top: p.y }}>
      <div className={className} style={style}>
        {children}
      </div>
    </div>
  )
}

function Opening({ t }) {
  const s = SUPERS[0]
  if (t < s.from || t >= s.to) return null
  const [a, b] = ['Every trade feeds', 'the flywheel.']
  return (
    <div className="opening">
      <div className="scrim" style={{ opacity: reveal(t, s.from - 0.3, s.to, { inDur: 0.8 }).opacity }} />
      <div style={reveal(t, s.from, s.to, { inDur: 0.6 })}>{a}</div>
      <div className="silver" style={reveal(t, s.from + 0.35, s.to, { inDur: 0.6 })}>
        {b}
      </div>
    </div>
  )
}

function Fee({ t }) {
  const c = CHIPS.fee
  if (t < c.from || t >= c.to) return null
  const st = reveal(t, c.from, c.to, { inDur: 0.5, lift: 30 })
  // the number counts up to the fee as it lands
  const n = Math.round(FEE * ease.out(prog(t, c.from, c.from + 0.6)))
  return (
    <Pin t={t} at={GATE.clone().add({ x: -1.15, y: 1.15, z: 0 })} className="fee" style={st}>
      <b>{n}%</b>
      <span>of every buy and sell</span>
    </Pin>
  )
}

const sliceTop = (s, y) => polar(s.mid, (ROTOR.inner + ROTOR.outer) / 2 + 0.2, y).add(polar(s.mid, ROTOR.gap, 0))

function SliceChips({ t, from, to }) {
  if (t < from || t >= to) return null
  const h = reveal(t, from, to, { inDur: 0.4, lift: 14, blur: 8 })
  const b = reveal(t, from + 0.15, to, { inDur: 0.4, lift: 14, blur: 8 })
  return (
    <>
      <Pin t={t} at={sliceTop(HOLDERS_SLICE, HOLDERS_SLICE.depth + 0.9)} className="chip holders" style={h}>
        {SPLIT.holders}%<small>holders</small>
      </Pin>
      <Pin t={t} at={sliceTop(BURN_SLICE, BURN_SLICE.depth + 0.9)} className="chip burn" style={b}>
        {SPLIT.burn}%<small>burn</small>
      </Pin>
    </>
  )
}

function Row({ chip, k, t, style }) {
  return (
    <div className={`row ${k}`} style={style}>
      <div className="pct">{chip.pct}</div>
      <div>
        <h3>{chip.title}</h3>
        <p>{chip.body}</p>
      </div>
    </div>
  )
}

function Card({ t, k, side = 'left' }) {
  const c = CHIPS[k]
  if (t < c.from || t >= c.to) return null
  const st = reveal(t, c.from, c.to, { inDur: 0.5, lift: 0, blur: 10 })
  const slide = (1 - ease.out(prog(t, c.from, c.from + 0.6))) * (side === 'left' ? -40 : 40)
  return (
    <div className={`card-slot ${side}`}>
      <Row chip={c} k={k} t={t} style={{ ...st, transform: `translateX(${slide}px)` }} />
    </div>
  )
}

function Snapshot({ t }) {
  const from = CUES.snapshot
  const to = CUES.snapshot + 1.6
  if (t < from || t >= to) return null
  const st = reveal(t, from, to, { inDur: 0.15, outDur: 0.4, lift: 10, blur: 6 })
  return (
    <Pin t={t} at={HOLDERS.hub.clone().add({ x: 0, y: 0.75, z: 0 })} className="tag" style={st}>
      <i /> snapshot
    </Pin>
  )
}

function Loop({ t }) {
  if (t < LOOP.from || t >= LOOP.to) return null
  const st = reveal(t, LOOP.from, LOOP.to, { inDur: 0.4, lift: 16, blur: 8 })
  // each step lights in turn on the beat, then the loop arrow
  const lit = (i) => ease.out(prog(t, LOOP.from + 0.2 + i * 0.5, LOOP.from + 0.45 + i * 0.5))
  const seps = ['→', '→', '+']
  return (
    <div className="loop-row" style={st}>
      {LOOP.steps.map((s, i) => (
        <span key={s} className="loop-step">
          <span style={{ opacity: 0.35 + 0.65 * lit(i), transform: `scale(${lerp(0.94, 1, lit(i))})` }}>{s}</span>
          {i < seps.length && <i style={{ opacity: 0.3 + 0.7 * lit(i) }}>{seps[i]}</i>}
        </span>
      ))}
      <i className="loop-turn" style={{ opacity: 0.3 + 0.7 * lit(4), transform: `rotate(${360 * ease.inOut(prog(t, LOOP.from + 2.2, LOOP.from + 3.0))}deg)` }}>
        ↻
      </i>
    </div>
  )
}

function EndCard({ t }) {
  if (t < CUES.final - 0.2) return null
  const at = CUES.final
  const lock = reveal(t, at + 0.05, 99, { inDur: 0.5, lift: 12, blur: 8 })
  const h1 = reveal(t, at + 0.2, 99, { inDur: 0.6, lift: 26 })
  const r1 = reveal(t, at + 0.75, 99, { inDur: 0.5, lift: 18 })
  const r2 = reveal(t, at + 0.95, 99, { inDur: 0.5, lift: 18 })
  const url = reveal(t, at + 1.4, 99, { inDur: 0.5, lift: 0, blur: 6 })
  const sheen = lerp(130, -30, ease.inOut(prog(t, at + 0.5, at + 1.9)))
  return (
    <>
      <div className="end">
        <img className="lockup" src={staticFile('lockup-dark.svg')} alt="" style={lock} />
        <h1 style={h1}>
          Every trade feeds
          <br />
          <b style={{ backgroundPosition: `${sheen}% 0, 0 0` }}>the flywheel.</b>
        </h1>
        <div className="rows">
          <Row chip={CHIPS.holders} k="holders" t={t} style={r1} />
          <Row chip={CHIPS.burn} k="burn" t={t} style={r2} />
        </div>
      </div>
      <div className="url" style={url}>
        <i />
        {URL}
      </div>
    </>
  )
}

function Flashes({ t }) {
  const kiss = (at, k, d = 7) => (t >= at ? Math.max(0, k * (1 - (t - at) * d)) : 0)
  const white = kiss(CUES.pour + 0.25, 0.22) + kiss(CUES.snapshot, 0.32, 6) + kiss(CUES.final, 0.3, 5)
  return white > 0 ? <div className="layer" style={{ background: '#fff', opacity: Math.min(0.5, white) }} /> : null
}

function Grain({ frame }) {
  return (
    <svg className="layer" width="1920" height="1080" style={{ mixBlendMode: 'overlay', opacity: 0.07 }}>
      <filter id="fw-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 97} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#fw-grain)" />
    </svg>
  )
}

export function Overlays() {
  const frame = useCurrentFrame()
  const t = frame / FPS
  return (
    <div className="layer fw-film">
      <Opening t={t} />
      <Fee t={t} />
      <SliceChips t={t} from={9.7} to={11.9} />
      <Card t={t} k="holders" side="right" />
      <Snapshot t={t} />
      <Card t={t} k="burn" side="right" />
      <Loop t={t} />
      <EndCard t={t} />
      <Grain frame={frame} />
      <Flashes t={t} />
    </div>
  )
}
