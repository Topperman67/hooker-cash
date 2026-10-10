import { Link } from 'react-router-dom'
import { usePlatform } from '../context/PlatformContext.jsx'
import { bps } from '../lib/format.js'

const SECTIONS = [
  ['launching', 'Launching a coin'],
  ['trading', 'Trading'],
  ['hooks', 'Quantum Hooks'],
  ['fees', 'Fees'],
  ['safety', 'Safety'],
]

export default function DocsPage() {
  const { platform, quantum } = usePlatform()
  return (
    <div className="wrap docs">
      <nav className="docs-nav" aria-label="Documentation sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <article className="prose">
        <h1>How Quant Pad works</h1>
        <p className="muted">
          Quant Pad is a launch and trading front end for pump.fun on Solana, with an on-chain
          program that routes each coin’s creator fees.
        </p>

        <h2 id="launching">Launching a coin</h2>
        <ol>
          <li>Connect a Solana wallet such as Phantom, Solflare or Backpack.</li>
          <li>
            On the Launch page, add a name, ticker, artwork and optional links. The metadata is
            published by Quant Pad and its address is stored in your token forever.
          </li>
          <li>
            Choose a Quantum launch (hooks) or a standard pump.fun launch (you are the creator and
            collect fees yourself).
          </li>
          <li>
            Optionally make a dev buy. It executes in the same transaction that creates the coin, so
            nobody can buy before you.
          </li>
          <li>
            Approve the transactions in your wallet. A Quantum launch first registers the hooks for
            the new mint, then creates the coin, then applies the Time Dilation lock if you chose
            one.
          </li>
        </ol>
        <p>
          Every coin is a real pump.fun coin: it appears on pump.fun, trades on the bonding curve,
          and graduates to a PumpSwap pool when the curve sells out.
        </p>

        <h2 id="trading">Trading</h2>
        <p>
          Buy with SOL and sell for SOL from any coin page. Before graduation trades go to the
          pump.fun bonding curve; after graduation they go to the coin’s canonical PumpSwap pool.
          Your slippage limit is enforced on-chain, so a trade fails instead of filling at a worse
          price. You can open any pump.fun coin by pasting its mint address in the search box.
        </p>

        <h2 id="hooks">Quantum Hooks</h2>
        <p>
          A Quantum coin’s pump.fun creator is a program-controlled address unique to that coin,
          called its well. Creator fees accumulate for the well; a pulse collects them and splits
          them by the allocation fixed at launch. See <Link to="/hooks">Quantum Hooks</Link> for
          each module.
        </p>

        <h2 id="fees">Fees</h2>
        <ul>
          <li>
            pump.fun charges its own trading fees, currently 1.25% on the bonding curve (0.95%
            protocol, 0.30% creator), and a tiered schedule on PumpSwap.
          </li>
          <li>
            {platform.feeBps
              ? `Quant Pad adds ${bps(platform.feeBps)} on trades and dev buys made here, shown before you sign as a separate transfer.`
              : 'Quant Pad currently charges no trading fee of its own.'}
          </li>
          <li>
            {quantum.protocolBps
              ? `Quantum Hooks take a ${bps(quantum.protocolBps)} protocol share of each fee pulse before it is split.`
              : 'Quantum Hooks take no protocol share of fee pulses unless the operator sets one (capped at 10% on-chain).'}
          </li>
          <li>
            Launching costs about 0.02–0.03 SOL in network fees and account rent, plus any dev buy.
          </li>
        </ul>

        <h2 id="safety">Safety</h2>
        <ul>
          <li>
            Quant Pad never holds your keys. Every action is a transaction you review and sign in
            your wallet.
          </li>
          <li>Memecoins are extremely volatile and most lose all value.</li>
          <li>
            pump.fun can change its programs or reassign a coin’s creator. Quantum Hooks depend on
            pump.fun continuing to pay creator fees to the well.
          </li>
          <li>The Quantum Hooks program has not yet been independently audited.</li>
        </ul>
      </article>
    </div>
  )
}
