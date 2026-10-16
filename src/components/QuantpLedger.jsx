import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useResource } from '../lib/api.js'
import { Address, Segmented, Stat } from './UI.jsx'
import { ago, compact, formatUnits, short, sol, toSol } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'

// Rows shown before "Show all": the panel sits in the page's narrow side column.
const FIRST_ROWS = 8

const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)
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
 * $QUANTP's payouts to holders and its burns, read from the team's wallets by /api/quantp/ledger,
 * so holders can check the stated 60/40 split against what was actually paid and burned. `fees`
 * is /api/quantp's fees earned so far, `burned` the whole tokens gone from the supply.
 */
export default function QuantpLedger({ symbol, decimals, fees, burned }) {
  const [tab, setTab] = useState('payouts')
  const ledger = useResource('/api/quantp/ledger', 30_000)
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
        <dl className="qp-ledger-totals">
          <Stat label="Paid out">
            <span className="num">{sol(toSol(t.paidLamports), { digits: 3 })}</span>
          </Stat>
          <Stat label="Wallets paid">
            <span className="num">{t.recipients.toLocaleString('en-US')}</span>
          </Stat>
          <Stat label="Holders’ share earned">
            <span className="num">{sol(num(fees?.holdersSol), { digits: 3 })}</span>
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
          The team pays holders in bursts: small ones now, bigger ones as the market cap grows. Each
          row is one burst of SOL from its payout wallet{' '}
          <Address value={d.wallets.payout} href={explorer.account(d.wallets.payout)} />, read from
          the chain.
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
          <Stat label="SOL spent">
            <span className="num">{sol(toSol(t.buybackLamports), { digits: 3 })}</span>
          </Stat>
          <Stat label="Buyback share earned">
            <span className="num">{sol(num(fees?.buybackSol), { digits: 3 })}</span>
          </Stat>
          <Stat label="Bought, not burned yet">
            <span
              className="num"
              title={`${formatUnits(t.unburned.amount, decimals, 0)} ${symbol}`}
            >
              {sol(toSol(t.unburned.lamports), { digits: 3 })}
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
          <Address value={d.wallets.creator} href={explorer.account(d.wallets.creator)} />. SOL
          spent is what they paid for the ${symbol} they bought since the burn before, the launch’s
          dev buy aside.
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
