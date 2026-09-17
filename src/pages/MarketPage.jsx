import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { isAddress } from 'viem'
import { ArrowUpRight, FlaskConical, Search } from 'lucide-react'
import Glass from '../components/Glass'
import { Button, PageHeading, TokenAvatar } from '../components/UI'
import TokenLookup from '../components/TokenLookup'
import { useResource, compact, number } from '../lib/api'
export default function MarketPage({ trading = false }) {
  const [params, setParams] = useSearchParams(),
    q = params.get('q') || '',
    sort = params.get('sort') || 'newest',
    fee = params.get('fee') || '',
    offset = Number(params.get('offset')) || 0
  const [input, setInput] = useState(q)
  useEffect(() => setInput(q), [q])
  const result = useResource(
    `/api/market?q=${encodeURIComponent(q)}&sort=${sort}&fee=${fee}&offset=${offset}`,
    10000,
  )
  function filter(key, value) {
    const p = new URLSearchParams(params)
    value ? p.set(key, value) : p.delete(key)
    if (key !== 'offset') p.delete('offset')
    setParams(p)
  }
  return (
    <>
      <PageHeading
        title={trading ? 'Find your next trade.' : 'Fresh brews. Open markets.'}
        description={
          trading
            ? 'Choose a market to open its live chart and buy or sell with your wallet.'
            : 'Explore tokens launched on Hookbrew. Every listing comes from a confirmed on-chain launch.'
        }
        action={
          <Button primary to="/create">
            <FlaskConical size={16} /> Launch a token
          </Button>
        }
      />
      <Glass className="product-market-toolbar" radius={20}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            filter('q', input.trim())
          }}
        >
          <Search size={18} />
          <input
            aria-label="Token contract address"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search tokens, symbols or addresses…"
          />
          <Button type="submit">Search</Button>
        </form>
        <div>
          <select
            aria-label="Sort markets"
            value={sort}
            onChange={(e) => filter('sort', e.target.value)}
          >
            <option value="newest">Newest launches</option>
            <option value="volume">24h volume</option>
            <option value="mcap">Market cap</option>
          </select>
          <select
            aria-label="Filter pool fee"
            value={fee}
            onChange={(e) => filter('fee', e.target.value)}
          >
            <option value="">All pool fees</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n * 10000}>
                {n}% fee
              </option>
            ))}
          </select>
        </div>
      </Glass>
      {isAddress(q) && <TokenLookup address={q} />}
      {result.error && (
        <p className="form-error" role="alert">
          Market unavailable: {result.error} <button onClick={result.refresh}>Retry</button>
        </p>
      )}
      {result.data?.index?.error && (
        <p className="form-error">Market index delayed: {result.data.index.error}</p>
      )}
      {!!result.data?.items.length ? (
        <Glass className="market-table-panel" radius={24}>
          <div className="table-scroll">
            <table className="product-table market-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Price / USDC</th>
                  <th>Market cap</th>
                  <th>24h volume</th>
                  <th>24h change</th>
                  <th>Pool fee</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((t) => (
                  <tr key={t.address}>
                    <td>
                      <Link to={`/token/${t.address}`} className="market-token">
                        <TokenAvatar token={t} />
                        <span>
                          <strong>{t.name}</strong>
                          <small>{t.symbol}</small>
                        </span>
                      </Link>
                    </td>
                    <td>{number(t.price, 10)}</td>
                    <td>{compact(t.marketCap)}</td>
                    <td>{compact(t.volume24h)}</td>
                    <td className={t.change24h >= 0 ? 'text-mint' : 'text-rose'}>
                      {t.change24h == null
                        ? '—'
                        : `${t.change24h >= 0 ? '+' : ''}${number(t.change24h)}%`}
                    </td>
                    <td>{t.fee / 10000}%</td>
                    <td>
                      <Link to={`/token/${t.address}`} aria-label={`Trade ${t.name}`}>
                        <ArrowUpRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Glass>
      ) : (
        !result.error && (
          <Glass className="product-empty market-empty" radius={26}>
            <img src="/brand/hookbrew/hookbrew-icon.png" alt="" width="100" height="100" />
            <span className="eyebrow">THE MARKET STARTS HERE</span>
            <h2>
              {result.loading
                ? 'Reading the market…'
                : q || fee
                  ? 'No matching brews.'
                  : result.data?.deployment
                    ? 'Be the first to brew.'
                    : 'Your launch venue is ready to set up.'}
            </h2>
            <p>
              {q || fee
                ? 'Try a different name, address or fee tier.'
                : result.data?.deployment
                  ? 'Confirmed launches appear here automatically, with their own chart and trading terminal.'
                  : 'Deploy Hookbrew’s contracts with your treasury, then launch the first token. You can build and save your token draft now.'}
            </p>
            <div className="product-actions">
              <Button primary to="/create">
                Open launch studio
              </Button>
              {!result.data?.deployment && <Button to="/setup">Set up contracts</Button>}
            </div>
          </Glass>
        )
      )}
      <div className="product-inline market-pagination">
        <span>{result.data?.total ?? '—'} indexed tokens · USDC quote markets</span>
        <div className="product-actions">
          {offset > 0 && (
            <Button onClick={() => filter('offset', String(Math.max(0, offset - 24)))}>
              Previous
            </Button>
          )}
          {result.data?.next != null && (
            <Button onClick={() => filter('offset', String(result.data.next))}>Next</Button>
          )}
        </div>
      </div>
    </>
  )
}
