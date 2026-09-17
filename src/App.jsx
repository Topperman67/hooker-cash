import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AccessGate from './components/AccessGate'
import Shell from './components/Shell'
import WalletDialog from './components/WalletDialog'
import { useWallet } from './context/WalletContext'
import HomePage from './pages/HomePage'
import MarketPage from './pages/MarketPage'
import CreatePage from './pages/CreatePage'
import TradePage from './pages/TradePage'
import ModulesPage from './pages/ModulesPage'
const TokenTerminal = lazy(() => import('./pages/TokenTerminal'))
const SetupPage = lazy(() => import('./pages/SetupPage'))
import LiquidityPage, { AgentsPage, DocsPage, LeaderboardPage, TermsPage } from './pages/MorePages'

const GATE_KEY = 'hooker_vamp_access_v1'

export default function App() {
  const [unlocked, setUnlocked] = useState(() => {
    try {
      return localStorage.getItem(GATE_KEY) === '1'
    } catch {
      return false
    }
  })
  const { account: connected } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)

  useEffect(() => {
    if (!unlocked) document.title = 'Hookbrew — access check'
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
    setWalletOpen(true)
  }

  if (!unlocked) {
    return <AccessGate onEnter={enter} />
  }

  return (
    <>
      <Suspense
        fallback={
          <p className="product-loading" role="status">
            Opening Hookbrew…
          </p>
        }
      >
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
            <Route path="token/:id" element={<TokenTerminal />} />
            <Route path="asset/:id" element={<TokenTerminal />} />
            <Route path="setup" element={<SetupPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
      <WalletDialog open={walletOpen} onClose={() => setWalletOpen(false)} />
    </>
  )
}
