import { ArrowRight, ArrowUpRight, FlaskConical, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import Glass from '../components/Glass'
import { BrandMark, Button, TokenAvatar } from '../components/UI'
import { useChain } from '../context/ChainContext'
import { useResource, compact } from '../lib/api'

export default function HomePage() {
  const market = useResource('/api/market?sort=newest', 15000)
  const chain = useChain()
  const tokens = market.data?.items || []

  return (
    <div className="landing">
      <Glass
        as="section"
        tone="slate"
        radius={28}
        className="landing-hero"
        aria-labelledby="landing-title"
      >
        <div className="landing-stage">
          <div className="landing-copy">
            <div className="landing-eyebrow">
              <span>Hookbrew</span>
              <i />
              The token launchpad on Arc
            </div>
            <h1 id="landing-title">
              Brew something
              <br />
              <span>worth trading.</span>
            </h1>
            <p>
              A new idea deserves its own market. Create your token, set the opening rules, and
              bring it to life on Arc.
            </p>
            <div className="landing-actions">
              <Button to="/create" primary>
                Launch a token <ArrowUpRight size={18} />
              </Button>
              <Link to="/market" className="landing-text-link">
                Explore the market <ArrowRight size={17} />
              </Link>
            </div>
            <span className="landing-note">Your token. Your recipe.</span>
          </div>
          <div className="brew-object" aria-hidden="true">
            <div className="brew-orbit" />
            <div className="brew-orbit brew-orbit-inner" />
            <div className="brew-plinth" />
            <img
              className="brew-flask"
              src="/brand/hookbrew/hookbrew-icon.png"
              alt=""
              width="1254"
              height="1254"
              fetchPriority="high"
            />
            <span className="brew-object-caption">
              <i />A little hook. A lot of possibility.
            </span>
          </div>
        </div>
        <div className="landing-foundations" aria-label="Built with">
          <span>
            <BrandMark name="arc-blue" />
            Built on Arc
          </span>
          <span>
            <BrandMark name="uniswap" />
            Uniswap V4 pools
          </span>
          <span>
            <BrandMark name="usdc" />
            Paired with USDC
          </span>
          <Link to="/docs">
            Get to know Hookbrew <ArrowUpRight size={14} />
          </Link>
        </div>
      </Glass>
      {chain.status === 'error' && (
        <div className="landing-network-error" role="status">
          <span>Arc connection unavailable. Network data may be out of date.</span>
          <button onClick={chain.retry}>
            Retry network <RefreshCw size={14} />
          </button>
        </div>
      )}
      <div className="landing-bottom">
        <section className="landing-market" aria-labelledby="fresh-launches-title">
          <div className="landing-section-heading">
            <div>
              <span className="landing-overline">Discover</span>
              <h2 id="fresh-launches-title">Freshly brewed.</h2>
            </div>
            <Link to="/market" className="landing-text-link">
              All tokens <ArrowUpRight size={16} />
            </Link>
          </div>
          {market.error && (
            <div className="landing-market-error" role="status">
              <span>
                {tokens.length
                  ? 'Market updates are unavailable. Showing the last loaded data.'
                  : 'The market is temporarily unavailable.'}
              </span>
              <button onClick={market.refresh}>
                Try again <RefreshCw size={14} />
              </button>
            </div>
          )}
          {tokens.length > 0 ? (
            <div className="table-scroll landing-market-table">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Market cap / USDC</th>
                    <th>24h volume / USDC</th>
                    <th>Trade</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.slice(0, 4).map((token) => (
                    <tr key={token.address}>
                      <td>
                        <Link className="market-token" to={`/token/${token.address}`}>
                          <TokenAvatar token={token} />
                          <span>
                            <strong>{token.name}</strong>
                            <small>{token.symbol}</small>
                          </span>
                        </Link>
                      </td>
                      <td>{compact(token.marketCap)}</td>
                      <td>{compact(token.volume24h)}</td>
                      <td>
                        <Link to={`/token/${token.address}`} aria-label={`Trade ${token.symbol}`}>
                          <ArrowUpRight size={18} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !market.error && (
              <div className="landing-market-empty" role="status" aria-busy={market.loading}>
                <span className="landing-empty-icon">
                  <FlaskConical size={25} strokeWidth={1.3} />
                </span>
                <div>
                  <h3>
                    {market.loading
                      ? 'Checking the latest launches…'
                      : 'The next launch could be yours.'}
                  </h3>
                  <p>
                    {market.loading
                      ? 'Fetching markets from Hookbrew.'
                      : 'New tokens land here, ready to discover and trade.'}
                  </p>
                </div>
                {!market.loading && (
                  <Link to="/create" aria-label="Create the first token">
                    <ArrowUpRight size={20} />
                  </Link>
                )}
              </div>
            )
          )}
        </section>
        <Glass
          as="section"
          tone="slate"
          radius={20}
          className="landing-studio"
          aria-labelledby="studio-title"
        >
          <span className="landing-overline">The launch studio</span>
          <h2 id="studio-title">
            An idea to a market.
            <br />
            All in one place.
          </h2>
          <p>
            Set your supply. Shape your launch. Then follow the chart and trade from your token’s
            own terminal.
          </p>
          <Link to="/create" className="landing-text-link">
            Start your recipe <ArrowRight size={16} />
          </Link>
        </Glass>
      </div>
    </div>
  )
}
