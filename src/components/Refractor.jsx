import {
  Component,
  lazy,
  memo,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Flame, LockKeyhole, UsersRound, Wallet } from 'lucide-react'
import { MODULES } from '../lib/hooks.js'
import { useTheme } from '../lib/theme.js'
import { MeteoraMark } from './Meteora.jsx'
import { supportsWebGL, useInView, usePageVisible, useReducedMotion } from '../three/support.js'
import { EXAMPLE, LOOP, T, arrival, measure, pathData, routes } from '../three/heroLayout.js'
import { BUYBACK_PCT, HOLDERS_PCT } from './quantpPayouts.js'
import { QUANTP } from '../../shared/network.mjs'

// "The Refractor": a white beam of creator fees enters the liquid-glass Q and leaves its cobalt
// tail as four coloured lines, one per hook, each lighting its readout as the pulse arrives. The
// page first paints a static version (the chrome mark and SVG lines); where WebGL works and motion
// is welcome, the live glass scene loads on demand and fades in over it once its first frame is
// drawn. CSS places everything; both versions draw their lines from the same measured anchors.
const HeroScene = lazy(() => import('../three/HeroScene.jsx'))

const ICONS = {
  creatorBps: Wallet,
  burnBps: Flame,
  entangleBps: UsersRound,
  fusionBps: LockKeyhole,
}

const same = (a, b) => a && b && JSON.stringify(a) === JSON.stringify(b)

/** A scene that throws or fails to load must not take the page with it: the static hero stays. */
class SceneGuard extends Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError?.()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

// Memoised: the home page re-renders on every data poll, and only the symbol matters here.
export default memo(function Refractor({ symbol }) {
  const stage = useRef(null)
  const reduce = useReducedMotion()
  const [theme] = useTheme()
  const inView = useInView(stage)
  const visible = usePageVisible()
  const [layout, setLayout] = useState(null)
  // decided before the first paint, so the no-WebGL loop never flashes where the scene will load;
  // a scene that fails (or loses its GPU context) hands back to that loop
  const [webgl, setWebgl] = useState(supportsWebGL)
  const [live, setLive] = useState(false)

  useLayoutEffect(() => {
    const el = stage.current
    let alive = true
    const update = () => {
      if (!alive) return
      const next = measure(el)
      setLayout((prev) => (same(prev, next) ? prev : next))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // card heights settle once the web fonts arrive
    document.fonts?.ready.then(update)
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [])

  const ready = useCallback(() => setLive(true), [])
  const fail = useCallback(() => {
    setLive(false)
    setWebgl(false)
  }, [])
  const loop = !reduce && !webgl
  // The home page labels the beam with $QUANTP, but $QUANTP did not launch through Quant Pad and
  // has no Quantum Hooks: the team's payout engine splits its fees 60/40. So with its ticker the
  // caption and the figure's name say the four readouts (which stay) are an example for coins
  // launched here, and what $QUANTP's own fees do.
  const quantp = symbol === QUANTP.symbol
  const name = quantp
    ? 'Example Quantum Hooks split for a coin launched here: creator fees enter the Q and leave as four hook lines'
    : 'Creator fees enter the Q and leave as four hook lines'

  return (
    <figure
      className={`refractor${live ? ' is-live' : ''}${loop ? ' is-loop' : ''}`}
      aria-label={name}
      style={{ '--loop': `${LOOP}s` }}
    >
      <div className="refractor-stage" ref={stage}>
        {layout && <Lines layout={layout} animate={loop} />}
        <div className="refractor-q" aria-hidden="true">
          <img src="/brand/mark.svg" alt="" />
          <span className="refractor-glint" />
        </div>
        {webgl && layout && (
          <SceneGuard onError={fail}>
            <Suspense fallback={null}>
              <HeroScene
                stage={stage}
                layout={layout}
                active={inView && visible}
                still={reduce}
                theme={theme}
                onReady={ready}
                onLost={fail}
              />
            </Suspense>
          </SceneGuard>
        )}
        <p className="refractor-feed">
          <span className="feed-mark" aria-hidden="true">
            <MeteoraMark size={16} className="meteora-mark" />
          </span>
          <span className="feed-label">Meteora creator fee</span>
          {symbol ? <strong className="num feed-symbol">${symbol}</strong> : null}
          <span className="feed-node" aria-hidden="true" />
        </p>
        <ul className="refractor-readouts">
          {MODULES.map((m, i) => {
            const Icon = ICONS[m.key]
            const pct = EXAMPLE[m.key] / 100
            return (
              <li
                key={m.key}
                className={`readout readout-${m.key.replace('Bps', '')}`}
                style={{ '--c': m.color, '--p': `${pct}%`, '--at': `${arrival(i)}s` }}
              >
                <span className="readout-node" aria-hidden="true" />
                <span className="readout-icon" aria-hidden="true">
                  <Icon size={16} strokeWidth={2.25} />
                </span>
                <span className="readout-name">{m.name}</span>
                <span className="readout-pct num">{pct}%</span>
                <span className="readout-effect">{m.short}</span>
                <span className="readout-bar" aria-hidden="true">
                  <i />
                </span>
              </li>
            )
          })}
        </ul>
      </div>
      <figcaption className="refractor-caption">
        {quantp
          ? `Example Quantum Hooks split for a coin launched here. $${QUANTP.symbol}’s own fees go ${HOLDERS_PCT}% to holders and ${BUYBACK_PCT}% to buyback and burn through the payout engine.`
          : 'Example split. Every coin sets its own at launch.'}
      </figcaption>
    </figure>
  )
})

/** The static lines: the beam and the four hook lines, with SVG pulses when there is no scene. */
function Lines({ layout, animate }) {
  const r = routes(layout)
  const beam = `${pathData(r.inbound)}${pathData(r.through).replace(/^M[^C]+/, '')}`
  const hooks = r.hooks.map(pathData)
  // a pulse runs from `from` to `to` seconds into the loop and hides the rest of it
  const span = (from, to) => ({ a: (from / LOOP).toFixed(4), b: (to / LOOP).toFixed(4) })
  return (
    <svg
      className="refractor-lines"
      viewBox={`0 0 ${layout.w} ${layout.h}`}
      width={layout.w}
      height={layout.h}
      aria-hidden="true"
    >
      <defs>
        <filter id="refractor-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <path className="line-beam-edge" d={beam} />
      <path className="line-beam-glow" d={beam} filter="url(#refractor-glow)" />
      <path className="line-beam" d={beam} />
      {hooks.map((d, i) => (
        <g key={MODULES[i].key} style={{ '--c': MODULES[i].color }}>
          <path className="line-hook-glow" d={d} filter="url(#refractor-glow)" />
          <path className="line-hook" d={d} />
        </g>
      ))}
      {animate && (
        <g>
          <Pulse d={beam} r={5} fill="#fff" {...span(0, T.exit)} />
          {hooks.map((d, i) => (
            <Pulse
              key={MODULES[i].key}
              d={d}
              r={4}
              fill={MODULES[i].color}
              {...span(T.exit + i * T.spread, arrival(i))}
            />
          ))}
        </g>
      )}
    </svg>
  )
}

function Pulse({ d, r, fill, a, b }) {
  const dur = `${LOOP}s`
  return (
    <circle r={r} style={{ fill }} filter="url(#refractor-glow)" opacity="0">
      <animateMotion
        dur={dur}
        repeatCount="indefinite"
        path={d}
        keyPoints="0;0;1;1"
        keyTimes={`0;${a};${b};1`}
        calcMode="linear"
      />
      <animate
        attributeName="opacity"
        dur={dur}
        repeatCount="indefinite"
        values="0;1;0"
        keyTimes={`0;${a};${b}`}
        calcMode="discrete"
      />
    </circle>
  )
}
