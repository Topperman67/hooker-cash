import { createContext, useCallback, useContext, useState } from 'react'
import { explorer } from '../../shared/network.mjs'

const ToastContext = createContext(() => {})

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const push = useCallback(({ title, body, signature, tone = 'info', ttl = 7000 }) => {
    const id = Math.random().toString(36).slice(2)
    setToasts((list) => [...list.slice(-3), { id, title, body, signature, tone }])
    if (ttl) setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ttl)
    return id
  }, [])
  const colors = { info: 'var(--blue)', success: 'var(--green)', error: 'var(--pink)' }
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" style={{ '--c': colors[t.tone] }}>
            <strong>{t.title}</strong>
            {t.body && <span className="muted">{t.body}</span>}
            {t.signature && (
              <a href={explorer.tx(t.signature)} target="_blank" rel="noreferrer">
                View transaction on Solscan
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
