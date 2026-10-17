import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Menu, Wallet, X } from 'lucide-react'
import Logo from './Logo.jsx'
import { MeteoraMark } from './Meteora.jsx'
import SearchBox from './SearchBox.jsx'
import Tape from './Tape.jsx'
import Glass from './Glass.jsx'
import StudioLights from './StudioLights.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import WalletDialog from './WalletDialog.jsx'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { Address } from './UI.jsx'
import { changeClass, QuantpPrice, useQuantpFigures } from './QuantpShowcase.jsx'
import { ENGINE_PATH } from './quantpPayouts.js'
import { pct, short, sol, toSol, usd } from '../lib/format.js'
import { DOCS_URL } from '../lib/links.js'
import { explorer, QUANTP } from '../../shared/network.mjs'

const LINKS = [
  ['/launch', 'Launch'],
  ['/market', 'Market'],
  ['/hooks', 'Quantum Hooks'],
  [ENGINE_PATH, 'Payout Engine'],
  ['/portfolio', 'Portfolio'],
]

// The docs live on GitBook. In the header the link shimmers blue every 3 s (shell.css).
function DocsLink({ onClick }) {
  return (
    <a href={DOCS_URL} target="_blank" rel="noreferrer" className="nav-docs" onClick={onClick}>
      Docs
    </a>
  )
}

function WalletButton() {
  const { connected, address, balance, openDialog, wallet } = useWallet()
  if (!connected)
    return (
      <button className="btn btn-primary wallet-btn" onClick={openDialog}>
        <Wallet size={16} aria-hidden="true" /> <span className="wallet-label">Connect</span>
      </button>
    )
  return (
    <button className="btn wallet-btn" onClick={openDialog} aria-label="Wallet details">
      {wallet?.icon ? (
        <img src={wallet.icon} alt="" width="18" height="18" style={{ borderRadius: 5 }} />
      ) : (
        <Wallet size={16} aria-hidden="true" />
      )}
      <span className="num wallet-label">
        {balance == null ? short(address) : sol(toSol(balance), { digits: 3 })}
      </span>
    </button>
  )
}

// The menu's $QUANTP row, under its search: one link to the token page.
function QuantpMenuRow() {
  const { q, f } = useQuantpFigures()
  return (
    <Link to={q.path} className="qp-menu">
      <img src="/brand/mark-small-dark.svg" alt="" width="24" height="24" />
      <span className="qp-menu-id">
        <strong>${q.symbol}</strong>
        <small>Quant Pad’s own token</small>
      </span>
      <span className="qp-menu-price num">
        <span>
          <QuantpPrice f={f} />
        </span>
        <span className={changeClass(f.change)}>{pct(f.change)}</span>
      </span>
      <span className="qp-menu-buy">Buy</span>
    </Link>
  )
}

// The footer's $QUANTP row: the contract with a copy button, and where to trade and track it.
function QuantpFooter() {
  const { q } = useQuantpFigures()
  return (
    <div className="footer-token">
      <div className="footer-token-row">
        <span className="footer-token-name">
          <img src="/brand/mark-small-dark.svg" alt="" width="18" height="18" />
          <strong>${q.symbol}</strong>
          <span>Quant Pad’s own token</span>
        </span>
        <Address value={q.mint} head={6} tail={6} href={explorer.token(q.mint)} />
        <span className="footer-token-links">
          <Link to={q.path}>Trade</Link>
          <a href={q.dexscreener} target="_blank" rel="noreferrer">
            Chart
          </a>
          <a href={explorer.token(q.mint)} target="_blank" rel="noreferrer">
            Solscan
          </a>
        </span>
      </div>
      <p className="footer-token-note">
        Quant Pad’s own token. Its fee split is paid out every hour by Quant Pad’s payout engine
        from a wallet the team funds; nothing on-chain enforces it.
      </p>
    </div>
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
                aria-label="Built on Meteora"
              >
                <MeteoraMark size={16} /> <span>Built on Meteora</span>
              </a>
              <nav className="nav" aria-label="Main">
                {LINKS.map(([to, label]) => (
                  <NavLink key={to} to={to}>
                    {label}
                  </NavLink>
                ))}
                <DocsLink />
              </nav>
              <SearchBox />
              <div className="topbar-actions">
                <ThemeToggle />
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
              <QuantpMenuRow />
              {LINKS.map(([to, label]) => (
                <NavLink key={to} to={to}>
                  {label}
                </NavLink>
              ))}
              <DocsLink onClick={() => setMenu(false)} />
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
            <QuantpFooter />
          </div>
          <div className="footer-links">
            <Link to={QUANTP.path}>${QUANTP.symbol}</Link>
            <Link to={ENGINE_PATH}>Payout Engine</Link>
            <Link to="/hooks">Quantum Hooks</Link>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              Docs
            </a>
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
            <a
              href="https://t.me/+3wl4eNhZcaNkNmM5"
              target="_blank"
              rel="noreferrer"
              className="built-on"
              aria-label="Join the Quant Pad Telegram"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M2.4 11.4 20.3 4.5c.8-.3 1.6.2 1.4 1.5l-3 14.2c-.2 1-.8 1.3-1.6.8l-4.5-3.3-2.2 2.1c-.2.2-.5.5-.9.5l.3-4.6 8.4-7.6c.4-.3-.1-.5-.6-.2L7.2 14.4l-4.4-1.4c-1-.3-1-1 .2-1.6z" />
              </svg>
              Telegram
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
