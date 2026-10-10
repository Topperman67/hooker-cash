import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Logo from './Logo.jsx'
import { gateExempt, readAccepted, saveAccepted } from './gate.js'

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// Shown once per browser before anything else, except on the pages it points to (terms, docs).
export default function RiskGate({ children }) {
  const [accepted, setAccepted] = useState(() => readAccepted(storage()))
  const { pathname } = useLocation()
  if (accepted || gateExempt(pathname)) return children
  return (
    <main className="gate">
      <div className="gate-card">
        <Logo className="gate-lockup" />
        <h1>Before you enter</h1>
        <ul>
          <li>
            Coins launched here are memecoins on pump.fun. Most go to zero. Only use SOL you can
            afford to lose.
          </li>
          <li>
            Quantum Hooks route a coin's creator fees through an on-chain program. pump.fun's admins
            can still reassign a coin's creator, which would stop its hooks.
          </li>
          <li>
            Every transaction is signed in your own wallet. Quant Pad never holds your keys or
            funds.
          </li>
          <li>Nothing here is financial advice. Check local rules before trading.</li>
        </ul>
        <button
          className="btn btn-primary btn-lg"
          onClick={() => {
            saveAccepted(storage())
            setAccepted(true)
          }}
        >
          I understand, enter
        </button>
        <p className="gate-note">
          Read the full <Link to="/terms">terms of use</Link> before you enter.
        </p>
      </div>
    </main>
  )
}
