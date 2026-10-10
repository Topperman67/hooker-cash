import { Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Shell from './components/Shell.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import RiskGate from './components/RiskGate.jsx'
import HomePage from './pages/HomePage.jsx'
import MarketPage from './pages/MarketPage.jsx'
import { Spinner } from './components/UI.jsx'
import { lazyPage } from './components/recovery.js'
import { useGlobalGlint } from './lib/glint.js'

// Launch and coin pages pull in the pump.fun SDKs and charting; load them on demand. lazyPage lets
// the ErrorBoundary retry a chunk that failed to load instead of caching the failure.
const LaunchPage = lazyPage(() => import('./pages/LaunchPage.jsx'))
const CoinPage = lazyPage(() => import('./pages/CoinPage.jsx'))
const HooksPage = lazyPage(() => import('./pages/HooksPage.jsx'))
const DocsPage = lazyPage(() => import('./pages/DocsPage.jsx'))
const TermsPage = lazyPage(() => import('./pages/TermsPage.jsx'))
const PortfolioPage = lazyPage(() => import('./pages/PortfolioPage.jsx'))

export default function App() {
  useGlobalGlint()
  const { pathname } = useLocation()
  return (
    <RiskGate>
      <Shell>
        <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<Spinner block label="Loading" />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/launch" element={<LaunchPage />} />
              <Route path="/market" element={<MarketPage />} />
              <Route path="/coin/:mint" element={<CoinPage />} />
              <Route path="/hooks" element={<HooksPage />} />
              <Route path="/portfolio" element={<PortfolioPage />} />
              <Route path="/docs" element={<DocsPage />} />
              <Route path="/terms" element={<TermsPage />} />
              <Route path="/create" element={<Navigate to="/launch" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </Shell>
    </RiskGate>
  )
}
