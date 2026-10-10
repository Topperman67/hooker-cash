import { Link } from 'react-router-dom'
import WaveField from '../components/WaveField.jsx'
import { CoinCard, CoinSkeletons } from '../components/CoinList.jsx'
import { Empty } from '../components/UI.jsx'
import { useResource } from '../lib/api.js'
import { usePlatform } from '../context/PlatformContext.jsx'
import { EXTRAS, MODULES } from '../lib/hooks.js'
import { compact, sol, usd } from '../lib/format.js'

export default function HomePage() {
  const latest = useResource('/api/market?sort=newest', 15000)
  const trending = useResource('/api/market?sort=trending', 20000)
  const stats = useResource('/api/stats', 30000)
  const { solUsd, quantum } = usePlatform()
  const s = stats.data

  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <h1>Launch on pump.fun. Route every fee through Quantum Hooks.</h1>
            <p className="hero-lede">
              Quant Pad creates your coin on pump.fun and points its creator fees at an on-chain
              program. Each pulse of fees is split by rules you lock at launch: buy back and burn,
              pay holders, fund liquidity, pay your team.
            </p>
            <div className="hero-actions">
              <Link to="/launch" className="btn btn-primary btn-lg">
                Launch a coin
              </Link>
              <Link to="/market" className="btn btn-lg">
                Explore the market
              </Link>
            </div>
            <p className="hero-facts">
              {s ? (
                <>
                  <span className="num">{compact(s.coins)}</span> coins launched,{' '}
                  <span className="num">{compact(s.quantum)}</span> with hooks,{' '}
                  <span className="num">
                    {s.volume24h
                      ? solUsd
                        ? usd(s.volume24h * solUsd)
                        : sol(s.volume24h)
                      : '0 SOL'}
                  </span>{' '}
                  traded in the last 24 hours.
                </>
              ) : (
                'Coins trade on pump.fun’s bonding curve and graduate to PumpSwap automatically.'
              )}
            </p>
          </div>
          <WaveField className="hero-field" />
        </div>
      </section>

      <section className="wrap section">
        <div className="section-head">
          <h2>Trending now</h2>
          <Link to="/market?sort=trending" className="btn btn-ghost">
            Full market
          </Link>
        </div>
        {trending.loading && !trending.data ? (
          <CoinSkeletons count={3} />
        ) : trending.data?.items?.length ? (
          <div className="coin-grid">
            {trending.data.items.slice(0, 6).map((c) => (
              <CoinCard key={c.mint} coin={c} />
            ))}
          </div>
        ) : (
          <Empty
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

      {latest.data?.items?.length > 0 && (
        <section className="wrap section">
          <div className="section-head">
            <h2>Just launched</h2>
            <Link to="/market?sort=newest" className="btn btn-ghost">
              All new coins
            </Link>
          </div>
          <div className="coin-grid">
            {latest.data.items.slice(0, 6).map((c) => (
              <CoinCard key={c.mint} coin={c} />
            ))}
          </div>
        </section>
      )}

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
            <h3>Launch on pump.fun</h3>
            <p>
              Your coin is created on pump.fun with its creator set to the coin’s own Quant Pad
              well, with your dev buy in the same transaction.
            </p>
          </li>
          <li>
            <h3>Pulse</h3>
            <p>
              Every trade pays a creator fee into the well. Pulses collect it and route it: burns,
              holder epochs and liquidity run automatically, and anyone can trigger them.
            </p>
          </li>
        </ol>
        {!quantum.available && (
          <p className="notice" style={{ marginTop: 20 }}>
            Quantum Hooks are being deployed. Standard pump.fun launches work today; hooked launches
            unlock once the program is live on mainnet.
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
              <h3>{m.name}</h3>
              <p>{m.body}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
