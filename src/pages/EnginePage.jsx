import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  Clock,
  Flame,
  Hourglass,
  ListChecks,
  MoonStar,
  Pause,
  TriangleAlert,
  Users,
  Wallet,
} from 'lucide-react'
import EngineArt from '../components/EngineArt.jsx'
import QuantpLedger from '../components/QuantpLedger.jsx'
import {
  buybackFloorLamports,
  dailyShare,
  hourlyBps,
  nextRunAt,
  shareLamports,
  utcClock,
} from '../components/engineSchedule.js'
import {
  ENGINE_STATE_LABEL,
  engineState,
  payoutFigures,
  PARTIAL_NOTE,
  atLeast,
  solFigure,
  tokenFigure,
} from '../components/quantpPayouts.js'
import { Address } from '../components/UI.jsx'
import { useQuantp } from '../context/QuantpContext.jsx'
import { useWallet } from '../context/WalletContext.jsx'
import { useResource } from '../lib/api.js'
import { ago, bps, compact, countdown, formatUnits, short, sol, toSol, usd } from '../lib/format.js'
import { QUANTP, explorer, isAddress } from '../../shared/network.mjs'

const POLICY = QUANTP.engine
const TITLE = 'Payout Engine · Quant Pad'
// Solana's least balance for a new account (0 bytes), until the engine reports the chain's figure.
const RENT_EXEMPT = 890_880
// Eligible wallets listed before "Show all".
const FIRST_HOLDERS = 10

const share = (fraction) => `${Math.round(fraction * 100)}%`
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const seconds = (t) => (t > 1e11 ? t / 1000 : t)
const minTransfer = sol(toSol(POLICY.minTransferLamports))
const minBuyback = sol(toSol(POLICY.minBuybackLamports), { digits: 3 })

// "Below $100K", "$100K to $1M", "Above $1M": the market-cap tiers of QUANTP.engine.tiers.
const tierLabel = (tiers, i) =>
  i === 0
    ? `Below ${usd(tiers[0].belowUsd)}`
    : tiers[i].belowUsd == null
      ? `Above ${usd(tiers[i - 1].belowUsd)}`
      : `${usd(tiers[i - 1].belowUsd)} to ${usd(tiers[i].belowUsd)}`
// Read after the tier's hourly rate: each run releases a 24th of the daily rate of what the wallet
// holds then, so a day of runs releases less than the daily rate.
const tierHint = (dailyBps) =>
  `of the wallet each hour, about ${share(dailyShare(dailyBps))} of it a day`
const tierIndex = (tiers, marketCap) =>
  marketCap == null ? -1 : tiers.findIndex((t) => t.belowUsd == null || marketCap < t.belowUsd)

// The market-cap meter runs on a log scale from $1K to ten times the top tier's floor.
const METER_FROM = 3
const METER_TO = Math.log10(POLICY.tiers.at(-2).belowUsd) + 1
const meterAt = (usdValue) =>
  Math.max(
    0,
    Math.min(
      100,
      ((Math.log10(Math.max(usdValue, 1)) - METER_FROM) / (METER_TO - METER_FROM)) * 100,
    ),
  )

// How full the payout wallet's tank is drawn: nearly empty at the fee reserve, then by the
// logarithm of its SOL, so a few SOL and a few hundred both read.
const tankLevel = (lamports) => {
  if (lamports == null) return 0.5
  const balance = toSol(lamports)
  if (balance <= toSol(POLICY.reserveLamports)) return 0.06
  return 0.28 + 0.3 * Math.log10(1 + 4 * balance)
}

/**
 * The engine's state as a status light: green running, yellow waiting or out of date, blue idle,
 * pink late or failing, grey paused. A running engine whose figures could not be refreshed is not
 * shown as healthy.
 */
function StateLight({ state, stale }) {
  if (!state) return null
  const healthy = state === 'running' && !stale
  return (
    <span
      className={`chip eg-state ${healthy ? 'chip-grad' : ''}`}
      data-state={state === 'running' && stale ? 'stale' : state}
    >
      <i className="eg-state-dot" aria-hidden="true" />
      {ENGINE_STATE_LABEL[state]}
    </span>
  )
}

/** A stat as a tile topped by its light line (`tone`), with a short note under its figure. */
function StatTile({ label, tone, note, title, children }) {
  return (
    <div className="eg-stat" data-tone={tone}>
      <dt>{label}</dt>
      <dd title={title}>
        <span className="eg-stat-value">{children}</span>
        {note && <small>{note}</small>}
      </dd>
    </div>
  )
}

const STATE_ICON = {
  running: Clock,
  idle: MoonStar,
  late: Clock,
  failing: TriangleAlert,
  pending: Hourglass,
  paused: Pause,
}

/** Beside the run line: the hour so far, filling towards the next run, or the state's icon. */
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

// Why the engine skips an eligible wallet in a run (its status's holders[].reason), and the
// next-run counts of each (next.skipped).
const HOLDER_STATUS = {
  paid: 'Paid',
  'below-minimum': 'Below minimum',
  'no-sol': 'Needs SOL',
  'not-payable': 'Not a wallet',
}
const SKIPPED = {
  belowMin: (n) => `${n} below the minimum`,
  noSol: (n) => `${n} ${n === 1 ? 'needs' : 'need'} SOL`,
  notPayable: (n) => `${n} not ${n === 1 ? 'a wallet' : 'wallets'}`,
}
const skippedText = (skipped) => {
  const parts = Object.entries(SKIPPED)
    .filter(([key]) => skipped?.[key] > 0)
    .map(([key, text]) => text(skipped[key]))
  return parts.length ? ` (${parts.join(', ')})` : ''
}

/** Unix seconds now, again every `every` ms, so times on the page move without a new poll. */
function useNow(every) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

/** What the hero says about the engine's runs, by its state, and how old its figures are. */
function runLine(engine, state, error, now) {
  if (!engine)
    return error
      ? 'The engine’s state is unavailable right now. Retrying shortly.'
      : 'Reading the engine…'
  const last = `Last run ${ago(engine.lastRunAt)} ago`
  const at = nextRunAt(engine)
  const left = at - now
  const next =
    left > 0
      ? `next run from ${utcClock(at, now)} UTC (in ${left < 60 ? 'less than a minute' : `about ${countdown(left)}`})`
      : 'a run is due now (usually within a few minutes)'
  let line
  if (state === 'paused') line = 'Paused: no payouts or buybacks run until it is switched back on'
  else if (state === 'pending') line = 'Switched on, and waiting for its first automatic run'
  else if (state === 'late') line = `${last}: it is behind its hourly schedule`
  else if (state === 'idle')
    line = `${last}: every share is under the payout minimums, so runs send nothing until the wallet holds more · ${next}`
  else if (state === 'failing')
    line = `${last}, but no holder has been paid since ${utcClock(engine.lastPaidAt, now)} UTC · ${next}`
  else line = `${last} · ${next}`
  line += ` · updated ${ago(engine.updatedAt)} ago`
  if (engine.state === 'stale') line += ': the chain could not be read just now'
  return error ? `${line}. Could not refresh, retrying.` : line
}

/** The state alone, for screen readers: it changes only when the state does. */
function stateSentence(engine, state, error) {
  if (!engine) return error ? 'The payout engine’s state is unavailable right now.' : ''
  if (!ENGINE_STATE_LABEL[state]) return ''
  const stale = engine.state === 'stale' ? ' (its figures may be out of date)' : ''
  return `Payout engine: ${ENGINE_STATE_LABEL[state]}${stale}.`
}

/** Why the next run buys nothing back, and when that changes. */
function noBuyback(engine, buybackShareBps) {
  const { next } = engine
  const release = BigInt(next.release)
  const pot = next.buybackPot ?? release - (release * BigInt(engine.holdersShareBps)) / 10_000n
  const head = `No buyback this run: its share (${sol(toSol(pot), { digits: 4 })}) is under ${minBuyback}`
  if (next.buybackEveryHours)
    return `${head}; it buys every ${next.buybackEveryHours} hours instead.`
  const floor = buybackFloorLamports(POLICY, engine.dailyBps, buybackShareBps)
  const top = POLICY.tiers.at(-1).dailyBps <= engine.dailyBps
  return `${head} and stays in the wallet; buybacks resume once the wallet holds more than ${sol(toSol(floor), { digits: 2 })}${top ? '' : ' or the market cap reaches the next tier'}.`
}

/**
 * What the engine's last run on the instance that answered did (its status's lastRun). A run stops
 * early (`stopped`) on a time limit or a payout it could not confirm; a payout batch that fails is
 * recorded (`error`) and the run goes on, so a run with an error may still have paid and bought
 * back.
 */
function lastRunOutcome(report, now) {
  const at = report.at ? ` at ${utcClock(seconds(report.at), now)} UTC` : ''
  const sent = report.payouts?.length ?? 0
  const did =
    sent || report.buyback
      ? `${sent ? count(sent, 'payout transaction') : 'no payouts'}, ${report.buyback ? 'bought back and burned' : 'no buyback'}`
      : null
  let what
  if (report.stopped) what = `${did ? `${did}, then it` : 'it'} stopped (${report.stopped})`
  else if (report.error)
    what = did
      ? `${did}, but part of it failed`
      : 'it hit an error and sent nothing; the next run tries again'
  else what = did ?? 'nothing to send'
  const skipped = report.skipped?.length
    ? `, ${count(report.skipped.length, 'wallet')} skipped`
    : ''
  return `Last run${at}: ${what}${skipped}`
}

/**
 * A holder's own figures, from /api/quantp/holder: whether the wallet is eligible, what it holds
 * and gets in the next run (or why it is skipped), and what it has been paid. The address is typed
 * or taken from the connected wallet, and never goes into the page's URL. Until a wallet is looked
 * up, the bare route is asked once: a server without it answers 404, and the panel stays hidden.
 * `engine` is this page's engine status, which gives a skipped wallet's share.
 */
function YourWallet({ engine, symbol, decimals, rentExempt }) {
  const connected = useWallet()?.address ?? null
  const [input, setInput] = useState(connected ?? '')
  const [wallet, setWallet] = useState(connected)
  const [invalid, setInvalid] = useState(false)
  const [shown, setShown] = useState(false)
  const previous = useRef(connected)
  const res = useResource(
    wallet ? `/api/quantp/holder?wallet=${wallet}` : '/api/quantp/holder',
    wallet ? 60_000 : 0,
  )

  // A wallet connected (or switched) later is filled in and looked up, unless another address was
  // typed.
  useEffect(() => {
    const before = previous.current
    previous.current = connected
    if (!connected || (input.trim() && input !== before)) return
    setInput(connected)
    setWallet(connected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])
  useEffect(() => {
    if (res.status === 404) setShown(false)
    else if (!res.loading) setShown(true)
  }, [res.status, res.loading])

  if (!shown) return null
  const ticker = `$${symbol}`
  const h = wallet && res.data?.wallet === wallet ? res.data : null
  const row = h?.engine ?? null
  const eligible = row ? row.eligible !== false : null
  const minHold = Number(h?.minHold ?? 0) / 10 ** decimals
  const last = h?.paid?.items?.[0]
  // The status lists no figure for a wallet it skips, so its share is worked out from the page's
  // engine status, and left out when that status is from another moment and no longer agrees.
  const shareUnder = (limit) => {
    const lamports = row?.lamports ?? shareLamports(engine, row?.amount)
    return lamports != null && BigInt(lamports) < BigInt(limit) ? ` (${sol(toSol(lamports))})` : ''
  }
  const skip = {
    'below-minimum': `Skipped this run: its share${shareUnder(POLICY.minTransferLamports)} is under ${minTransfer} and stays in the payout wallet`,
    'no-sol': `Skipped this run: the wallet holds no SOL and its share${shareUnder(rentExempt)} is under ${sol(toSol(rentExempt), { digits: 5 })}; keep a little SOL in it to be paid`,
    'not-payable': 'Skipped: this account is not a wallet the engine can pay',
  }

  const submit = (e) => {
    e.preventDefault()
    const value = input.trim()
    setInvalid(!isAddress(value))
    if (isAddress(value)) setWallet(value)
  }

  return (
    <section className="panel eg-wallet" aria-labelledby="eg-wallet-title">
      <h2 id="eg-wallet-title" className="h3">
        Your wallet
      </h2>
      <form className="eg-wallet-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="eg-wallet-address">
          Wallet address
        </label>
        <input
          id="eg-wallet-address"
          className="input num"
          placeholder="Your Solana wallet address"
          autoComplete="off"
          spellCheck={false}
          value={input}
          aria-invalid={invalid}
          aria-describedby={invalid ? 'eg-wallet-error' : undefined}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn">
          Look up
        </button>
      </form>
      {invalid && (
        <p id="eg-wallet-error" className="muted eg-wallet-note">
          Enter a Solana wallet address.
        </p>
      )}
      {!invalid && wallet && !h && (
        <p className="muted eg-wallet-note" role="status">
          {res.error || `Reading ${short(wallet)}…`}
        </p>
      )}
      {h && (
        <>
          <dl className="kv">
            <dt>Eligible</dt>
            <dd>
              {eligible == null
                ? 'Unknown right now'
                : eligible
                  ? 'Yes'
                  : `No: not among the next run’s eligible wallets (it needs at least ${compact(minHold)} ${ticker}; pools and the team’s wallets are never paid)`}
            </dd>
            {row?.amount != null && (
              <>
                <dt>Holds</dt>
                <dd className="num">
                  {formatUnits(row.amount, decimals, 0)} {ticker}
                </dd>
              </>
            )}
            {eligible && (
              <>
                <dt>Next run</dt>
                <dd>{row.reason ? skip[row.reason] : sol(toSol(row.lamports), { digits: 6 })}</dd>
              </>
            )}
            <dt>Paid so far</dt>
            <dd>
              <span className="num">{sol(toSol(h.paid.lamports), { digits: 4 })}</span> in{' '}
              {count(h.paid.payouts, 'payout')}
            </dd>
            <dt>Last payout</dt>
            <dd>
              {last ? (
                <>
                  <span className="num">{sol(toSol(last.lamports), { digits: 6 })}</span>,{' '}
                  {ago(last.timestamp)} ago ·{' '}
                  <a href={explorer.tx(last.signature)} target="_blank" rel="noreferrer">
                    Solscan
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </>
              ) : (
                'None yet'
              )}
            </dd>
          </dl>
          {h.complete === false && (
            <p className="faint qp-fine">
              Older payouts are still being read from the chain: the totals may be missing some.
            </p>
          )}
        </>
      )}
    </section>
  )
}

const byAmount = (a, b) => {
  const x = BigInt(a.amount)
  const y = BigInt(b.amount)
  return x < y ? 1 : x > y ? -1 : 0
}

// An account the engine cannot pay (a program's): it has no share, and the engine leaves what it
// holds out of the total the others' shares are of.
const unpayable = (row) => row.reason === 'not-payable'

/**
 * Every wallet eligible for the next run (engine.holders, once the engine's status lists them),
 * largest first: what it holds, its share of what the payable ones hold (engine.heldEligible,
 * which the run's holders' pot is shared over), what the run pays it, and why it is skipped when
 * it is.
 */
function Holders({ engine, symbol, decimals }) {
  const [all, setAll] = useState(false)
  const rows = useMemo(() => [...engine.holders].sort(byAmount), [engine.holders])
  const held = BigInt(
    engine.heldEligible ?? rows.reduce((s, r) => (unpayable(r) ? s : s + BigInt(r.amount)), 0n),
  )
  const perMillion = shareLamports(engine, 10n ** BigInt(6 + decimals), held)
  const shown = all ? rows : rows.slice(0, FIRST_HOLDERS)
  const ofHeld = (row) =>
    held > 0n && !unpayable(row)
      ? `${(Number((BigInt(row.amount) * 1_000_000n) / held) / 10_000).toFixed(2)}%`
      : '—'
  return (
    <section className="panel eg-holders" aria-labelledby="eg-holders-title">
      <h2 id="eg-holders-title" className="h3">
        Eligible wallets, next run
      </h2>
      {perMillion != null && (
        <p className="muted eg-holders-rate">
          Each 1M ${symbol} held earns about{' '}
          <span className="num">{sol(toSol(perMillion), { digits: 7 })}</span> this run.
        </p>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="right">${symbol} held</th>
              <th className="right eg-share">Share of eligible</th>
              <th className="right">Next run SOL</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.wallet} className={r.reason ? 'eg-skipped' : undefined}>
                <td>
                  <a
                    href={explorer.account(r.wallet)}
                    target="_blank"
                    rel="noreferrer"
                    className="num"
                  >
                    {short(r.wallet)}
                  </a>
                </td>
                <td className="right num">{compact(Number(r.amount) / 10 ** decimals)}</td>
                <td className="right num eg-share">{ofHeld(r)}</td>
                <td className="right num">
                  {r.reason || r.lamports == null
                    ? '—'
                    : sol(toSol(r.lamports), { digits: 6, unit: false })}
                </td>
                <td>{HOLDER_STATUS[r.reason ?? 'paid'] ?? r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > FIRST_HOLDERS && (
        <button type="button" className="btn btn-sm eg-holders-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  )
}

// $QUANTP's payout engine (server/quantp-engine.mjs): where it stands, when it runs next and what
// that run pays, from /api/quantp/engine; a holder's own figures (/api/quantp/holder); its rules,
// from QUANTP.engine; and every payout and burn so far, from /api/quantp/ledger (QuantpLedger,
// given this page's engine status and without its own engine block and totals). Totals come from
// /api/quantp. The hero is a graphite instrument in both themes, around the engine's own drawing
// (EngineArt), with the next run's readout under it.
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
  const hourly = dailyBps == null ? null : bps(hourlyBps(dailyBps))
  const postFee = d?.postGradFeeBps ?? q.postGradFeeBps
  const next = live ? engine.next : null
  const waiting = d?.payouts?.waitingLamports ?? engine?.balance ?? null
  const rentExempt = engine?.rentExemptLamports ?? RENT_EXEMPT
  const stale = engine?.state === 'stale'
  const fresh = engine
    ? [
        `Engine figures from ${ago(engine.updatedAt)} ago`,
        (engine.lastPaidAt || engine.lastBurnAt) &&
          [
            engine.lastPaidAt && `last payout ${utcClock(engine.lastPaidAt, now)} UTC`,
            engine.lastBurnAt && `last burn ${utcClock(engine.lastBurnAt, now)} UTC`,
          ]
            .filter(Boolean)
            .join(' · '),
        engine.lastRun && lastRunOutcome(engine.lastRun, now),
      ].filter(Boolean)
    : []

  useEffect(() => {
    const before = document.title
    document.title = TITLE
    return () => {
      document.title = before
    }
  }, [])

  // the drawing and the readout: the next run's split, who it pays, and the hour so far
  const toHolders = next ? toSol(next.holders) : null
  const toBurn = next ? toSol(next.buyback) : null
  const split = toHolders + toBurn > 0 ? toHolders / (toHolders + toBurn) : holdersPct / 100
  const paying = next?.paying ?? engine?.eligible ?? null
  const nextAt = engine && ['running', 'idle', 'failing'].includes(state) ? nextRunAt(engine) : null
  const hourDone =
    nextAt != null && nextAt > now && engine.everySecs
      ? 1 - (nextAt - now) / engine.everySecs
      : null
  const tiers = POLICY.tiers
  const tierNow = tierIndex(tiers, marketCap)
  const nextTier = tierNow >= 0 ? tiers[tierNow + 1] : null
  const tones = ['blue', 'yellow', 'green', 'pink', 'tint']
  const icons = [Wallet, Clock, Users, Flame, ListChecks]

  const steps = [
    [
      'The team funds the payout wallet',
      `Every ${ticker} buy and sell pays a ${bps(postFee)} fee in its Meteora DAMM v2 pool. The team sends SOL from the creator’s fee claims to the payout wallet when it chooses; nothing on-chain makes it.`,
    ],
    [
      'A slice is released each hour',
      hourly == null
        ? 'Each hourly run releases a slice of what the wallet holds, set by the market cap: small now, more as it grows.'
        : `Each hourly run releases ${hourly} of what the wallet holds at today’s market cap (about ${share(dailyShare(dailyBps))} of it over a day if nothing new comes in).`,
    ],
    [
      `${holdersPct}% goes to holders`,
      `In SOL, to every wallet holding at least ${minHoldPct}% of the supply (${compact(minHold)} ${ticker}), by balance. Pools and the team’s wallets are never paid.`,
    ],
    [
      `${buybackPct}% is bought back and burned`,
      `It buys ${ticker} in its DAMM v2 pool and burns it in the same transaction, so the supply only goes down. Any ${ticker} already in the engine wallet is burned with it.`,
    ],
    [
      'Every transaction is listed',
      'Each payout and burn is read from the chain and listed below, with its link to Solscan.',
    ],
  ]

  return (
    <div className="wrap eg-page">
      <header className="eg-hero">
        <span className="eg-hero-lines" aria-hidden="true" />
        <div className="eg-copy">
          <div className="qp-chips eg-chips">
            <Link to={QUANTP.path} className="chip chip-own">
              {ticker}
            </Link>
            <StateLight state={state} stale={stale} />
          </div>
          <h1 className="eg-h1">
            <span className="eg-title">Payout Engine</span>
            <span className="eg-lede">
              Pays {ticker} holders in SOL and burns {ticker}, about once an hour.
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
          mode={live && state !== 'idle' ? 'run' : state === 'paused' ? 'off' : 'idle'}
          holders={paying ?? 24}
          share={split}
          level={tankLevel(waiting)}
          now={now}
          tags={{
            wallet: ['Payout wallet', waiting == null ? null : sol(toSol(waiting), { digits: 3 })],
            core: ['Each hour', hourly == null ? null : `${hourly} released`],
            holders: [`${holdersPct}% to holders`, paying == null ? null : count(paying, 'wallet')],
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
              <ul className="eg-next-split" role="list">
                <li>
                  <i className="qp-dot qp-dot-holders" />
                  <span>
                    <span className="num">{sol(toSol(next.holders), { digits: 4 })}</span> to{' '}
                    {next.paying.toLocaleString('en-US')} of{' '}
                    {count(engine.eligible, 'eligible wallet')}
                    {skippedText(next.skipped)}
                  </span>
                </li>
                <li>
                  <i className="qp-dot qp-dot-burn" />
                  <span>
                    {BigInt(next.buyback) > 0n ? (
                      <>
                        <span className="num">{sol(toSol(next.buyback), { digits: 4 })}</span> to
                        buy back and burn
                      </>
                    ) : (
                      noBuyback(engine, q.buybackShareBps)
                    )}
                  </span>
                </li>
              </ul>
            </div>
          )}
          <div className="eg-when" data-state={state === 'running' && stale ? 'stale' : state}>
            <WhenIcon state={state} hourDone={hourDone} />
            <p className="qp-updated eg-when-text">{runLine(engine, state, res.error, now)}</p>
            <p className="sr-only" role="status">
              {stateSentence(engine, state, res.error)}
            </p>
          </div>
        </div>
      </header>

      {fresh.length > 0 && <p className="eg-fresh faint">{fresh.join(' · ')}</p>}

      <dl className="eg-stats">
        <StatTile
          label="Market cap"
          tone="yellow"
          note={tierNow >= 0 ? `${tierLabel(tiers, tierNow)} tier` : null}
        >
          <span className="num">{usd(marketCap)}</span>
        </StatTile>
        <StatTile
          label="Release rate"
          tone="blue"
          note={dailyBps == null ? null : `about ${share(dailyShare(dailyBps))} a day`}
        >
          {hourly == null ? (
            <span className="num">—</span>
          ) : (
            <>
              <span className="num">{hourly}</span> <span className="eg-unit">/ hour</span>
            </>
          )}
        </StatTile>
        <StatTile label="In the payout wallet" tone="tint" note={short(POLICY.wallet)}>
          <span className="num">{waiting == null ? '—' : sol(toSol(waiting), { digits: 3 })}</span>
        </StatTile>
        <StatTile
          label="Eligible / paid next run"
          tone="green"
          note={`holding ${minHoldPct}% or more`}
        >
          <span className="num">
            {engine
              ? `${engine.eligible.toLocaleString('en-US')} / ${next ? next.paying.toLocaleString('en-US') : '—'}`
              : '—'}
          </span>
        </StatTile>
        <StatTile
          label="Paid to holders"
          tone="green"
          note={
            paid.partial
              ? 'still reading older payouts'
              : paid.wallets
                ? `to ${count(paid.wallets, 'wallet')} so far`
                : null
          }
          title={paid.partial ? PARTIAL_NOTE : undefined}
        >
          <span className="num">{atLeast(solFigure(paid.paidSol), paid.partial)}</span>
        </StatTile>
        <StatTile
          label="Bought back and burned"
          tone="pink"
          note={
            paid.partial
              ? 'still reading older burns'
              : paid.boughtSol
                ? `${solFigure(paid.boughtSol)} bought back`
                : null
          }
          title={
            d?.payouts
              ? `${paid.partial ? 'At least ' : ''}${formatUnits(d.payouts.burnedAmount, q.decimals)} ${q.symbol}`
              : undefined
          }
        >
          {paid.burned == null ? (
            <span className="num">—</span>
          ) : (
            <>
              <span className="num">{atLeast(tokenFigure(paid.burned), paid.partial)}</span>{' '}
              <span className="eg-unit">{q.symbol}</span>
            </>
          )}
        </StatTile>
      </dl>

      <div className="eg-grid">
        <div className="eg-main">
          <YourWallet
            engine={engine}
            symbol={q.symbol}
            decimals={q.decimals}
            rentExempt={rentExempt}
          />

          <section className="panel eg-how" aria-labelledby="eg-how-title">
            <h2 id="eg-how-title" className="h3">
              How it works
            </h2>
            <ol className="eg-steps" role="list">
              {steps.map(([title, text], i) => {
                const Icon = icons[i]
                return (
                  <li key={title} data-tone={tones[i]}>
                    <span className="eg-step-icon" aria-hidden="true">
                      <Icon size={18} strokeWidth={2.2} />
                    </span>
                    <strong>{title}</strong>
                    <p className="muted">{text}</p>
                  </li>
                )
              })}
            </ol>
          </section>

          {next && engine.holders?.length > 0 && (
            <Holders engine={engine} symbol={q.symbol} decimals={q.decimals} />
          )}

          <div className="eg-ledger">
            <QuantpLedger
              symbol={q.symbol}
              decimals={q.decimals}
              burned={d?.burned == null ? null : Number(d.burned) / 10 ** q.decimals}
              showEngine={false}
              engine={engine}
              showTotals={false}
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
              <li>Payouts are small at today’s market cap and can be zero.</li>
              <li>
                Payouts and buybacks are the team’s discretionary policy: they can change, pause or
                stop at any time, and holding {ticker} gives no right to any payment.
              </li>
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
              Release rate, by market cap
            </h2>
            {marketCap != null && (
              <div className="eg-meter">
                <p className="eg-meter-head">
                  <span>
                    Market cap <b className="num">{usd(marketCap)}</b>
                  </span>
                  {nextTier && (
                    <span className="faint">
                      {bps(hourlyBps(nextTier.dailyBps))} an hour from{' '}
                      {usd(tiers[tierNow].belowUsd)}
                    </span>
                  )}
                </p>
                <div className="eg-meter-track" aria-hidden="true">
                  {tiers.map((tier, i) => {
                    const from = i === 0 ? 0 : meterAt(tiers[i - 1].belowUsd)
                    const to = tier.belowUsd == null ? 100 : meterAt(tier.belowUsd)
                    return (
                      <i
                        key={tier.dailyBps}
                        className={i === tierNow ? 'is-here' : ''}
                        style={{ left: `${from}%`, width: `${to - from}%` }}
                      />
                    )
                  })}
                  <b style={{ left: `${meterAt(marketCap)}%` }} />
                </div>
              </div>
            )}
            <div className="eg-tier-list">
              {tiers.map((tier, i) => {
                const current = dailyBps === tier.dailyBps
                return (
                  <div
                    key={tier.dailyBps}
                    className={`eg-tier ${current ? 'is-now' : ''}`}
                    style={{ '--fill': share(dailyShare(tier.dailyBps)) }}
                  >
                    <span className="eg-tier-label">
                      {tierLabel(tiers, i)}
                      {current && <span className="qp-now">Now</span>}
                    </span>
                    <span className="eg-tier-pct num">{bps(hourlyBps(tier.dailyBps))}</span>
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
              <dd>About once each UTC hour while it is running, on Quant Pad’s server</dd>
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
                A holder’s share under {minTransfer}, or under{' '}
                {sol(toSol(rentExempt), { digits: 5 })} to a wallet holding no SOL (the least a new
                account can receive), is skipped that run and stays in the payout wallet; keep a
                little SOL in your wallet to be paid.
              </dd>
              <dt>Small buybacks</dt>
              <dd>
                {next?.buybackEveryHours
                  ? `A buyback under ${minBuyback} is batched every few hours.`
                  : `A buyback under ${minBuyback} is skipped that run and stays in the wallet.`}
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
