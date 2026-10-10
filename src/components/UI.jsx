import { useEffect, useRef, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { short } from '../lib/format.js'
import { MODULES } from '../lib/hooks.js'

export function Spinner({ block, label }) {
  if (!block) return <span className="spinner" role="status" aria-label={label || 'Loading'} />
  return (
    <div className="spinner-block" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
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

export function CurveProgress({ progress = 0, complete }) {
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
        <span>{complete ? 'Graduated to PumpSwap' : 'Bonding curve'}</span>
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

export function Modal({ title, onClose, children, labelledBy = 'modal-title' }) {
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector('button, [href], input, select, textarea')?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      previous?.focus?.()
    }
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
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
    </div>
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
