import { Blocks, ArrowUpRight } from 'lucide-react'
import { hookModules } from '../data/hookModules'
import { recipeModules } from '../lib/hookRecipe'
import { useResource, short } from '../lib/api'
import Glass from '../components/Glass'
import { Button, PageHeading } from '../components/UI'
export default function ModulesPage() {
  const registry = useResource('/api/hooks')
  return (
    <>
      <PageHeading
        title="The hook is the whole point."
        description="Seven composable modules. Assemble an immutable recipe inside Stage 2 of your token launch, confirm it in your wallet, and reuse it for future launches."
        action={
          <Button to="/create" primary>
            Launch with a custom hook
          </Button>
        }
      />
      <Glass className="registry-banner" tone="violet">
        <Blocks size={28} />
        <p>
          <strong>Your rules, built on-chain.</strong>
          <br />
          Every recipe keeps the 70/30 fee split and permanently locked seed liquidity.
        </p>
        <Button to="/docs">How hooks work</Button>
      </Glass>
      {['opening', 'value'].map((group) => (
        <section key={group}>
          <div className="section-head section-space">
            <div>
              <h2>{group === 'opening' ? 'Shape the opening' : 'Put fees to work'}</h2>
              <p>
                {group === 'opening'
                  ? 'Rules around swaps and price observations.'
                  : 'Allocate part of the creator share at harvest.'}
              </p>
            </div>
          </div>
          <div className="grid-2">
            {hookModules
              .filter((m) => m.group === group)
              .map((m) => {
                const Icon = m.icon
                return (
                  <Glass className="mod-card" key={m.key}>
                    <div className="mod-card-head">
                      <span className="module-icon">
                        <Icon size={22} />
                      </span>
                      <span className="product-badge">
                        {group === 'opening' ? 'Trading' : 'Harvest'}
                      </span>
                    </div>
                    <h3>{m.title}</h3>
                    <p>{m.text}</p>
                    <p className="fine-print">{m.detail}</p>
                  </Glass>
                )
              })}
          </div>
        </section>
      ))}
      <section className="section-space">
        <div className="section-head">
          <div>
            <h2>Community recipes</h2>
            <p>Confirmed Hookbrew builds available to reuse in Stage 2.</p>
          </div>
        </div>
        {registry.loading ? (
          <p>Loading confirmed builds...</p>
        ) : registry.error ? (
          <p role="alert">{registry.error}</p>
        ) : registry.data?.items?.length ? (
          <div className="grid-2">
            {registry.data.items.map((d) => (
              <Glass className="mod-card" key={d.factory}>
                <h3>{recipeModules(d.recipe).join(' + ') || 'Base recipe'}</h3>
                <p>Built by {short(d.builtBy)} on Arc</p>
                <a
                  href={`https://explorer.arc.io/address/${d.factory}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(d.factory)} <ArrowUpRight size={13} />
                </a>
                <Button to="/create">Choose in launch studio</Button>
              </Glass>
            ))}
          </div>
        ) : (
          <Glass className="product-empty">
            <h3>The first recipe is yours to brew.</h3>
            <p>
              Build a custom hook in Stage 2. It appears here after its transaction is confirmed and
              verified.
            </p>
            <Button to="/create">Start a launch</Button>
          </Glass>
        )}
      </section>
      <p className="fine-print section-space">
        Hookbrew modular contracts are independently unaudited. A confirmed build verifies
        deployment and settings; it does not guarantee economic outcomes.
      </p>
    </>
  )
}
