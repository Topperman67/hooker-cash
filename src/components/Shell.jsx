import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  CircleHelp,
  ExternalLink,
  Menu,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react'
import Glass from './Glass'
import { BrandMark, Button, Logo } from './UI'
import { arc, shortenAddress } from '../config/network'
import { useChain } from '../context/ChainContext'

const NAV = [
  { to: '/', label: 'Overview', image: 'overview' },
  { to: '/market', label: 'Market', image: 'market' },
  { to: '/create', label: 'Create a token', image: 'create' },
  { to: '/trade', label: 'Trade', image: 'trade' },
  { to: '/liquidity', label: 'Liquidity', image: 'liquidity' },
  { to: '/leaderboard', label: 'Leaderboard', image: 'leaderboard' },
  { to: '/modules', label: 'Hook registry', image: 'registry' },
  { to: '/agents', label: 'Agents', image: 'agents' },
  { to: '/docs', label: 'Documentation', image: 'docs' },
]

export default function Shell({ onConnect, connected }) {
  const location = useLocation()
  const navigate = useNavigate()
  const search = useRef(null)
  const menuButton = useRef(null)
  const navigation = useRef(null)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const chain = useChain()

  useEffect(() => {
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
    const title =
      NAV.find((item) => item.to === location.pathname)?.label ||
      (location.pathname.startsWith('/token/') || location.pathname.startsWith('/asset/')
        ? 'Token terminal'
        : location.pathname === '/setup'
          ? 'Contract setup'
          : 'Terms')
    document.title = `${title} — Hookbrew`
  }, [location.pathname])
  useEffect(() => {
    function shortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        search.current?.focus()
      }
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  useEffect(() => {
    const desktop = matchMedia('(min-width: 901px)')
    const closeOnDesktop = () => {
      if (desktop.matches) setMenuOpen(false)
    }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const drawer = navigation.current.closest('aside')
    const focusable = [...drawer.querySelectorAll('a[href], button')].filter(
      (element) => element.getClientRects().length,
    )
    focusable[0]?.focus()
    function containFocus(event) {
      if (event.key !== 'Tab') return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    drawer.addEventListener('keydown', containFocus)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      drawer.removeEventListener('keydown', containFocus)
      document.body.style.overflow = previousOverflow
      menuButton.current?.focus()
    }
  }, [menuOpen])

  function submitSearch(event) {
    event.preventDefault()
    navigate(`/market${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
    setQuery('')
    search.current?.blur()
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="ambient-scene" aria-hidden="true">
        <div className="ambient-ribbon ribbon-one" />
        <div className="ambient-ribbon ribbon-two" />
      </div>
      {menuOpen && (
        <button
          className="nav-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-label="Close navigation backdrop"
          tabIndex={-1}
        />
      )}
      <Glass
        as="aside"
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
        radius={28}
        role={menuOpen ? 'dialog' : undefined}
        aria-modal={menuOpen ? true : undefined}
        aria-label="Site navigation"
      >
        <button
          type="button"
          className="sidebar-close icon-button"
          onClick={() => setMenuOpen(false)}
          aria-label="Close navigation"
        >
          <X size={18} />
        </button>
        <Link
          to="/"
          className="sidebar-brand"
          aria-label="Hookbrew overview"
          onClick={() => setMenuOpen(false)}
        >
          <Logo />
        </Link>
        <div className="sidebar-caption">Token launchpad on Arc</div>
        <nav ref={navigation} aria-label="Primary navigation" id="primary-navigation">
          {NAV.map(({ to, label, image }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  <img
                    className="nav-artwork"
                    src={`/brand/navigation/platinum/${image}.png`}
                    alt=""
                    width="36"
                    height="36"
                  />
                  <span className="nav-label">{label}</span>
                  {isActive && <span className="nav-active-dot" />}
                  {to === '/create' && !isActive && <span className="nav-plus">+</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-network" aria-label="Arc network status">
            <div className="sidebar-network-heading">
              <BrandMark name="arc" />
              <div>
                <strong>Arc mainnet</strong>
                <span className="sidebar-network-state">
                  <i
                    className={chain.status === 'ready' ? 'is-connected' : ''}
                    aria-hidden="true"
                  />
                  {chain.status === 'ready'
                    ? 'Network connected'
                    : chain.status === 'loading'
                      ? 'Connecting…'
                      : 'Connection unavailable'}
                </span>
              </div>
            </div>
            <div className="sidebar-network-block">
              <span>Latest block</span>
              <span>
                {chain.status === 'ready'
                  ? BigInt(chain.network.blockNumber).toLocaleString('en-US')
                  : '—'}
              </span>
            </div>
            <a href={arc.blockExplorers.default.url} target="_blank" rel="noreferrer">
              Open explorer <ArrowUpRight size={12} />
            </a>
          </div>
          <Link to="/docs" className="sidebar-help">
            <CircleHelp size={17} />
            <span>Help & resources</span>
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </Glass>

      <div className="main-col" inert={menuOpen ? true : undefined}>
        <header className="topbar">
          <button
            ref={menuButton}
            className="mobile-menu icon-button"
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={menuOpen}
            aria-controls="primary-navigation"
          >
            {menuOpen ? <X size={23} /> : <Menu size={23} />}
          </button>
          <Link className="mobile-brand" to="/" aria-label="Hookbrew overview">
            <Logo compact />
          </Link>
          <Glass
            as="form"
            variant="control"
            className="top-search"
            role="search"
            onSubmit={submitSearch}
          >
            <Search size={17} />
            <input
              ref={search}
              aria-label="Search token contract address"
              placeholder="Token contract address…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
          </Glass>
          <div className="top-actions">
            <Glass
              variant="pill"
              className="network-chip"
              title={
                chain.status === 'ready'
                  ? `Latest RPC block: ${chain.network.blockNumber}`
                  : 'Arc RPC unavailable or still connecting'
              }
            >
              <BrandMark name="arc" />
              Arc
              <span className={`status-dot ${chain.status !== 'ready' ? 'status-offline' : ''}`} />
            </Glass>
            <Button primary onClick={onConnect} className="connect-button">
              <Wallet size={16} />
              <span>{connected ? shortenAddress(connected) : 'Connect wallet'}</span>
            </Button>
          </div>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet context={{ onConnect, connected }} />
          <footer className="footer-note">
            <span>
              <ShieldCheck size={14} /> Your wallet controls signing.
            </span>
            <div>
              <Link to="/docs">Docs</Link>
              <Link to="/terms">Terms</Link>
              <a href="https://hooker.cash/" target="_blank" rel="noreferrer">
                Original project <ExternalLink size={11} />
              </a>
              <span>© 2026 Hookbrew</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  )
}
