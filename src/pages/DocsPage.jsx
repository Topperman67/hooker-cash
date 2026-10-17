import { Link } from 'react-router-dom'
import { usePlatform } from '../context/PlatformContext.jsx'
import { Address } from '../components/UI.jsx'
import { useQuantp } from '../context/QuantpContext.jsx'
import { BUYBACK_RULE, ENGINE_NOTE, GRADUATED, HOLDERS_RULE } from '../components/quantpPayouts.js'
import { bps } from '../lib/format.js'
import { explorer, QUANTP } from '../../shared/network.mjs'

const SECTIONS = [
  ['launching', 'Launching a coin'],
  ['trading', 'Trading'],
  ['hooks', 'Quantum Hooks'],
  ['fees', 'Fees'],
  ['safety', 'Safety'],
  ['quantp', '$QUANTP'],
]

export default function DocsPage() {
  const { platform, quantum } = usePlatform()
  // $QUANTP's curve state, so the hook and fee lines read right before and after graduation. It has
  // graduated for good (GRADUATED), so they read right while /api/quantp is down too.
  const migrated = GRADUATED || !!useQuantp()?.data?.migrated
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
          Quant Pad is a launch and trading front end for Meteora on Solana, with an on-chain
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
            Choose a Quantum launch (hooks) or a standard Meteora launch (you are the creator and
            claim fees yourself).
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
          Every coin is a real Meteora coin: it trades on Meteora’s Dynamic Bonding Curve and
          graduates to a Meteora DAMM v2 pool, with its liquidity permanently locked, when the curve
          fills.
        </p>

        <h2 id="trading">Trading</h2>
        <p>
          Buy with SOL and sell for SOL from any coin page. Before graduation trades go to the
          coin’s Meteora bonding curve; after graduation they go to its Meteora DAMM v2 pool. Your
          slippage limit is enforced on-chain, so a trade fails instead of filling at a worse price.
          You can open any Meteora bonding-curve coin by pasting its mint address in the search box.
        </p>

        <h2 id="hooks">Quantum Hooks</h2>
        <p>
          A Quantum coin’s Meteora creator is a program-controlled address unique to that coin,
          called its well. Creator fees accumulate for the well; a pulse collects them and splits
          them by the allocation fixed at launch. See <Link to="/hooks">Quantum Hooks</Link> for
          each module.
        </p>

        <h2 id="fees">Fees</h2>
        <ul>
          <li>
            Every Quant Pad coin has a trading tax, shown on its coin page: 1% on Standard launches,
            and 1%, 2%, 3% or 5% on Quantum launches, as the launcher picks. Standard launches can
            also opt into an anti-sniper tax: 25% at launch, falling to the tax over the first two
            minutes. Meteora keeps its protocol share and the rest goes to the coin’s creator.
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
            Meteora can upgrade its programs, and its operators can change or pause a migrated pool.
            Quantum Hooks depend on Meteora continuing to pay creator fees to the well.
          </li>
          <li>The Quantum Hooks program has not yet been independently audited.</li>
        </ul>

        <h2 id="quantp">$QUANTP</h2>
        <p>
          $QUANTP is Quant Pad’s own token. It launched on Meteora’s Dynamic Bonding Curve and has
          graduated to a Meteora DAMM v2 pool. Its fee split is paid out about once an hour by Quant
          Pad’s payout engine from a wallet the team funds, at the team’s discretion; nothing
          on-chain enforces it. <Link to={QUANTP.path}>Open $QUANTP</Link>.
        </p>
        <ul>
          <li>
            Contract:{' '}
            <Address value={QUANTP.mint} head={8} tail={8} href={explorer.token(QUANTP.mint)} />
          </li>
          <li>
            A Token-2022 token with 6 decimals and a fixed supply of 1,000,000,000 (burns can only
            lower it). Its mint and freeze authorities are revoked, so no more can ever be minted
            and no account can be frozen.
          </li>
          <li>
            {migrated
              ? 'While it traded on its bonding curve, every transfer ran a transfer-hook program. Meteora removed the hook when the curve graduated, so its transfers no longer run it.'
              : 'While it trades on its bonding curve, every transfer runs a transfer-hook program, which its owner can upgrade. It only checks a launch whitelist that has already opened, and it takes no fee. Meteora removes the hook when the curve graduates.'}
          </li>
        </ul>
        <h3>Fees</h3>
        <ul>
          <li>
            2% of every buy and sell on its Meteora bonding curve, taken in SOL. Meteora keeps 20%
            of that fee, the launch partner 8% and the creator 72%.
          </li>
          <li>
            5% of every trade in its Meteora DAMM v2 pool, once the curve has graduated.{' '}
            {migrated
              ? 'It has: the curve filled and $QUANTP now trades in its DAMM v2 pool.'
              : 'Graduation happens on its own when the curve fills.'}
          </li>
          <li>
            {ENGINE_NOTE} Holders: {HOLDERS_RULE} Buyback and burn: {BUYBACK_RULE} The figures Quant
            Pad shows are what has actually been paid, bought back and burned, and every transaction
            is listed on the <Link to={QUANTP.path}>$QUANTP page</Link>.
          </li>
          <li>
            Any Quant Pad platform fee on trades made here is shown before you sign, as a separate
            transfer.
          </li>
        </ul>
        <h3>Buying on Quant Pad</h3>
        <ol>
          <li>Connect a Solana wallet.</li>
          <li>
            Open <Link to={QUANTP.path}>$QUANTP</Link>, or search “quantp”.
          </li>
          <li>
            Enter an amount, check the fee and the minimum you receive, and approve in your wallet.
            Quant Pad trades on the bonding curve before graduation and in the DAMM v2 pool after,
            and switches on its own.
          </li>
        </ol>
        {!migrated && (
          <p>
            Some aggregators, Jupiter among them, cannot trade it while its transfer hook is active.
          </p>
        )}
        <h3>Risks</h3>
        <ul>
          <li>
            Memecoins are extremely volatile and most lose all value. Nothing here is financial
            advice.
          </li>
          <li>Quant Pad promotes its own token here, so it is not a neutral party.</li>
          <li>
            Holder payouts and buybacks depend on the team funding the payout wallet and on Quant
            Pad’s server running the engine. No on-chain program enforces them.
          </li>
          <li>
            Payouts and buybacks are the team’s discretionary policy: they can change, pause or stop
            at any time, and a run can pay nothing. Holding $QUANTP gives no right to any payment.
          </li>
          {!migrated && (
            <li>
              Until graduation the hook’s owner can change the transfer hook, which runs on every
              transfer.
            </li>
          )}
        </ul>
      </article>
    </div>
  )
}
