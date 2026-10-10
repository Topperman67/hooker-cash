import {
  ArrowRight,
  ArrowUpRight,
  FlaskConical,
  RefreshCw,
  LockKeyhole,
  SlidersHorizontal,
  Users,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import HookStack from '../components/HookStack'
import { BrandMark, Button, TokenAvatar } from '../components/UI'
import { useChain } from '../context/ChainContext'
import { useResource, eth } from '../lib/api'
import { hookModules } from '../data/hookModules'
import { network } from '../../shared/network.mjs'
import { formatUnits } from 'viem'

export default function HomePage() {
  const market = useResource('/api/market?sort=newest', 15000)
  const chain = useChain()
  const tokens = market.data?.items || []

  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-stage">
          <div className="landing-copy">
            <div className="landing-eyebrow">
              <BrandMark name="robinhood" />A new home for your next idea
            </div>
            <h1 id="landing-title">
              Brew something
              <br />
              worth trading.
            </h1>
            <p>
              Create a token. Give it your own rules. Open an ETH market on Robinhood Chain, with a
              little help from Uniswap V4.
            </p>
            <div className="landing-actions">
              <Button to="/create" primary>
                Launch a token <ArrowUpRight size={18} />
              </Button>
              <Link to="/market" className="landing-text-link">
                Explore the market <ArrowRight size={17} />
              </Link>
            </div>
            <span className="landing-note">
              <span>
                {formatUnits(BigInt(network.launchFee), network.quoteDecimals)} ETH launch fee
              </span>
              <span>+ network gas</span>
            </span>
          </div>
          <div className="landing-visual">
            <div className="architecture-heading">
              <span>The anatomy of a brew</span>
              <span>Uniswap V4</span>
            </div>
            <HookStack />
            <div className="architecture-footnote">
              <LockKeyhole size={13} /> Seed liquidity, permanently locked
            </div>
          </div>
        </div>
        <div className="landing-foundations" aria-label="Built with">
          <span>
            <BrandMark name="robinhood-blue" />
            Robinhood Chain
          </span>
          <span>
            <BrandMark name="uniswap" />
            Uniswap V4
          </span>
          <span>
            <BrandMark name="eth" />
            Native ETH markets
          </span>
          <Link to="/docs">
            Get to know Hookbrew <ArrowUpRight size={14} />
          </Link>
        </div>
      </section>
      {chain.status === 'error' && (
        <div className="landing-network-error" role="status">
          <span>Robinhood Chain connection unavailable. Network data may be out of date.</span>
          <button onClick={chain.retry}>
            Retry network <RefreshCw size={14} />
          </button>
        </div>
      )}
      <div className="landing-bottom">
        <section className="landing-market" aria-labelledby="fresh-launches-title">
          <div className="landing-section-heading">
            <div>
              <h2 id="fresh-launches-title">Freshly brewed.</h2>
              <p>New ideas, straight from the launchpad.</p>
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
                    <th>Market cap / ETH</th>
                    <th>24h volume / ETH</th>
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
                      <td>{eth(token.marketCap)}</td>
                      <td>{eth(token.volume24h)}</td>
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
        <section className="landing-studio" aria-labelledby="studio-title">
          <div className="studio-invitation-icon">
            <FlaskConical size={26} strokeWidth={1.4} />
          </div>
          <span className="landing-overline">Your next move</span>
          <h2 id="studio-title">It starts with a recipe.</h2>
          <p>
            Five steps from a blank canvas to your own token. Build your draft now and launch when
            you’re ready.
          </p>
          <Link to="/create" className="landing-text-link">
            Start your recipe <ArrowRight size={16} />
          </Link>
        </section>
      </div>
      <section className="recipe-discovery" aria-labelledby="recipe-discovery-title">
        <div className="recipe-discovery-heading">
          <div>
            <h2 id="recipe-discovery-title">The hook makes it yours.</h2>
            <p>Seven modules. Your combination. Set the rules before the first trade.</p>
          </div>
          <Link to="/modules" className="landing-text-link">
            Explore the hooks <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="recipe-module-list">
          {hookModules.map(({ key, title, icon: Icon }) => (
            <span key={key}>
              <Icon size={19} strokeWidth={1.5} />
              {title}
            </span>
          ))}
        </div>
        <div className="brew-principles">
          <article>
            <SlidersHorizontal size={23} strokeWidth={1.4} />
            <h3>Set the opening.</h3>
            <p>
              Choose a {formatUnits(BigInt(network.minMcap), 18)}–
              {formatUnits(BigInt(network.maxMcap), 18)} ETH starting valuation and a 1–5% pool fee.
            </p>
          </article>
          <article>
            <Users size={23} strokeWidth={1.4} />
            <h3>Share your upside.</h3>
            <p>
              Split creator payouts with your team. Add holder rewards to share a portion of ETH
              fees with your community.
            </p>
          </article>
          <article>
            <LockKeyhole size={23} strokeWidth={1.4} />
            <h3>Build on clear rules.</h3>
            <p>
              Permanent seed liquidity. A fixed 70/30 creator and protocol fee split. Every
              transaction signed by you.
            </p>
          </article>
        </div>
      </section>
    </div>
  )
}
