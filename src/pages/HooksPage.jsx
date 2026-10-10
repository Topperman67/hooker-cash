import { Link } from 'react-router-dom'
import { usePlatform } from '../context/PlatformContext.jsx'
import { EXTRAS, MODULES } from '../lib/hooks.js'
import { bps } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'

const DETAIL = {
  creatorBps:
    'Sent to the launcher wallet in the same pulse that collects the fees. If Superposition wallets are set, they are paid their fixed share of this slice first.',
  burnBps:
    'Accumulates in the coin’s burn reserve. The keeper spends it in capped buys (on the bonding curve before graduation, on PumpSwap after) and burns every token bought in the same transaction. If the keeper stalls, anyone can run the burn after a grace period.',
  entangleBps:
    'Accumulates in the holder reserve. About once a day the keeper snapshots wallet balances, posts a merkle root for the epoch on-chain, and holders claim their SOL from the coin page within 30 days. Unclaimed SOL rolls into the next epoch.',
  fusionBps:
    'Before graduation it simply accumulates. After graduation the reserve buys tokens and deposits both sides into the coin’s canonical PumpSwap pool. The LP tokens stay in the coin’s well; the program has no instruction to withdraw them.',
}

export default function HooksPage() {
  const { quantum } = usePlatform()
  return (
    <div className="wrap prose-page">
      <header className="page-head">
        <h1>Quantum Hooks</h1>
        <p className="muted">
          pump.fun does not let anyone hook into trades directly, so Quantum Hooks work on the one
          stream every coin has: its creator fees. A Quant Pad coin’s pump.fun creator is the coin’s
          own well, a program-controlled address, and the hooks decide where every lamport goes.
        </p>
      </header>

      <section className="flow" aria-label="Fee flow">
        <div className="flow-node">
          <strong>Trades</strong>
          <span className="faint">on the bonding curve or PumpSwap</span>
        </div>
        <div className="flow-arrow" aria-hidden="true" />
        <div className="flow-node">
          <strong>Creator fee</strong>
          <span className="faint">paid by pump.fun into the well</span>
        </div>
        <div className="flow-arrow" aria-hidden="true" />
        <div className="flow-node">
          <strong>Pulse</strong>
          <span className="faint">
            {quantum.protocolBps ? `${bps(quantum.protocolBps)} protocol share, then` : ''} split by
            locked rules
          </span>
        </div>
        <div className="flow-arrow" aria-hidden="true" />
        <div className="flow-node flow-fan">
          {MODULES.map((m) => (
            <span key={m.key} style={{ '--c': m.color }}>
              {m.name}
            </span>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <h2>Fee modules</h2>
        <div className="hook-detail-list">
          {MODULES.map((m) => (
            <article key={m.key} className="hook-detail" style={{ '--c': m.color }}>
              <h3>{m.name}</h3>
              <p>{DETAIL[m.key]}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-tight">
        <h2>Launch extras</h2>
        <div className="hook-detail-list">
          {EXTRAS.map((m) => (
            <article key={m.key} className="hook-detail" style={{ '--c': m.color }}>
              <h3>{m.name}</h3>
              <p>{m.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-tight prose">
        <h2>What you can rely on</h2>
        <ul>
          <li>
            Allocations, split wallets and lock schedules are written before the coin exists and
            cannot be edited afterwards, by you or by Quant Pad.
          </li>
          <li>
            Pulses, burns and Fusion are permissionless once the keeper’s grace period passes, so
            hooks keep running even if Quant Pad’s keeper stops.
          </li>
          <li>
            The keeper can post Entanglement epochs and run burns, but it has no instruction that
            sends the well’s SOL anywhere else.
          </li>
        </ul>
        <h2>What you should know</h2>
        <ul>
          <li>
            pump.fun’s admins can reassign a coin’s creator (their community takeover feature). If
            that happens, future creator fees stop flowing into the well. Quant Pad cannot prevent
            it.
          </li>
          <li>
            Creator fees are a small share of volume, currently 0.30% on the curve and 0.05–0.95% on
            PumpSwap, so hooks scale with trading activity.
          </li>
          <li>
            Buybacks are market orders and can be front-run. Each burn is capped in size to limit
            that.
          </li>
          <li>The Quantum Hooks program has not been independently audited yet.</li>
        </ul>
        {quantum.programId && (
          <p className="muted">
            Program:{' '}
            <a
              href={explorer.account(quantum.programId)}
              target="_blank"
              rel="noreferrer"
              className="num"
            >
              {quantum.programId}
            </a>
          </p>
        )}
        <p>
          <Link to="/launch" className="btn btn-primary">
            Launch with Quantum Hooks
          </Link>
        </p>
      </section>
    </div>
  )
}
