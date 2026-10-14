// Everything typographic sits in HTML over the 3D canvas: supers, hook chips, the holographic
// launch card, the kinetic titles and the end card. Plus film grain and the hard cuts to black.
import { useCurrentFrame, staticFile } from 'remotion'
import { FPS, HOOKS, SUPERS, TITLES, CUES, URL } from '../timeline.js'
import { prog, ease, lerp } from '../anim.js'
import './overlays.css'

/** opacity, lift and blur for text that eases in at `from` and out at `to` */
function reveal(t, from, to, { inDur = 0.4, outDur = 0.3, lift = 26, blur = 14 } = {}) {
  const i = ease.out(prog(t, from, from + inDur))
  const o = ease.in(prog(t, to - outDur, to))
  const k = i * (1 - o)
  return {
    opacity: k,
    transform: `translateY(${(1 - i) * lift - o * lift * 0.5}px)`,
    filter: `blur(${(1 - k) * blur}px)`,
  }
}

function Super({ t }) {
  const s = SUPERS[0]
  if (t < s.from || t >= s.to) return null
  return (
    <div className="super" style={{ bottom: 150, ...reveal(t, s.from, s.to, { inDur: 0.7 }) }}>
      {s.text}
    </div>
  )
}

function HookChip({ t }) {
  if (t < 8 || t >= 14) return null
  const i = Math.min(3, Math.floor((t - 8) / 1.5))
  const h = HOOKS[i]
  const style = reveal(t, h.at + 0.25, h.at + 1.5, { inDur: 0.35, outDur: 0.2, lift: 0, blur: 10 })
  const slide = (1 - ease.out(prog(t, h.at + 0.25, h.at + 0.7))) * -40
  return (
    <div className="chip" style={{ ...style, transform: `translateX(${slide}px)`, '--c': h.color }}>
      <span className="chip-index">0{i + 1}</span>
      <span className="chip-name">
        <span className="chip-dot" />
        {h.name}
      </span>
      <span className="chip-short">{h.short}</span>
    </div>
  )
}

function Card({ t }) {
  if (t < CUES.cardRise || t >= 20) return null
  const u = t - CUES.cardRise
  const rise = ease.outExpo(prog(u, 0, 0.9))
  const out = ease.in(prog(t, 19.7, 20))
  const rx = lerp(26, 7, rise) + Math.sin(u * 1.3) * 1.5
  const ry = lerp(-30, -14, rise) + Math.sin(u * 0.9) * 3
  const sheen = 20 + u * 22
  return (
    <div
      className="card-stage"
      style={{
        opacity: Math.min(1, rise * 2) * (1 - out),
        transform: `translateY(${(1 - rise) * 820}px)`,
      }}
    >
      <article className="holo" style={{ transform: `rotateX(${rx}deg) rotateY(${ry}deg)` }}>
        <div className="holo-inner">
          <header className="holo-head">
            <img src={staticFile('mark.svg')} alt="" />
            <span>Quantum Hooks</span>
          </header>
          <div className="holo-art">
            <div className="art">
              <div className="art-orb" />
              <div className="art-lines" style={{ transform: `translateX(${-30 + u * 14}px)` }} />
            </div>
          </div>
          <div className="holo-symbol">$PRISM</div>
          <div className="holo-name">Prism</div>
          <ul className="holo-hooks">
            {HOOKS.map((h, i) => {
              const fill = ease.out(prog(u, 0.5 + i * 0.12, 1.3 + i * 0.12))
              return (
                <li key={h.key} style={{ '--c': h.color }}>
                  <span>{h.name}</span>
                  <span className="holo-bar">
                    <i style={{ width: `${h.split * fill}%` }} />
                  </span>
                  <span className="num">{Math.round(h.split * fill)}%</span>
                </li>
              )
            })}
          </ul>
          <footer className="holo-foot">Example split. Every coin sets its own at launch.</footer>
        </div>
        <span className="holo-sheen" style={{ backgroundPosition: `${sheen}% ${sheen}%` }} />
      </article>
    </div>
  )
}

function Rules({ t }) {
  const s = SUPERS[1]
  if (t < s.from || t >= s.to) return null
  const [a, b] = s.text.split('. ')
  return (
    <div className="rules">
      <div style={reveal(t, s.from, s.to, { inDur: 0.5 })}>{a}.</div>
      <div style={reveal(t, s.from + 0.5, s.to, { inDur: 0.5 })}>{b}</div>
    </div>
  )
}

function Titles({ t }) {
  const title = TITLES.find((x) => t >= x.from && t < x.to)
  if (!title) return null
  const u = t - title.from
  const i = ease.outExpo(prog(u, 0, 0.35))
  const last = title === TITLES[TITLES.length - 1]
  const o = last ? 0 : ease.in(prog(t, title.to - 0.12, title.to))
  const style = {
    opacity: Math.min(1, i * 1.6) * (1 - o),
    transform: `scale(${lerp(1.14, 1, i) * lerp(1, 1.04, ease.sine(prog(u, 0, title.to - title.from)))})`,
    filter: `blur(${(1 - i) * 22 + o * 12}px)`,
    letterSpacing: `${lerp(0.08, -0.015, i)}em`,
  }
  if (title.chrome) {
    const sweep = lerp(110, -30, ease.inOut(prog(u, 0.15, 1.6)))
    return (
      <div className="title title-chrome" style={style}>
        <span style={{ backgroundPosition: `${sweep}% 0, 0 0` }}>{title.text}</span>
      </div>
    )
  }
  return (
    <div className="title" style={style}>
      {title.text}
    </div>
  )
}

function EndCard({ t }) {
  if (t < CUES.final) return null
  const cta = reveal(t, CUES.final + 1.3, 31, { inDur: 0.5, lift: 20, blur: 10 })
  const fine = reveal(t, CUES.final + 1.7, 31, { inDur: 0.6, lift: 0, blur: 6 })
  const sheen = lerp(140, -40, ease.inOut(prog(t, CUES.final + 2.0, CUES.final + 3.0)))
  return (
    <>
      <div className="cta" style={cta}>
        <div className="cta-button">
          <span className="cta-sheen" style={{ backgroundPosition: `${sheen}% 0` }} />
          <span style={{ position: 'relative' }}>Launch a coin</span>
        </div>
        {URL && <div className="cta-url">{URL}</div>}
      </div>
      <div className="fine" style={fine}>
        Memecoins are extremely risky. Only use SOL you can afford to lose.
      </div>
    </>
  )
}

function Cuts({ t }) {
  // half a beat of hard black before the final hit
  const black = t >= CUES.silence && t < CUES.final - 5 / FPS
  // a white kiss of light on the reveal hit
  const flash = t >= CUES.reveal ? Math.max(0, 0.45 * (1 - (t - CUES.reveal) * 7)) : 0
  return (
    <>
      {flash > 0 && <div className="layer" style={{ background: '#fff', opacity: flash }} />}
      {black && <div className="layer" style={{ background: '#000' }} />}
    </>
  )
}

function Grain({ frame }) {
  return (
    <svg className="layer" width="1920" height="1080" style={{ mixBlendMode: 'overlay', opacity: 0.09 }}>
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 97} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  )
}

export function Overlays() {
  const frame = useCurrentFrame()
  const t = frame / FPS
  return (
    <div className="layer">
      <Super t={t} />
      <HookChip t={t} />
      <Card t={t} />
      <Rules t={t} />
      <Titles t={t} />
      <EndCard t={t} />
      <Grain frame={frame} />
      <Cuts t={t} />
    </div>
  )
}
