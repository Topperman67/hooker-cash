import { Link } from 'react-router-dom'
import { ALL_MODULES, GATE_MODULES, VALUE_MODULES } from '../data'

export default function ModulesPage() {
  return (
    <>
      <h1 className="page-title">Hook Registry</h1>
      <p className="page-sub">
        The module set — gate modules fire at the swap · value modules fire at the harvest. Platform-curated
        bytecode, one reviewed version at a time.
      </p>

      <div className="panel panel-pad" style={{ marginBottom: 18, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link className="btn btn-primary" to="/create">
          Open the Hook Builder →
        </Link>
        <Link className="btn btn-ghost" to="/docs">
          New to hooks? Read the guide →
        </Link>
        <span className="chip">Δ-free · trades anywhere</span>
        <span className="chip">fold cap Σ ≤ 100%</span>
      </div>

      <div className="lane-label">Lane 01 · gates · beforeSwap</div>
      <div className="grid-2" style={{ marginBottom: 22 }}>
        {GATE_MODULES.map((m) => (
          <div key={m.id} className="mod-card panel">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="name">{m.name}</span>
              <span className={`tag tag-${m.tag}`}>{m.tag}</span>
              {m.badge && <span className="hook-chip">{m.badge}</span>}
              <span className="hook-chip">platform-curated</span>
            </div>
            <div className="blurb">{m.blurb}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>no launches yet · demo registry</div>
          </div>
        ))}
      </div>

      <div className="lane-label">Lane 02 · values · harvest</div>
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

      <div className="panel panel-pad" style={{ marginTop: 22 }}>
        <strong style={{ color: 'var(--text-h)' }}>{ALL_MODULES.length} modules</strong>
        <span style={{ color: 'var(--text-dim)' }}>
          {' '}
          · weights on every value module · presets strict / standard / light · deterministic address preview
        </span>
      </div>
    </>
  )
}
