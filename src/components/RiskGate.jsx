import { useState } from 'react'
import Logo from './Logo.jsx'

const KEY = 'quantpad:risk-accepted:v1'
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// Shown once per browser before anything else.
export default function RiskGate({ children }) {
  const [accepted, setAccepted] = useState(read)
  if (accepted) return children
  return (
    <div className="gate">
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
            try {
              localStorage.setItem(KEY, '1')
            } catch {}
            setAccepted(true)
          }}
        >
          I understand, enter
        </button>
        <p className="faint">The full terms are on the Terms page.</p>
      </div>
    </div>
  )
}
