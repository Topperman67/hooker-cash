import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PublicKey } from '@solana/web3.js'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { CoinTable } from '../components/CoinList.jsx'
import { CoinAvatar, Empty, Spinner } from '../components/UI.jsx'
import { api, useResource } from '../lib/api.js'
import { connection } from '../lib/solana.js'
import { formatUnits, sol, toSol, usd } from '../lib/format.js'
import { network } from '../../shared/network.mjs'

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
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const launches = useResource(
    address ? `/api/market?launcher=${address}&filter=all&sort=newest` : null,
    30000,
  )

  useEffect(() => {
    if (!address) return setRows(null)
    let live = true
    ;(async () => {
      try {
        const held = await holdings(address)
        const mints = [...held.keys()]
        const known = mints.length
          ? (await api(`/api/coins?mints=${mints.slice(0, 100).join(',')}`)).items
          : []
        const rows = known
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

  const total = rows?.reduce((s, r) => s + (r.value || 0), 0) || 0
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
        ) : rows.length ? (
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
          <p className="muted">You don't hold any coins tracked by Quant Pad.</p>
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
