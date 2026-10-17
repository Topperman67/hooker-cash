import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown } from 'lucide-react'
import { useResource } from '../lib/api.js'
import { Address, Segmented, Stat } from './UI.jsx'
import { ago, compact, formatUnits, short, sol, toSol } from '../lib/format.js'
import { QUANTP, explorer } from '../../shared/network.mjs'
import { ENGINE_PATH, ENGINE_STATE_LABEL, engineState } from './quantpPayouts.js'

// Rows shown before "Show all": the panel sits in the page's narrow side column.
const FIRST_ROWS = 8

const when = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined
const wallets = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'wallet' : 'wallets'}`

function TxLink({ signature }) {
  return (
    <a href={explorer.tx(signature)} target="_blank" rel="noreferrer" className="faint">
      {signature.slice(0, 6)}
    </a>
  )
}

function Rows({ rows, head, row }) {
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
      {rows.length > FIRST_ROWS && (
        <button type="button" className="btn btn-sm qp-ledger-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
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
 * The payout engine (/api/quantp/engine), shown once it is switched on: where it stands, what it
 * does every hour at the current market cap, how many wallets it pays, its next run, the payout
 * wallet's last payout on-chain (`lastPayoutAt`, from the ledger) and a link to its own page.
 */
function Engine({ engine, lastPayoutAt, symbol, decimals }) {
  if (!engine?.live) return null
  const minHold = Number(engine.minHold) / 10 ** decimals
  const holdersPct = engine.holdersShareBps / 100
  const ticker = `$${symbol}`
  const state = engineState(engine)
  return (
    <div className="qp-engine">
      <p className="qp-engine-head">
        <strong>Automatic payouts</strong>
        <span className={`chip ${state === 'running' ? 'chip-grad' : ''}`}>
          {ENGINE_STATE_LABEL[state]}
        </span>
      </p>
      <p className="qp-engine-text">
        Every hour the engine wallet{' '}
        <Address value={engine.wallet} href={explorer.account(engine.wallet)} /> releases{' '}
        {engine.dailyBps / 100}% a day of its SOL (more as the market cap grows): {holdersPct}% to
        the {engine.eligible.toLocaleString('en-US')} wallets holding at least {compact(minHold)}{' '}
        {ticker} ({engine.minHoldBps / 100}% of the supply), by balance, and {100 - holdersPct}% to
        buy back and burn {ticker}.
      </p>
      <p className="faint qp-engine-text">
        Next run about {sol(toSol(engine.next.release), { digits: 4 })} ·{' '}
        {lastPayoutAt ? `last payout ${ago(lastPayoutAt)} ago` : 'no payout yet'} ·{' '}
        <Link to={ENGINE_PATH}>How it works</Link>
      </p>
    </div>
  )
}

/**
 * $QUANTP's payouts to holders and its burns, read from the team's wallets by /api/quantp/ledger,
 * with the payout engine's state from /api/quantp/engine, so holders can see what was actually
 * paid, bought back and burned. `burned` is the whole tokens gone from the supply. `showEngine`
 * false leaves out the engine's block, for the engine's own page, which shows it in full.
 */
export default function QuantpLedger({ symbol, decimals, burned, showEngine = true }) {
  const [tab, setTab] = useState('payouts')
  const ledger = useResource('/api/quantp/ledger', 30_000)
  const engine = useResource('/api/quantp/engine', 60_000).data
  const d = ledger.data
  const t = d?.totals
  const teamBurned = t ? Number(t.burnedAmount) / 10 ** decimals : null
  const othersBurned = burned != null && teamBurned != null ? burned - teamBurned : null

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
          lastPayoutAt={d.payouts[0]?.timestamp ?? null}
          symbol={symbol}
          decimals={decimals}
        />
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
              title={`Holding at least ${QUANTP.engine.minHoldBps / 100}% of the supply`}
            >
              {engine?.configured ? engine.eligible.toLocaleString('en-US') : '—'}
            </span>
          </Stat>
          <Stat label="In the payout wallet">
            <span className="num">{sol(toSol(d.payoutLamports), { digits: 3 })}</span>
          </Stat>
        </dl>
        {d.payouts.length ? (
          <Rows
            rows={d.payouts}
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
          (transactions sent together count as one), read from the chain.{' '}
          <Link to={ENGINE_PATH}>See every wallet paid on the Payout Engine page</Link>.
        </p>
      </>
    )
  else
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
                <td className="right num">
                  {b.solSpent == null ? '—' : sol(toSol(b.solSpent), { unit: false })}
                </td>
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
          {engine?.live && ' The payout engine buys back and burns every hour.'} SOL spent is what
          they paid for the ${symbol} they bought since the burn before, the launch’s dev buy aside.
          {othersBurned >= 1 && ` Other wallets have burned ${compact(othersBurned)} ${symbol}.`}
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
          label="Show payouts or burns"
          value={tab}
          onChange={setTab}
          options={[
            ['payouts', 'Payouts'],
            ['burns', 'Burns'],
          ]}
        />
      </div>
      {body}
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
