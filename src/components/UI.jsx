import { useEffect, useId, useRef } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import Glass from './Glass'

export function Button({ to, children, primary = false, className = '', ...props }) {
  return (
    <Glass
      as={to ? Link : 'button'}
      to={to}
      type={to ? undefined : 'button'}
      variant="control"
      tone={primary ? 'violet' : 'neutral'}
      interactive
      className={`btn ${primary ? 'btn-primary' : 'btn-secondary'} ${className}`}
      {...props}
    >
      {children}
    </Glass>
  )
}

export function Logo({ compact = false }) {
  return (
    <span className={`brand ${compact ? 'brand-compact' : ''}`}>
      <img
        className={compact ? 'brand-icon' : 'brand-lockup'}
        src={`/brand/hookbrew/hookbrew-${compact ? 'icon' : 'logo'}.png`}
        alt="Hookbrew"
        width={compact ? 1254 : 2172}
        height={compact ? 1254 : 724}
        decoding="async"
      />
    </span>
  )
}

const brandAssets = {
  arc: '/brand/arc/arc-network.svg',
  'arc-blue': '/brand/arc/arc-network-blue.svg',
  usdc: '/brand/usdc/usdc.svg',
  uniswap: '/brand/uniswap/uniswap.svg',
}

export function BrandMark({ name, alt = '' }) {
  return (
    <img
      className={`brand-mark brand-mark-${name}`}
      src={brandAssets[name]}
      alt={alt}
      width="32"
      height="32"
    />
  )
}

export function PageHeading({ title, description, action }) {
  return (
    <div className="page-heading">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{description}</p>
      </div>
      {action}
    </div>
  )
}

export function TokenAvatar({ token, small = false }) {
  return (
    <span className={`token-avatar token-initials ${small ? 'small' : ''}`} aria-hidden="true">
      {(token.symbol || token.name || '?').slice(0, 2).toUpperCase()}
    </span>
  )
}
export function Modal({ open, onClose, title, children }) {
  const dialog = useRef(null)
  const titleId = useId()
  useEffect(() => {
    const el = dialog.current
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <Glass className="modal-body">
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        {children}
      </Glass>
    </dialog>
  )
}
