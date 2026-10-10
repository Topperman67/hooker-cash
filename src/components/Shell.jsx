import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Menu, Search, Wallet, X } from 'lucide-react'
import Logo from './Logo.jsx'
import Tape from './Tape.jsx'
import WalletDialog from './WalletDialog.jsx'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { isAddress } from '../../shared/network.mjs'
import { short, sol, toSol, usd } from '../lib/format.js'

const LINKS = [
  ['/launch', 'Launch'],
  ['/market', 'Market'],
  ['/hooks', 'Quantum Hooks'],
  ['/portfolio', 'Portfolio'],
  ['/docs', 'Docs'],
]

function SearchBox({ onDone }) {
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  return (
    <form
      className="topbar-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        const value = q.trim()
        if (!value) return
        navigate(isAddress(value) ? `/coin/${value}` : `/market?q=${encodeURIComponent(value)}`)
        setQ('')
        onDone?.()
      }}
    >
      <Search size={16} aria-hidden="true" />
      <label className="sr-only" htmlFor="global-search">
        Search coins or paste a mint address
      </label>
      <input
        id="global-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search or paste a mint"
        autoComplete="off"
        spellCheck="false"
      />
    </form>
  )
}

function WalletButton() {
  const { connected, address, balance, openDialog, wallet } = useWallet()
  if (!connected)
    return (
      <button className="btn btn-primary" onClick={openDialog}>
        <Wallet size={16} aria-hidden="true" /> Connect
      </button>
    )
  return (
    <button className="btn" onClick={openDialog} aria-label="Wallet details">
      {wallet?.icon && (
        <img src={wallet.icon} alt="" width="18" height="18" style={{ borderRadius: 5 }} />
      )}
      <span className="num">
        {balance == null ? short(address) : sol(toSol(balance), { digits: 3 })}
      </span>
    </button>
  )
}

export default function Shell({ children }) {
  const [menu, setMenu] = useState(false)
  const location = useLocation()
  const { solUsd } = usePlatform()
  const { dialogOpen } = useWallet()
  useEffect(() => {
    setMenu(false)
    window.scrollTo(0, 0)
  }, [location.pathname])
  return (
    <div className="app">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <Link to="/" className="brand" aria-label="Quant Pad home">
            <Logo />
          </Link>
          <nav className="nav" aria-label="Main">
            {LINKS.map(([to, label]) => (
              <NavLink key={to} to={to}>
                {label}
              </NavLink>
            ))}
          </nav>
          <SearchBox />
          <div className="topbar-actions">
            <WalletButton />
            <button
              className="btn btn-ghost icon-btn menu-toggle"
              aria-label={menu ? 'Close menu' : 'Open menu'}
              aria-expanded={menu}
              aria-controls="mobile-nav"
              onClick={() => setMenu((m) => !m)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
        <nav id="mobile-nav" className="mobile-nav" hidden={!menu} aria-label="Main">
          <SearchBox onDone={() => setMenu(false)} />
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to}>
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Tape />
      <main className="app-main">{children}</main>
      <footer className="footer">
        <div className="wrap footer-inner">
          <div>
            <Logo tone="dark" className="footer-lockup" />
            <p>
              Quant Pad launches coins through pump.fun on Solana and routes their creator fees
              through Quantum Hooks. Memecoins are extremely risky. Nothing here is financial
              advice.
              {solUsd ? <span className="num"> SOL {usd(solUsd)}.</span> : null}
            </p>
          </div>
          <div className="footer-links">
            <Link to="/hooks">Quantum Hooks</Link>
            <Link to="/docs">Docs</Link>
            <Link to="/terms">Terms</Link>
            <a href="https://pump.fun" target="_blank" rel="noreferrer">
              pump.fun
            </a>
          </div>
        </div>
      </footer>
      {dialogOpen && <WalletDialog />}
    </div>
  )
}
