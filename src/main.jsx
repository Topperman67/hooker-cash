import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import { ChainProvider } from './context/ChainContext'
import { WalletProvider } from './context/WalletContext'
import { PlatformProvider } from './context/PlatformContext'
import '@fontsource-variable/outfit'
import '@fontsource-variable/dm-sans'
import './index.css'
import './product.css'
import './landing.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <ChainProvider>
          <WalletProvider>
            <PlatformProvider>
              <App />
            </PlatformProvider>
          </WalletProvider>
        </ChainProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
)
