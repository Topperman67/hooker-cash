import { ArrowUpRight, Blocks, Droplets, Plus } from 'lucide-react'
import Glass from '../components/Glass'
import { BrandMark, Button, Logo } from '../components/UI'
import ChainStatus from '../components/ChainStatus'
import { usePlatform } from '../context/PlatformContext'
import { useResource, compact } from '../lib/api'
import { Link } from 'react-router-dom'
import { TokenAvatar } from '../components/UI'

function PoolSculpture() {
  return (
    <div
      className="pool-sculpture"
      aria-label="Architecture diagram: swaps, custom hooks, and Uniswap V4 pools"
    >
      <div className="sculpture-halo" />
      <div className="sculpture-orbit orbit-one" />
      <div className="sculpture-orbit orbit-two" />
      <span className="sculpture-caption">The launch architecture</span>
      <div className="slab-wrap slab-core">
        <Glass variant="clear" tone="cyan" radius={38} className="glass-slab">
          <div className="slab-label">
            <BrandMark name="uniswap" />
            <span>Uniswap V4</span>
            <span className="slab-detail">The pool</span>
          </div>
        </Glass>
      </div>
      <div className="slab-wrap slab-hook">
        <Glass variant="clear" tone="violet" radius={38} className="glass-slab">
          <div className="slab-label">
            <Logo compact />
            <span>Your hook</span>
            <span className="slab-detail">Programmable rules</span>
          </div>
        </Glass>
      </div>
      <div className="slab-wrap slab-swap">
        <Glass variant="clear" radius={38} className="glass-slab">
          <div className="slab-label">
            <Droplets size={29} />
            <span>Every swap</span>
            <span className="slab-detail">On-chain execution</span>
          </div>
        </Glass>
      </div>
      <span className="sculpture-footnote">The Hookbrew launch engine</span>
    </div>
  )
}

export default function HomePage() {
  const { deployment } = usePlatform()
  const market = useResource('/api/market?sort=newest', 15000)
  return (
    <>
      <section className="home-hero">
        <div className="hero-copy">
          <span className="hero-kicker">
            <BrandMark name="arc" />
            Hookbrew on Arc
          </span>
          <h1>
            Your token.
            <br />
            Your rules.
          </h1>
          <p>
            Give your next idea a market. Launch a token, shape its opening rules, and trade in one
            place — powered by Uniswap V4.
          </p>
          <div className="hero-ctas">
            <Button to="/create" primary className="btn-lg">
              <Plus size={18} />
              Create a token
            </Button>
            <Button to="/market" className="btn-lg">
              Explore markets
              <ArrowUpRight size={17} />
            </Button>
          </div>
        </div>
        <PoolSculpture />
      </section>
      <ChainStatus />
      <section className="floor-section">
        <div className="section-head">
          <div>
            <h2>The market</h2>
            <p>Launches and pool activity will appear here from verified on-chain sources.</p>
          </div>
        </div>
        {market.data?.items.length ? (
          <Glass className="market-table-panel">
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Newest tokens</th>
                    <th>Market cap / USDC</th>
                    <th>24h volume / USDC</th>
                    <th>Market</th>
                  </tr>
                </thead>
                <tbody>
                  {market.data.items.slice(0, 5).map((t) => (
                    <tr key={t.address}>
                      <td>
                        <Link className="market-token" to={`/token/${t.address}`}>
                          <TokenAvatar token={t} />
                          <span>
                            <strong>{t.name}</strong>
                            <small>{t.symbol}</small>
                          </span>
                        </Link>
                      </td>
                      <td>{compact(t.marketCap)}</td>
                      <td>{compact(t.volume24h)}</td>
                      <td>
                        <Link to={`/token/${t.address}`}>Trade ↗</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Glass>
        ) : (
          <Glass className="empty-state">
            <Blocks size={30} />
            <h2>
              {market.error
                ? 'Market temporarily unavailable'
                : deployment
                  ? 'The next launch could be yours.'
                  : 'Build your first brew.'}
            </h2>
            <p>
              {market.error ||
                (deployment
                  ? 'Your launch appears here with a chart and trading terminal after confirmation.'
                  : 'The launch studio is ready. Configure your token while your Hookbrew contracts await deployment.')}
            </p>
            <Button to="/market">
              Open the market
              <ArrowUpRight size={16} />
            </Button>
          </Glass>
        )}
      </section>
      <Glass className="bottom-cta" tone="violet">
        <span className="bottom-cta-icon">
          <Logo compact />
        </span>
        <div>
          <h2>A little hook. A lot of possibility.</h2>
          <p>Review the contract integration and the hook architecture.</p>
        </div>
        <Button to="/docs">
          Read the project status
          <ArrowUpRight size={16} />
        </Button>
      </Glass>
    </>
  )
}
