import { useMemo, useState } from 'react'
import { ALL_MODULES, FEE_TIERS, GATE_MODULES, VALUE_MODULES } from '../data'

export default function CreatePage() {
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [fee, setFee] = useState(FEE_TIERS[1].fee)
  const [creatorCut, setCreatorCut] = useState(70)
  const [selected, setSelected] = useState(() => new Set(['velvet', 'ashtray']))
  const [quote, setQuote] = useState('USDC')
  const [seed, setSeed] = useState('1.0')

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedList = useMemo(
    () => ALL_MODULES.filter((m) => selected.has(m.id)),
    [selected],
  )

  const weightSum = selectedList.filter((m) => m.lane === 'value').length * 20

  return (
    <>
      <div className="create-head">
        <div className="eyebrow">Hook builder · V1</div>
        <h1>Launch a token</h1>
        <p className="page-sub" style={{ marginBottom: 0 }}>
          Assemble vetted modules, set the 70/30 harvest split, mint into a real Uniswap V4 pool. Demo UI —
          connect wallet + factory for live launches.
        </p>
      </div>

      <div className="create-grid">
        <div className="panel panel-pad">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cash Money" />
          </div>
          <div className="field">
            <label>Symbol</label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 10))}
              placeholder="CASH"
            />
          </div>
          <div className="grid-2">
            <div className="field">
              <label>Trade against</label>
              <select value={quote} onChange={(e) => setQuote(e.target.value)}>
                <option>USDC</option>
                <option>WETH</option>
                <option>USDG</option>
              </select>
            </div>
            <div className="field">
              <label>Seed liquidity ({quote})</label>
              <input value={seed} onChange={(e) => setSeed(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>Pool fee tier</label>
            <select value={fee} onChange={(e) => setFee(Number(e.target.value))}>
              {FEE_TIERS.map((t) => (
                <option key={t.fee} value={t.fee}>
                  {t.label} · tick {t.tickSpacing}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Creator harvest cut · {creatorCut}% (protocol {100 - creatorCut}%)</label>
            <input
              type="range"
              min={30}
              max={70}
              value={creatorCut}
              onChange={(e) => setCreatorCut(Number(e.target.value))}
            />
          </div>

          <div className="lane-label" style={{ marginTop: 8 }}>
            Gates · beforeSwap
          </div>
          {GATE_MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mod-toggle${selected.has(m.id) ? ' on' : ''}`}
              onClick={() => toggle(m.id)}
            >
              <span>
                <div style={{ color: 'var(--text-h)', fontWeight: 700, fontSize: 13 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{m.blurb}</div>
              </span>
              <span className="switch" />
            </button>
          ))}

          <div className="lane-label" style={{ marginTop: 14 }}>
            Values · harvest
          </div>
          {VALUE_MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`mod-toggle${selected.has(m.id) ? ' on' : ''}`}
              onClick={() => toggle(m.id)}
            >
              <span>
                <div style={{ color: 'var(--text-h)', fontWeight: 700, fontSize: 13 }}>{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{m.blurb}</div>
              </span>
              <span className="switch" />
            </button>
          ))}
        </div>

        <div>
          <div className="panel panel-pad" style={{ marginBottom: 12 }}>
            <div style={{ color: 'var(--text-h)', fontWeight: 700, marginBottom: 12 }}>Launch preview</div>
            <div className="preview-stat">
              <span>Token</span>
              <span>
                {name || '—'} / ${symbol || '—'}
              </span>
            </div>
            <div className="preview-stat">
              <span>Quote</span>
              <span>{quote}</span>
            </div>
            <div className="preview-stat">
              <span>Fee tier</span>
              <span>{FEE_TIERS.find((t) => t.fee === fee)?.label}</span>
            </div>
            <div className="preview-stat">
              <span>Creator cut</span>
              <span>
                {creatorCut}/{100 - creatorCut}
              </span>
            </div>
            <div className="preview-stat">
              <span>Modules</span>
              <span>{selectedList.length}</span>
            </div>
            <div className="preview-stat">
              <span>Value weight Σ</span>
              <span className={weightSum > 100 ? 'down' : 'up'}>{weightSum}% {weightSum > 100 ? 'over cap' : 'ok'}</span>
            </div>
            <div className="preview-stat" style={{ borderBottom: 'none' }}>
              <span>Liquidity</span>
              <span>sealed · no remove</span>
            </div>
            <button className="btn btn-primary btn-lg" type="button" style={{ width: '100%', marginTop: 16 }}>
              Connect & launch
            </button>
            <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '12px 0 0', lineHeight: 1.4 }}>
              👋 Explore freely. Live mint needs wallet + factory deployment. Experimental module surface —
              use at your own risk.
            </p>
          </div>
          <div className="panel panel-pad">
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>Selected stack</div>
            <div className="hook-chips">
              {selectedList.map((m) => (
                <span key={m.id} className={`tag tag-${m.tag}`}>
                  {m.name}
                </span>
              ))}
              {!selectedList.length && <span className="hook-chip">none yet</span>}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
