import { Droplets, Layers3, Plus, ShieldCheck } from 'lucide-react'
import { ALL_MODULES, GATE_MODULES, VALUE_MODULES } from '../data'
import Glass from '../components/Glass'
import { Button, PageHeading } from '../components/UI'

function ModuleCard({ module }) {
  return (
    <Glass className="mod-card">
      <div className="mod-card-head">
        <span className="module-icon">
          {module.lane === 'gate' ? <ShieldCheck size={22} /> : <Droplets size={22} />}
        </span>
        <span className={`tag tag-${module.tag}`}>{module.tag}</span>
      </div>
      <h3>{module.name}</h3>
      <p>{module.blurb}</p>
      {module.badge && <p className="fine-print">{module.badge}</p>}
      <Button to={`/create?module=${module.id}`} className="btn-sm">
        <Plus size={14} />
        Launch integration status
      </Button>
    </Glass>
  )
}

export default function ModulesPage() {
  return (
    <>
      <PageHeading
        title="The hook is the whole point."
        description="Reference module catalogue from the original Hooker project. Hookbrew’s module registry has not been configured or verified."
        action={
          <Button to="/create" primary>
            <Plus size={17} />
            Open the builder
          </Button>
        }
      />
      <Glass className="registry-banner" tone="violet">
        <Layers3 size={28} />
        <p>
          <strong>{ALL_MODULES.length} reference module designs.</strong>
          <br />
          Gates shape the swap. Value modules shape the harvest.
        </p>
        <Button to="/docs">How hooks work</Button>
      </Glass>
      <div className="section-head">
        <div>
          <h2>At the swap</h2>
          <p>Gate modules set the rules before a trade goes through.</p>
        </div>
        <span className="chip">{GATE_MODULES.length} modules</span>
      </div>
      <div className="grid-2">
        {GATE_MODULES.map((module) => (
          <ModuleCard key={module.id} module={module} />
        ))}
      </div>
      <div className="section-head section-space">
        <div>
          <h2>At the harvest</h2>
          <p>Value modules decide where a share of the fees goes.</p>
        </div>
        <span className="chip">{VALUE_MODULES.length} modules</span>
      </div>
      <div className="grid-3">
        {VALUE_MODULES.map((module) => (
          <ModuleCard key={module.id} module={module} />
        ))}
      </div>
      <p className="fine-print">
        These descriptions document the original product’s intended behavior. They do not confirm
        availability, implementation, or security in a Hookbrew deployment.
      </p>
    </>
  )
}
