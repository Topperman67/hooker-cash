import { Link } from 'react-router-dom'
import Glass from '../components/Glass'
import { Button, PageHeading, TokenAvatar } from '../components/UI'
import ChainStatus from '../components/ChainStatus'
import { useResource, compact, short } from '../lib/api'

function IndexedTable({ liquidity = false }) {
  const market = useResource(`/api/market?sort=${liquidity ? 'newest' : 'volume'}`)
  return (
    <>
      <Glass className="market-table-panel">
        <div className="table-scroll">
          <table className="product-table">
            <thead>
              <tr>
                <th>{liquidity ? 'Pool' : 'Rank / token'}</th>
                <th>{liquidity ? 'Seed position' : '24h volume / USDC'}</th>
                <th>{liquidity ? 'Creator' : 'Market cap / USDC'}</th>
                <th>Pool fee</th>
              </tr>
            </thead>
            <tbody>
              {market.data?.items.map((t, index) => (
                <tr key={t.address}>
                  <td>
                    <Link to={`/token/${t.address}`} className="market-token">
                      {!liquidity && <span>{index + 1}</span>}
                      <TokenAvatar token={t} />
                      <span>
                        <strong>{t.name}</strong>
                        <small>{t.symbol} / USDC</small>
                      </span>
                    </Link>
                  </td>
                  <td>{liquidity ? 'Factory held · no withdrawal' : compact(t.volume24h)}</td>
                  <td>{liquidity ? short(t.creator) : compact(t.marketCap)}</td>
                  <td>{t.fee / 10000}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!market.data?.items.length && (
          <div className="table-empty">
            <p>
              {market.error ||
                (market.loading ? 'Reading indexed pools…' : 'No Hookbrew pools are indexed yet.')}
            </p>
            <Button to="/create">Create a token</Button>
            <Button to="/setup">Contract setup</Button>
          </div>
        )}
      </Glass>
      <p className="fine-print">
        {liquidity
          ? 'The factory seed position has no withdrawal function. Open a token’s Creator & vesting tab to harvest and claim fees. External LP position management is not included.'
          : 'Top 24 indexed tokens ranked by USDC swap volume over the past 24 hours. Volume is observed activity, not a recommendation.'}
      </p>
    </>
  )
}
export default function LiquidityPage() {
  return (
    <>
      <PageHeading
        title="The pools behind the brews."
        description="Every Hookbrew launch creates a token / USDC pool with a permanent factory seed position."
      />
      <IndexedTable liquidity />
    </>
  )
}
export function LeaderboardPage() {
  return (
    <>
      <PageHeading
        title="Where the activity is."
        description="Real swap volume. A rolling 24-hour window. Markets ranked from confirmed pool events."
      />
      <IndexedTable />
    </>
  )
}
export function AgentsPage() {
  return (
    <>
      <PageHeading
        title="Hookbrew for builders."
        description="Public market reads for integrations, dashboards and agents."
      />
      <Glass as="article" className="docs-body">
        <h2>Read API</h2>
        <p>
          The server exposes the same data used by this app. No private API credential from the
          original project is used.
        </p>
        <pre>
          GET /api/status{'\n'}GET /api/market?q=&sort=volume&fee=&offset=0{'\n'}GET
          /api/tokens/:address{'\n'}GET /api/tokens/:address/trades?side=buy{'\n'}GET
          /api/tokens/:address/candles?interval=300
        </pre>
        <h2>Wallet signing stays with you</h2>
        <p>
          There is no transaction-capable MCP service or agent signing wallet in this build. Read
          responses include index progress, confirmed trades, and deployment identity. Unavailable
          markets return explicit errors.
        </p>
        <Button to="/docs">Read the protocol guide</Button>
      </Glass>
    </>
  )
}
export function DocsPage() {
  return (
    <>
      <PageHeading
        title="Built to brew. Built on-chain."
        description="The Hookbrew v1 launch and trading guide."
      />
      <ChainStatus />
      <Glass as="article" className="docs-body">
        <h2>Launch studio</h2>
        <p>
          Set a name, ticker, artwork and socials. Every token has a fixed one-billion supply, an
          ERC20 USDC market, and a 1–5% pool fee. Opening valuation targets 2,000–10,000 USDC and
          rounds to a V4 price tick. This valuation is not deposited liquidity or funds raised.
        </p>
        <h2>Founder buys and vesting</h2>
        <p>
          An optional initial purchase is capped at 10% of token supply. Approve the exact ERC20
          USDC amount, simulate, and sign the launch. Up to ten recipients share that allocation and
          creator fees. Each recipient can have an immutable cliff followed by linear vesting; zero
          periods deliver immediately.
        </p>
        <h2>Launch guards</h2>
        <p>
          Optional buy caps ramp as a percentage of the seed position’s virtual USDC reserves for up
          to one hour. Optional global buy spacing applies during that window. Sells and the founder
          purchase are exempt. These rules cannot guarantee protection against bots or multiple
          wallets.
        </p>
        <h2>Trading inside Hookbrew</h2>
        <p>
          Open a token market for its real swap chart and buy/sell ticket. Quotes come from the V4
          quoter. The Hookbrew router takes an exact input, enforces minimum received and a
          deadline, and delivers output directly to your wallet. Approvals are exact amounts. USDC
          for gas and ERC20 USDC for trading are two interfaces to one balance on Arc. Keep enough
          USDC for both the purchase and gas.
        </p>
        <h2>Creator fees and seed liquidity</h2>
        <p>
          The factory holds the seed LP position with no withdrawal function. Harvesting allocates
          70% of its fees to recipients and 30% to the immutable Hookbrew treasury. Recipients with
          founder tokens must retain their original allocation, counting unreleased vesting, to
          claim creator fees. Protocol fees are independent of that hold requirement. Other
          liquidity positions are outside this fee split.
        </p>
        <h2>Data and confirmations</h2>
        <p>
          The server indexes confirmed TokenLaunched and PoolManager Swap events, including external
          routes into these pools. Own-router events identify traders; external routes are labeled
          separately. Candles use actual observed swaps and do not fill gaps with invented activity.
          The index follows two blocks behind the head, persists to disk, and rebuilds after a
          detected reorganization.
        </p>
        <h2>Deployment and contract source</h2>
        <p>
          Hookbrew v1 is an independent implementation in contracts/protocol. The setup page
          verifies the deployment bytecode, fixed treasury, receipt and network. The treasury signs
          a host-bound activation message identifying both deployment transactions. The original
          Hooker factory and treasury are not used. Local contract and integration tests do not
          constitute an independent security audit.
        </p>
        <Button to="/setup">Contract deployment setup</Button>
        <h2>Current scope</h2>
        <p>
          This build covers launches, token branding, recipient splits, vesting, creator claims,
          indexed markets, charts and spot trading. The original project’s eight-module builder,
          reflection and buyback modules, managed external LP positions, leveraged markets, and
          transaction-capable MCP service remain separate backlog items.
        </p>
        <h2>Hosting</h2>
        <p>
          Run the Node server with persistent storage and set HOOKBREW_PUBLIC_URL to the public
          HTTPS origin before a live launch. Token metadata and uploaded artwork must remain
          accessible at that origin. Browser drafts are saved on this device; on-chain token
          metadata is immutable.
        </p>
      </Glass>
    </>
  )
}
export function TermsPage() {
  return (
    <>
      <PageHeading title="Using Hookbrew." description="Your wallet controls every transaction." />
      <Glass as="article" className="docs-body">
        <h2>Wallet control</h2>
        <p>
          The app does not collect private keys. Transactions require your wallet signature.
          Approvals, launches, swaps, and claims are separate on-chain actions. A confirmed
          transaction cannot be undone by this interface.
        </p>
        <h2>Protocol availability</h2>
        <p>
          Live launches and trading require an activated Hookbrew deployment. Newly written
          contracts have not had an independent security audit. A successful simulation does not
          guarantee a transaction’s future execution or economic outcome.
        </p>
        <h2>Market data</h2>
        <p>
          Token names, descriptions and links are creator-provided. Pool data is indexed from
          on-chain events and may be delayed or unavailable. Listings do not represent endorsement,
          guaranteed liquidity, or guaranteed value.
        </p>
        <h2>Local storage and hosting</h2>
        <p>
          This browser stores the entry acknowledgement, token drafts, deployment progress, and
          pending transaction hashes. Uploaded artwork and token metadata are public and stored by
          the Hookbrew server. An on-chain metadata URI is immutable.
        </p>
        <h2>Independent project</h2>
        <p>
          Hookbrew is based on the original Hooker interface with separate contracts and treasury.
          No affiliation with the original project is implied.
        </p>
      </Glass>
    </>
  )
}
