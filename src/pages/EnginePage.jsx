import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import QuantpLedger from '../components/QuantpLedger.jsx'
import {
  ENGINE_STATE_LABEL,
  engineState,
  payoutFigures,
  solFigure,
  tokenFigure,
} from '../components/quantpPayouts.js'
import { Address, Stat } from '../components/UI.jsx'
import { useQuantp } from '../context/QuantpContext.jsx'
import { useResource } from '../lib/api.js'
import { ago, bps, compact, countdown, sol, toSol, usd } from '../lib/format.js'
import { QUANTP, explorer } from '../../shared/network.mjs'

const POLICY = QUANTP.engine

// "Below $100K", "$100K to $1M", "Above $1M": the market-cap tiers of QUANTP.engine.tiers.
const tierLabel = (tiers, i) =>
  i === 0
    ? `Below ${usd(tiers[0].belowUsd)}`
    : tiers[i].belowUsd == null
      ? `Above ${usd(tiers[i - 1].belowUsd)}`
      : `${usd(tiers[i - 1].belowUsd)} to ${usd(tiers[i].belowUsd)}`
const tierHint = (dailyBps) =>
  dailyBps >= 10_000
    ? 'all of the wallet over a day'
    : `of the wallet a day, about ${bps(dailyBps / 24)} each hour`

/** What the hero says about the engine's runs, by its state. */
function runLine(engine, state, error) {
  if (!engine)
    return error
      ? 'The engine’s state is unavailable right now. Retrying shortly.'
      : 'Reading the engine…'
  if (state === 'paused') return 'Paused: no payouts or buybacks run until it is switched back on.'
  if (state === 'pending') return 'Switched on, and waiting for its first automatic run.'
  if (state === 'late')
    return `Last run ${ago(engine.lastRunAt)} ago: it is behind its hourly schedule.`
  const left = engine.lastRunAt + engine.everySecs - Date.now() / 1000
  return `Last run ${ago(engine.lastRunAt)} ago · next in ${left > 60 ? `about ${countdown(left)}` : 'a moment'}`
}

// $QUANTP's payout engine (server/quantp-engine.mjs): where it stands and what its next run pays,
// from /api/quantp/engine; its rules, from QUANTP.engine; and every payout and burn so far, from
// /api/quantp/ledger (QuantpLedger, without its own engine block). Totals come from /api/quantp.
export default function EnginePage() {
  const q = useQuantp()
  const d = q.data
  const res = useResource('/api/quantp/engine', 60_000)
  const engine = res.data?.configured ? res.data : null
  const state = engineState(engine)
  const live = state != null && state !== 'paused'
  const ticker = `$${q.symbol}`
  const paid = payoutFigures(d?.payouts, q.decimals)
  const minHoldPct = POLICY.minHoldBps / 100
  const minHold =
    (engine ? Number(engine.minHold) : (Number(q.supply) * POLICY.minHoldBps) / 10_000) /
    10 ** q.decimals
  const holdersPct = q.holdersShareBps / 100
  const buybackPct = q.buybackShareBps / 100
  const marketCap = engine?.marketCapUsd ?? d?.marketCapUsd ?? null
  const dailyBps = engine?.dailyBps ?? null
  const postFee = d?.postGradFeeBps ?? q.postGradFeeBps
  const next = live ? engine.next : null

  const steps = [
    [
      'Fees fill the payout wallet',
      `Every ${ticker} buy and sell pays a ${bps(postFee)} fee in its Meteora DAMM v2 pool. The team sends the creator’s share of it to the payout wallet.`,
    ],
    [
      'A slice is released every hour',
      `The engine releases ${dailyBps == null ? 'a share' : bps(dailyBps)} of the wallet a day at today’s market cap, a 24th of it each hour: small now, more as the market cap grows.`,
    ],
    [
      `${holdersPct}% goes to holders`,
      `In SOL, to every wallet holding at least ${minHoldPct}% of the supply (${compact(minHold)} ${ticker}), by balance: hold more, get more. Pools and the team’s wallets are never paid.`,
    ],
    [
      `${buybackPct}% is bought back and burned`,
      `It buys ${ticker} in its DAMM v2 pool and burns it in the same transaction, so the supply only goes down.`,
    ],
    [
      'Every transaction is listed',
      'Each payout and burn is read from the chain and listed below, with its link to Solscan.',
    ],
  ]

  return (
    <div className="wrap eg-page">
      <header className="qp-hero eg-hero">
        <span className="qp-hero-lines" aria-hidden="true" />
        <div className="qp-id">
          <span className="qp-lens" aria-hidden="true">
            <img src="/brand/mark.svg" alt="" width="104" height="104" />
          </span>
          <div className="qp-names">
            <div className="qp-chips">
              <Link to={QUANTP.path} className="chip chip-own">
                {ticker}
              </Link>
              {state && (
                <span className={`chip ${state === 'running' ? 'chip-grad' : ''}`}>
                  {ENGINE_STATE_LABEL[state]}
                </span>
              )}
            </div>
            <h1 className="qp-title">
              <span className="qp-ticker eg-title chrome-text">Payout Engine</span>
              <span className="qp-name">
                Pays {ticker} holders in SOL and burns {ticker}, every hour.
              </span>
            </h1>
            <div className="qp-actions">
              <a className="btn btn-primary" href="#payouts">
                See every payout
              </a>
              <a
                className="btn"
                href={explorer.account(POLICY.wallet)}
                target="_blank"
                rel="noreferrer"
              >
                Payout wallet <ArrowUpRight size={14} aria-hidden="true" />
              </a>
              <Link className="btn" to={QUANTP.path}>
                {ticker} page
              </Link>
            </div>
          </div>
        </div>
        <div className="qp-quote eg-next">
          <p className="qp-label">Next run</p>
          <p className="qp-price num">{next ? sol(toSol(next.release), { digits: 4 }) : '—'}</p>
          {next && (
            <ul className="eg-next-split">
              <li>
                <i className="qp-dot qp-dot-holders" />{' '}
                <span className="num">{sol(toSol(next.holders), { digits: 4 })}</span> to{' '}
                {next.paying.toLocaleString('en-US')} {next.paying === 1 ? 'wallet' : 'wallets'}
              </li>
              <li>
                <i className="qp-dot qp-dot-burn" />{' '}
                {BigInt(next.buyback) > 0n ? (
                  <>
                    <span className="num">{sol(toSol(next.buyback), { digits: 4 })}</span> to buy
                    back and burn
                  </>
                ) : (
                  `The buyback waits until it reaches ${sol(toSol(POLICY.minBuybackLamports), { digits: 3 })}`
                )}
              </li>
            </ul>
          )}
          <p className="qp-updated faint" aria-live="polite">
            {runLine(engine, state, res.error)}
          </p>
        </div>
      </header>

      <dl className="qp-stats eg-stats">
        <Stat label="Market cap">
          <span className="num">{usd(marketCap)}</span>
        </Stat>
        <Stat label="Released a day">
          <span className="num">{dailyBps == null ? '—' : bps(dailyBps)}</span>
        </Stat>
        <Stat label="In the payout wallet">
          <span className="num">{engine ? sol(toSol(engine.balance), { digits: 3 }) : '—'}</span>
        </Stat>
        <Stat label="Wallets eligible now">
          <span className="num">{engine ? engine.eligible.toLocaleString('en-US') : '—'}</span>
        </Stat>
        <Stat label="Paid to holders">
          <span className="num">{solFigure(paid.paidSol)}</span>
        </Stat>
        <Stat label="Bought back and burned">
          <span className="num">
            {paid.burned == null ? '—' : `${tokenFigure(paid.burned)} ${q.symbol}`}
          </span>
        </Stat>
      </dl>

      <div className="eg-grid">
        <div className="eg-main">
          <section className="panel eg-how" aria-labelledby="eg-how-title">
            <h2 id="eg-how-title" className="h3">
              How it works
            </h2>
            <ol className="eg-steps">
              {steps.map(([title, text]) => (
                <li key={title}>
                  <strong>{title}</strong>
                  <p className="muted">{text}</p>
                </li>
              ))}
            </ol>
          </section>

          <div className="eg-ledger">
            <QuantpLedger
              symbol={q.symbol}
              decimals={q.decimals}
              burned={d?.burned == null ? null : Number(d.burned) / 10 ** q.decimals}
              showEngine={false}
            />
          </div>

          <section className="panel eg-disclose" aria-labelledby="eg-disclose-title">
            <h2 id="eg-disclose-title" className="h3">
              Before you buy
            </h2>
            <ul>
              <li>
                The engine is the team’s policy, not on-chain code: it runs on Quant Pad’s server
                and pays only what the team puts in the payout wallet. Nothing on-chain enforces it.
              </li>
              <li>Payouts are small while the market cap is small.</li>
              <li>
                {ticker} is Quant Pad’s own token. Memecoins are extremely risky and can lose all
                their value. Nothing here is financial advice.
              </li>
            </ul>
          </section>
        </div>

        <aside className="eg-side">
          <section className="panel eg-tiers" aria-labelledby="eg-tiers-title">
            <h2 id="eg-tiers-title" className="h3">
              Released per day, by market cap
            </h2>
            <div className="eg-tier-list">
              {POLICY.tiers.map((tier, i) => {
                const now = dailyBps === tier.dailyBps
                return (
                  <div key={tier.dailyBps} className={`qp-fee ${now ? 'is-now' : ''}`}>
                    <span className="qp-fee-text eg-tier-label">
                      {tierLabel(POLICY.tiers, i)}
                      {now && <span className="qp-now">Now</span>}
                    </span>
                    <span className="qp-fee-pct num">{bps(tier.dailyBps)}</span>
                    <span className="qp-fee-text">{tierHint(tier.dailyBps)}</span>
                  </div>
                )
              })}
            </div>
            <p className="faint qp-fine">
              Each run releases at most {sol(toSol(POLICY.maxRunLamports), { digits: 0 })} and keeps{' '}
              {sol(toSol(POLICY.reserveLamports), { digits: 2 })} in the wallet for fees.
            </p>
          </section>

          <section className="panel eg-rules" aria-labelledby="eg-rules-title">
            <h2 id="eg-rules-title" className="h3">
              The rules
            </h2>
            <dl className="kv">
              <dt>Runs</dt>
              <dd>Every hour, on Quant Pad’s server</dd>
              <dt>Paid</dt>
              <dd>
                Wallets holding at least {minHoldPct}% of the supply ({compact(minHold)} {ticker})
                when a run starts
              </dd>
              <dt>Never paid</dt>
              <dd>Liquidity pools and the team’s wallets</dd>
              <dt>Split</dt>
              <dd>
                {holdersPct}% to holders by balance, {buybackPct}% to buy back and burn
              </dd>
              <dt>Small amounts</dt>
              <dd>
                A share under {sol(toSol(POLICY.minTransferLamports))} or a buyback under{' '}
                {sol(toSol(POLICY.minBuybackLamports), { digits: 3 })} waits for a later run
              </dd>
              <dt>Wallet</dt>
              <dd>
                <Address value={POLICY.wallet} href={explorer.account(POLICY.wallet)} />
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
