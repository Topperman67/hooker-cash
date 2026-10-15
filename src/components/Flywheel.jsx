// The fee flywheel: the 3D glass chart (rendered from ad/src/social/Flywheel.jsx into
// public/art/flywheel-*.webp) with its copy as real text. On wide cards everything is placed in
// container units over the 16:9 render, so it matches social/quantpad-flywheel.png; narrow cards
// stack the copy over a crop of the chart. Chart labels sit in a canvas that always spans the full
// render, so the same percentages place them in both layouts.
export default function Flywheel() {
  return (
    <div className="fw">
      <div className="fw-stage">
        <div className="fw-copy">
          <img className="fw-lockup" src="/brand/lockup-dark.svg" alt="Quant Pad" />
          <h2 className="fw-title">
            Every trade feeds <span className="fw-silver">the flywheel.</span>
          </h2>
          <p className="fw-lede">
            A 7% fee on every buy and sell, split two ways. Both work for the people holding the
            coin.
          </p>
          <div className="fw-rows">
            <div className="fw-row fw-holders">
              <div className="fw-pct">60%</div>
              <div>
                <h3>Paid to holders</h3>
                <p>In SOL, by a snapshot taken at a random moment every 2 hours.</p>
              </div>
            </div>
            <div className="fw-row fw-burn">
              <div className="fw-pct">40%</div>
              <div>
                <h3>Buyback &amp; burn</h3>
                <p>Buys the token on the market and burns it. Supply only shrinks.</p>
              </div>
            </div>
          </div>
          <div
            className="fw-loop"
            aria-label="Trades, then a 7% fee, then holders paid and supply burned, repeating"
          >
            <span>Trades</span>
            <i>→</i>
            <span>7% fee</span>
            <i>→</i>
            <span>Holders paid</span>
            <i>+</i>
            <span>Supply burned</span>
            <i>↻</i>
          </div>
        </div>

        <div
          className="fw-art"
          role="img"
          aria-label="Chart: a 7% fee on every trade, 60% paid to holders and 40% to buyback and burn"
        >
          <div className="fw-canvas" aria-hidden="true">
            <img
              className="fw-plate"
              src="/art/flywheel-1600.webp"
              srcSet="/art/flywheel-1600.webp 1600w, /art/flywheel-2800.webp 2800w"
              sizes="(max-width: 700px) 160vw, min(100vw, 1320px)"
              alt=""
              width="1600"
              height="900"
              loading="lazy"
              decoding="async"
            />
            <div className="fw-fee">
              <b>7%</b>
              <span>of every buy and sell</span>
            </div>
            <div className="fw-chip fw-chip-burn">
              40%<small>burn</small>
            </div>
            <div className="fw-chip fw-chip-holders">
              60%<small>holders</small>
            </div>
          </div>
        </div>

        <div className="fw-url">
          <i />
          quantpad.company
        </div>
      </div>
    </div>
  )
}
