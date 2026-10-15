import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink, Globe, Send } from 'lucide-react'
import MarketChart from '../components/MarketChart.jsx'
import TradeTicket from '../components/TradeTicket.jsx'
import TradesTable from '../components/TradesTable.jsx'
import QuantumPanel from '../components/QuantumPanel.jsx'
import HoloCard from '../components/HoloCard.jsx'
import { Address, CurveProgress, Empty, Spinner, Stat } from '../components/UI.jsx'
import { lowerBound, PARTIAL_NOTE } from '../components/figures.js'
import { api, useResource } from '../lib/api.js'
import { loadJob, registerOnce } from '../lib/launchPlan.js'
import { usePlatform } from '../context/PlatformContext.jsx'
import Price from '../components/Price.js'
import { ago, pct, safeLink, sol, usd } from '../lib/format.js'
import { explorer, isAddress } from '../../shared/network.mjs'
import { MeteoraMark } from '../components/Meteora.jsx'

const storage = () => {
  try {
    return localStorage
  } catch {
    return null
  }
}

// A launch from this browser whose create landed but whose registration has not finished.
function unregisteredLaunch(mint) {
  const job = loadJob(storage(), mint)
  return job && !job.registered && job.done?.launch ? job : null
}

export default function CoinPage() {
  const { mint } = useParams()
  const { solUsd } = usePlatform()
  const coin = useResource(isAddress(mint) ? `/api/coins/${mint}` : null, 10000)
  // Tracking state belongs to one mint: the page instance is reused when the route's mint changes.
  const [trackingState, setTrackingState] = useState({ mint: null, status: '' })
  const tracking = trackingState.mint === mint ? trackingState.status : ''
  const [hooks, setHooks] = useState(null)
  const refresh = coin.refresh
  const external = !!coin.data?.coin?.external

  // Any Meteora DBC coin can be opened; untracked mints are added on first visit. A launch made from
  // this browser is registered as a Quant Pad coin instead (with retries), never tracked as an
  // external coin unless the server says it is not one.
  useEffect(() => {
    if (coin.code !== 'NOT_TRACKED' || tracking) return
    const update = (status) => setTrackingState((t) => (t.mint === mint ? { mint, status } : t))
    setTrackingState({ mint, status: 'pending' })
    const job = unregisteredLaunch(mint)
    const run = job
      ? registerOnce(job, { post: api, storage: storage() }).then((result) => {
          if (result.status === 'failed')
            throw Error('Quant Pad has not indexed this launch yet. Reload the page in a minute.')
        })
      : api('/api/coins/track', { mint })
    run
      .then(() => {
        update('done')
        refresh()
      })
      .catch((e) => update(e.message))
  }, [coin.code, mint, tracking, refresh])

  // Our own launch that the server only knows as an external coin: register it to upgrade it.
  useEffect(() => {
    if (!external) return
    const job = unregisteredLaunch(mint)
    if (!job) return
    registerOnce(job, { post: api, storage: storage() })
      .then((result) => result.status === 'registered' && refresh())
      .catch(() => {})
  }, [external, mint, refresh])

  if (!isAddress(mint)) return <Empty level={1} title="That is not a Solana mint address" />
  const c = coin.data?.coin
  if (!c) {
    if (coin.code === 'NOT_TRACKED' || tracking === 'pending')
      return (
        <Spinner
          block
          label={
            tracking && tracking !== 'pending' && tracking !== 'done'
              ? tracking
              : 'Reading this coin from Meteora'
          }
        />
      )
    if (tracking && tracking !== 'pending' && tracking !== 'done')
      return (
        <div className="wrap">
          <Empty
            level={1}
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
        <Empty level={1} title="This coin could not be loaded">
          {coin.error}
        </Empty>
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
      <header className="coin-top">
        <HoloCard
          name={c.name}
          symbol={c.symbol}
          image={c.image}
          quantum={c.quantum}
          hooks={hooks}
          footer={
            <span>
              {c.complete
                ? c.migrated
                  ? 'Graduated to Meteora DAMM v2'
                  : 'Graduating to Meteora DAMM v2'
                : `Meteora curve ${Math.round(c.progress || 0)}%`}
            </span>
          }
        />
        <div className="coin-summary">
          <div className="coin-id">
            <h1>
              {c.name} <span className="coin-ticker">${c.symbol}</span>
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
              <span className="num">
                <Price value={c.price} /> SOL
              </span>
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
              {/* While the last 24 hours are still being indexed this is a lower bound. */}
              <span className="num" title={c.statsPartial ? PARTIAL_NOTE : undefined}>
                {lowerBound(c.volume24h, sol(c.volume24h, { digits: 2 }), c.statsPartial)}
              </span>
            </Stat>
            <Stat label="Age">
              <span className="num">{ago(c.createdAt)}</span>
            </Stat>
          </dl>
        </div>
      </header>

      <div className="coin-grid-layout">
        <div className="coin-main">
          <MarketChart mint={c.mint} symbol={c.symbol} supply={c.supply} mayhem={c.mayhem} />
          <TradesTable mint={c.mint} symbol={c.symbol} launcher={c.launcher} />
        </div>
        <aside className="coin-side">
          <TradeTicket coin={c} onTraded={coin.refresh} />
          <section className="panel">
            <CurveProgress progress={c.progress} complete={c.complete} migrated={!!c.migrated} />
            {!c.complete && (
              <p className="faint" style={{ marginTop: 10, fontSize: 'var(--t-xs)' }}>
                When the curve fills, Meteora graduates the coin to a DAMM v2 pool with its
                liquidity locked, and trading continues there.
              </p>
            )}
          </section>
          {c.quantum && <QuantumPanel coin={c} onLoaded={setHooks} />}
          <section className="panel about">
            <h2 className="h3">About</h2>
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
              <dt>
                <MeteoraMark size={14} /> Meteora
              </dt>
              <dd>
                <a
                  href={explorer.account(c.migrated && c.pool ? c.pool : c.dbcPool || c.mint)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.migrated ? 'DAMM v2 pool' : 'Bonding curve pool'}
                </a>
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
