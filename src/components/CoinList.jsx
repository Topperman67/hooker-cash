import { Link, useNavigate } from 'react-router-dom'
import { CoinAvatar, CurveProgress } from './UI.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { ago, pct, price, sol, usd } from '../lib/format.js'

function Badges({ coin }) {
  return (
    <>
      {coin.quantum && <span className="chip chip-quantum">Quantum</span>}
      {coin.complete && <span className="chip chip-grad">Graduated</span>}
    </>
  )
}

export function CoinCard({ coin }) {
  const { solUsd } = usePlatform()
  return (
    <Link to={`/coin/${coin.mint}`} className="coin-card">
      <div className="coin-card-head">
        <CoinAvatar src={coin.image} symbol={coin.symbol} size={52} />
        <div className="coin-card-id">
          <strong>{coin.name}</strong>
          <span className="muted">${coin.symbol}</span>
        </div>
        <span
          className={`coin-card-change num ${coin.change24h > 0 ? 'up' : coin.change24h < 0 ? 'down' : 'faint'}`}
        >
          {pct(coin.change24h)}
        </span>
      </div>
      <dl className="coin-card-stats">
        <div>
          <dt>Market cap</dt>
          <dd className="num">
            {solUsd && coin.marketCap
              ? usd(coin.marketCap * solUsd)
              : sol(coin.marketCap, { digits: 1 })}
          </dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd className="num">{sol(coin.volume24h, { digits: 2 })}</dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd className="num">{ago(coin.createdAt)}</dd>
        </div>
      </dl>
      <CurveProgress progress={coin.progress} complete={coin.complete} />
      <div className="coin-card-badges">
        <Badges coin={coin} />
      </div>
    </Link>
  )
}

export function CoinTable({ items }) {
  const navigate = useNavigate()
  const { solUsd } = usePlatform()
  return (
    <div className="table-wrap panel" style={{ padding: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Coin</th>
            <th className="right">Price</th>
            <th className="right">24h</th>
            <th className="right">Market cap</th>
            <th className="right">Volume 24h</th>
            <th className="right">Trades</th>
            <th>Curve</th>
            <th className="right">Age</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.mint} className="row-link" onClick={() => navigate(`/coin/${c.mint}`)}>
              <td>
                <Link
                  to={`/coin/${c.mint}`}
                  className="coin-cell"
                  onClick={(e) => e.stopPropagation()}
                >
                  <CoinAvatar src={c.image} symbol={c.symbol} size={32} />
                  <span>
                    <strong>{c.symbol}</strong>
                    <span className="muted"> {c.name}</span>
                  </span>
                  <Badges coin={c} />
                </Link>
              </td>
              <td className="right num">{price(c.price)}</td>
              <td
                className={`right num ${c.change24h > 0 ? 'up' : c.change24h < 0 ? 'down' : 'faint'}`}
              >
                {pct(c.change24h)}
              </td>
              <td className="right num">
                {solUsd && c.marketCap
                  ? usd(c.marketCap * solUsd)
                  : sol(c.marketCap, { digits: 1 })}
              </td>
              <td className="right num">{sol(c.volume24h, { digits: 2 })}</td>
              <td className="right num">{c.trades24h || 0}</td>
              <td style={{ minWidth: 120 }}>
                <CurveProgress progress={c.progress} complete={c.complete} />
              </td>
              <td className="right num">{ago(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CoinSkeletons({ count = 6 }) {
  return (
    <div className="coin-grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 196 }} />
      ))}
    </div>
  )
}
