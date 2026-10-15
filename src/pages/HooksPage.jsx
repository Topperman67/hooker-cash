import { Link } from 'react-router-dom'
import { usePlatform } from '../context/PlatformContext.jsx'
import { EXTRAS, MODULES } from '../lib/hooks.js'
import { bps, duration } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'

const CANCEL_NOTE =
  'Until then Quant Pad can cancel the epoch, which returns its SOL to the holder reserve.'

// When an epoch's claims open, from the config's claim delay (seconds) when the server reports it.
function claimWindowText(seconds) {
  const delay = Number(seconds)
  if (seconds == null || !Number.isFinite(delay) || delay < 0)
    return `An epoch’s claims open only after a delay set on-chain (6 hours by default). ${CANCEL_NOTE}`
  if (delay === 0) return 'An epoch’s claims open as soon as it is posted.'
  return `An epoch’s claims open ${duration(delay)} after it is posted. ${CANCEL_NOTE}`
}

const DETAIL = {
  creatorBps:
    'Sent to the launcher wallet in the same pulse that collects the fees. If Superposition wallets are set, they are paid their fixed share of this slice first.',
  burnBps:
    'Accumulates in the coin’s burn reserve. The keeper spends it in capped buys (on the Meteora bonding curve before graduation, on its DAMM v2 pool after) and burns every token bought in the same transaction. If the keeper stalls, anyone can run the burn after a grace period.',
  entangleBps:
    'Accumulates in the holder reserve. About once a day (never more often than every 20 hours) the keeper snapshots wallet balances and posts a merkle root for the epoch on-chain. Its claims open after a short delay, and holders then claim their SOL from the coin page until the epoch expires 30 days after posting. Unclaimed SOL rolls into the next epoch.',
  fusionBps:
    'Before graduation it simply accumulates. After graduation the reserve buys tokens and adds both sides to the well’s Meteora DAMM v2 position, permanently locked; the program has no instruction to withdraw them.',
}

export default function HooksPage() {
  const { quantum } = usePlatform()
  return (
    <div className="wrap prose-page">
      <header className="page-head">
        <h1>Quantum Hooks</h1>
        <p className="muted">
          Quantum Hooks work on the one stream every coin has: its creator fees. A Quant Pad coin’s
          Meteora creator is the coin’s own well, a program-controlled address, and the hooks decide
          where every lamport goes.
        </p>
      </header>

      <section className="flow" aria-label="Fee flow">
        <div className="flow-node">
          <strong>Trades</strong>
          <span className="faint">on the Meteora curve or DAMM v2 pool</span>
        </div>
        <div className="flow-arrow" aria-hidden="true" />
        <div className="flow-node">
          <strong>Creator fee</strong>
          <span className="faint">claimed from Meteora into the well</span>
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
            The keeper can post Entanglement epochs and run burns and Fusion, but it has no
            instruction that sends the well’s SOL anywhere else.
          </li>
        </ul>
        <h2>What you should know</h2>
        <ul>
          <li>
            The keeper decides who each Entanglement epoch pays, and epochs are at least 20 hours
            apart. {claimWindowText(quantum.claimDelay)}
          </li>
          <li>
            Meteora can upgrade its programs, and its operators can change a migrated pool’s fees or
            pause it. No Meteora admin can reassign a coin’s creator away from its well.
          </li>
          <li>
            Creator fees are a share of volume (the 1% trading fee less Meteora’s protocol share),
            so hooks scale with trading activity.
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
