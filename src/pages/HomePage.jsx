import { Link } from 'react-router-dom'
import {
  DEMO_TOKENS,
  FEATURES,
  GATE_MODULES,
  VALUE_MODULES,
  fmtPct,
  fmtUsd,
  moduleById,
} from '../data'

function TokenCard({ t }) {
  return (
    <Link to={`/token/${t.id}`} className={`token-card panel${t.hot ? ' hot' : ''}`}>
      <div className="token-top">
        <div className="avatar">{t.symbol.slice(0, 2)}</div>
        <div>
          <div className="token-name">{t.name}</div>
          <div className="token-sym">${t.symbol}</div>
        </div>
      </div>
      <div className="metrics">
        <div>
          <div className="metric-label">Mcap</div>
          <div className="metric-value">{fmtUsd(t.mcap)}</div>
        </div>
        <div>
          <div className="metric-label">24h</div>
          <div className={`metric-value ${t.change24h >= 0 ? 'up' : 'down'}`}>{fmtPct(t.change24h)}</div>
        </div>
        <div>
          <div className="metric-label">Vol</div>
          <div className="metric-value">{fmtUsd(t.vol24h)}</div>
        </div>
        <div>
          <div className="metric-label">Liq</div>
          <div className="metric-value">{fmtUsd(t.liq)}</div>
        </div>
      </div>
      <div className="hook-chips">
        {t.modules.map((id) => (
          <span key={id} className="hook-chip">
            {moduleById(id)?.name ?? id}
          </span>
        ))}
      </div>
      <div className="token-actions">
        <span className="btn btn-secondary btn-sm">Quick buy</span>
        <span className="btn btn-ghost btn-sm">Chart</span>
      </div>
    </Link>
  )
}

export default function HomePage() {
  return (
    <>
      <section className="home-hero">
        <div>
          <h1>
            A Uniswap V4 pool at birth,
            <br />
            dressed in your pick of house modules.
          </h1>
          <p className="lede">
            Anti-snipe, reflections, burn, a resting bid under price. No Solidity, no presale — and you
            choose where the creator fee goes.
          </p>
          <div className="hero-ctas">
            <Link className="btn btn-primary btn-lg" to="/create">
              Launch a token
            </Link>
            <Link className="btn btn-secondary btn-lg" to="/market">
              Walk the floor →
            </Link>
          </div>
          <div className="live-pill">
            <span className="pulse" />
            live on mainnet · Arc × Uni V4
          </div>
        </div>
        <div className="hero-viz panel">
          <div className="stack-card">
            <div className="stack-row core">V4 CORE</div>
            <div className="stack-row hook">YOUR HOOK · composable modules</div>
            <div className="stack-row swap">SWAP</div>
            <div style={{ marginTop: 8 }}>
              <div style={{ color: 'var(--text-h)', fontWeight: 700, marginBottom: 6 }}>
                Programmable liquidity
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--text)' }}>
                Every launch is a Uniswap V4 pool — your hook sandwiched between the swap and the core,
                tradable everywhere from block one.
              </div>
              <Link to="/modules" style={{ display: 'inline-block', marginTop: 12, color: 'var(--gold)' }}>
                Explore the module plane →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="powered panel panel-pad">
        <div>
          <h3>Trade against USDC</h3>
          <p>
            Natively born leverage. The ticker tape TWAP module enables leverage capability — longs and
            shorts marked against the launch&apos;s own tape, not the last print.
          </p>
          <Link className="btn btn-ghost" to="/leaderboard">
            See who&apos;s on the board →
          </Link>
        </div>
        <div className="panel panel-pad" style={{ background: 'var(--bg-0)' }}>
          <div className="preview-stat">
            <span>Long / Short</span>
            <span>3×</span>
          </div>
          <div className="preview-stat">
            <span>Margin</span>
            <span>USDC</span>
          </div>
          <div className="preview-stat">
            <span>Mark</span>
            <span>the tape decides</span>
          </div>
          <div className="preview-stat" style={{ borderBottom: 'none' }}>
            <span>Status</span>
            <span className="up">experimental</span>
          </div>
        </div>
      </section>

      <div className="section-head">
        <div>
          <h2>Ten modules. Two lanes. Your rules.</h2>
          <p>Gates work the door at the swap; values carve your cut at the harvest. Fold-cap Σ ≤ 100%.</p>
        </div>
        <Link className="btn btn-secondary" to="/create">
          Open the builder
        </Link>
      </div>

      <div className="module-lane" style={{ marginBottom: 18 }}>
        <div className="lane-label">Lane 01 · at the swap · The gates</div>
        <div className="grid-2">
          {GATE_MODULES.map((m) => (
            <div key={m.id} className="mod-card panel">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="name">{m.name}</span>
                <span className={`tag tag-${m.tag}`}>{m.tag}</span>
                {m.badge && <span className="hook-chip">{m.badge}</span>}
              </div>
              <div className="blurb">{m.blurb}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="module-lane" style={{ marginBottom: 28 }}>
        <div className="lane-label">Lane 02 · at the harvest · The values</div>
        <div className="grid-3">
          {VALUE_MODULES.map((m) => (
            <div key={m.id} className="mod-card panel">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="name">{m.name}</span>
                <span className={`tag tag-${m.tag}`}>{m.tag}</span>
              </div>
              <div className="blurb">{m.blurb}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-head">
        <div>
          <h2>Launch in minutes</h2>
          <p>Pick the modules, set the split, mint. The pool ships with the token.</p>
        </div>
      </div>
      <div className="grid-3" style={{ marginBottom: 32 }}>
        {FEATURES.map((f) => (
          <div key={f.title} className="feature-card panel panel-pad">
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </div>

      <div className="section-head">
        <div>
          <h2>Live on the floor</h2>
          <p>Demo feed — wire indexer for production.</p>
        </div>
        <Link className="btn btn-ghost" to="/market">
          Full market →
        </Link>
      </div>
      <div className="token-grid">
        {DEMO_TOKENS.slice(0, 4).map((t) => (
          <TokenCard key={t.id} t={t} />
        ))}
      </div>
    </>
  )
}

export { TokenCard }
