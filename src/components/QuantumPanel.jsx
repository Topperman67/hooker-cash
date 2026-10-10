import { useCallback, useEffect, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { useToast } from './Toasts.jsx'
import { Address, AllocationBar, Spinner } from './UI.jsx'
import { api, useResource } from '../lib/api.js'
import { connection, friendlyWalletError, packTransactions } from '../lib/solana.js'
import { loadQuantum } from '../lib/quantum.js'
import { ago, bps, duration, formatUnits, sol, toSol } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'

const ACTION_LABELS = {
  pulse: 'Pulse',
  burn: 'Quantum Burn',
  fusion: 'Fusion',
  entangle: 'Entanglement epoch',
  'close-epoch': 'Epoch closed',
}

export default function QuantumPanel({ coin }) {
  const { address, connected, openDialog, sendTransactions } = useWallet()
  const { lookupTable } = usePlatform()
  const toast = useToast()
  const [state, setState] = useState(null)
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const history = useResource(`/api/quantum/${coin.mint}`, 30000)
  const claims = useResource(
    address ? `/api/quantum/${coin.mint}/claims?wallet=${address}` : null,
    60000,
  )

  const load = useCallback(async () => {
    try {
      const client = await loadQuantum()
      const mint = new PublicKey(coin.mint)
      const [quantum, waiting] = await Promise.all([
        client.fetchQuantum(connection, mint),
        client.pendingCreatorFees(connection, mint).catch(() => null),
      ])
      setState({ client, quantum })
      setPending(waiting)
      setError('')
    } catch (e) {
      setError(e.message)
    }
  }, [coin.mint])
  useEffect(() => {
    load()
    const timer = setInterval(load, 20000)
    return () => clearInterval(timer)
  }, [load])

  async function run(label, build) {
    if (!connected) return openDialog()
    setBusy(label)
    setError('')
    try {
      const instructions = await build(
        state.client,
        new PublicKey(address),
        new PublicKey(coin.mint),
      )
      const { transactions, lastValidBlockHeight } = await packTransactions(
        address,
        [instructions],
        {
          units: 600_000,
          lookupTableAddresses: lookupTable ? [lookupTable] : [],
        },
      )
      const [signature] = await sendTransactions(transactions, { lastValidBlockHeight })
      toast({ title: `${label} confirmed`, tone: 'success', signature })
      api('/api/sync', { mint: coin.mint }).catch(() => {})
      await load()
      claims.refresh()
      history.refresh()
    } catch (e) {
      setError(friendlyWalletError(e))
    } finally {
      setBusy('')
    }
  }

  if (!state)
    return (
      <section className="panel quantum-panel">
        <h3>Quantum Hooks</h3>
        {error ? (
          <p className="error-text">{error}</p>
        ) : (
          <Spinner block label="Reading hook state" />
        )}
      </section>
    )
  const q = state.quantum
  if (!q)
    return (
      <section className="panel quantum-panel">
        <h3>Quantum Hooks</h3>
        <p className="muted">
          This coin's creator is a Quant Pad well, but its hook account was not found on-chain.
        </p>
      </section>
    )

  const now = Math.floor(Date.now() / 1000)
  const vested = state.client.vestedAmount ? state.client.vestedAmount(q, now) : 0n
  const releasable = vested > q.releasedAmount ? vested - q.releasedAmount : 0n
  const isLauncher = address && address === q.launcher

  return (
    <section className="panel quantum-panel" aria-labelledby="quantum-title">
      <div className="panel-head">
        <h3 id="quantum-title">Quantum Hooks</h3>
        <span className="chip chip-quantum">Immutable</span>
      </div>
      <AllocationBar hooks={q} />

      {q.splits?.length > 0 && (
        <div className="quantum-block">
          <h4>Superposition</h4>
          <ul className="split-list">
            {q.splits.map((s) => (
              <li key={s.wallet}>
                <Address value={s.wallet} href={explorer.account(s.wallet)} />
                <span className="num">{bps(s.bps)} of creator share</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="quantum-reserves">
        <div style={{ '--c': 'var(--hook-burn)' }}>
          <dt>Burn reserve</dt>
          <dd className="num">{sol(toSol(q.burnReserve))}</dd>
        </div>
        <div style={{ '--c': 'var(--hook-entangle)' }}>
          <dt>Holder reserve</dt>
          <dd className="num">{sol(toSol(q.entangleReserve + q.entangleOwed))}</dd>
        </div>
        <div style={{ '--c': 'var(--hook-fusion)' }}>
          <dt>Fusion reserve</dt>
          <dd className="num">{sol(toSol(q.fusionReserve))}</dd>
        </div>
        <div style={{ '--c': 'var(--hook-creator)' }}>
          <dt>Waiting to pulse</dt>
          <dd className="num">{pending == null ? '—' : sol(toSol(pending))}</dd>
        </div>
      </dl>

      <dl className="kv quantum-totals">
        <dt>Fees collected</dt>
        <dd className="num">{sol(toSol(q.totalCollected))}</dd>
        <dt>Tokens burned</dt>
        <dd className="num">
          {formatUnits(q.totalBurnedTokens, 6, 0)} {coin.symbol}
        </dd>
        <dt>Paid to holders</dt>
        <dd className="num">{sol(toSol(q.totalClaimed))}</dd>
        <dt>Paid to creator</dt>
        <dd className="num">{sol(toSol(q.totalCreatorPaid))}</dd>
        <dt>Liquidity fused</dt>
        <dd className="num">{sol(toSol(q.totalFusedSol))}</dd>
      </dl>

      <button
        className="btn btn-block"
        disabled={!!busy}
        onClick={() =>
          run('Pulse', (client, payer, mint) =>
            client.buildPulseInstructions({ connection, payer, mint }),
          )
        }
      >
        {busy === 'Pulse' ? <Spinner /> : null} Pulse fees now
      </button>
      <p className="faint quantum-note">
        A pulse collects this coin's waiting creator fees and routes them by the rules above. Anyone
        can send one; the keeper also does it automatically.
      </p>

      {q.lockedAmount > 0n && (
        <div className="quantum-block">
          <h4>Time Dilation lock</h4>
          <dl className="kv">
            <dt>Locked</dt>
            <dd className="num">{formatUnits(q.lockedAmount, 6, 0)}</dd>
            <dt>Released</dt>
            <dd className="num">{formatUnits(q.releasedAmount, 6, 0)}</dd>
            <dt>
              {now < q.lockCliff
                ? 'Cliff ends in'
                : now < q.lockEnd
                  ? 'Fully vested in'
                  : 'Fully vested'}
            </dt>
            <dd>
              {now < q.lockCliff
                ? duration(q.lockCliff - now)
                : now < q.lockEnd
                  ? duration(q.lockEnd - now)
                  : '✓'}
            </dd>
          </dl>
          {isLauncher && (
            <button
              className="btn btn-block"
              style={{ marginTop: 12 }}
              disabled={!!busy || releasable <= 0n}
              onClick={() =>
                run('Release', async (client, launcher, mint) => [
                  await client.buildReleaseInstruction({ connection, launcher, mint }),
                ])
              }
            >
              Release {formatUnits(releasable, 6, 0)} {coin.symbol}
            </button>
          )}
        </div>
      )}

      {connected && claims.data?.items?.length > 0 && (
        <div className="quantum-block">
          <h4>Your Entanglement rewards</h4>
          {claims.data.items.map((c) => (
            <div className="claim-row" key={c.index}>
              <span className="num">{sol(toSol(BigInt(c.amount)))}</span>
              <span className="faint">epoch {c.index + 1}</span>
              <button
                className="btn btn-sm btn-primary"
                disabled={!!busy}
                onClick={() =>
                  run('Claim', async (client, claimant, mint) => [
                    await client.buildClaimInstruction({
                      connection,
                      claimant,
                      mint,
                      index: c.index,
                      leafIndex: c.leafIndex,
                      amount: BigInt(c.amount),
                      proof: c.proof.map((h) =>
                        Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16))),
                      ),
                    }),
                  ])
                }
              >
                Claim
              </button>
            </div>
          ))}
        </div>
      )}

      {history.data?.log?.length > 0 && (
        <div className="quantum-block">
          <h4>Recent hook activity</h4>
          <ul className="activity">
            {history.data.log.slice(0, 8).map((row, i) => (
              <li key={i}>
                <span>{ACTION_LABELS[row.action] || row.action}</span>
                <span className="faint num">{ago(row.at)} ago</span>
                {row.signature && (
                  <a href={explorer.tx(row.signature)} target="_blank" rel="noreferrer">
                    tx
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
