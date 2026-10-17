import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  Clock,
  Flame,
  Hourglass,
  ListChecks,
  Pause,
  Users,
  Wallet,
} from 'lucide-react'
import EngineArt from '../components/EngineArt.jsx'
import QuantpLedger from '../components/QuantpLedger.jsx'
import {
  ENGINE_STATE_LABEL,
  engineState,
  nextRunAt,
  payoutFigures,
  solFigure,
  tokenFigure,
  utcTime,
} from '../components/quantpPayouts.js'
import { Address } from '../components/UI.jsx'
import { useQuantp } from '../context/QuantpContext.jsx'
import { useResource } from '../lib/api.js'
import { ago, bps, compact, countdown, short, sol, toSol, usd } from '../lib/format.js'
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
const tierIndex = (tiers, marketCap) =>
  marketCap == null ? -1 : tiers.findIndex((t) => t.belowUsd == null || marketCap < t.belowUsd)

// The market-cap meter runs on a log scale from $1K to ten times the top tier's floor.
const METER_FROM = 3
const meterAt = (usdValue, top) =>
  Math.max(
    0,
    Math.min(100, ((Math.log10(Math.max(usdValue, 1)) - METER_FROM) / (top - METER_FROM)) * 100),
  )

// How full the payout wallet's tank is drawn: nearly empty at the fee reserve, then by the
// logarithm of its SOL, so a few SOL and a few hundred both read.
const tankLevel = (lamports) => {
  if (lamports == null) return 0.5
  const balance = toSol(lamports)
  if (balance <= toSol(POLICY.reserveLamports)) return 0.06
  return 0.28 + 0.3 * Math.log10(1 + 4 * balance)
}

/** The time now in seconds, every `ms`: the engine's clock moves with it. */
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** What the hero says about the engine's runs, by its state: one or two lines. */
function runLines(engine, state, error, now) {
  if (!engine)
    return [
      error
        ? 'The engine’s state is unavailable right now. Retrying shortly.'
        : 'Reading the engine…',
    ]
  if (state === 'paused')
    return ['Paused: no payouts or buybacks run until it is switched back on.']
  if (state === 'pending') return ['Switched on, and waiting for its first automatic run.']
  const last = `Last run ${utcTime(engine.lastRunAt)} UTC, ${ago(engine.lastRunAt)} ago`
  if (state === 'late') return [`${last}: it is behind its hourly schedule.`]
  const next = nextRunAt(engine, now)
  return [
    last,
    next
      ? `Next run at ${utcTime(next)} UTC, in ${countdown(next - now)}`
      : 'This hour’s run is due now',
  ]
}

/** The engine's state as a status light: green running, yellow waiting, pink late, grey paused. */
function StateLight({ state }) {
  if (!state) return null
  return (
    <span className="eg-state" data-state={state}>
      <i className="eg-state-dot" aria-hidden="true" />
      {ENGINE_STATE_LABEL[state]}
    </span>
  )
}

const STATE_ICON = { running: Clock, late: Clock, pending: Hourglass, paused: Pause }

/** Beside the run lines: the hour so far, filling towards the next run, or the state's icon. */
function WhenIcon({ state, hourDone }) {
  if (hourDone != null)
    return (
      <span className="eg-clock" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15" className="eg-clock-track" />
          <circle
            cx="18"
            cy="18"
            r="15"
            pathLength="100"
            className="eg-clock-left"
            transform="rotate(-90 18 18)"
            style={{ strokeDasharray: `${Math.min(100, hourDone * 100).toFixed(1)} 100` }}
          />
        </svg>
      </span>
    )
  const Icon = STATE_ICON[state]
  return Icon ? (
    <span className="eg-clock eg-clock-icon" aria-hidden="true">
      <Icon size={18} strokeWidth={2.2} />
    </span>
  ) : null
}

// $QUANTP's payout engine (server/quantp-engine.mjs): where it stands and what its next run pays,
// from /api/quantp/engine; its rules, from QUANTP.engine; and every payout and burn so far, from
// /api/quantp/ledger (QuantpLedger, without its own engine block). Totals come from /api/quantp.
// The hero is a graphite instrument in both themes, around the engine's own drawing (EngineArt).
export default function EnginePage() {
  const q = useQuantp()
  const d = q.data
  const res = useResource('/api/quantp/engine', 60_000)
  const now = useNow(30_000)
  const engine = res.data?.configured ? res.data : null
  const state = engineState(engine, now)
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
  const nextAt = state === 'running' ? nextRunAt(engine, now) : null
  const tiers = POLICY.tiers
  const tierNow = tierIndex(tiers, marketCap)
  const nextTier = tierNow >= 0 ? tiers[tierNow + 1] : null

  const toHolders = next ? toSol(next.holders) : null
  const toBurn = next ? toSol(next.buyback) : null
  const split = toHolders + toBurn > 0 ? toHolders / (toHolders + toBurn) : holdersPct / 100
  const paying = next?.paying ?? engine?.eligible ?? null

  const steps = [
    [
      Wallet,
      'blue',
      'Fees fill the payout wallet',
      `Every ${ticker} buy and sell pays a ${bps(postFee)} fee in its Meteora DAMM v2 pool. The team sends the creator’s share of it to the payout wallet.`,
    ],
    [
      Clock,
      'yellow',
      'A slice is released every hour',
      `The engine releases ${dailyBps == null ? 'a share' : bps(dailyBps)} of the wallet a day at today’s market cap, a 24th of it each hour: small now, more as the market cap grows.`,
    ],
    [
      Users,
      'green',
      `${holdersPct}% goes to holders`,
      `In SOL, to every wallet holding at least ${minHoldPct}% of the supply (${compact(minHold)} ${ticker}), by balance: hold more, get more. Pools and the team’s wallets are never paid.`,
    ],
    [
      Flame,
      'pink',
      `${buybackPct}% is bought back and burned`,
      `It buys ${ticker} in its DAMM v2 pool and burns it in the same transaction, so the supply only goes down.`,
    ],
    [
      ListChecks,
      'tint',
      'Every transaction is listed',
      'Each payout and burn is read from the chain and listed below, with its link to Solscan.',
    ],
  ]

  const stats = [
    [
      'Market cap',
      usd(marketCap),
      tierNow >= 0 ? `${tierLabel(tiers, tierNow)} tier` : null,
      'yellow',
    ],
    [
      'Released a day',
      dailyBps == null ? '—' : bps(dailyBps),
      dailyBps == null ? null : `about ${bps(dailyBps / 24)} each hour`,
      'blue',
    ],
    [
      'In the payout wallet',
      engine ? sol(toSol(engine.balance), { digits: 3 }) : '—',
      short(POLICY.wallet),
      'tint',
    ],
    [
      'Wallets eligible now',
      engine ? engine.eligible.toLocaleString('en-US') : '—',
      `holding ${minHoldPct}% or more`,
      'green',
    ],
    [
      'Paid to holders',
      solFigure(paid.paidSol),
      paid.wallets ? `to ${paid.wallets.toLocaleString('en-US')} wallets so far` : null,
      'green',
    ],
    [
      'Bought back and burned',
      paid.burned == null ? '—' : `${tokenFigure(paid.burned)} ${q.symbol}`,
      paid.boughtSol ? `${solFigure(paid.boughtSol)} bought back` : null,
      'pink',
    ],
  ]

  return (
    <div className="wrap eg-page">
      <header className="eg-hero">
        <span className="eg-hero-lines" aria-hidden="true" />
        <div className="eg-copy">
          <div className="eg-chips">
            <Link to={QUANTP.path} className="chip chip-own">
              {ticker}
            </Link>
            <StateLight state={state} />
          </div>
          <h1 className="eg-h1">
            <span className="eg-title">Payout Engine</span>
            <span className="eg-lede">
              Pays {ticker} holders in SOL and burns {ticker}, every hour.
            </span>
          </h1>
          <div className="eg-actions">
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

        <EngineArt
          mode={live ? 'run' : state === 'paused' ? 'off' : 'idle'}
          holders={paying ?? 24}
          share={split}
          level={tankLevel(engine?.balance)}
          now={now}
          tags={{
            wallet: ['Payout wallet', engine ? sol(toSol(engine.balance), { digits: 3 }) : null],
            core: ['Every hour', dailyBps == null ? null : `${bps(dailyBps)} a day`],
            holders: [`${holdersPct}% to holders`, paying == null ? null : `${paying} wallets`],
            burn: [`${buybackPct}% buyback`, 'and burn'],
          }}
        />

        <div className="eg-readout">
          <div className="eg-next">
            <p className="eg-label">Next run</p>
            <p className="eg-next-sol num">
              {next ? sol(toSol(next.release), { digits: 4 }) : '—'}
            </p>
          </div>
          {next && (
            <div className="eg-split">
              <div className="eg-split-bar" aria-hidden="true">
                <i className="eg-split-holders" style={{ flexGrow: split }} />
                <i className="eg-split-burn" style={{ flexGrow: 1 - split }} />
              </div>
              <ul className="eg-next-split">
                <li>
                  <i className="qp-dot qp-dot-holders" />{' '}
                  <span className="num">{sol(toHolders, { digits: 4 })}</span> to{' '}
                  {next.paying.toLocaleString('en-US')} {next.paying === 1 ? 'wallet' : 'wallets'}
                </li>
                <li>
                  <i className="qp-dot qp-dot-burn" />{' '}
                  {BigInt(next.buyback) > 0n ? (
                    <>
                      <span className="num">{sol(toBurn, { digits: 4 })}</span> to buy back and burn
                    </>
                  ) : (
                    `The buyback waits until it reaches ${sol(toSol(POLICY.minBuybackLamports), { digits: 3 })}`
                  )}
                </li>
              </ul>
            </div>
          )}
          <div className="eg-when" data-state={state ?? 'unknown'} aria-live="polite">
            <WhenIcon
              state={state}
              hourDone={nextAt ? 1 - (nextAt - now) / engine.everySecs : null}
            />
            <span className="eg-when-text">
              {runLines(engine, state, res.error, now).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          </div>
        </div>
      </header>

      <dl className="eg-stats">
        {stats.map(([label, value, note, tone]) => (
          <div key={label} className="eg-stat" data-tone={tone}>
            <dt>{label}</dt>
            <dd>
              <span className="num">{value}</span>
              {note && <small>{note}</small>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="eg-grid">
        <div className="eg-main">
          <section className="panel eg-how" aria-labelledby="eg-how-title">
            <h2 id="eg-how-title" className="h3">
              How it works
            </h2>
            <ol className="eg-steps">
              {steps.map(([Icon, tone, title, text]) => (
                <li key={title} data-tone={tone}>
                  <span className="eg-step-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={2.2} />
                  </span>
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
            {marketCap != null && (
              <div className="eg-meter">
                <p className="eg-meter-head">
                  <span>
                    Market cap <b className="num">{usd(marketCap)}</b>
                  </span>
                  {nextTier && (
                    <span className="faint">
                      {bps(nextTier.dailyBps)} a day from {usd(tiers[tierNow].belowUsd)}
                    </span>
                  )}
                </p>
                <div className="eg-meter-track" aria-hidden="true">
                  {tiers.map((tier, i) => {
                    const top = Math.log10(tiers[tiers.length - 2].belowUsd) + 1
                    const from = i === 0 ? 0 : meterAt(tiers[i - 1].belowUsd, top)
                    const to = tier.belowUsd == null ? 100 : meterAt(tier.belowUsd, top)
                    return (
                      <i
                        key={tier.dailyBps}
                        className={i === tierNow ? 'is-here' : ''}
                        style={{ left: `${from}%`, width: `${to - from}%` }}
                      />
                    )
                  })}
                  <b
                    style={{
                      left: `${meterAt(marketCap, Math.log10(tiers[tiers.length - 2].belowUsd) + 1)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            <div className="eg-tier-list">
              {tiers.map((tier, i) => {
                const isNow = dailyBps === tier.dailyBps
                return (
                  <div
                    key={tier.dailyBps}
                    className={`eg-tier ${isNow ? 'is-now' : ''}`}
                    style={{ '--fill': `${Math.min(100, tier.dailyBps / 100)}%` }}
                  >
                    <span className="eg-tier-label">
                      {tierLabel(tiers, i)}
                      {isNow && <span className="qp-now">Now</span>}
                    </span>
                    <span className="eg-tier-pct num">{bps(tier.dailyBps)}</span>
                    <span className="eg-tier-bar" aria-hidden="true">
                      <i />
                    </span>
                    <span className="eg-tier-hint">{tierHint(tier.dailyBps)}</span>
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
