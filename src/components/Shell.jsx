import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { BRAND } from '../data'

const NAV = [
  { to: '/', label: 'Home', icon: '⌂' },
  { to: '/market', label: 'Market', icon: '▦' },
  { to: '/create', label: 'Create', icon: '＋' },
  { to: '/trade', label: 'Trade', icon: '⇄' },
  { to: '/liquidity', label: 'Liquidity', icon: '◇' },
  { to: '/leaderboard', label: 'Board', icon: '♛' },
  { to: '/modules', label: 'Modules', icon: '⬢' },
  { to: '/agents', label: 'Agents', icon: '◈' },
  { to: '/docs', label: 'Docs', icon: '☰' },
]

export default function Shell({ onConnect, connected }) {
  const loc = useLocation()

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary">
        <NavLink to="/" className="rail-logo" title={BRAND.name}>
          H
        </NavLink>
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span aria-hidden>{n.icon}</span>
            <span className="tip">{n.label}</span>
          </NavLink>
        ))}
        <div className="rail-spacer" />
        <NavLink to="/terms" className="nav-item">
          <span aria-hidden>§</span>
          <span className="tip">Terms</span>
        </NavLink>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="brand-word">
            hooker<em>.cash</em>
          </div>
          <div className="top-search">
            <span aria-hidden>⌕</span>
            <input placeholder="Search tokens, hooks, creators…" />
          </div>
          <div className="top-actions">
            <span className="chip">
              <span className="dot" />
              {BRAND.chain}
            </span>
            <span className="chip">Node ▾</span>
            <button className="btn btn-primary btn-sm" type="button" onClick={onConnect}>
              {connected ? `${connected.slice(0, 6)}…${connected.slice(-4)}` : 'Connect'}
            </button>
          </div>
        </header>

        <main className="content" key={loc.pathname}>
          <Outlet />
          <footer className="footer-note">
            <span>
              ⚠️ Non-custodial interface to permissionless contracts. Anyone can deploy tokens — DYOR.
            </span>
            <span style={{ display: 'flex', gap: 14 }}>
              <a href="/docs">Docs</a>
              <a href="/terms">Terms</a>
              <a href="https://hooker.cash/" target="_blank" rel="noreferrer">
                Original reference
              </a>
              <span>© 2026 Hooker vamp</span>
            </span>
          </footer>
        </main>
      </div>
    </div>
  )
}
