import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AccessGate from './components/AccessGate'
import Shell from './components/Shell'
import HomePage from './pages/HomePage'
import MarketPage from './pages/MarketPage'
import CreatePage from './pages/CreatePage'
import TradePage from './pages/TradePage'
import ModulesPage from './pages/ModulesPage'
import LiquidityPage, {
  AgentsPage,
  DocsPage,
  LeaderboardPage,
  TermsPage,
  TokenPage,
} from './pages/MorePages'

const GATE_KEY = 'hooker_vamp_access_v1'

export default function App() {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return localStorage.getItem(GATE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [connected, setConnected] = useState(null)

  useEffect(() => {
    document.title = unlocked
      ? 'hooker.cash — the hook launchpad on Arc'
      : 'Hooker — access check'
  }, [unlocked])

  function enter() {
    try {
      localStorage.setItem(GATE_KEY, '1')
    } catch {
      /* ignore */
    }
    setUnlocked(true)
  }

  function onConnect() {
    if (connected) {
      setConnected(null)
      return
    }
    // Demo connect — replace with RainbowKit / wagmi for production
    const demo = `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 42)
    setConnected(demo)
  }

  if (!unlocked) {
    return <AccessGate onEnter={enter} />
  }

  return (
    <Routes>
      <Route element={<Shell onConnect={onConnect} connected={connected} />}>
        <Route index element={<HomePage />} />
        <Route path="market" element={<MarketPage />} />
        <Route path="create" element={<CreatePage />} />
        <Route path="trade" element={<TradePage />} />
        <Route path="liquidity" element={<LiquidityPage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="modules" element={<ModulesPage />} />
        <Route path="hooks" element={<Navigate to="/modules" replace />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="guide" element={<Navigate to="/docs" replace />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="token/:id" element={<TokenPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
