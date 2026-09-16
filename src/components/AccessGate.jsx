import { useMemo, useState } from 'react'
import { ACCESS_RULES } from '../data'

export default function AccessGate({ onEnter }) {
  const [checked, setChecked] = useState(() => new Set())
  const count = checked.size
  const ready = count === ACCESS_RULES.length

  const progress = useMemo(() => `${count} / ${ACCESS_RULES.length}`, [count])

  function toggle(id) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="gate-screen">
      <div className="gate-card panel">
        <div className="gate-left">
          <div className="gate-eyebrow">
            <span>● Access check</span>
            <span className="chip" style={{ height: 26 }}>
              ARC
            </span>
          </div>
          <h1>
            Four rules
            <br />
            before
            <br />
            the floor
            <br />
            opens.
          </h1>
          <p>
            Hooker is a non-custodial window onto permissionless contracts running on Arc. Confirm each
            rule to unlock the terminal — we&apos;ll only ask once.
          </p>
        </div>
        <div className="gate-right">
          <div className="gate-right-head">
            <span>Confirm each to proceed</span>
            <span className="mono">{progress}</span>
          </div>
          {ACCESS_RULES.map((r) => {
            const on = checked.has(r.id)
            return (
              <button
                key={r.id}
                type="button"
                className={`rule${on ? ' on' : ''}`}
                onClick={() => toggle(r.id)}
              >
                <span className="num">{String(r.id).padStart(2, '0')}</span>
                <span>
                  <h3>{r.title}</h3>
                  <p>{r.body}</p>
                </span>
                <span className="box" aria-hidden>
                  {on ? '✓' : ''}
                </span>
              </button>
            )
          })}
          <button className="btn btn-primary btn-lg gate-cta" type="button" disabled={!ready} onClick={onEnter}>
            {ready ? 'Open the floor →' : 'Confirm all four rules'}
          </button>
        </div>
      </div>
    </div>
  )
}
