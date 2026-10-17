import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, ChevronDown, Coins, Flame, Search } from 'lucide-react'
import EngineChart, { useSize } from '../components/EngineChart.jsx'
import {
  activityOf,
  burnSeries,
  clock,
  nextRun,
  paidSeries,
  tierIndex,
} from '../components/engineData.js'
import { ENGINE_STATE_LABEL, engineState } from '../components/quantpPayouts.js'
import { Address } from '../components/UI.jsx'
import { useQuantp } from '../context/QuantpContext.jsx'
import { useResource } from '../lib/api.js'
import { ago, bps, compact, countdown, formatUnits, short, sol, toSol, usd } from '../lib/format.js'
import { QUANTP, explorer } from '../../shared/network.mjs'

const FEED_ROWS = 8
const WALLET_ROWS = 25
const TABLE_ROWS = 12

const solText = (lamports, digits = 4) =>
  lamports == null ? '—' : sol(toSol(lamports), { digits })
const plain = (lamports, digits = 4) =>
  lamports == null ? '—' : sol(toSol(lamports), { digits, unit: false })
const when = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
    : '—'
const count = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const usdBound = (v) => usd(v).replace('.00', '')

// The chip's words when the engine is in none of its four states (quantpPayouts.js engineState).
const OTHER_STATE = {
  off: 'Not set up',
  down: 'Status unavailable',
  loading: 'Reading the engine…',
}

/** What the hero says about the engine's runs, by its state. */
function runLine(engine, state, run, error) {
  if (!engine)
    return error ? 'The engine’s state is unavailable right now. Retrying shortly.' : null
  if (state === 'paused') return 'Paused: no payouts or buybacks run until it is switched back on.'
  if (state === 'pending') return 'Switched on, and waiting for its first automatic run.'
  if (state === 'late')
    return `Last run ${ago(engine.lastRunAt)} ago: it is behind its hourly schedule.`
  return `Last run ${ago(engine.lastRunAt)} ago · next ${run?.left > 60 ? `in about ${countdown(run.left)}` : 'this hour'}`
}

/** Now in unix seconds, ticking every `ms`. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

function TxLink({ signature, children }) {
  return (
    <a href={explorer.tx(signature)} target="_blank" rel="noreferrer" className="eng-tx">
      {children ?? signature.slice(0, 6)}
      <ArrowUpRight size={12} aria-hidden="true" />
    </a>
  )
}

function More({ total, shown, step, onMore, onLess }) {
  if (total <= step) return null
  return (
    <div className="eng-more">
      <span className="faint num">
        {Math.min(shown, total).toLocaleString('en-US')} of {total.toLocaleString('en-US')}
      </span>
      {shown < total ? (
        <button type="button" className="btn btn-sm" onClick={onMore}>
          Show more
        </button>
      ) : (
        <button type="button" className="btn btn-sm" onClick={onLess}>
          Show fewer
        </button>
      )}
    </div>
  )
}

/** The countdown ring: how far through its hour the engine is, and the time left. */
function RunClock({ run, release, label }) {
  const r = 54
  const length = 2 * Math.PI * r
  const progress = run?.progress ?? 0
  return (
    <div className={`eng-clock ${run ? 'is-on' : 'is-off'}`}>
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <defs>
          <linearGradient id="eng-clock-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8fa4ff" />
            <stop offset="100%" stopColor="#2e4bff" />
          </linearGradient>
        </defs>
        <circle className="eng-clock-track" cx="64" cy="64" r={r} />
        {Array.from({ length: 12 }, (_, i) => (
          <line
            key={i}
            className="eng-clock-tick"
            x1="64"
            y1="4"
            x2="64"
            y2={i % 3 ? 8 : 11}
            transform={`rotate(${i * 30} 64 64)`}
          />
        ))}
        <circle
          className="eng-clock-arc"
          cx="64"
          cy="64"
          r={r}
          strokeDasharray={length}
          strokeDashoffset={length * (1 - progress)}
          transform="rotate(-90 64 64)"
        />
      </svg>
      <div className="eng-clock-face">
        {run ? (
          <>
            <span className="eng-clock-label">{run.left > 0 ? 'Next run in' : 'Next run'}</span>
            <strong className="num">{run.left > 0 ? clock(run.left) : 'This hour'}</strong>
            <span className="eng-clock-sub num">≈ {solText(release)}</span>
          </>
        ) : (
          <>
            <span className="eng-clock-label">Next run</span>
            <strong className="eng-clock-off">—</strong>
            <span className="eng-clock-sub">{label}</span>
          </>
        )}
      </div>
    </div>
  )
}

// The gap between the two outputs (engine.css .eng-outs): the branches end at their middles.
const OUTS_GAP = 10

/** The engine wallet's two branches, drawn at the size the layout gives them. */
function Fork() {
  const box = useRef(null)
  const { width: w, height: h } = useSize(box)
  const mid = h / 2
  const up = (h - OUTS_GAP) / 4
  const down = h - up
  const branch = (to) => `M0,${mid} C${w * 0.55},${mid} ${w * 0.45},${to} ${w},${to}`
  return (
    <span ref={box} className="eng-fork" aria-hidden="true">
      {w > 0 && h > 0 && (
        <svg width={w} height={h}>
          <path className="eng-fork-path" d={branch(up)} />
          <path className="eng-fork-path" d={branch(down)} />
          <path className="eng-fork-pulse is-green" d={branch(up)} pathLength="100" />
          <path className="eng-fork-pulse is-pink" d={branch(down)} pathLength="100" />
        </svg>
      )}
    </span>
  )
}

/** Fees in, through the engine wallet, out to holders and to the buyback and burn. */
function Flow({ feeBps, balance, dailyBps, holdersPct, eligible, next, live }) {
  return (
    <div className={`eng-flow ${live ? 'is-live' : ''}`}>
      <div className="eng-node eng-node-in">
        <span className="eng-node-label">Trading fee</span>
        <strong className="num">{feeBps == null ? '—' : bps(feeBps)}</strong>
        <span className="eng-node-sub">per trade; the creator’s share funds the engine</span>
      </div>
      <span className="eng-pipe" aria-hidden="true">
        <i />
      </span>
      <div className="eng-node eng-node-core">
        <span className="eng-node-label">Engine wallet</span>
        <strong className="num">{solText(balance, 3)}</strong>
        <span className="eng-node-sub">
          {dailyBps == null ? 'releases a slice every hour' : `releases ${bps(dailyBps)} a day`}
        </span>
      </div>
      <Fork />
      <div className="eng-outs">
        <div className="eng-node eng-node-out is-green">
          <span className="eng-node-label">
            <i className="eng-key" /> {holdersPct}% to holders
          </span>
          <strong className="num">{solText(next?.holders)}</strong>
          <span className="eng-node-sub">
            next run{eligible == null ? '' : `, ${count(eligible, 'wallet', 'wallets')} eligible`}
          </span>
        </div>
        <div className="eng-node eng-node-out is-pink">
          <span className="eng-node-label">
            <i className="eng-key" /> {100 - holdersPct}% buyback & burn
          </span>
          <strong className="num">{solText(next?.buyback)}</strong>
          <span className="eng-node-sub">next run, bought and burned at once</span>
        </div>
      </div>
    </div>
  )
}

function Kpi({ tone, label, value, sub, title }) {
  return (
    <div className={`panel eng-kpi is-${tone}`}>
      <dt>{label}</dt>
      <dd className="eng-kpi-value num" title={title}>
        {value}
      </dd>
      <dd className="eng-kpi-sub">{sub}</dd>
    </div>
  )
}

function ChartPanel({ tone, icon: Icon, title, total, sub, empty, children }) {
  return (
    <section className="instrument eng-chart-panel" aria-labelledby={`eng-${tone}-title`}>
      <div className="eng-chart-head">
        <div>
          <h2 id={`eng-${tone}-title`} className="eng-chart-title">
            <span className={`eng-icon is-${tone}`}>
              <Icon size={15} aria-hidden="true" />
            </span>
            {title}
          </h2>
          <p className="eng-chart-sub">{sub}</p>
        </div>
        <strong className="eng-chart-total num">{total}</strong>
      </div>
      {children ?? <p className="eng-chart-empty">{empty}</p>}
    </section>
  )
}

/** The plan for the next run, the release tiers and the split. */
function Plan({ engine, stateKey, stateLabel, marketCapUsd, holdersPct, minHold, symbol }) {
  const tiers = engine?.tiers || QUANTP.engine.tiers
  const current = tierIndex(engine?.marketCapUsd ?? marketCapUsd, tiers)
  const next = engine?.next
  return (
    <section className="panel eng-plan" aria-labelledby="eng-plan-title">
      <div className="panel-head">
        <h2 id="eng-plan-title" className="h3">
          Next run
        </h2>
        <span className={`chip eng-state is-${stateKey}`}>
          <i className="eng-pulse" aria-hidden="true" />
          {stateLabel}
        </span>
      </div>
      <dl className="kv eng-plan-kv">
        <dt>Releases</dt>
        <dd className="num">{solText(next?.release)}</dd>
        <dt>To holders</dt>
        <dd className="num">{solText(next?.holders)}</dd>
        <dt>Holders paid</dt>
        <dd className="num">
          {next
            ? `${next.paying.toLocaleString('en-US')} of ${engine.eligible.toLocaleString('en-US')}`
            : '—'}
        </dd>
        <dt>To buyback & burn</dt>
        {next && next.buyback === '0' ? (
          <dd>waits for a later run</dd>
        ) : (
          <dd className="num">{solText(next?.buyback)}</dd>
        )}
        <dt>Minimum to hold</dt>
        <dd className="num">{minHold == null ? '—' : `${compact(minHold)} ${symbol}`}</dd>
        <dt>Last run</dt>
        <dd className="num">{engine?.lastRunAt ? `${ago(engine.lastRunAt)} ago` : '—'}</dd>
      </dl>

      <h3 className="eng-sub">Release rate by market cap</h3>
      <ol className="eng-tiers">
        {tiers.map((t, i) => {
          const low = i ? tiers[i - 1].belowUsd : null
          const range =
            low == null
              ? `Under ${usdBound(t.belowUsd)}`
              : t.belowUsd == null
                ? `${usdBound(low)} and up`
                : `${usdBound(low)} – ${usdBound(t.belowUsd)}`
          return (
            <li key={range} className={i === current ? 'is-now' : ''}>
              <span className="eng-tier-range">
                {range}
                {i === current && <span className="eng-now">Now</span>}
              </span>
              <span className="eng-tier-bar" aria-hidden="true">
                <i style={{ width: `${t.dailyBps / 100}%` }} />
              </span>
              <span className="eng-tier-rate num">{bps(t.dailyBps)} a day</span>
            </li>
          )
        })}
      </ol>

      <h3 className="eng-sub">Each run’s split</h3>
      <div
        className="eng-split"
        role="img"
        aria-label={`${holdersPct}% to holders, ${100 - holdersPct}% to buyback and burn`}
      >
        <span className="is-green" style={{ flexBasis: `${holdersPct}%` }}>
          {holdersPct}%
        </span>
        <span className="is-pink" style={{ flexBasis: `${100 - holdersPct}%` }}>
          {100 - holdersPct}%
        </span>
      </div>
      <p className="faint eng-fine">
        Every wallet holding at least {QUANTP.engine.minHoldBps / 100}% of the supply when a run
        starts gets its share by balance; liquidity pools and the team’s wallets are never paid. A
        share under {sol(toSol(QUANTP.engine.minTransferLamports), { digits: 5 })} waits for a later
        run, and so does a buyback under{' '}
        {sol(toSol(QUANTP.engine.minBuybackLamports), { digits: 3 })}. Each run releases at most{' '}
        {sol(toSol(QUANTP.engine.maxRunLamports), { digits: 0 })} and keeps{' '}
        {sol(toSol(QUANTP.engine.reserveLamports), { digits: 2 })} in the wallet for fees.
      </p>
    </section>
  )
}

/** How the engine works, in five steps. */
function HowItWorks({ symbol, feeBps, dailyBps, holdersPct, minHold }) {
  const ticker = `$${symbol}`
  const steps = [
    [
      'Fees fill the payout wallet',
      `Every ${ticker} buy and sell pays a ${bps(feeBps)} fee in its Meteora DAMM v2 pool. The team sends the creator’s share of it to the payout wallet.`,
    ],
    [
      'A slice is released every hour',
      `The engine releases ${bps(dailyBps)} of the wallet a day at today’s market cap, a 24th of it each hour: small now, more as the market cap grows.`,
    ],
    [
      `${holdersPct}% goes to holders`,
      `In SOL, to every wallet holding at least ${QUANTP.engine.minHoldBps / 100}% of the supply (${compact(minHold)} ${ticker}), by balance: hold more, get more.`,
    ],
    [
      `${100 - holdersPct}% is bought back and burned`,
      `It buys ${ticker} in its DAMM v2 pool and burns it in the same transaction, so the supply only goes down.`,
    ],
    [
      'Every transaction is listed',
      'Each payout and burn is read from the chain and listed on this page, with its link to Solscan.',
    ],
  ]
  return (
    <section className="panel eng-how" aria-labelledby="eng-how-title">
      <h2 id="eng-how-title" className="h3">
        How it works
      </h2>
      <ol className="eng-steps">
        {steps.map(([title, text]) => (
          <li key={title}>
            <strong>{title}</strong>
            <p className="muted">{text}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Disclose({ symbol }) {
  return (
    <section className="panel eng-disclose" aria-labelledby="eng-disclose-title">
      <h2 id="eng-disclose-title" className="h3">
        Before you buy
      </h2>
      <ul>
        <li>
          The engine is the team’s policy, not on-chain code: it runs on Quant Pad’s server and pays
          only what the team puts in the payout wallet. Nothing on-chain enforces it.
        </li>
        <li>Payouts are small while the market cap is small.</li>
        <li>
          ${symbol} is Quant Pad’s own token. Memecoins are extremely risky and can lose all their
          value. Nothing here is financial advice.
        </li>
      </ul>
    </section>
  )
}

function Activity({ items, symbol, decimals }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, FEED_ROWS)
  return (
    <section className="panel eng-activity" aria-labelledby="eng-activity-title">
      <div className="panel-head">
        <h2 id="eng-activity-title" className="h3">
          Activity
        </h2>
        <span className="chip">{count(items.length, 'event', 'events')}</span>
      </div>
      {items.length ? (
        <ol className="eng-feed">
          {shown.map((e) =>
            e.kind === 'payout' ? (
              <li key={e.key} className="is-green">
                <span className="eng-icon is-green">
                  <Coins size={15} aria-hidden="true" />
                </span>
                <span className="eng-feed-text">
                  <strong>
                    Paid <span className="num">{solText(e.lamports)}</span>
                  </strong>
                  <span className="faint">
                    to{' '}
                    {e.recipient ? (
                      <span className="num">{short(e.recipient)}</span>
                    ) : (
                      count(e.recipients, 'wallet', 'wallets')
                    )}{' '}
                    · {ago(e.t)} ago
                  </span>
                </span>
                <TxLink signature={e.transactions.at(-1).signature} />
              </li>
            ) : (
              <li key={e.key} className="is-pink">
                <span className="eng-icon is-pink">
                  <Flame size={15} aria-hidden="true" />
                </span>
                <span className="eng-feed-text">
                  <strong>
                    Burned <span className="num">{compact(Number(e.amount) / 10 ** decimals)}</span>{' '}
                    {symbol}
                  </strong>
                  <span className="faint">
                    {e.solSpent == null ? 'held tokens' : `bought for ${solText(e.solSpent)}`} ·{' '}
                    {ago(e.t)} ago
                  </span>
                </span>
                <TxLink signature={e.signature} />
              </li>
            ),
          )}
        </ol>
      ) : (
        <p className="muted eng-empty-line">Nothing yet. Each payout and burn shows here.</p>
      )}
      {items.length > FEED_ROWS && (
        <button type="button" className="btn btn-sm eng-feed-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  )
}

function Wallets({ wallets, paidLamports, team }) {
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(WALLET_ROWS)
  const total = BigInt(paidLamports || 0)
  const ranked = useMemo(() => (wallets || []).map((w, i) => ({ ...w, rank: i + 1 })), [wallets])
  const needle = query.trim().toLowerCase()
  const rows = needle ? ranked.filter((w) => w.wallet.toLowerCase().includes(needle)) : ranked
  const top = ranked.length ? Number(ranked[0].lamports) : 0
  return (
    <section className="panel eng-wallets" aria-labelledby="eng-wallets-title">
      <div className="panel-head eng-table-head">
        <div>
          <h2 id="eng-wallets-title" className="h3">
            Wallets paid
          </h2>
          <p className="faint eng-head-sub">Every wallet the engine has paid, most paid first.</p>
        </div>
        <label className="eng-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Find a wallet</span>
          <input
            className="input"
            type="search"
            placeholder="Find a wallet"
            value={query}
            spellCheck="false"
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setShown(WALLET_ROWS)
            }}
          />
        </label>
      </div>
      {wallets == null ? (
        <p className="muted eng-empty-line">The wallet totals are not available yet.</p>
      ) : !ranked.length ? (
        <p className="muted eng-empty-line">
          No wallet has been paid yet. Each wallet shows here after its first payout.
        </p>
      ) : !rows.length ? (
        <p className="muted eng-empty-line">No paid wallet matches “{query.trim()}”.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table eng-table">
              <thead>
                <tr>
                  <th className="right">#</th>
                  <th>Wallet</th>
                  <th className="right">Received</th>
                  <th>Share of all paid</th>
                  <th className="right">Rounds</th>
                  <th className="right">Last paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((w) => {
                  const share = total > 0n ? (Number(w.lamports) / Number(total)) * 100 : 0
                  return (
                    <tr key={w.wallet}>
                      <td className="right num faint">{w.rank}</td>
                      <td>
                        <span className="eng-wallet">
                          <Address value={w.wallet} href={explorer.account(w.wallet)} />
                          {team.includes(w.wallet) && <span className="chip eng-team">Team</span>}
                        </span>
                      </td>
                      <td className="right num">{plain(w.lamports, 5)}</td>
                      <td>
                        <span className="eng-share">
                          <span className="eng-share-bar" aria-hidden="true">
                            <i
                              style={{ width: `${top ? (Number(w.lamports) / top) * 100 : 0}%` }}
                            />
                          </span>
                          <span className="num">
                            {share < 0.01 && share > 0 ? '<0.01' : share.toFixed(2)}%
                          </span>
                        </span>
                      </td>
                      <td className="right num">{w.rounds}</td>
                      <td className="right num faint" title={when(w.lastAt)}>
                        {ago(w.lastAt)} ago
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <More
            total={rows.length}
            shown={shown}
            step={WALLET_ROWS}
            onMore={() => setShown(shown + 50)}
            onLess={() => setShown(WALLET_ROWS)}
          />
        </>
      )}
    </section>
  )
}

function Burns({ burns, unburned, symbol, decimals, wallets }) {
  const [shown, setShown] = useState(TABLE_ROWS)
  const waiting = BigInt(unburned?.lamports ?? 0)
  const name = (w) =>
    w === wallets.engine || w === wallets.payout
      ? 'Engine'
      : w === wallets.creator
        ? 'Creator'
        : short(w)
  return (
    <section className="panel eng-burns" aria-labelledby="eng-burns-title">
      <div className="panel-head eng-table-head">
        <div>
          <h2 id="eng-burns-title" className="h3">
            Burns
          </h2>
          <p className="faint eng-head-sub">
            Every ${symbol} the team’s wallets have bought back and burned.
          </p>
        </div>
        <span className="chip">{count(burns.length, 'burn', 'burns')}</span>
      </div>
      {waiting > 0n && (
        <p className="eng-waiting">
          <i className="eng-key is-pink" />
          <span>
            <strong className="num">{solText(waiting)}</strong> of ${symbol} bought back (
            <span className="num">{formatUnits(unburned.amount, decimals, 0)}</span>) is waiting for
            its burn.
          </span>
        </p>
      )}
      {burns.length ? (
        <>
          <div className="table-wrap">
            <table className="table eng-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th className="right">Burned ({symbol})</th>
                  <th className="right">SOL spent</th>
                  <th>How</th>
                  <th>By</th>
                  <th className="right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {burns.slice(0, shown).map((b) => (
                  <tr key={`${b.signature}:${b.wallet}`}>
                    <td className="num faint">{when(b.timestamp)}</td>
                    <td className="right num">{formatUnits(b.amount, decimals, 0)}</td>
                    <td className="right num">{b.solSpent == null ? '—' : plain(b.solSpent)}</td>
                    <td>{b.method === 'incinerator' ? 'Sent to the incinerator' : 'Burned'}</td>
                    <td>
                      <a href={explorer.account(b.wallet)} target="_blank" rel="noreferrer">
                        {name(b.wallet)}
                      </a>
                    </td>
                    <td className="right">
                      <TxLink signature={b.signature} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <More
            total={burns.length}
            shown={shown}
            step={TABLE_ROWS}
            onMore={() => setShown(shown + 50)}
            onLess={() => setShown(TABLE_ROWS)}
          />
        </>
      ) : (
        <div className="eng-empty">
          <span className="eng-icon is-pink eng-icon-lg">
            <Flame size={22} aria-hidden="true" />
          </span>
          <p>
            <strong>No burns yet.</strong> Each hourly buyback buys ${symbol} in its pool and burns
            it in the same transaction. It shows here once it confirms.
          </p>
        </div>
      )}
    </section>
  )
}

function Round({ burst }) {
  const [open, setOpen] = useState(false)
  const txs = burst.transactions
  const each = burst.recipients ? BigInt(burst.lamports) / BigInt(burst.recipients) : null
  return (
    <>
      <tr>
        <td className="num faint">{when(burst.timestamp)}</td>
        <td className="right num">{plain(burst.lamports)}</td>
        <td className="right num">
          {burst.recipient ? (
            <a href={explorer.account(burst.recipient)} target="_blank" rel="noreferrer">
              {short(burst.recipient)}
            </a>
          ) : (
            burst.recipients.toLocaleString('en-US')
          )}
        </td>
        <td className="right num faint">{each == null ? '—' : plain(each, 6)}</td>
        <td className="right">
          {txs.length === 1 ? (
            <TxLink signature={txs[0].signature} />
          ) : (
            <button
              type="button"
              className="eng-toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {txs.length} txs <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </td>
      </tr>
      {open &&
        txs.map((x) => (
          <tr key={x.signature} className="eng-sub-row">
            <td />
            <td className="right num">{plain(x.lamports)}</td>
            <td className="right num">{x.recipients}</td>
            <td />
            <td className="right">
              <TxLink signature={x.signature} />
            </td>
          </tr>
        ))}
    </>
  )
}

function Rounds({ payouts }) {
  const [shown, setShown] = useState(TABLE_ROWS)
  return (
    <section className="panel eng-rounds" aria-labelledby="eng-rounds-title">
      <div className="panel-head eng-table-head">
        <div>
          <h2 id="eng-rounds-title" className="h3">
            Payout rounds
          </h2>
          <p className="faint eng-head-sub">
            Each round of SOL sent to holders (transactions sent together count as one).
          </p>
        </div>
        <span className="chip">{count(payouts.length, 'round', 'rounds')}</span>
      </div>
      {payouts.length ? (
        <>
          <div className="table-wrap">
            <table className="table eng-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th className="right">SOL</th>
                  <th className="right">Wallets</th>
                  <th className="right">Per wallet</th>
                  <th className="right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {payouts.slice(0, shown).map((burst) => (
                  <Round key={burst.transactions[0].signature} burst={burst} />
                ))}
              </tbody>
            </table>
          </div>
          <More
            total={payouts.length}
            shown={shown}
            step={TABLE_ROWS}
            onMore={() => setShown(shown + 50)}
            onLess={() => setShown(TABLE_ROWS)}
          />
        </>
      ) : (
        <div className="eng-empty">
          <span className="eng-icon is-green eng-icon-lg">
            <Coins size={22} aria-hidden="true" />
          </span>
          <p>
            <strong>No payouts yet.</strong> Each round of SOL to holders shows here once it
            confirms.
          </p>
        </div>
      )}
    </section>
  )
}

// The Payout Engine: $QUANTP's payout engine (server/quantp-engine.mjs) as a dashboard. Everything
// it has paid and burned comes from /api/quantp/ledger, read from the team's wallets on-chain; its
// state and next run from /api/quantp/engine; the market cap, fee and supply from /api/quantp.
// None of it touches the store.
export default function EnginePage() {
  const q = useQuantp()
  const snap = q.data
  const ledger = useResource('/api/quantp/ledger', 30_000)
  const status = useResource('/api/quantp/engine', 60_000)
  const now = useNow()
  const d = ledger.data
  const t = d?.totals
  const engine = status.data?.configured ? status.data : null
  const state = engineState(engine, now)
  const stateKey = state ?? (status.data ? 'off' : status.error ? 'down' : 'loading')
  const stateLabel = state ? ENGINE_STATE_LABEL[state] : OTHER_STATE[stateKey]
  const run = nextRun(engine, now)
  const line = runLine(engine, state, run, status.error)
  const decimals = q.decimals
  const holdersPct = (engine?.holdersShareBps ?? q.holdersShareBps) / 100
  const paid = useMemo(() => paidSeries(d?.payouts), [d?.payouts])
  const burned = useMemo(() => burnSeries(d?.burns, decimals), [d?.burns, decimals])
  const activity = useMemo(() => activityOf(d), [d])
  const supply = Number(snap?.supply ?? q.supply) / 10 ** decimals
  const minHold = engine?.minHold
    ? Number(engine.minHold) / 10 ** decimals
    : (supply * QUANTP.engine.minHoldBps) / 10_000
  const teamBurned = t ? Number(t.burnedAmount) / 10 ** decimals : null
  const bought = t ? BigInt(t.buybackLamports) + BigInt(t.unburned.lamports) : null
  const balance = engine?.balance ?? d?.payoutLamports ?? null
  const marketCapUsd = engine?.marketCapUsd ?? snap?.marketCapUsd ?? null
  const dailyBps =
    engine?.dailyBps ?? QUANTP.engine.tiers[tierIndex(marketCapUsd, QUANTP.engine.tiers)].dailyBps
  const team = [d?.wallets?.payout, d?.wallets?.creator, d?.wallets?.engine].filter(Boolean)
  const wallet = engine?.wallet || QUANTP.engine.wallet
  const loadingText = ledger.loading ? 'Reading the team’s wallets…' : ledger.error

  return (
    <div className="wrap eng-page">
      <section className="instrument eng-hero" aria-labelledby="eng-title">
        <span className="eng-hero-lines" aria-hidden="true" />
        <div className="eng-hero-top">
          <div className="eng-hero-id">
            <p className="eng-eyebrow">
              <span className={`eng-pulse is-${stateKey}`} aria-hidden="true" />${q.symbol} payout
              engine
            </p>
            <h1 id="eng-title" className="eng-title">
              <span className="silver-text">Fees</span> engine
            </h1>
            <p className="eng-lede">
              Every hour it releases a slice of its wallet’s SOL: {holdersPct}% straight to the
              wallets holding ${q.symbol}, {100 - holdersPct}% to buy ${q.symbol} back and burn it.
              Every payout and burn below is read from the chain.
            </p>
            <div className="eng-hero-meta">
              <span className={`chip eng-state is-${stateKey}`}>
                <i className="eng-pulse" aria-hidden="true" />
                {stateLabel}
              </span>
              <span className="eng-wallet-pill">
                <span className="faint">Engine wallet</span>
                <Address value={wallet} href={explorer.account(wallet)} />
              </span>
              <Link to={QUANTP.path} className="btn btn-sm">
                ${q.symbol} page
              </Link>
            </div>
            {line && (
              <p className="eng-runline" aria-live="polite">
                {line}
              </p>
            )}
          </div>
          <div className="eng-hero-side">
            <RunClock run={run} release={engine?.next?.release} label={stateLabel} />
            <div className="eng-hero-figure">
              <span className="eng-label">Paid to holders</span>
              <strong className="eng-big num">{t ? solText(t.paidLamports, 3) : '—'}</strong>
              <span className="eng-label">
                {t
                  ? `to ${count(t.recipients, 'wallet', 'wallets')} in ${count(d.payouts.length, 'round', 'rounds')}`
                  : loadingText || ' '}
              </span>
            </div>
          </div>
        </div>
        <Flow
          feeBps={snap?.feeBps ?? null}
          balance={balance}
          dailyBps={dailyBps}
          holdersPct={holdersPct}
          eligible={engine?.configured ? engine.eligible : null}
          next={engine?.next}
          live={!!engine?.live}
        />
      </section>

      <dl className="eng-kpis">
        <Kpi
          tone="green"
          label="Wallets paid"
          value={t ? t.recipients.toLocaleString('en-US') : '—'}
          sub={engine?.configured ? `${engine.eligible.toLocaleString('en-US')} eligible now` : ' '}
        />
        <Kpi
          tone="green"
          label="Payout rounds"
          value={d ? d.payouts.length.toLocaleString('en-US') : '—'}
          sub={d?.payouts[0] ? `last ${ago(d.payouts[0].timestamp)} ago` : 'none yet'}
        />
        <Kpi
          tone="pink"
          label={`${q.symbol} burned`}
          value={teamBurned == null ? '—' : compact(teamBurned)}
          sub={
            teamBurned == null
              ? ' '
              : `${((teamBurned / (Number(q.supply) / 10 ** decimals)) * 100).toFixed(3)}% of the supply`
          }
        />
        <Kpi
          tone="pink"
          label="Spent on buybacks"
          value={bought == null ? '—' : solText(bought, 3)}
          sub={
            t && BigInt(t.unburned.lamports) > 0n
              ? `${solText(t.unburned.lamports, 3)} waiting to burn`
              : d
                ? `${count(d.burns.length, 'burn', 'burns')}`
                : ' '
          }
        />
        <Kpi
          tone="blue"
          label="In the engine wallet"
          value={solText(balance, 3)}
          sub={engine?.next ? `next run ≈ ${solText(engine.next.release)}` : ' '}
        />
        <Kpi
          tone="blue"
          label="Release rate"
          value={`${bps(dailyBps)} / day`}
          sub={marketCapUsd == null ? 'at the lowest tier' : `at ${usd(marketCapUsd)} market cap`}
        />
      </dl>

      <div className="eng-charts">
        <ChartPanel
          tone="green"
          icon={Coins}
          title="Paid to holders"
          sub="Running total, in SOL"
          total={t ? solText(t.paidLamports, 3) : '—'}
          empty={d ? 'No payouts yet. The total climbs with each one.' : loadingText}
        >
          {paid.length ? (
            <EngineChart
              points={paid}
              tone="green"
              now={now}
              label={`SOL paid to holders over time, ${paid.length} rounds`}
              format={(v) => (v === 0 ? '0' : v < 1 ? v.toFixed(v < 0.1 ? 3 : 2) : compact(v))}
              readout={(p) => ({
                value: `${sol(p.v, { digits: 4 })} in all`,
                lines: [`+${sol(p.d, { digits: 4 })} to ${count(p.n, 'wallet', 'wallets')}`],
              })}
            />
          ) : null}
        </ChartPanel>
        <ChartPanel
          tone="pink"
          icon={Flame}
          title={`${q.symbol} burned`}
          sub="Running total, in tokens"
          total={teamBurned == null ? '—' : `${compact(teamBurned)} ${q.symbol}`}
          empty={
            d ? `No burns yet. The total climbs with each hourly buyback and burn.` : loadingText
          }
        >
          {burned.length ? (
            <EngineChart
              points={burned}
              tone="pink"
              now={now}
              label={`${q.symbol} burned over time, ${burned.length} burns`}
              format={(v) => compact(v)}
              readout={(p) => ({
                value: `${compact(p.v)} ${q.symbol} in all`,
                lines: [
                  `+${compact(p.d)} ${q.symbol}${p.sol == null ? '' : ` for ${sol(p.sol, { digits: 4 })}`}`,
                ],
              })}
            />
          ) : null}
        </ChartPanel>
      </div>

      <div className="eng-layout">
        <div className="eng-main">
          {d ? (
            <>
              <Wallets wallets={d.paidWallets} paidLamports={t.paidLamports} team={team} />
              <Burns
                burns={d.burns}
                unburned={t.unburned}
                symbol={q.symbol}
                decimals={decimals}
                wallets={d.wallets}
              />
              <Rounds payouts={d.payouts} />
            </>
          ) : (
            <section className="panel eng-loading" aria-live="polite">
              <p className="muted">{loadingText}</p>
            </section>
          )}
          <Disclose symbol={q.symbol} />
        </div>
        <aside className="eng-side">
          <Plan
            engine={engine}
            stateKey={stateKey}
            stateLabel={stateLabel}
            marketCapUsd={marketCapUsd}
            holdersPct={holdersPct}
            minHold={minHold}
            symbol={q.symbol}
          />
          <HowItWorks
            symbol={q.symbol}
            feeBps={snap?.postGradFeeBps ?? q.postGradFeeBps}
            dailyBps={dailyBps}
            holdersPct={holdersPct}
            minHold={minHold}
          />
          <Activity items={activity} symbol={q.symbol} decimals={decimals} />
        </aside>
      </div>

      <footer className="eng-notes">
        <p className="faint">
          Every figure on this page is read from the chain: the engine wallet{' '}
          <Address value={wallet} href={explorer.account(wallet)} /> and the creator wallet{' '}
          <Address value={QUANTP.creator} href={explorer.account(QUANTP.creator)} />.
        </p>
        {d?.unread > 0 && (
          <p className="faint">
            {count(d.unread, 'transaction', 'transactions')} of the team’s wallets could not be read
            yet: these lists may be missing {d.unread === 1 ? 'it' : 'them'}. Retrying shortly.
          </p>
        )}
        {d?.state === 'stale' && (
          <p className="faint">
            Updated {ago(d.updatedAt)} ago: the chain could not be read just now.
          </p>
        )}
      </footer>
    </div>
  )
}
