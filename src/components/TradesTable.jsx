import { useState } from 'react'
import { useResource } from '../lib/api.js'
import { Segmented } from './UI.jsx'
import { ago, formatUnits, short, sol, toSol } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'
import Price from './Price.js'

/** Credit for market data served from GeckoTerminal's public API (its terms ask for one). */
export function DataCredit() {
  return (
    <p className="data-credit">
      Data:{' '}
      <a href="https://www.geckoterminal.com/" target="_blank" rel="noreferrer">
        GeckoTerminal
      </a>
    </p>
  )
}

// `tradesPath` reads the trades from another route of the same shape (the $QUANTP page's
// /api/quantp/trades); a response with `source: 'geckoterminal'` credits GeckoTerminal.
export default function TradesTable({ mint, symbol, launcher, decimals, tradesPath }) {
  const [side, setSide] = useState('')
  const path = tradesPath || `/api/coins/${mint}/trades`
  const trades = useResource(`${path}${side ? `?side=${side}` : ''}`, 8000)
  const items = trades.data?.items || []
  return (
    <section className="instrument" aria-labelledby="trades-title" style={{ padding: 0 }}>
      <div className="panel-head" style={{ padding: '16px 16px 0' }}>
        <h2 id="trades-title" className="h3">
          Trades
        </h2>
        <Segmented
          label="Filter trades"
          value={side}
          onChange={setSide}
          options={[
            ['', 'All'],
            ['buy', 'Buys'],
            ['sell', 'Sells'],
          ]}
        />
      </div>
      {items.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Age</th>
                <th>Side</th>
                <th className="right">SOL</th>
                <th className="right">{symbol}</th>
                <th className="right">Price</th>
                <th>Trader</th>
                <th className="right">Tx</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td className="num faint">{ago(t.timestamp)}</td>
                  <td className={t.side === 'buy' ? 'up' : 'down'}>
                    {t.side === 'buy' ? 'Buy' : 'Sell'}
                  </td>
                  <td className="right num">{sol(toSol(t.solAmount), { unit: false })}</td>
                  <td className="right num">{formatUnits(t.tokenAmount, decimals ?? 6, 0)}</td>
                  <td className="right num">
                    <Price value={t.price} />
                  </td>
                  <td>
                    <a
                      href={explorer.account(t.trader)}
                      target="_blank"
                      rel="noreferrer"
                      className="num"
                    >
                      {short(t.trader)}
                    </a>
                    {t.trader === launcher && (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        Dev
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <a
                      href={explorer.tx(t.signature)}
                      target="_blank"
                      rel="noreferrer"
                      className="faint"
                    >
                      {t.signature.slice(0, 6)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ padding: 16 }}>
          {trades.loading
            ? 'Loading trades…'
            : trades.error ||
              'No trades indexed yet. They appear within a few seconds of confirming.'}
        </p>
      )}
      {trades.data?.source === 'geckoterminal' && <DataCredit />}
    </section>
  )
}
