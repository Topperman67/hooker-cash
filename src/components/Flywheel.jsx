import {
  Component,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { supportsWebGL, useInView, usePageVisible, useReducedMotion } from '../three/support.js'
import { CopyButton } from './UI.jsx'
import { bps, compact, short, sol } from '../lib/format.js'
import { QUANTP } from '../../shared/network.mjs'

// The live chart (three.js), fetched only when the card comes near and WebGL is there.
const FlywheelScene = lazy(() => import('../three/FlywheelScene.jsx'))

const EARNED_NOTE =
  'The creator’s share of $QUANTP’s trading fees so far, split 60/40 by the team’s stated policy. The team pays it out off-chain.'
const solText = (value) => (value == null ? '—' : sol(value, { digits: value < 10 ? 3 : 2 }))
const burnedText = (raw) =>
  raw == null || !Number.isFinite(Number(raw)) ? '—' : compact(Number(raw) / 10 ** QUANTP.decimals)

/** A scene that throws (or fails to load) leaves the still in place. */
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

// The fee flywheel: the 3D glass chart with its copy as real text. The still (public/art/
// flywheel-*.webp, rendered from ad/src/social/Flywheel.jsx) shows first and stays for reduced
// motion and browsers without WebGL; elsewhere the live scene (three/FlywheelScene.jsx) fades in
// over it once its first frame is drawn, and drives the labels and step chips in time with its
// loop. On wide cards everything is placed in container units over the 16:9 frame, so it matches
// social/quantpad-flywheel.png; narrow cards stack the copy over a crop of the chart. Chart labels
// sit in a box that always spans the full frame, so the same percentages place them in both
// layouts. Memoised: the home page re-renders on every data poll, and this card takes only
// primitives.
//
// It is $QUANTP's flywheel, with the fee its pool really charges (feeBps from /api/quantp: 2% on
// the bonding curve, 5% in the DAMM v2 pool after graduation). The 60/40 split is the team's
// stated policy for the creator's share of that fee, paid out off-chain, so the live figures say
// "earned", never "paid". Every figure is null while /api/quantp is loading or down.
function Flywheel({
  feeBps = null,
  migrated = false,
  holdersSol = null,
  buybackSol = null,
  burned = null,
}) {
  const stage = useRef(null)
  const art = useRef(null)
  const frame = useRef(null)
  const fee = useRef(null)
  const burn = useRef(null)
  const holders = useRef(null)
  const loop = useRef(null)
  const rowHolders = useRef(null)
  const rowBurn = useRef(null)
  const dom = useMemo(
    () => ({ stage, art, frame, fee, burn, holders, loop, rowHolders, rowBurn }),
    [],
  )

  const reduce = useReducedMotion()
  const [webgl] = useState(() => supportsWebGL())
  const soon = useInView(stage, '120% 0px')
  const near = useInView(stage, '200px')
  const visible = usePageVisible()
  const [load, setLoad] = useState(false)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = webgl && !reduce && !failed
  useEffect(() => {
    if (live && soon) setLoad(true)
  }, [live, soon])
  const run = live && load
  useEffect(() => {
    if (!run) setReady(false)
  }, [run])
  const onReady = useCallback(() => setReady(true), [])
  const onFail = useCallback(() => setFailed(true), [])

  const feeText = feeBps == null ? '' : bps(feeBps)
  const feePhrase = feeBps == null ? 'a fee' : `a ${feeText} fee`
  const lede =
    feeBps == null
      ? `2% of every $${QUANTP.symbol} trade on the curve, 5% after graduation. The team pays out the creator’s share:`
      : migrated
        ? `A ${feeText} fee on every $${QUANTP.symbol} trade in its DAMM v2 pool. The team pays out the creator’s share:`
        : `A ${feeText} fee on every $${QUANTP.symbol} trade, ${bps(QUANTP.postGradFeeBps)} after graduation. The team pays out the creator’s share:`

  return (
    <div className="fw">
      <div className="fw-stage" ref={stage}>
        <div className="fw-copy">
          <p className="fw-kicker">
            <img className="fw-lockup" src="/brand/lockup-dark.svg" alt="Quant Pad" />
            <span className="fw-tag">${QUANTP.symbol}</span>
          </p>
          <h2 className="fw-title">
            Every trade feeds <span className="fw-silver">the flywheel.</span>
          </h2>
          <p className="fw-lede">{lede}</p>
          <div className="fw-rows">
            <div className="fw-row fw-holders" ref={rowHolders}>
              <i className="fw-row-glow" aria-hidden="true" />
              <div className="fw-pct">60%</div>
              <div>
                <h3>To holders</h3>
                <p>In SOL, by each wallet’s average balance over time held.</p>
                <p className="fw-earned" title={EARNED_NOTE}>
                  <b>{solText(holdersSol)}</b> earned so far
                </p>
              </div>
            </div>
            <div className="fw-row fw-burn" ref={rowBurn}>
              <i className="fw-row-glow" aria-hidden="true" />
              <div className="fw-pct">40%</div>
              <div>
                <h3>Buyback &amp; burn</h3>
                <p>Buys ${QUANTP.symbol} on the market and burns it.</p>
                <p className="fw-earned" title={EARNED_NOTE}>
                  <b>{solText(buybackSol)}</b> earned · <b>{burnedText(burned)}</b> burned
                </p>
              </div>
            </div>
          </div>
          <div
            className="fw-loop"
            ref={loop}
            role="img"
            aria-label={`Trades, then ${feePhrase}, then holders earn SOL and supply is burned, repeating`}
          >
            <span className="fw-step-trades">Trades</span>
            <i>→</i>
            <span className="fw-step-fee">{feeBps == null ? 'Fee' : `${feeText} fee`}</span>
            <i>→</i>
            <span className="fw-step-holders">Holders earn</span>
            <i>+</i>
            <span className="fw-step-burn">Supply burned</span>
            <i className="fw-step-turn">↻</i>
          </div>
        </div>

        <div
          className="fw-art"
          ref={art}
          role="img"
          aria-label={`Chart: ${feePhrase} on every $${QUANTP.symbol} trade; the creator’s share goes 60% to holders and 40% to buyback and burn`}
          data-live={run && ready ? '' : undefined}
        >
          <div className="fw-canvas" ref={frame} aria-hidden="true">
            <img
              className="fw-plate"
              src="/art/flywheel-1600.webp"
              srcSet="/art/flywheel-1600.webp 1600w, /art/flywheel-2800.webp 2800w"
              sizes="(max-width: 1024px) 160vw, min(100vw, 1320px)"
              alt=""
              width="1600"
              height="900"
              loading="lazy"
              decoding="async"
            />
            {run && (
              <SceneGuard onError={onFail}>
                <Suspense fallback={null}>
                  <FlywheelScene
                    active={near && visible}
                    dom={dom}
                    onReady={onReady}
                    onLost={onFail}
                  />
                </Suspense>
              </SceneGuard>
            )}
            <div className="fw-fee" ref={fee}>
              <i className="fw-fee-glow" />
              <b>{feeBps == null ? '—' : feeText}</b>
              <span>of every buy and sell</span>
            </div>
            <div className="fw-chip fw-chip-burn" ref={burn}>
              40%<small>burn</small>
            </div>
            <div className="fw-chip fw-chip-holders" ref={holders}>
              60%<small>holders</small>
            </div>
          </div>
        </div>

        <div className="fw-url">
          <i />
          <span>
            ${QUANTP.symbol} · <span className="fw-url-ca">{short(QUANTP.mint, 6, 6)}</span>
          </span>
          <CopyButton value={QUANTP.mint} label={`Copy the ${QUANTP.symbol} contract address`} />
        </div>
      </div>
    </div>
  )
}

export default memo(Flywheel)
