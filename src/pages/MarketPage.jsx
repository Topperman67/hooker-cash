import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { LayoutGrid, List } from 'lucide-react'
import { CoinCard, CoinSkeletons, CoinTable } from '../components/CoinList.jsx'
import { Empty, Segmented } from '../components/UI.jsx'
import { useResource } from '../lib/api.js'
import { isAddress } from '../../shared/network.mjs'

const SORTS = [
  ['trending', 'Trending'],
  ['newest', 'Newest'],
  ['mcap', 'Market cap'],
  ['volume', 'Volume'],
  ['progress', 'Curve progress'],
]
const FILTERS = [
  ['all', 'All'],
  ['quantum', 'Quantum'],
  ['graduated', 'Graduated'],
  ['tracked', 'Tracked'],
]
const VIEW_KEY = 'quantpad:market-view'

export default function MarketPage() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const sort = params.get('sort') || 'trending'
  const filter = params.get('filter') || 'all'
  const q = params.get('q') || ''
  const [text, setText] = useState(q)
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) || 'grid'
    } catch {
      return 'grid'
    }
  })
  const [offset, setOffset] = useState(0)
  useEffect(() => setText(q), [q])
  useEffect(() => setOffset(0), [sort, filter, q])
  const query = new URLSearchParams({ sort, filter, q, offset: String(offset) })
  const market = useResource(`/api/market?${query}`, 15000)

  const update = (patch) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k)
    setParams(next, { replace: true })
  }
  const changeView = (v) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {}
  }
  const items = market.data?.items || []

  return (
    <div className="wrap market">
      <header className="page-head">
        <h1>Market</h1>
        <p className="muted">
          Coins launched through Quant Pad. Paste any Meteora bonding-curve mint to open and trade it here.
        </p>
      </header>
      <div className="market-bar">
        <form
          className="market-search"
          role="search"
          aria-label="Search the market"
          onSubmit={(e) => {
            e.preventDefault()
            const value = text.trim()
            if (isAddress(value)) navigate(`/coin/${value}`)
            else update({ q: value })
          }}
        >
          <label className="sr-only" htmlFor="market-q">
            Search by name, ticker or mint
          </label>
          <input
            id="market-q"
            className="input"
            placeholder="Name, ticker or mint address"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </form>
        <Segmented
          label="Filter"
          value={filter}
          onChange={(v) => update({ filter: v === 'all' ? '' : v })}
          options={FILTERS}
        />
        <Segmented
          label="Sort"
          value={sort}
          onChange={(v) => update({ sort: v })}
          options={SORTS}
        />
        <div className="segmented" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={view === 'grid'}
            aria-label="Grid view"
            onClick={() => changeView('grid')}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            type="button"
            aria-pressed={view === 'table'}
            aria-label="Table view"
            onClick={() => changeView('table')}
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {market.loading && !market.data ? (
        <CoinSkeletons />
      ) : market.error && !market.data ? (
        <Empty title="The market could not load">{market.error}</Empty>
      ) : items.length ? (
        <>
          {view === 'grid' ? (
            <div className="coin-grid">
              {items.map((c) => (
                <CoinCard key={c.mint} coin={c} />
              ))}
            </div>
          ) : (
            <CoinTable items={items} />
          )}
          <div className="pager">
            <button
              className="btn"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 24))}
            >
              Previous
            </button>
            <span className="muted num">
              {offset + 1}–{offset + items.length} of {market.data.total}
            </span>
            <button
              className="btn"
              disabled={market.data.next == null}
              onClick={() => setOffset(market.data.next)}
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <Empty title={q ? `Nothing matches “${q}”` : 'No coins here yet'}>
          {q
            ? 'Try a ticker, a name, or paste a Meteora mint address.'
            : 'Launched coins appear here once their launch confirms.'}
        </Empty>
      )}
    </div>
  )
}
