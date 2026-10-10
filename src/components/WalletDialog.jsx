import { Link } from 'react-router-dom'
import { ExternalLink, LogOut } from 'lucide-react'
import { Modal, Address, Spinner } from './UI.jsx'
import { useWallet } from '../context/WalletContext.jsx'
import { explorer } from '../../shared/network.mjs'
import { sol, toSol } from '../lib/format.js'

export default function WalletDialog() {
  const { wallets, wallet, address, balance, busy, error, select, disconnect, closeDialog } =
    useWallet()
  if (address)
    return (
      <Modal title="Your wallet" onClose={closeDialog} labelledBy="wallet-title">
        <dl className="kv" style={{ marginBottom: 20 }}>
          <dt>Wallet</dt>
          <dd>{wallet?.name}</dd>
          <dt>Address</dt>
          <dd>
            <Address value={address} href={explorer.account(address)} head={6} tail={6} />
          </dd>
          <dt>Balance</dt>
          <dd className="num">{balance == null ? '—' : sol(toSol(balance))}</dd>
        </dl>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/portfolio" onClick={closeDialog}>
            Portfolio
          </Link>
          <a className="btn" href={explorer.account(address)} target="_blank" rel="noreferrer">
            Solscan <ExternalLink size={14} aria-hidden="true" />
          </a>
          <button
            className="btn btn-ghost"
            onClick={() => {
              disconnect()
              closeDialog()
            }}
          >
            <LogOut size={14} aria-hidden="true" /> Disconnect
          </button>
        </div>
      </Modal>
    )
  return (
    <Modal title="Connect a Solana wallet" onClose={closeDialog} labelledBy="wallet-title">
      {wallets.length ? (
        <div className="wallet-list">
          {wallets.map((w) => (
            <button
              key={w.name}
              className="wallet-option"
              onClick={() => select(w)}
              disabled={busy}
            >
              {w.icon && <img src={w.icon} alt="" />}
              <span>{w.name}</span>
              {busy && <Spinner />}
            </button>
          ))}
        </div>
      ) : (
        <div className="notice">
          <p>
            <strong>No Solana wallet found in this browser.</strong> Install Phantom, Solflare or
            Backpack, then reload this page.
          </p>
          <p style={{ marginTop: 10 }}>
            <a href="https://phantom.com/download" target="_blank" rel="noreferrer">
              Get Phantom
            </a>
          </p>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      <p className="faint" style={{ marginTop: 16, fontSize: 'var(--t-xs)' }}>
        Quant Pad only asks your wallet to sign transactions you review. It never sees your keys.
      </p>
    </Modal>
  )
}
