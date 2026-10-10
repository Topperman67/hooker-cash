import { Link } from 'react-router-dom'
import { useResource } from '../lib/api.js'
import { pct } from '../lib/format.js'
import Price from './Price.js'

// Live rail of real Quant Pad coins. Hidden until there is something to show. It sits between the
// header and the main content, so it is its own labelled region: every part of the page is then
// inside a landmark.
export default function Tape() {
  const market = useResource('/api/market?sort=trending', 30000)
  const items = (market.data?.items || []).slice(0, 16)
  if (!items.length) return null
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
      <div className="tape-track">
        <span className="tape-label">Live</span>
        {row('a-', false)}
        <span className="tape-label" aria-hidden="true">
          Live
        </span>
        {row('b-', true)}
      </div>
    </section>
  )
}
