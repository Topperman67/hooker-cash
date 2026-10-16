import './polyfills.js'
import '@fontsource-variable/hubot-sans/wdth.css'
import '@fontsource-variable/mona-sans/wdth.css'
import '@fontsource-variable/martian-mono'
import './styles/base.css'
import './styles/shell.css'
import './styles/components.css'
import './styles/pages.css'
import './styles/glass.css'
import './styles/flywheel.css'
import './styles/hero.css'
import './styles/quantp.css'
import './styles/showcase.css'
import './styles/theme-dark.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { PlatformProvider } from './context/PlatformContext.jsx'
import { QuantpProvider } from './context/QuantpContext.jsx'
import { WalletProvider } from './context/WalletContext.jsx'
import { ToastProvider } from './components/Toasts.jsx'
import { installChunkReload } from './components/recovery.js'

// A tab left open across a redeploy asks for chunks that no longer exist: reload once.
installChunkReload()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <QuantpProvider>
          <WalletProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </WalletProvider>
        </QuantpProvider>
      </PlatformProvider>
    </BrowserRouter>
  </StrictMode>,
)
