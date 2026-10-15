import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, X } from 'lucide-react'
import { short } from '../lib/format.js'
import { MODULES } from '../lib/hooks.js'
import { focusables, trapTarget } from './focus.js'

export function Spinner({ block, label }) {
  if (!block) return <span className="spinner" role="status" aria-label={label || 'Loading'} />
  return (
    <div className="spinner-block" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}

// `level` keeps the page's heading outline in order: 1 when the message is the whole page, 2 under
// the page's h1, 3 inside a section. It always looks the same.
export function Empty({ title, children, action, level = 2 }) {
  const Heading = `h${level}`
  return (
    <div className="empty">
      <Heading className="h3 empty-title">{title}</Heading>
      {children && <p>{children}</p>}
      {action}
    </div>
  )
}

export function CoinAvatar({ src, symbol, size = 40, eager = false }) {
  const [failed, setFailed] = useState(false)
  const style = { '--s': `${size}px` }
  if (src && !failed)
    return (
      <img
        className="avatar"
        style={style}
        src={src}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        onError={() => setFailed(true)}
      />
    )
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {(symbol || '?').slice(0, 2)}
    </span>
  )
}

export function CopyButton({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="copy"
      aria-label={done ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        } catch {}
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export function Address({ value, href, head = 4, tail = 4 }) {
  if (!value) return <span className="faint">—</span>
  return (
    <span className="address">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {short(value, head, tail)}
        </a>
      ) : (
        short(value, head, tail)
      )}
      <CopyButton value={value} label="Copy address" />
    </span>
  )
}

export function Stat({ label, children, className = '' }) {
  return (
    <div className={`stat ${className}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// `migrated`: Meteora moved the full curve into its DAMM v2 pool (until then a full curve is
// graduating and cannot trade).
export function CurveProgress({ progress = 0, complete, migrated = false }) {
  const value = complete ? 100 : Math.max(0, Math.min(100, progress || 0))
  return (
    <div className={`curve ${complete ? 'curve-done' : ''}`}>
      <div
        className="curve-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        aria-label="Bonding curve progress"
      >
        <div
          className="curve-fill"
          style={{ width: `${Math.max(value, complete ? 100 : 1.5)}%` }}
        />
      </div>
      <div className="curve-meta">
        <span>
          {complete
            ? migrated
              ? 'Graduated to Meteora DAMM v2'
              : 'Graduating to Meteora DAMM v2'
            : 'Meteora bonding curve'}
        </span>
        <span className="num">{value.toFixed(value < 10 ? 1 : 0)}%</span>
      </div>
    </div>
  )
}

export function AllocationBar({ hooks, legend = true }) {
  const parts = MODULES.map((m) => ({ ...m, value: Number(hooks?.[m.key] || 0) })).filter(
    (p) => p.value > 0,
  )
  return (
    <div>
      <div
        className="alloc-bar"
        role="img"
        aria-label={parts.map((p) => `${p.name} ${p.value / 100}%`).join(', ')}
      >
        {parts.map((p) => (
          <span key={p.key} style={{ flexBasis: `${p.value / 100}%`, background: p.color }} />
        ))}
      </div>
      {legend && (
        <div className="alloc-legend">
          {parts.map((p) => (
            <span key={p.key}>
              <i style={{ background: p.color }} />
              {p.name}{' '}
              <span className="num">
                {(p.value / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// A modal dialog rendered over the whole app: the page behind is inert, Tab and Shift+Tab cycle
// inside the dialog, Escape closes it, and focus returns to the opener afterwards.
export function Modal({ title, onClose, children, labelledBy = 'modal-title' }) {
  const ref = useRef(null)
  // Callers may pass a new onClose on every render (the wallet context does). Read the latest one
  // at event time so those renders never re-run the setup below and move focus back to Close.
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement
    const root = document.getElementById('root')
    const wasInert = root?.inert ?? false
    if (root) root.inert = true
    ;(focusables(dialog)[0] || dialog).focus()
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
      } else if (e.key === 'Tab') {
        const target = trapTarget(focusables(dialog), document.activeElement, e.shiftKey, dialog)
        if (target) {
          e.preventDefault()
          target.focus()
        }
      }
    }
    // Capture phase, so the dialog handles Escape before page-level shortcuts such as the menu.
    document.addEventListener('keydown', onKey, true)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      if (root) root.inert = wasInert
      previous?.focus?.()
    }
  }, [])
  // If the focused control disappears (a wallet option after connecting), keep focus in the dialog
  // without jumping to a particular button.
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus()
  })
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <h3 id={labelledBy}>{title}</h3>
          <button
            type="button"
            className="btn btn-ghost icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function Segmented({ value, onChange, options, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  )
}
