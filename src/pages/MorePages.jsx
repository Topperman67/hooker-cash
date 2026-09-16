import { DEMO_ACTIVITY, DEMO_TOKENS, fmtUsd } from '../data'

export default function LiquidityPage() {
  return (
    <>
      <h1 className="page-title">Liquidity</h1>
      <p className="page-sub">Sealed seed positions from launch — no removal path for anyone.</p>
      <div className="panel" style={{ overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Pool</th>
              <th>TVL</th>
              <th>24h vol</th>
              <th>Fee tier</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_TOKENS.map((t) => (
              <tr key={t.id}>
                <td>
                  <strong style={{ color: 'var(--text-h)' }}>
                    {t.symbol}/USDC
                  </strong>
                </td>
                <td className="mono">{fmtUsd(t.liq)}</td>
                <td className="mono">{fmtUsd(t.vol24h)}</td>
                <td className="mono">0.25%</td>
                <td>
                  <span className="tag tag-deepen">sealed</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function LeaderboardPage() {
  const board = [...DEMO_TOKENS].sort((a, b) => b.vol24h - a.vol24h)
  return (
    <>
      <h1 className="page-title">Leaderboard</h1>
      <p className="page-sub">
        Tape-bearing launches can go on the board — leveraged longs and shorts, margin in USDC. Experimental.
      </p>
      <div className="grid-3" style={{ marginBottom: 18 }}>
        {board.slice(0, 3).map((t, i) => (
          <div key={t.id} className="panel panel-pad">
            <div className="metric-label">#{i + 1} volume</div>
            <div style={{ color: 'var(--text-h)', fontWeight: 700, fontSize: 18 }}>${t.symbol}</div>
            <div className="mono" style={{ marginTop: 6 }}>
              {fmtUsd(t.vol24h)} · mcap {fmtUsd(t.mcap)}
            </div>
          </div>
        ))}
      </div>
      <div className="panel" style={{ overflow: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Token</th>
              <th>Vol 24h</th>
              <th>Mcap</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {board.map((t, i) => (
              <tr key={t.id}>
                <td className="mono">{i + 1}</td>
                <td style={{ color: 'var(--text-h)', fontWeight: 600 }}>${t.symbol}</td>
                <td className="mono">{fmtUsd(t.vol24h)}</td>
                <td className="mono">{fmtUsd(t.mcap)}</td>
                <td className={t.change24h >= 0 ? 'up' : 'down'}>
                  {t.change24h >= 0 ? '+' : ''}
                  {t.change24h.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section-head" style={{ marginTop: 28 }}>
        <div>
          <h2>Tape</h2>
          <p>Recent floor activity</p>
        </div>
      </div>
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Token</th>
              <th>Size</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {DEMO_ACTIVITY.map((a, i) => (
              <tr key={i}>
                <td>
                  <span className={`tag ${a.type === 'sell' ? 'tag-burn' : a.type === 'launch' ? 'tag-oracle' : 'tag-floor'}`}>
                    {a.type}
                  </span>
                </td>
                <td className="mono">${a.symbol}</td>
                <td>{a.amount}</td>
                <td className="mono">{a.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export function AgentsPage() {
  return (
    <>
      <h1 className="page-title">Agents</h1>
      <p className="page-sub">MCP / agent surface for reading the floor and assembling launches programmatically.</p>
      <div className="grid-2">
        <div className="panel panel-pad">
          <h3 style={{ margin: '0 0 8px', color: 'var(--text-h)' }}>Read tools</h3>
          <ul>
            <li>
              <code>list_launches</code> — recent tokens + modules
            </li>
            <li>
              <code>get_token</code> — mcap, vol, hook chips
            </li>
            <li>
              <code>list_modules</code> — gate/value registry
            </li>
          </ul>
        </div>
        <div className="panel panel-pad">
          <h3 style={{ margin: '0 0 8px', color: 'var(--text-h)' }}>Write tools</h3>
          <ul>
            <li>
              <code>preview_launch</code> — deterministic address + weight check
            </li>
            <li>
              <code>build_launch_tx</code> — unsigned payload for wallet agents
            </li>
            <li>
              <code>quote_swap</code> — V4 route estimate
            </li>
          </ul>
        </div>
      </div>
      <div className="panel panel-pad" style={{ marginTop: 14 }}>
        <div className="metric-label">Endpoint (placeholder)</div>
        <code>https://api.hooker.cash/mcp</code>
        <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>
          Wire your indexer auth secrets in env. This vamp ships the IA and agent docs shell only.
        </p>
      </div>
    </>
  )
}

export function DocsPage() {
  return (
    <div className="docs-layout">
      <nav className="docs-nav panel panel-pad">
        <a className="active" href="#hooks">
          Uniswap V4 hooks
        </a>
        <a href="#builder">Hook Builder</a>
        <a href="#split">70/30 split</a>
        <a href="#tape">Ticker Tape</a>
        <a href="#limits">Honest limits</a>
        <a href="#faq">FAQ</a>
      </nav>
      <article className="docs-body panel panel-pad">
        <div className="chip" style={{ marginBottom: 12 }}>
          📚 Guides
        </div>
        <h2 id="hooks">Uniswap V4 hooks?</h2>
        <p>
          The 30-second version: a <code>hook</code> is a contract Uniswap calls at points like{' '}
          <code>beforeSwap</code> / <code>afterSwap</code>. Your pool keeps AMM math; the hook adds house
          rules.
        </p>
        <h2 id="builder">Build your own — no Solidity needed</h2>
        <p>
          Pick modules on the Hook Builder. Gates run the door at the swap; values carve the cut at harvest.
          The builder assembles reviewed bytecode — card pick, not a code review.
        </p>
        <h2 id="split">The 70/30 split</h2>
        <p>
          Every swap pays the pool fee. At harvest, up to 70% can flow to creator-chosen recipients; the rest
          is protocol. Delta-free routing means external routers can still pick these pools up.
        </p>
        <h2 id="tape">Ticker Tape</h2>
        <p>
          Optional TWAP record — one honest tick a second, born with the pool. Required if you want the
          leverage board. Experimental.
        </p>
        <h2 id="limits">Honest limits</h2>
        <p>
          Buy caps key off the router, not the wallet — per-wallet keying is impossible from a pool hook by
          design. No custody. No refunds. Assume hostile tokens.
        </p>
        <h2 id="faq">FAQ</h2>
        <p>
          <strong style={{ color: 'var(--text-h)' }}>Is liquidity locked?</strong> Seed liquidity is sealed
          inside launch contracts from block one — no removal path.
        </p>
        <p>
          <strong style={{ color: 'var(--text-h)' }}>Do I need Solidity?</strong> No. Module cards compose the
          hook. Custom advanced hooks are a separate path.
        </p>
      </article>
    </div>
  )
}

export function TermsPage() {
  return (
    <>
      <h1 className="page-title">Terms</h1>
      <div className="panel panel-pad docs-body">
        <p>
          This interface is a non-custodial window onto permissionless smart contracts. It does not custody
          funds, provide investment advice, or endorse any token. You are solely responsible for wallet
          security, transaction review, and risk.
        </p>
        <p>
          Tokens can be launched by anyone. Many will be worthless or malicious. Charts and stats may be
          incomplete, delayed, or wrong. Signed transactions are final.
        </p>
        <p>
          This repository is a design/product vamp of the hooker.cash launchpad UX for portfolio and
          integration work. It is not affiliated with the production Hooker team unless explicitly stated.
          NFA.
        </p>
      </div>
    </>
  )
}

export function TokenPage() {
  const t = DEMO_TOKENS[0]
  return (
    <>
      <h1 className="page-title">
        {t.name} <span className="mono">${t.symbol}</span>
      </h1>
      <p className="page-sub">Token desk — demo. Wire address routing for production.</p>
      <div className="trade-layout">
        <div className="panel panel-pad">
          <div className="chart-fake">
            <svg viewBox="0 0 400 160" preserveAspectRatio="none">
              <path
                d="M0,100 C50,90 80,120 120,80 S200,40 240,60 320,20 400,40"
                fill="none"
                stroke="#62d9ff"
                strokeWidth="2.5"
              />
            </svg>
          </div>
        </div>
        <div className="panel panel-pad">
          <div className="preview-stat">
            <span>Price</span>
            <span>{fmtUsd(t.price)}</span>
          </div>
          <div className="preview-stat">
            <span>Mcap</span>
            <span>{fmtUsd(t.mcap)}</span>
          </div>
          <div className="preview-stat">
            <span>Vol 24h</span>
            <span>{fmtUsd(t.vol24h)}</span>
          </div>
          <div className="preview-stat" style={{ borderBottom: 'none' }}>
            <span>Modules</span>
            <span>{t.modules.join(', ')}</span>
          </div>
          <button className="btn btn-primary btn-lg" type="button" style={{ width: '100%', marginTop: 12 }}>
            Trade ${t.symbol}
          </button>
        </div>
      </div>
    </>
  )
}
