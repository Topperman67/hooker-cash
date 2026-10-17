import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { useResource } from '../lib/api.js'
import { Address, Segmented, Stat } from './UI.jsx'
import { ago, bps, compact, formatUnits, short, sol, toSol } from '../lib/format.js'
import { QUANTP, explorer } from '../../shared/network.mjs'
import { ENGINE_PATH, ENGINE_STATE_LABEL, dailyShare, engineState } from './quantpPayouts.js'

const LEDGER = '/api/quantp/ledger'
const POLICY = QUANTP.engine
// Rows shown before "Show all": the panel sits in the page's narrow side column.
const FIRST_ROWS = 8
// Runs shown before "Show the last 7 days".
const FIRST_RUNS = 24
const WEEK = 7 * 86_400
const MIN_BUYBACK = BigInt(POLICY.minBuybackLamports)
const minBuybackText = sol(toSol(POLICY.minBuybackLamports))

const when = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined
const day = (seconds) =>
  new Date(seconds * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' })
const utc = (seconds, options) =>
  new Date(seconds * 1000).toLocaleString('en-US', { timeZone: 'UTC', ...options })
const wallets = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'wallet' : 'wallets'}`
const big = (v) => {
  try {
    return BigInt(v ?? 0)
  } catch {
    return 0n
  }
}

// The visible text stays the signature's first characters; screen readers hear what it is and
// that it leaves the page.
function TxLink({ signature }) {
  return (
    <a href={explorer.tx(signature)} target="_blank" rel="noreferrer" className="faint">
      <span className="sr-only">Transaction </span>
      {signature.slice(0, 6)}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/**
 * A table that shows its first rows, then all of them on request. `total` is how many there are
 * on the server (more than `rows` when the ledger answered with its newest only); `onAll` asks it
 * for the rest.
 */
function Rows({ rows, head, row, total = rows.length, onAll }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, FIRST_ROWS)
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody>{shown.map(row)}</tbody>
        </table>
      </div>
      {Math.max(total, rows.length) > FIRST_ROWS && (
        <button
          type="button"
          className="btn btn-sm qp-ledger-more"
          onClick={() => {
            if (!all) onAll?.()
            setAll(!all)
          }}
        >
          {all ? 'Show fewer' : `Show all ${Math.max(total, rows.length).toLocaleString('en-US')}`}
        </button>
      )}
    </>
  )
}

/** One burst of payouts; a burst sent in several transactions opens to list each of them. */
function Burst({ burst }) {
  const [open, setOpen] = useState(false)
  const txs = burst.transactions
  return (
    <>
      <tr>
        <td className="num faint" title={when(burst.timestamp)}>
          {ago(burst.timestamp)}
        </td>
        <td className="right num">{sol(toSol(burst.lamports), { unit: false })}</td>
        <td>
          {burst.recipient ? (
            <a
              href={explorer.account(burst.recipient)}
              target="_blank"
              rel="noreferrer"
              className="num"
            >
              {short(burst.recipient)}
            </a>
          ) : (
            wallets(burst.recipients)
          )}
        </td>
        <td className="right">
          {txs.length === 1 ? (
            <TxLink signature={txs[0].signature} />
          ) : (
            <button
              type="button"
              className="qp-ledger-toggle"
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
          <tr key={x.signature} className="qp-ledger-sub">
            <td />
            <td className="right num">{sol(toSol(x.lamports), { unit: false })}</td>
            <td>{wallets(x.recipients)}</td>
            <td className="right">
              <TxLink signature={x.signature} />
            </td>
          </tr>
        ))}
    </>
  )
}

/**
 * The payout engine (/api/quantp/engine), shown once it is switched on: where it stands, what each
 * hourly run releases at the current market cap and how that adds up over a day, how many of the
 * eligible wallets its next run pays, the payout wallet's last payout on-chain (`lastPayoutAt`,
 * from the ledger) and a link to its own page.
 */
function Engine({ engine, lastPayoutAt, symbol, decimals }) {
  if (!engine?.live) return null
  const minHold = Number(engine.minHold) / 10 ** decimals
  const holdersPct = engine.holdersShareBps / 100
  const daily = Number(engine.dailyBps)
  const ticker = `$${symbol}`
  const state = engineState(engine)
  const stale = engine.state === 'stale'
  const next = engine.next ?? {}
  const release = sol(toSol(next.release), { digits: 4 })
  return (
    <div className="qp-engine">
      <p className="qp-engine-head">
        <strong>Automatic payouts</strong>
        <span className={`chip ${state === 'running' && !stale ? 'chip-grad' : ''}`}>
          {ENGINE_STATE_LABEL[state]}
        </span>
      </p>
      <p className="qp-engine-text">
        Each hour the engine wallet{' '}
        <Address value={engine.wallet} href={explorer.account(engine.wallet)} /> releases{' '}
        {bps(daily / 24)} of its SOL (about {Math.round(dailyShare(daily) * 100)}% of it a day at
        this market cap): {holdersPct}% to wallets holding at least {compact(minHold)} {ticker} (
        {engine.minHoldBps / 100}% of the supply), by balance, and {100 - holdersPct}% to buy back
        and burn {ticker}.
      </p>
      <p className="faint qp-engine-text">
        {next.paying != null && engine.eligible != null
          ? `Next run pays ${next.paying.toLocaleString('en-US')} of ${engine.eligible.toLocaleString('en-US')} eligible wallets, releasing about ${release}`
          : `Next run about ${release}`}{' '}
        · {lastPayoutAt ? `last payout ${ago(lastPayoutAt)} ago` : 'no payout yet'} ·{' '}
        {stale && 'figures may be out of date · '}
        <Link to={ENGINE_PATH}>How it works</Link>
      </p>
    </div>
  )
}

/**
 * The engine wallet's runs from the ledger, newest first: one per UTC hour (or per `run`, the hour
 * the engine's memo names, when the ledger reads it), with what it paid and to how many wallets
 * (summed over its bursts), what its buyback spent and burned, and its transactions. `status` says
 * how the run went:
 *   - 'complete': it bought back and burned (or had nothing to pay);
 *   - 'no buyback (below minimum)': the buyback its payout implies (paid × 40/60) is under the
 *     minimum, so it was skipped and its SOL stayed in the wallet;
 *   - 'buyback did not go through': otherwise.
 * `repeated` is set when the hour has two payout bursts or more.
 */
export function engineRuns(d, { everySecs = POLICY.everySecs, wallet } = {}) {
  const engineWallet = wallet ?? d?.wallets?.engine ?? POLICY.wallet
  const runs = new Map()
  const runOf = (entry) => {
    const hour = Number.isInteger(entry.run) ? entry.run : Math.floor(entry.timestamp / everySecs)
    if (!runs.has(hour))
      runs.set(hour, {
        hour,
        at: hour * everySecs,
        bursts: 0,
        paid: 0n,
        recipients: 0,
        burns: 0,
        bought: 0n,
        burned: 0n,
        signatures: [],
      })
    return runs.get(hour)
  }
  for (const burst of d?.payouts ?? []) {
    if (burst.wallet && burst.wallet !== engineWallet) continue
    const run = runOf(burst)
    run.bursts += 1
    run.paid += big(burst.lamports)
    run.recipients += burst.recipients ?? 0
    run.signatures.push(...burst.transactions.map((x) => x.signature))
  }
  for (const burn of d?.burns ?? []) {
    if (burn.wallet !== engineWallet) continue
    const run = runOf(burn)
    run.burns += 1
    run.bought += big(burn.solSpent)
    run.burned += big(burn.amount)
    run.signatures.push(burn.signature)
  }
  return [...runs.values()]
    .sort((a, b) => b.hour - a.hour)
    .map((run) => {
      const implied = (run.paid * BigInt(QUANTP.buybackShareBps)) / BigInt(QUANTP.holdersShareBps)
      return {
        ...run,
        status:
          run.burns > 0 || run.paid === 0n
            ? 'complete'
            : implied < MIN_BUYBACK
              ? 'no buyback (below minimum)'
              : 'buyback did not go through',
        repeated: run.bursts >= 2,
      }
    })
}

/** The engine's runs, the last 24 first, then the last 7 days on request. */
function Runs({ runs, symbol, decimals, more, onAll }) {
  const [week, setWeek] = useState(false)
  const since = Date.now() / 1000 - WEEK
  const recent = runs.filter((r) => r.at + POLICY.everySecs > since)
  const shown = week ? recent : runs.slice(0, FIRST_RUNS)
  if (!runs.length)
    return (
      <p className="muted qp-ledger-empty">
        No runs yet. Each hour in which the engine wallet pays holders or burns ${symbol} shows here
        once it confirms.
      </p>
    )
  return (
    <>
      <div className="table-wrap">
        <table className="table qp-runs">
          <thead>
            <tr>
              <th>Hour (UTC)</th>
              <th className="right">SOL paid</th>
              <th className="right">SOL bought</th>
              <th className="right">{symbol} burned</th>
              <th className="right">Tx</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <RunRows key={r.hour} run={r} decimals={decimals} />
            ))}
          </tbody>
        </table>
      </div>
      {(week || recent.length > FIRST_RUNS || more) && (
        <button
          type="button"
          className="btn btn-sm qp-ledger-more"
          onClick={() => {
            if (!week) onAll?.()
            setWeek(!week)
          }}
        >
          {week ? 'Show the last 24' : 'Show the last 7 days'}
        </button>
      )}
    </>
  )
}

/** A run's figures, and under them how it went. */
function RunRows({ run, decimals }) {
  const ok = run.status === 'complete' && !run.repeated
  return (
    <>
      <tr className="qp-run">
        <td className="num" title={utc(run.at, { dateStyle: 'full', timeStyle: 'short' })}>
          {utc(run.at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
          <span className="qp-run-day">{utc(run.at, { month: 'short', day: 'numeric' })}</span>
        </td>
        <td className="right num">
          {run.bursts ? sol(toSol(run.paid), { unit: false }) : '—'}
          {/* a repeated hour may have paid the same wallets twice: its count is of payments */}
          {run.bursts > 0 && (
            <span className="qp-run-day">
              {run.repeated
                ? `${run.recipients.toLocaleString('en-US')} payments`
                : wallets(run.recipients)}
            </span>
          )}
        </td>
        <td className="right num">{run.burns ? sol(toSol(run.bought), { unit: false }) : '—'}</td>
        <td className="right num">
          {run.burns ? compact(Number(run.burned) / 10 ** decimals) : '—'}
        </td>
        <td className="right qp-run-txs">
          {run.signatures.map((s) => (
            <TxLink key={s} signature={s} />
          ))}
        </td>
      </tr>
      <tr className="qp-ledger-sub qp-run-status">
        <td colSpan={5}>
          <span className={`chip qp-run-chip ${ok ? 'chip-grad' : ''}`}>{run.status}</span>
          {run.repeated && <span className="chip qp-run-chip">repeated</span>}
        </td>
      </tr>
    </>
  )
}

/**
 * $QUANTP's payouts to holders, its burns and the engine's hourly runs, read from the team's
 * wallets by /api/quantp/ledger, with the payout engine's state, so holders can see what was
 * actually paid, bought back and burned. `burned` is the whole tokens gone from the supply.
 * `engine` is the /api/quantp/engine body when the page already loads it (null included); left
 * out, the panel fetches it itself. `showEngine` false leaves out the engine's block and
 * `showTotals` false the payout totals, for the engine's own page, which shows both in full.
 */
export default function QuantpLedger({
  symbol,
  decimals,
  burned,
  engine: engineProp,
  showEngine = true,
  showTotals = true,
}) {
  const [tab, setTab] = useState('payouts')
  // The ledger answers with its newest rows; "Show all" asks it for every one, once it has more.
  const [wantAll, setWantAll] = useState(false)
  const full = useResource(wantAll ? `${LEDGER}?all=1` : null, 60_000)
  const newest = useResource(full.data ? null : LEDGER, 60_000)
  const ledger = full.data ? full : newest
  const own = useResource(engineProp === undefined ? '/api/quantp/engine' : null, 60_000).data
  const engine = engineProp === undefined ? own : engineProp
  const d = ledger.data
  const t = d?.totals
  const more = !!d?.more
  const requestAll = () => more && setWantAll(true)
  const teamBurned = t ? Number(t.burnedAmount) / 10 ** decimals : null
  const othersBurned = burned != null && teamBurned != null ? burned - teamBurned : null
  const unburnedTokens = t ? Number(t.unburned.amount) / 10 ** decimals : 0
  const latest = d?.payouts[0]
  const lastPayoutAt = latest
    ? (latest.lastTimestamp ?? latest.transactions?.at(-1)?.timestamp ?? latest.timestamp)
    : null

  let body
  if (!d)
    body = (
      <p className="muted qp-ledger-empty">
        {ledger.loading ? 'Reading the team’s wallets…' : ledger.error}
      </p>
    )
  else if (tab === 'payouts')
    body = (
      <>
        <Engine
          engine={showEngine ? engine : null}
          lastPayoutAt={lastPayoutAt}
          symbol={symbol}
          decimals={decimals}
        />
        {showTotals && (
          <dl className="qp-ledger-totals">
            <Stat label="Paid out">
              <span className="num">{sol(toSol(t.paidLamports), { digits: 3 })}</span>
            </Stat>
            <Stat label="Wallets paid">
              <span className="num">{t.recipients.toLocaleString('en-US')}</span>
            </Stat>
            <Stat label="Wallets eligible now">
              <span
                className="num"
                title={`Holding at least ${POLICY.minHoldBps / 100}% of the supply`}
              >
                {engine?.configured ? engine.eligible.toLocaleString('en-US') : '—'}
              </span>
            </Stat>
            <Stat label="In the payout wallet">
              <span className="num">{sol(toSol(d.payoutLamports), { digits: 3 })}</span>
            </Stat>
          </dl>
        )}
        {d.payouts.length ? (
          <Rows
            rows={d.payouts}
            total={d.payoutCount}
            onAll={requestAll}
            head={
              <>
                <th>Age</th>
                <th className="right">SOL</th>
                <th>Paid to</th>
                <th className="right">Tx</th>
              </>
            }
            row={(burst) => <Burst key={burst.transactions[0].signature} burst={burst} />}
          />
        ) : (
          <p className="muted qp-ledger-empty">
            No payouts yet. Each SOL payout to holders shows here once it confirms.
          </p>
        )}
        <p className="faint qp-fine">
          Each row is one payout of SOL from the payout wallet{' '}
          <Address value={d.wallets.payout} href={explorer.account(d.wallets.payout)} />{' '}
          (transactions sent together count as one), read from the chain.
        </p>
      </>
    )
  else if (tab === 'burns')
    body = (
      <>
        <dl className="qp-ledger-totals">
          <Stat label="Burned">
            <span className="num">
              {compact(teamBurned)} {symbol}
            </span>
          </Stat>
          <Stat label="Bought back">
            <span className="num">
              {sol(toSol(BigInt(t.buybackLamports) + BigInt(t.unburned.lamports)), { digits: 3 })}
            </span>
          </Stat>
          <Stat label="Not burned yet">
            <span
              className="num"
              title={`${formatUnits(t.unburned.amount, decimals, 0)} ${symbol}, bought for this SOL`}
            >
              {sol(toSol(t.unburned.lamports), { digits: 3 })}
            </span>
            {unburnedTokens > 0 && (
              <span className="num qp-ledger-tokens">
                {compact(unburnedTokens)} {symbol}
              </span>
            )}
          </Stat>
          <Stat label="Next buyback">
            <span className="num">
              {engine?.live ? sol(toSol(engine.next.buyback), { digits: 4 }) : '—'}
            </span>
          </Stat>
        </dl>
        {d.burns.length ? (
          <Rows
            rows={d.burns}
            total={d.burnCount}
            onAll={requestAll}
            head={
              <>
                <th>Age</th>
                <th className="right">{symbol}</th>
                <th className="right">SOL spent</th>
                <th className="right">Tx</th>
              </>
            }
            row={(b) => (
              <tr key={`${b.signature}:${b.wallet}`}>
                <td className="num faint" title={when(b.timestamp)}>
                  {ago(b.timestamp)}
                </td>
                <td className="right num">{formatUnits(b.amount, decimals, 0)}</td>
                {b.solSpent == null ? (
                  <td className="right num">—</td>
                ) : (
                  <td
                    className="right num"
                    title={`Includes earlier buys whose $${symbol} this transaction burned`}
                  >
                    {sol(toSol(b.solSpent), { unit: false })}
                  </td>
                )}
                <td className="right">
                  <TxLink signature={b.signature} />
                </td>
              </tr>
            )}
          />
        ) : (
          <p className="muted qp-ledger-empty">
            No burns yet. Each burn of ${symbol} by the team’s wallets shows here once it confirms.
          </p>
        )}
        <p className="faint qp-fine">
          Buys and burns by the payout wallet{' '}
          <Address value={d.wallets.payout} href={explorer.account(d.wallets.payout)} /> and the
          creator wallet{' '}
          <Address value={d.wallets.creator} href={explorer.account(d.wallets.creator)} />.
          {engine?.live &&
            (big(engine.next?.buyback) > 0n
              ? ` The payout engine buys back and burns about once an hour when its share is at least ${minBuybackText}.`
              : ` No buyback this hour: its share is under ${minBuybackText} and stays in the wallet.`)}{' '}
          SOL spent is what they paid for the ${symbol} they bought since the burn before, the
          launch’s dev buy aside.
          {othersBurned >= 1 && ` Other wallets have burned ${compact(othersBurned)} ${symbol}.`}
        </p>
      </>
    )
  else
    body = (
      <>
        <Runs
          runs={engineRuns(d)}
          symbol={symbol}
          decimals={decimals}
          more={more}
          onAll={requestAll}
        />
        <p className="faint qp-fine">
          One row per UTC hour in which the engine wallet{' '}
          <Address
            value={d.wallets.engine ?? POLICY.wallet}
            href={explorer.account(d.wallets.engine ?? POLICY.wallet)}
          />{' '}
          paid holders or burned ${symbol}, read from the chain. A buyback under {minBuybackText} is
          skipped and its SOL stays in the wallet.
        </p>
      </>
    )

  return (
    <section id="payouts" className="panel qp-ledger" aria-labelledby="qp-ledger-title">
      <div className="panel-head">
        <h2 id="qp-ledger-title" className="h3">
          Payouts & burns
        </h2>
        <Segmented
          label="Show payouts, burns or runs"
          value={tab}
          onChange={setTab}
          options={[
            ['payouts', 'Payouts'],
            ['burns', 'Burns'],
            ['runs', 'Runs'],
          ]}
        />
      </div>
      {body}
      {d?.complete === false && (
        <p className="faint qp-fine">
          {d.since ? `Showing history since ${day(d.since)}` : 'Showing recent history'}; older
          transactions are still loading.
        </p>
      )}
      {d?.unread > 0 && (
        <p className="faint qp-fine">
          {d.unread === 1 ? '1 transaction' : `${d.unread} transactions`} of the team’s wallets
          could not be read yet: these lists may be missing {d.unread === 1 ? 'it' : 'them'}.
          Retrying shortly.
        </p>
      )}
      {d?.state === 'stale' && (
        <p className="faint qp-fine">
          Updated {ago(d.updatedAt)} ago: the chain could not be read just now.
        </p>
      )}
    </section>
  )
}
