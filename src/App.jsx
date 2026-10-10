import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Shell from './components/Shell.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import RiskGate from './components/RiskGate.jsx'
import HomePage from './pages/HomePage.jsx'
import MarketPage from './pages/MarketPage.jsx'
import { Spinner } from './components/UI.jsx'
import { useGlobalGlint } from './lib/glint.js'

// Launch and coin pages pull in the pump.fun SDKs and charting; load them on demand.
const LaunchPage = lazy(() => import('./pages/LaunchPage.jsx'))
const CoinPage = lazy(() => import('./pages/CoinPage.jsx'))
const HooksPage = lazy(() => import('./pages/HooksPage.jsx'))
const DocsPage = lazy(() => import('./pages/DocsPage.jsx'))
const TermsPage = lazy(() => import('./pages/TermsPage.jsx'))
const PortfolioPage = lazy(() => import('./pages/PortfolioPage.jsx'))

export default function App() {
  useGlobalGlint()
  return (
    <RiskGate>
      <Shell>
        <ErrorBoundary>
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
