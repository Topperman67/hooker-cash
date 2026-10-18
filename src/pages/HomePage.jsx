import { Link } from 'react-router-dom'
import Refractor from '../components/Refractor.jsx'
import { CoinCard, CoinSkeletons } from '../components/CoinList.jsx'
import { Empty } from '../components/UI.jsx'
import { useResource } from '../lib/api.js'
import { usePlatform } from '../context/PlatformContext.jsx'
import { EXTRAS, MODULES } from '../lib/hooks.js'
import Glass from '../components/Glass.jsx'
import { compact, sol, toSol, usd } from '../lib/format.js'
import { MeteoraMark } from '../components/Meteora.jsx'
import Flywheel from '../components/Flywheel.jsx'
import QuantpShowcase from '../components/QuantpShowcase.jsx'
import { GRADUATED } from '../components/quantpPayouts.js'
import { useQuantp } from '../context/QuantpContext.jsx'
import { DOCS_URL } from '../lib/links.js'
import { QUANTP } from '../../shared/network.mjs'

// $QUANTP as a coin card, from /api/quantp (which never reads the store), in the units the market
// API uses: SOL for market cap and volume, percent for change and curve progress.
function quantpCoin(qp, solUsd) {
  if (!qp?.priceSol) return null
  return {
    mint: QUANTP.mint,
    name: QUANTP.name,
    symbol: QUANTP.symbol,
    image: '/brand/mark.svg',
    marketCap: qp.marketCapSol ?? null,
    volume24h: qp.volume24hUsd != null && solUsd ? qp.volume24hUsd / solUsd : null,
    trades24h: qp.txns24h ? qp.txns24h.buys + qp.txns24h.sells : null,
    change24h: qp.change24h != null ? qp.change24h * 100 : null,
    createdAt: qp.launchedAt ?? QUANTP.launchedAt,
    progress: Math.min(1, qp.curveProgress ?? 0) * 100,
    complete: !!qp.migrated || (qp.curveProgress ?? 0) >= 1,
    migrated: !!qp.migrated,
  }
}

// $QUANTP joins Trending now (it trades on Quant Pad) where the server's trending order
// (server/indexer.mjs SORTS) would put it, even while the market list cannot load.
const trendingOrder = (a, b) =>
  (b.trades24h || 0) - (a.trades24h || 0) || (b.volume24h || 0) - (a.volume24h || 0)
function withQuantp(items = [], coin) {
  if (!coin) return items
  const rest = items.filter((c) => c.mint !== coin.mint)
  const at = rest.findIndex((c) => trendingOrder(coin, c) < 0)
  return at < 0 ? [...rest, coin] : [...rest.slice(0, at), coin, ...rest.slice(at)]
}

export default function HomePage() {
  const trending = useResource('/api/market?sort=trending', 20000)
  const stats = useResource('/api/stats', 30000)
  const { solUsd, quantum } = usePlatform()
  const qp = useQuantp().data
  const qpCoin = quantpCoin(qp, solUsd)
  const trendingItems = withQuantp(trending.data?.items, qpCoin)
  const s = stats.data

  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <h1 className="hero-title">
              <span className="hero-venue">
                Launch on <MeteoraMark size="0.9em" className="meteora-mark hero-mark" /> Meteora.
              </span>
              <span>Route every fee through</span>
              <span className="hero-chrome chrome-text">Quantum Hooks.</span>
            </h1>
            <p className="hero-lede">
              Quant Pad creates your coin on Meteora and points its creator fees at an on-chain
              program. Every pulse of fees is split by rules you lock at launch:{' '}
              <b>buy back and burn</b>, <b>pay holders in SOL</b>, <b>lock liquidity</b>,{' '}
              <b>pay your team</b>.
            </p>
            <div className="hero-actions">
              <Link to="/launch" className="btn btn-primary btn-lg">
                Launch a coin
              </Link>
              <a href={DOCS_URL} target="_blank" rel="noreferrer" className="btn btn-lg">
                See how the hooks work
              </a>
            </div>
            {s && (
              <Glass variant="panel" className="hero-stats-glass" radius={20}>
                <dl className="hero-stats">
                  <div>
                    <dt>Coins launched</dt>
                    <dd className="num">{compact(s.coins)}</dd>
                  </div>
                  <div>
                    <dt>With Quantum Hooks</dt>
                    <dd className="num">{compact(s.quantum)}</dd>
                  </div>
                  <div>
                    <dt>Traded in 24 h</dt>
                    <dd className="num">
                      {s.volume24h
                        ? solUsd
                          ? usd(s.volume24h * solUsd)
                          : sol(s.volume24h)
                        : '0 SOL'}
                    </dd>
                  </div>
                </dl>
              </Glass>
            )}
          </div>
          {/* Always Quant Pad's own coin, not whichever coin launched last. */}
          <Refractor symbol={QUANTP.symbol} />
        </div>
      </section>

      {/* $QUANTP, Quant Pad's own token, then its fee flywheel. Both read /api/quantp (no store),
          so they still show while the market lists are down. The flywheel takes primitives only,
          so its memo skips the home page's other polls; its burned figure is the team's burns
          (raw units), not the whole supply's. */}
      <section className="wrap section qps-section">
        <QuantpShowcase />
      </section>
      <section className="wrap section">
        <Flywheel
          feeBps={qp?.feeBps ?? null}
          migrated={GRADUATED || !!qp?.migrated}
          paidSol={qp?.payouts ? toSol(qp.payouts.paidLamports) : null}
          boughtSol={qp?.payouts ? toSol(qp.payouts.boughtLamports) : null}
          burned={qp?.payouts?.burnedAmount ?? null}
        />
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>Trending now</h2>
          <Link to="/market?sort=trending" className="btn btn-ghost">
            Full market
          </Link>
        </div>
        {trending.loading && !trending.data && !qpCoin ? (
          <CoinSkeletons count={3} />
        ) : trendingItems.length ? (
          <div className="coin-grid">
            {trendingItems.slice(0, 6).map((c) => (
              <CoinCard key={c.mint} coin={c} />
            ))}
          </div>
        ) : (
          <Empty
            level={3}
            title="No coins yet"
            action={
              <Link to="/launch" className="btn btn-primary">
                Launch the first one
              </Link>
            }
          >
            Coins launched through Quant Pad appear here as soon as their launch confirms.
          </Empty>
        )}
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>How a Quantum launch works</h2>
        </div>
        <ol className="steps">
          <li>
            <h3>Wire the hooks</h3>
            <p>
              Choose how creator fees split between you, burns, holders and liquidity. The rules are
              written on-chain before your coin exists and can never be changed.
            </p>
          </li>
          <li>
            <h3>Launch on Meteora</h3>
            <p>
              Your coin is created on Meteora’s Dynamic Bonding Curve with its creator set to the
              coin’s own Quant Pad well, with your dev buy in the same transaction.
            </p>
          </li>
          <li>
            <h3>Pulse</h3>
            <p>
              Every trade pays a creator fee into the well. Pulses collect it and route it: burns,
              holder payouts and liquidity run automatically, and anyone can trigger them.
            </p>
          </li>
        </ol>
        {!quantum.available && (
          <p className="notice" style={{ marginTop: 20 }}>
            {quantum.reason === 'paused'
              ? 'Quantum launches are paused right now. Standard Meteora launches work as usual.'
              : 'Quantum Hooks are being deployed. Standard Meteora launches work today; hooked launches unlock once the program is live on mainnet.'}
          </p>
        )}
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>The hooks</h2>
          <Link to="/hooks" className="btn btn-ghost">
            How each hook works
          </Link>
        </div>
        <div className="hook-grid">
          {[...MODULES, ...EXTRAS].map((m) => (
            <article key={m.key} className="hook-tile" style={{ '--c': m.color }}>
              <span className="hook-line" aria-hidden="true" />
              <h3>{m.name}</h3>
              <p>{m.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
