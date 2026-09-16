import { useState } from 'react'
import { DEMO_TOKENS, fmtUsd } from '../data'

export default function TradePage() {
  const [pay, setPay] = useState('100')
  const [token, setToken] = useState(DEMO_TOKENS[0].id)
  const t = DEMO_TOKENS.find((x) => x.id === token) || DEMO_TOKENS[0]
  const out = t.price > 0 ? (Number(pay) || 0) / t.price : 0

  return (
    <>
      <h1 className="page-title">Trade</h1>
      <p className="page-sub">Route across V4 pools. 0 platform fee on the demo desk — you only pay pool fees.</p>

      <div className="trade-layout">
        <div className="panel panel-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ color: 'var(--text-h)', fontWeight: 700 }}>
                {t.name} <span className="mono">${t.symbol}</span>
              </div>
              <div className="mono" style={{ marginTop: 4 }}>
                {fmtUsd(t.price)}{' '}
                <span className={t.change24h >= 0 ? 'up' : 'down'}>
                  {t.change24h >= 0 ? '+' : ''}
                  {t.change24h.toFixed(1)}%
                </span>
              </div>
            </div>
            <select
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{
                height: 36,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg-0)',
                padding: '0 10px',
              }}
            >
              {DEMO_TOKENS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.symbol}
                </option>
              ))}
            </select>
          </div>
          <div className="chart-fake">
            <svg viewBox="0 0 400 160" preserveAspectRatio="none">
              <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#16c784" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#16c784" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0,120 C40,110 60,90 100,95 S160,40 200,55 260,20 300,35 360,10 400,25 L400,160 L0,160 Z"
                fill="url(#g)"
              />
              <path
                d="M0,120 C40,110 60,90 100,95 S160,40 200,55 260,20 300,35 360,10 400,25"
                fill="none"
                stroke="#16c784"
                strokeWidth="2.5"
              />
            </svg>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginTop: 14 }}>
            {[
              ['Mcap', fmtUsd(t.mcap)],
              ['Vol 24h', fmtUsd(t.vol24h)],
              ['Liq', fmtUsd(t.liq)],
              ['Trades', t.trades.toLocaleString()],
            ].map(([k, v]) => (
              <div key={k} className="panel panel-pad" style={{ padding: 10, background: 'var(--bg-0)' }}>
                <div className="metric-label">{k}</div>
                <div className="metric-value">{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel-pad swap-box">
          <div className="row">
            <span>You pay</span>
            <span>Balance —</span>
          </div>
          <div className="swap-leg">
            <input value={pay} onChange={(e) => setPay(e.target.value.replace(/[^0-9.]/g, ''))} />
            <span className="chip">USDC</span>
          </div>
          <div className="row">
            <span>You get (est.)</span>
            <span>Route · V4</span>
          </div>
          <div className="swap-leg">
            <input readOnly value={out ? out.toFixed(2) : '0'} />
            <span className="chip">${t.symbol}</span>
          </div>
          <div className="preview-stat">
            <span>Slippage</span>
            <span>1.0%</span>
          </div>
          <div className="preview-stat">
            <span>Price impact</span>
            <span className="up">&lt; 0.5%</span>
          </div>
          <div className="preview-stat" style={{ borderBottom: 'none' }}>
            <span>Pool fee</span>
            <span>0.25%</span>
          </div>
          <button className="btn btn-primary btn-lg" type="button" style={{ width: '100%', marginTop: 12 }}>
            Connect wallet
          </button>
        </div>
      </div>
    </>
  )
}
