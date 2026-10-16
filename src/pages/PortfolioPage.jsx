import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { CoinTable } from '../components/CoinList.jsx'
import { CoinAvatar, Empty, Spinner } from '../components/UI.jsx'
import { useQuantpFigures } from '../components/QuantpShowcase.jsx'
import { api, useResource } from '../lib/api.js'
import { connection } from '../lib/solana.js'
import { formatUnits, sol, toSol, usd } from '../lib/format.js'
import { network, QUANTP } from '../../shared/network.mjs'

async function holdings(owner) {
  const programs = [network.tokenProgram, network.token2022Program]
  const results = await Promise.all(
    programs.map((programId) =>
      connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
        programId: new PublicKey(programId),
      }),
    ),
  )
  const byMint = new Map()
  for (const { value } of results)
    for (const { account } of value) {
      const info = account.data.parsed?.info
      if (!info || info.tokenAmount.decimals !== 6 || info.tokenAmount.amount === '0') continue
      byMint.set(info.mint, (byMint.get(info.mint) || 0n) + BigInt(info.tokenAmount.amount))
    }
  return byMint
}

export default function PortfolioPage() {
  const { connected, address, balance, openDialog } = useWallet()
  const { solUsd } = usePlatform()
  const { f: qp } = useQuantpFigures()
  const [held, setHeld] = useState(null)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [unpriced, setUnpriced] = useState(false)
  const launches = useResource(
    address ? `/api/market?launcher=${address}&filter=all&sort=newest` : null,
    30000,
  )

  useEffect(() => {
    setHeld(null)
    setRows(null)
    setError('')
    setUnpriced(false)
    if (!address) return
    let live = true
    ;(async () => {
      try {
        const held = await holdings(address)
        if (live) setHeld(held)
        // $QUANTP is priced from /api/quantp (below); every other coin from the indexer. A store
        // outage only costs those other rows, never the $QUANTP one.
        const mints = [...held.keys()].filter((m) => m !== QUANTP.mint)
        let known = []
        try {
          known = mints.length
            ? (await api(`/api/coins?mints=${mints.slice(0, 100).join(',')}`)).items
            : []
        } catch {
          if (live) setUnpriced(true)
        }
        const rows = known
          .filter((c) => c.mint !== QUANTP.mint)
          .map((c) => ({
            ...c,
            held: held.get(c.mint),
            value: c.price ? (Number(held.get(c.mint)) / 1e6) * c.price : null,
          }))
          .sort((a, b) => (b.value || 0) - (a.value || 0))
        if (live) setRows(rows)
      } catch (e) {
        if (live) setError(e.message)
      }
    })()
    return () => {
      live = false
    }
  }, [address])

  // The wallet's $QUANTP (a Token-2022 account, read with the rest) at the live price, pinned first.
  const quantpHeld = held?.get(QUANTP.mint) || 0n
  const quantpRow =
    rows && quantpHeld > 0n
      ? {
          held: quantpHeld,
          value:
            qp.priceSol != null ? (Number(quantpHeld) / 10 ** QUANTP.decimals) * qp.priceSol : null,
        }
      : null

  if (!connected)
    return (
      <div className="wrap">
        <Empty
          level={1}
          title="Connect a wallet to see your portfolio"
          action={
            <button className="btn btn-primary" onClick={openDialog}>
              Connect wallet
            </button>
          }
        >
          Your holdings of Quant Pad coins and the coins you launched appear here.
        </Empty>
      </div>
    )

  const total = (rows?.reduce((s, r) => s + (r.value || 0), 0) || 0) + (quantpRow?.value || 0)
  return (
    <div className="wrap portfolio">
      <header className="page-head">
        <h1>Portfolio</h1>
        <p className="muted">
          <span className="num">{sol(toSol(balance))}</span> in your wallet
          {rows ? (
            <>
              , <span className="num">{solUsd ? usd(total * solUsd) : sol(total)}</span> in tracked
              coins.
            </>
          ) : (
            '.'
          )}
        </p>
      </header>

      <section className="section-tight">
        <h2>Holdings</h2>
        {error ? (
          <p className="error-text">{error}</p>
        ) : !rows ? (
          <Spinner block label="Reading your token accounts" />
        ) : rows.length || quantpRow ? (
          <div className="panel" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th className="right">Balance</th>
                    <th className="right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {quantpRow && (
                    <tr>
                      <td>
                        <Link to={QUANTP.path} className="coin-cell">
                          <CoinAvatar src="/brand/mark.svg" symbol={QUANTP.symbol} size={28} />
                          <strong>{QUANTP.symbol}</strong>
                          <span className="chip">Quant Pad’s own token</span>
                        </Link>
                      </td>
                      <td className="right num">
                        {formatUnits(quantpRow.held, QUANTP.decimals, 0)}
                      </td>
                      <td className="right num">
                        {quantpRow.value == null
                          ? '—'
                          : solUsd
                            ? usd(quantpRow.value * solUsd)
                            : sol(quantpRow.value)}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.mint}>
                      <td>
                        <Link to={`/coin/${r.mint}`} className="coin-cell">
                          <CoinAvatar src={r.image} symbol={r.symbol} size={28} />
                          <strong>{r.symbol}</strong>
                          {r.quantum && <span className="chip chip-quantum">Quantum</span>}
                        </Link>
                      </td>
                      <td className="right num">{formatUnits(r.held, 6, 0)}</td>
                      <td className="right num">
                        {r.value == null ? '—' : solUsd ? usd(r.value * solUsd) : sol(r.value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <p className="muted">
            {unpriced
              ? 'Your other coins could not be priced right now. Try again in a minute.'
              : "You don't hold any coins tracked by Quant Pad."}
          </p>
        )}
        {unpriced && (rows?.length > 0 || quantpRow) && (
          <p className="muted" style={{ marginTop: 10 }}>
            Some coins could not be priced right now. Try again in a minute.
          </p>
        )}
      </section>

      <section className="section-tight">
        <h2>Your launches</h2>
        {launches.data?.items?.length ? (
          <CoinTable items={launches.data.items} />
        ) : (
          <p className="muted">
            {launches.loading ? (
              'Loading…'
            ) : (
              <>
                You haven't launched a coin yet. <Link to="/launch">Launch one</Link>.
              </>
            )}
          </p>
        )}
      </section>
    </div>
  )
}
