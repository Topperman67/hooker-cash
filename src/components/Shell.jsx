import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Menu, Wallet, X } from 'lucide-react'
import Logo from './Logo.jsx'
import { MeteoraMark } from './Meteora.jsx'
import SearchBox from './SearchBox.jsx'
import Tape from './Tape.jsx'
import Glass from './Glass.jsx'
import StudioLights from './StudioLights.jsx'
import WalletDialog from './WalletDialog.jsx'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { short, sol, toSol, usd } from '../lib/format.js'

const LINKS = [
  ['/launch', 'Launch'],
  ['/market', 'Market'],
  ['/hooks', 'Quantum Hooks'],
  ['/portfolio', 'Portfolio'],
  ['/docs', 'Docs'],
]

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
  const toggle = useRef(null)
  useEffect(() => {
    setMenu(false)
    window.scrollTo(0, 0)
  }, [location.pathname])
  // Escape closes the open menu and puts focus back on its toggle. An open dialog handles Escape
  // first (it marks the event as handled).
  useEffect(() => {
    if (!menu) return
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setMenu(false)
      toggle.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menu])
  return (
    <div className="app">
      <StudioLights />
      <header className="topbar">
        <div className="wrap">
          <Glass variant="bar" className="topbar-capsule">
            <div className="topbar-inner">
              <Link to="/" className="brand" aria-label="Quant Pad home">
                <Logo />
              </Link>
              <a
                href="https://www.meteora.ag"
                target="_blank"
                rel="noreferrer"
                className="built-on built-on-top"
                title="Coins launch and trade on Meteora"
              >
                <MeteoraMark size={16} /> <span>Built on Meteora</span>
              </a>
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
                  ref={toggle}
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
          </Glass>
        </div>
      </header>
      <Tape />
      <main className="app-main">{children}</main>
      <footer className="footer">
        <div className="wrap footer-inner">
          <div>
            <Logo tone="dark" className="footer-lockup" />
            <p>
              Quant Pad launches coins on Meteora’s Dynamic Bonding Curve on Solana and routes their
              creator fees through Quantum Hooks. Memecoins are extremely risky. Nothing here is
              financial advice.
              {solUsd ? <span className="num"> SOL {usd(solUsd)}.</span> : null}
            </p>
          </div>
          <div className="footer-links">
            <Link to="/hooks">Quantum Hooks</Link>
            <Link to="/docs">Docs</Link>
            <Link to="/terms">Terms</Link>
            <a
              href="https://x.com/quantpadhook"
              target="_blank"
              rel="noreferrer"
              className="built-on"
              aria-label="Quant Pad on X"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              @quantpadhook
            </a>
            <a href="https://www.meteora.ag" target="_blank" rel="noreferrer" className="built-on">
              Built on <MeteoraMark size={16} /> Meteora
            </a>
          </div>
        </div>
      </footer>
      {dialogOpen && <WalletDialog />}
    </div>
  )
}
