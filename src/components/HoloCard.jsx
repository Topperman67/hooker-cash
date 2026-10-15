import { CoinAvatar } from './UI.jsx'
import { MODULES } from '../lib/hooks.js'
import { tiltHandlers } from '../lib/glint.js'
import { bps } from '../lib/format.js'

// Holographic launch card: the coin's identity and its hook loadout on a tilting graphite
// card whose four light lines follow the pointer.
export default function HoloCard({ name, symbol, image, hooks, quantum, footer, compact = false }) {
  const rows = quantum && hooks ? MODULES.filter((m) => Number(hooks[m.key]) > 0) : []
  return (
    <article className={`holo ${compact ? 'holo-compact' : ''}`} {...tiltHandlers()}>
      <div className="holo-inner">
        <header className="holo-head">
          <img src="/brand/mark.svg" alt="" className="holo-mark" />
          <span>{quantum ? 'Quantum Hooks' : 'Standard Meteora'}</span>
        </header>
        <div className="holo-art">
          <CoinAvatar src={image} symbol={symbol} size={compact ? 84 : 112} eager />
        </div>
        <h3 className="holo-symbol silver-text">${symbol || 'TICKER'}</h3>
        <p className="holo-name">{name || 'Your coin'}</p>
        {rows.length ? (
          <ul className="holo-hooks">
            {rows.map((m) => (
              <li key={m.key} style={{ '--c': m.color, '--w': `${Number(hooks[m.key]) / 100}%` }}>
                <span className="holo-hook-name">{m.name}</span>
                <span className="holo-hook-bar" />
                <span className="num">{bps(hooks[m.key])}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="holo-plain">
            The creator claims fees directly on Meteora. No hooks run.
          </p>
        )}
        {footer && <footer className="holo-foot">{footer}</footer>}
      </div>
      <span className="holo-sheen" aria-hidden="true" />
    </article>
  )
}
