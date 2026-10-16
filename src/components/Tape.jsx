import { Link } from 'react-router-dom'
import { useResource } from '../lib/api.js'
import { pct } from '../lib/format.js'
import Price from './Price.js'
import { QUANTP } from '../../shared/network.mjs'
import { changeClass, marketCapText, QuantpPrice, useQuantpFigures } from './QuantpShowcase.jsx'

// $QUANTP, pinned at the tape's left end at every width. It reads /api/quantp (no store), so the
// tape still shows while the market lists are down; with no other coins to run it has the rail to
// itself and shows a little more.
function QuantpPin({ alone }) {
  const { q, f } = useQuantpFigures()
  return (
    <Link to={q.path} className="qp-pin" title={`${q.name}: Quant Pad’s own token`}>
      <img src="/brand/mark-small-dark.svg" alt="" width="16" height="16" />
      <strong>${q.symbol}</strong>
      <span className="num qp-pin-price">
        <QuantpPrice f={f} />
      </span>
      <span className={`num ${changeClass(f.change)}`}>{pct(f.change)}</span>
      {alone && (
        <span className="qp-pin-extra">
          <span>
            Market cap <b className="num">{marketCapText(f)}</b>
          </span>
          <span className="qp-pin-go">Trade on Quant Pad →</span>
        </span>
      )}
    </Link>
  )
}

// Live rail of real Quant Pad coins, after the $QUANTP pin. It sits between the header and the
// main content, so it is its own labelled region: every part of the page is then inside a
// landmark.
export default function Tape() {
  const market = useResource('/api/market?sort=trending', 30000)
  // $QUANTP has its own pin, so it does not run again among the coins
  const items = (market.data?.items || []).filter((c) => c.mint !== QUANTP.mint).slice(0, 16)
  const row = (keyPrefix, hidden) =>
    items.map((c) => (
      <Link
        key={keyPrefix + c.mint}
        to={`/coin/${c.mint}`}
        className="tape-item"
        tabIndex={hidden ? -1 : undefined}
        aria-hidden={hidden || undefined}
      >
        <strong>${c.symbol}</strong>
        <span className={`num ${c.change24h > 0 ? 'up' : c.change24h < 0 ? 'down' : ''}`}>
          {pct(c.change24h)}
        </span>
        <span className="num">
          <Price value={c.price} /> SOL
        </span>
        {c.quantum && <span className="chip chip-quantum">Quantum</span>}
      </Link>
    ))
  return (
    <section className="tape" aria-label="Trending coins">
      <div className={`tape-inner ${items.length ? '' : 'tape-alone'}`}>
        <QuantpPin alone={!items.length} />
        {items.length > 0 && (
          <div className="tape-run">
            <div className="tape-track">
              <span className="tape-label">Live</span>
              {row('a-', false)}
              <span className="tape-label" aria-hidden="true">
                Live
              </span>
              {row('b-', true)}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
