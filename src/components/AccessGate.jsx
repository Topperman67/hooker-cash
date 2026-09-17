import { useState } from 'react'
import { ArrowRight, Check, ShieldCheck } from 'lucide-react'
import { ACCESS_RULES } from '../data'
import Glass from './Glass'
import { BrandMark, Button, Logo } from './UI'

export default function AccessGate({ onEnter }) {
  const [checked, setChecked] = useState(() => new Set())
  const ready = checked.size === ACCESS_RULES.length
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
      <div className="ambient-scene" aria-hidden="true">
        <div className="ambient-ribbon ribbon-one" />
        <div className="ambient-ribbon ribbon-two" />
      </div>
      <div className="gate-brand">
        <Logo />
        <span>Good tokens have a recipe.</span>
      </div>
      <Glass className="gate-card" radius={32}>
        <div className="gate-left">
          <div className="gate-emblem">
            <Glass variant="clear" radius={36}>
              <Logo compact />
            </Glass>
          </div>
          <span className="eyebrow">Your keys. Your calls.</span>
          <h1>
            Before you
            <br />
            make a move.
          </h1>
          <p>
            Big ideas start here. Take a moment to understand the floor before stepping onto it.
          </p>
          <span className="gate-note">
            <ShieldCheck size={16} /> Four things to know. One time only.
          </span>
        </div>
        <div className="gate-right">
          <div className="gate-right-head">
            <span>A quick reality check</span>
            <span>{checked.size} of 4 confirmed</span>
          </div>
          <div className="gate-progress">
            <span style={{ width: `${checked.size * 25}%` }} />
          </div>
          {ACCESS_RULES.map((rule) => (
            <Glass
              as="button"
              key={rule.id}
              variant="control"
              className={`rule ${checked.has(rule.id) ? 'on' : ''}`}
              type="button"
              onClick={() => toggle(rule.id)}
              aria-pressed={checked.has(rule.id)}
            >
              <span className="rule-copy">
                <strong>{rule.title}</strong>
                <span>{rule.body}</span>
              </span>
              <span className="check-box" aria-hidden="true">
                {checked.has(rule.id) && <Check size={14} />}
              </span>
            </Glass>
          ))}
          <Button primary className="gate-cta" disabled={!ready} onClick={onEnter}>
            {ready ? 'Step onto the floor' : 'Confirm all four to continue'}
            <ArrowRight size={17} />
          </Button>
          <span className="fine-print">
            Contract addresses and data sources are shown where available.
          </span>
        </div>
      </Glass>
      <div className="gate-footer">
        <span>
          <BrandMark name="arc" /> Built on Arc
        </span>
        <span>
          <BrandMark name="uniswap" /> Uniswap V4 hooks
        </span>
      </div>
    </div>
  )
}
