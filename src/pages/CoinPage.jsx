import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink, Globe, Send } from 'lucide-react'
import MarketChart from '../components/MarketChart.jsx'
import TradeTicket from '../components/TradeTicket.jsx'
import TradesTable from '../components/TradesTable.jsx'
import QuantumPanel from '../components/QuantumPanel.jsx'
import { Address, CoinAvatar, CurveProgress, Empty, Spinner, Stat } from '../components/UI.jsx'
import { api, useResource } from '../lib/api.js'
import { usePlatform } from '../context/PlatformContext.jsx'
import { ago, pct, price, safeLink, sol, usd } from '../lib/format.js'
import { explorer, isAddress, pumpFunUrl } from '../../shared/network.mjs'

export default function CoinPage() {
  const { mint } = useParams()
  const { solUsd } = usePlatform()
  const coin = useResource(isAddress(mint) ? `/api/coins/${mint}` : null, 10000)
  const [tracking, setTracking] = useState('')

  // Any pump.fun coin can be opened; untracked mints are added on first visit.
  useEffect(() => {
    if (coin.code !== 'NOT_TRACKED' || tracking) return
    setTracking('pending')
    api('/api/coins/track', { mint })
      .then(() => {
        setTracking('done')
        coin.refresh()
      })
      .catch((e) => setTracking(e.message))
  }, [coin.code, mint, tracking, coin])

  if (!isAddress(mint)) return <Empty title="That is not a Solana mint address" />
  const c = coin.data?.coin
  if (!c) {
    if (coin.code === 'NOT_TRACKED' || tracking === 'pending')
      return (
        <Spinner
          block
          label={
            tracking && tracking !== 'pending' && tracking !== 'done'
              ? tracking
              : 'Reading this coin from pump.fun'
          }
        />
      )
    if (tracking && tracking !== 'pending' && tracking !== 'done')
      return (
        <div className="wrap">
          <Empty
            title="This coin could not be opened"
            action={
              <Link to="/market" className="btn">
                Back to market
              </Link>
            }
          >
            {tracking}
          </Empty>
        </div>
      )
    return coin.error ? (
      <div className="wrap">
        <Empty title="This coin could not be loaded">{coin.error}</Empty>
      </div>
    ) : (
      <Spinner block label="Loading coin" />
    )
  }

  const mcap = c.marketCap
  const links = [
    [safeLink(c.meta?.website), 'Website', Globe],
    [safeLink(c.meta?.twitter), 'X', ExternalLink],
    [safeLink(c.meta?.telegram), 'Telegram', Send],
  ].filter(([href]) => href)

  return (
    <div className="wrap coin-page">
      <header className="coin-head">
        <CoinAvatar src={c.image} symbol={c.symbol} size={64} />
        <div className="coin-id">
          <h1>
            {c.name} <span className="muted coin-ticker">${c.symbol}</span>
          </h1>
          <div className="coin-badges">
            {c.quantum && <span className="chip chip-quantum">Quantum Hooks</span>}
            {c.complete && <span className="chip chip-grad">Graduated</span>}
            {c.external && <span className="chip">Launched outside Quant Pad</span>}
            <Address value={c.mint} href={explorer.token(c.mint)} />
          </div>
        </div>
        <dl className="coin-stats">
          <Stat label="Price">
            <span className="num">{price(c.price)} SOL</span>
          </Stat>
          <Stat label="Market cap">
            <span className="num">
              {solUsd && mcap ? usd(mcap * solUsd) : sol(mcap, { digits: 1 })}
            </span>
          </Stat>
          <Stat label="24h change">
            <span className={`num ${c.change24h > 0 ? 'up' : c.change24h < 0 ? 'down' : ''}`}>
              {pct(c.change24h)}
            </span>
          </Stat>
          <Stat label="24h volume">
            <span className="num">{sol(c.volume24h, { digits: 2 })}</span>
          </Stat>
          <Stat label="Age">
            <span className="num">{ago(c.createdAt)}</span>
          </Stat>
        </dl>
      </header>

      <div className="coin-grid-layout">
        <div className="coin-main">
          <MarketChart mint={c.mint} symbol={c.symbol} />
          <TradesTable mint={c.mint} symbol={c.symbol} launcher={c.launcher} />
        </div>
        <aside className="coin-side">
          <TradeTicket coin={c} onTraded={coin.refresh} />
          <section className="panel">
            <CurveProgress progress={c.progress} complete={c.complete} />
            {!c.complete && (
              <p className="faint" style={{ marginTop: 10, fontSize: 'var(--t-xs)' }}>
                When the curve sells out, the coin graduates to a PumpSwap pool and trading
                continues there.
              </p>
            )}
          </section>
          {c.quantum && <QuantumPanel coin={c} />}
          <section className="panel about">
            <h3>About</h3>
            {c.meta?.description ? (
              <p className="muted">{c.meta.description}</p>
            ) : (
              <p className="faint">No description.</p>
            )}
            {links.length > 0 && (
              <div className="about-links">
                {links.map(([href, label, Icon]) => (
                  <a
                    key={label}
                    className="btn btn-sm"
                    href={href}
                    target="_blank"
                    rel="noreferrer nofollow"
                  >
                    <Icon size={14} aria-hidden="true" /> {label}
                  </a>
                ))}
              </div>
            )}
            <dl className="kv" style={{ marginTop: 14 }}>
              <dt>Creator</dt>
              <dd>
                <Address value={c.creator} href={explorer.account(c.creator)} />
              </dd>
              {c.launcher && c.launcher !== c.creator && (
                <>
                  <dt>Launched by</dt>
                  <dd>
                    <Address value={c.launcher} href={explorer.account(c.launcher)} />
                  </dd>
                </>
              )}
              <dt>pump.fun</dt>
              <dd>
                <a href={pumpFunUrl(c.mint)} target="_blank" rel="noreferrer">
                  View on pump.fun
                </a>
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
