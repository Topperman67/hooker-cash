import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { Link } from 'react-router-dom'
import { arc, explorerAddress } from '../config/network'
import { publicClient, readableError } from '../lib/chain'
import {
  prepareLaunch,
  readLaunchConfiguration,
  sendPreparedLaunch,
  verifyLaunchReceipt,
} from '../lib/launch'
import { clearPendingLaunch, loadPendingLaunch, savePendingLaunch } from '../lib/pendingLaunch'
import { useWallet } from '../context/WalletContext'
import Glass from './Glass'
import { Button } from './UI'

export default function LaunchForm({ config, onConnect }) {
  const wallet = useWallet()
  const [draft, setDraft] = useState({
    name: '',
    symbol: '',
    description: '',
    presetId: config.presets?.[0]?.id || '',
  })
  const [live, setLive] = useState(null)
  const [review, setReview] = useState(null)
  const [pending, setPending] = useState(() => loadPendingLaunch(config))
  const [confirmed, setConfirmed] = useState(null)
  const [stage, setStage] = useState('loading')
  const [error, setError] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const [reverted, setReverted] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(true)
  const latestWallet = useRef(wallet)
  latestWallet.current = wallet
  const frozen = ['preparing', 'signing', 'confirming'].includes(stage) || !!pending

  useEffect(() => {
    mounted.current = true
    let active = true
    readLaunchConfiguration(publicClient, config)
      .then((value) => {
        if (active) {
          setLive(value)
          setStage('editing')
        }
      })
      .catch((failure) => {
        if (active) {
          setError(readableError(failure))
          setStage('error')
        }
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [config])

  useEffect(() => {
    setReview(null)
  }, [wallet.account, wallet.chainId, wallet.selected])

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }))
    setReview(null)
    setError('')
  }

  async function refresh() {
    setError('')
    setReview(null)
    setLive(null)
    setStage('loading')
    try {
      setLive(await readLaunchConfiguration(publicClient, config))
      setStage('editing')
    } catch (failure) {
      setError(readableError(failure))
      setStage('error')
    }
  }

  async function prepare() {
    if (lock.current || pending) return
    lock.current = true
    setError('')
    setReview(null)
    setStage('preparing')
    const account = wallet.account
    const provider = wallet.selected?.provider
    try {
      const result = await prepareLaunch({
        client: publicClient,
        config,
        draft,
        account,
        reviewedFee: live?.launchFee,
      })
      if (!mounted.current) return
      if (
        latestWallet.current.account !== account ||
        latestWallet.current.selected?.provider !== provider ||
        latestWallet.current.chainId !== config.chainId
      )
        throw new Error('Wallet changed during simulation. Review the launch again.')
      setReview(result)
      setStage('review')
    } catch (failure) {
      if (mounted.current) {
        setError(readableError(failure))
        setStage('error')
      }
    } finally {
      lock.current = false
    }
  }

  function retain(record) {
    setPending(record)
    try {
      savePendingLaunch(record)
    } catch {
      setStorageWarning(
        'The transaction was sent, but this browser could not save it. Keep the explorer link before leaving this page.',
      )
    }
  }

  async function checkReceipt(record) {
    setStage('confirming')
    setError('')
    setReverted(false)
    try {
      const result = await verifyLaunchReceipt({
        client: publicClient,
        config,
        prepared: record.prepared,
        hash: record.hash,
        onReplacement: (hash) => {
          record = { ...record, hash }
          retain(record)
        },
      })
      if (mounted.current) {
        setConfirmed(result)
        setStage('confirmed')
      }
    } catch (failure) {
      if (mounted.current) {
        setError(readableError(failure))
        setReverted(failure.code === 'LAUNCH_REVERTED')
        setStage('verification-error')
      }
    }
  }

  async function submit() {
    if (lock.current || !review || pending) return
    lock.current = true
    setStage('signing')
    setError('')
    const provider = wallet.selected?.provider
    try {
      const hash = await sendPreparedLaunch({
        client: publicClient,
        provider,
        config,
        prepared: review,
        isCurrent: () =>
          mounted.current &&
          latestWallet.current.account === review.request.account &&
          latestWallet.current.chainId === config.chainId &&
          latestWallet.current.selected?.provider === provider,
      })
      const record = { hash, chainId: config.chainId, factory: config.factory, prepared: review }
      // Persist immediately after broadcast, even if navigation happened while
      // the wallet prompt was open. Resuming only verifies; it never resends.
      retain(record)
      if (mounted.current) await checkReceipt(record)
    } catch (failure) {
      if (mounted.current) {
        setError(readableError(failure))
        setStage('error')
        setReview(null)
      }
    } finally {
      lock.current = false
    }
  }

  function startAnother() {
    clearPendingLaunch()
    setPending(null)
    setConfirmed(null)
    setReview(null)
    setReverted(false)
    setStorageWarning('')
    setDraft((current) => ({ ...current, name: '', symbol: '', description: '' }))
    refresh()
  }

  return (
    <Glass className="panel-pad launch-form">
      <h2 className="panel-title">Token launch</h2>
      <fieldset disabled={frozen}>
        <div className="grid-2 fields-grid">
          <div className="field">
            <label htmlFor="token-name">Token name</label>
            <input
              id="token-name"
              value={draft.name}
              onChange={(event) => update('name', event.target.value)}
              placeholder="Your token name"
            />
            <small>Up to 32 UTF-8 bytes</small>
          </div>
          <div className="field">
            <label htmlFor="token-symbol">Symbol</label>
            <input
              id="token-symbol"
              value={draft.symbol}
              onChange={(event) => update('symbol', event.target.value)}
              placeholder="TOKEN"
            />
            <small>Up to 12 UTF-8 bytes</small>
          </div>
        </div>
        <div className="field">
          <label htmlFor="token-description">Description</label>
          <textarea
            id="token-description"
            value={draft.description}
            onChange={(event) => update('description', event.target.value)}
            rows={3}
          />
          <small>Up to 280 UTF-8 bytes</small>
        </div>
        <div className="field">
          <label htmlFor="hook-preset">Hook preset</label>
          <select
            id="hook-preset"
            value={draft.presetId}
            onChange={(event) => update('presetId', event.target.value)}
          >
            {(Array.isArray(config.presets) ? config.presets : []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <div className="preview-stat">
        <span>Total supply</span>
        <strong>{config.totalSupply}</strong>
      </div>
      <div className="preview-stat">
        <span>Pool fee</span>
        <strong>{config.poolFee / 10000}%</strong>
      </div>
      <div className="preview-stat">
        <span>Launch fee</span>
        <strong>{live ? `${formatUnits(live.launchFee, 18)} USDC + gas` : 'Unavailable'}</strong>
      </div>
      <div className="preview-stat">
        <span>Factory</span>
        <a
          className="break-value"
          href={explorerAddress(config.factory)}
          target="_blank"
          rel="noreferrer"
        >
          {config.factory}
        </a>
      </div>
      <div className="preview-stat">
        <span>Protocol treasury</span>
        <a
          className="break-value"
          href={explorerAddress(config.treasury)}
          target="_blank"
          rel="noreferrer"
        >
          {config.treasury}
        </a>
      </div>
      <p className="fine-print">
        This launch creates the token and its USDC pool with no initial purchase or free creator
        allocation. It does not approve token spending. Trading and additional launch options
        require their own completed integrations.
      </p>
      {live && (
        <p className="fine-print">
          Contract configuration checked at block {live.blockNumber.toString()}.
        </p>
      )}
      {review && !pending && (
        <div className="launch-review" role="status">
          <h3>Review your launch</h3>
          <p>
            {review.fields.name} · {review.fields.symbol} · {review.fields.preset.name}
          </p>
          <p className="wallet-address">From {review.request.account}</p>
          <p>
            Launch fee: {formatUnits(review.request.value, 18)} USDC. Estimated gas:{' '}
            {formatUnits(review.estimatedGas * review.gasPrice, 18)} USDC. Your wallet supplies the
            final gas fee.
          </p>
          <p className="fine-print">Simulation passed. No token has been deployed yet.</p>
        </div>
      )}
      {!pending && (
        <div className="launch-actions">
          {!wallet.account ? (
            <Button primary onClick={onConnect}>
              Connect wallet
            </Button>
          ) : wallet.chainId !== arc.id ? (
            <Button primary onClick={wallet.switchNetwork} disabled={wallet.busy}>
              Switch to Arc
            </Button>
          ) : review ? (
            <Button primary onClick={submit} disabled={frozen}>
              Confirm launch in wallet
            </Button>
          ) : (
            <Button primary onClick={prepare} disabled={!live || frozen}>
              {stage === 'preparing' ? 'Simulating launch…' : 'Review launch'}
            </Button>
          )}
          <Button onClick={refresh} disabled={frozen || stage === 'loading'}>
            Refresh contract settings
          </Button>
        </div>
      )}
      {stage === 'signing' && (
        <p role="status">Check your wallet to approve or decline the launch transaction.</p>
      )}
      {pending && (
        <div className="launch-receipt" aria-live="polite">
          <h3>{confirmed ? 'Launch confirmed' : 'Submitted transaction'}</h3>
          <a
            className="wallet-address text-link"
            href={`${arc.blockExplorers.default.url}/tx/${pending.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            {pending.hash}
          </a>
          {stage === 'confirming' && (
            <p>Waiting for two confirmations and checking the deployed token…</p>
          )}
          {!confirmed && stage !== 'confirming' && (
            <>
              <p>
                Submission alone does not confirm a launch. Check this transaction before sending
                another.
              </p>
              <Button onClick={() => checkReceipt(pending)}>Verify submitted transaction</Button>
            </>
          )}
          {confirmed && (
            <>
              <p>
                Token and hook registration verified at block {confirmed.blockNumber.toString()}.
              </p>
              <Link className="wallet-address text-link" to={`/token/${confirmed.token}`}>
                {confirmed.token}
              </Link>
              <Button onClick={startAnother}>Create another token</Button>
            </>
          )}
          {reverted && <Button onClick={startAnother}>Start a new launch</Button>}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {storageWarning && (
        <p className="form-error" role="alert">
          {storageWarning}
        </p>
      )}
      {wallet.error && (
        <p className="form-error" role="alert">
          {wallet.error}
        </p>
      )}
    </Glass>
  )
}
