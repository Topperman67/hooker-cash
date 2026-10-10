import './polyfills.js'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/manrope'
import './styles/base.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/pages.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { PlatformProvider } from './context/PlatformContext.jsx'
import { WalletProvider } from './context/WalletContext.jsx'
import { ToastProvider } from './components/Toasts.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <WalletProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </WalletProvider>
      </PlatformProvider>
    </BrowserRouter>
  </StrictMode>,
)
