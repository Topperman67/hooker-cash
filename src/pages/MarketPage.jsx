import { useMemo, useState } from 'react'
import { DEMO_TOKENS } from '../data'
import { TokenCard } from './HomePage'

export default function MarketPage() {
  const [view, setView] = useState('tiles')
  const [sort, setSort] = useState('vol')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    let list = [...DEMO_TOKENS]
    if (q.trim()) {
      const s = q.toLowerCase()
      list = list.filter(
        (t) => t.name.toLowerCase().includes(s) || t.symbol.toLowerCase().includes(s),
      )
    }
    list.sort((a, b) => {
      if (sort === 'mcap') return b.mcap - a.mcap
      if (sort === 'chg') return b.change24h - a.change24h
      return b.vol24h - a.vol24h
    })
    return list
  }, [q, sort])

  return (
    <>
      <h1 className="page-title">Market</h1>
      <p className="page-sub">Cash money, fast hookers. Live launches on Arc — demo data until indexer is wired.</p>

      <div className="feed-toolbar">
        <div className="seg">
          <button type="button" className={view === 'tiles' ? 'on' : ''} onClick={() => setView('tiles')}>
            ▦ Tiles
          </button>
          <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            ☰ List
          </button>
        </div>
        <div className="seg">
          {[
            ['vol', '24h vol'],
            ['mcap', 'mcap'],
            ['chg', '24h %'],
          ].map(([k, label]) => (
            <button key={k} type="button" className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="top-search" style={{ maxWidth: 260, marginLeft: 'auto' }}>
          <span>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tokens…" />
        </div>
      </div>

      {view === 'tiles' ? (
        <div className="token-grid">
          {rows.map((t) => (
            <TokenCard key={t.id} t={t} />
          ))}
        </div>
      ) : (
        <div className="panel" style={{ overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Price</th>
                <th>Mcap</th>
                <th>24h</th>
                <th>Vol</th>
                <th>Liq</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong style={{ color: 'var(--text-h)' }}>{t.name}</strong>{' '}
                    <span className="mono">${t.symbol}</span>
                  </td>
                  <td className="mono">${t.price}</td>
                  <td className="mono">${(t.mcap / 1000).toFixed(1)}K</td>
                  <td className={t.change24h >= 0 ? 'up' : 'down'}>
                    {t.change24h >= 0 ? '+' : ''}
                    {t.change24h.toFixed(1)}%
                  </td>
                  <td className="mono">${(t.vol24h / 1000).toFixed(1)}K</td>
                  <td className="mono">${(t.liq / 1000).toFixed(1)}K</td>
                  <td className="mono">{t.age}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
