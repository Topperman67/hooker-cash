import { useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { isAddress } from 'viem'
import { ArrowUpRight, Copy, Globe } from 'lucide-react'
import Glass from '../components/Glass'
import { Button, PageHeading, TokenAvatar } from '../components/UI'
import MarketChart from '../components/MarketChart'
import TradeTicket from '../components/TradeTicket'
import CreatorPosition from '../components/CreatorPosition'
import { Metric } from '../components/LaunchStudio'
import { useResource, number, compact, short, safeLink } from '../lib/api'
import TokenLookup from '../components/TokenLookup'
export default function TokenTerminal() {
  const { id } = useParams(),
    [params] = useSearchParams(),
    [tab, setTab] = useState('activity'),
    [side, setSide] = useState(''),
    [offset, setOffset] = useState(0),
    [copied, setCopied] = useState(false)
  const valid = isAddress(id || ''),
    detail = useResource(valid ? `/api/tokens/${id}` : null, 10000),
    trades = useResource(
      valid ? `/api/tokens/${id}/trades?side=${side}&offset=${offset}` : null,
      10000,
    )
  const token = detail.data?.token,
    deployment = detail.data?.deployment
  if (!token)
    return (
      <>
        <PageHeading
          title={params.get('launched') ? 'Your token is on-chain.' : 'Token terminal'}
          description={
            params.get('launched')
              ? 'Waiting for the market index to reach your confirmed launch. This page refreshes automatically.'
              : 'Load a Hookbrew token to chart its market and trade.'
          }
        />
        <Glass className="product-empty">
          <h2>
            {detail.loading
              ? 'Reading the market…'
              : valid
                ? 'Market not available yet'
                : 'Enter a valid token address'}
          </h2>
          <p>{detail.error}</p>
          {params.get('launched') && /^0x[\da-f]{64}$/i.test(params.get('launched')) && (
            <a
              href={`https://explorer.arc.io/tx/${params.get('launched')}`}
              target="_blank"
              rel="noreferrer"
            >
              View confirmed launch ↗
            </a>
          )}
          <Button onClick={detail.refresh}>Refresh market</Button>
          <Button to="/market">Browse markets</Button>
        </Glass>
        {valid && <TokenLookup address={id} />}
      </>
    )
  async function copy() {
    try {
      await navigator.clipboard.writeText(token.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  const metadata = token.metadata || {},
    change = token.change24h
  return (
    <div className="terminal">
      <Link to="/market" className="terminal-back">
        ← All markets
      </Link>
      <div className="terminal-header">
        <div className="terminal-identity">
          <TokenAvatar token={token} />
          <div>
            <div className="product-inline">
              <h1>{token.name}</h1>
              <span className="product-badge">{token.symbol}</span>
            </div>
            <div className="token-links">
              <button onClick={copy}>
                <Copy size={12} /> {copied ? 'Copied' : short(token.address)}
              </button>
              <a
                href={`https://explorer.arc.io/address/${token.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Contract <ArrowUpRight size={12} />
              </a>
              {[
                ['website', 'Website'],
                ['twitter', 'X'],
                ['telegram', 'Telegram'],
              ]
                .filter(([key]) => safeLink(metadata[key]))
                .map(([key, label]) => (
                  <a key={key} href={metadata[key]} target="_blank" rel="noreferrer">
                    <Globe size={12} />
                    {label}
                  </a>
                ))}
            </div>
          </div>
        </div>
        <span className="product-badge">Arc · V4 pool · {token.fee / 10000}% fee</span>
      </div>
      <div className="terminal-metrics">
        <Metric label="PRICE / USDC" value={number(token.price, 10)} />
        <Metric label="MARKET CAP / USDC" value={compact(token.marketCap)} />
        <Metric label="24H VOLUME / USDC" value={compact(token.volume24h)} />
        <Metric
          label="24H CHANGE"
          value={change == null ? '—' : `${change >= 0 ? '+' : ''}${number(change)}%`}
        />
      </div>
      {detail.error && <p className="form-error">Market refresh failed: {detail.error}</p>}
      {detail.data.index?.error && (
        <p className="form-error">Index delayed: {detail.data.index.error}</p>
      )}
      <div className="terminal-grid">
        <div className="terminal-main">
          <MarketChart address={token.address} symbol={token.symbol} />
          <Glass className="terminal-bottom" radius={24}>
            <div className="terminal-tabs" role="tablist" aria-label="Token information">
              {['activity', 'details', 'rewards'].map((t) => (
                <button role="tab" aria-selected={tab === t} key={t} onClick={() => setTab(t)}>
                  {t === 'activity'
                    ? 'Recent trades'
                    : t === 'details'
                      ? 'Token details'
                      : 'Creator & vesting'}
                </button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'activity' && (
                <>
                  <div className="activity-filters">
                    <span>{trades.data?.total || 0} trades</span>
                    <select
                      aria-label="Filter trade side"
                      value={side}
                      onChange={(e) => {
                        setSide(e.target.value)
                        setOffset(0)
                      }}
                    >
                      <option value="">All trades</option>
                      <option value="buy">Buys</option>
                      <option value="sell">Sells</option>
                    </select>
                  </div>
                  <div className="table-scroll">
                    <table className="product-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Side</th>
                          <th>USDC</th>
                          <th>{token.symbol}</th>
                          <th>Trader</th>
                          <th>Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.data?.items.map((t) => (
                          <tr key={t.id}>
                            <td>{new Date(t.timestamp * 1000).toLocaleTimeString()}</td>
                            <td className={t.side === 'buy' ? 'text-mint' : 'text-rose'}>
                              {t.side}
                            </td>
                            <td>{number(t.quoteAmount, 4)}</td>
                            <td>{compact(Number(t.tokenAmount))}</td>
                            <td>
                              {t.trader ? (
                                <a
                                  href={`https://explorer.arc.io/address/${t.trader}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {short(t.trader)}
                                </a>
                              ) : (
                                'External route'
                              )}
                            </td>
                            <td>
                              <a
                                aria-label="View trade transaction"
                                href={`https://explorer.arc.io/tx/${t.transactionHash}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                ↗
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!trades.data?.items.length && (
                    <p className="table-empty">
                      {trades.error || 'No confirmed swaps yet. Your first trade will appear here.'}
                    </p>
                  )}
                  <div className="product-actions">
                    {offset > 0 && (
                      <Button onClick={() => setOffset(Math.max(0, offset - 50))}>Newer</Button>
                    )}
                    {trades.data?.next != null && (
                      <Button onClick={() => setOffset(trades.data.next)}>Older</Button>
                    )}
                  </div>
                </>
              )}
              {tab === 'details' && (
                <div className="token-description">
                  <p>{metadata.description || 'No description provided.'}</p>
                  <div className="review-list">
                    {[
                      ['Creator', token.creator],
                      ['Factory / hook', token.hook],
                      ['Pool ID', token.poolId],
                      ['Supply', `${number(token.totalSupply)} ${token.symbol}`],
                      ['Founder allocation', `${number(token.founderTokens)} ${token.symbol}`],
                      ['Created', new Date(token.createdAt * 1000).toLocaleString()],
                      ['Router', deployment.router],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  <p>
                    Fixed supply. No additional minting, token freeze, or transfer tax. Seed
                    liquidity stays in the factory; its fees are harvested separately.
                  </p>
                </div>
              )}
              {tab === 'rewards' && <CreatorPosition token={token} />}
            </div>
          </Glass>
        </div>
        <aside>
          <TradeTicket
            key={token.address}
            token={token}
            onTrade={() => {
              detail.refresh()
              trades.refresh()
            }}
          />
          <div className="terminal-footnote">
            <span className="status-dot" /> Real pool quotes. Transactions signed by you.
          </div>
        </aside>
      </div>
    </div>
  )
}
