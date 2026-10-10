import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ImagePlus, Plus, Trash2 } from 'lucide-react'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { useToast } from '../components/Toasts.jsx'
import { AllocationBar, CoinAvatar, Segmented, Spinner } from '../components/UI.jsx'
import { api } from '../lib/api.js'
import { MODULES, PRESETS, MAX_SPLITS, setAllocation } from '../lib/hooks.js'
import { bps, formatUnits, parseUnits, sol, toSol } from '../lib/format.js'
import { friendlyWalletError, packTransactions } from '../lib/solana.js'
import {
  devBuyQuote,
  grindMint,
  launchInstructions,
  publishMetadata,
  uploadArtwork,
  MINT_SUFFIX,
} from '../lib/launch.js'
import { isAddress } from '../../shared/network.mjs'

const DRAFT_KEY = 'quantpad:launch-draft:v1'
const EMPTY = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  website: '',
  twitter: '',
  telegram: '',
  mode: 'quantum',
  hooks: { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 },
  splits: [],
  lock: { enabled: false, bps: 5000, cliffDays: 7, durationDays: 90 },
  devBuy: '0.5',
  slippage: 2,
}
const bytes = (s) => new TextEncoder().encode(s).length

function loadDraft() {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }
  } catch {
    return EMPTY
  }
}

export default function LaunchPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { connected, address, balance, openDialog, sendTransactions } = useWallet()
  const { platform, quantum, lookupTable } = usePlatform()
  const [draft, setDraft] = useState(loadDraft)
  const [uploading, setUploading] = useState(false)
  const [errors, setErrors] = useState({})
  const [progress, setProgress] = useState(null)
  const [failure, setFailure] = useState(null)
  const [devTokens, setDevTokens] = useState(0n)
  const pendingLaunch = useRef(null)
  const fileInput = useRef(null)

  const wantsQuantum = draft.mode === 'quantum'
  const quantumMode = wantsQuantum && quantum.available
  const quantumBlocked = wantsQuantum && !quantum.available
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {}
  }, [draft])

  const devLamports = parseUnits(draft.devBuy || '0', 9) ?? null
  useEffect(() => {
    let live = true
    if (!devLamports) return setDevTokens(0n)
    const t = setTimeout(() => {
      devBuyQuote(devLamports)
        .then((v) => live && setDevTokens(v))
        .catch(() => live && setDevTokens(0n))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [devLamports])

  const splitTotal = draft.splits.reduce((s, x) => s + Number(x.bps || 0), 0)
  const fee =
    platform.treasury && platform.feeBps && devLamports
      ? (devLamports * BigInt(platform.feeBps)) / 10_000n
      : 0n
  const supplyPct = devTokens ? (Number(devTokens) / 1e15) * 100 : 0

  function validate() {
    const e = {}
    if (!draft.name.trim()) e.name = 'Give your coin a name.'
    else if (bytes(draft.name.trim()) > 32) e.name = 'Names are limited to 32 bytes on pump.fun.'
    if (!draft.symbol.trim()) e.symbol = 'Choose a ticker.'
    else if (bytes(draft.symbol.trim()) > 10) e.symbol = 'Tickers are limited to 10 bytes.'
    if (draft.description.length > 500) e.description = 'Keep the description under 500 characters.'
    if (!draft.image) e.image = 'Add artwork for your coin.'
    for (const key of ['website', 'twitter', 'telegram'])
      if (draft[key] && !/^https?:\/\/\S+$/i.test(draft[key]))
        e[key] = 'Use a full link starting with https://'
    if (devLamports === null) e.devBuy = 'Enter a SOL amount, or 0 to skip the dev buy.'
    if (quantumMode) {
      draft.splits.forEach((s, i) => {
        if (!isAddress(s.wallet)) e[`split-${i}`] = 'Enter a valid Solana wallet address.'
        if (!(Number(s.bps) > 0)) e[`split-${i}`] = 'Give this wallet a share above 0%.'
      })
      if (splitTotal > 10000)
        e.splits = 'Superposition shares cannot exceed 100% of the creator share.'
      if (draft.lock.enabled) {
        if (!devLamports)
          e.lock = 'Time Dilation locks part of your dev buy. Add a dev buy or turn the lock off.'
        if (Number(draft.lock.cliffDays) > Number(draft.lock.durationDays))
          e.lock = 'The cliff must end before vesting finishes.'
        if (Number(draft.lock.durationDays) > 1460) e.lock = 'Vesting can last at most four years.'
      }
    }
    if (
      connected &&
      balance != null &&
      devLamports != null &&
      devLamports + fee + 40_000_000n > balance
    )
      e.devBuy = 'Your wallet needs the dev buy plus about 0.04 SOL for fees and account rent.'
    setErrors(e)
    return !Object.keys(e).length
  }

  async function onImage(file) {
    if (!file) return
    setUploading(true)
    setErrors((e) => ({ ...e, image: '' }))
    try {
      set({ image: await uploadArtwork(file) })
    } catch (err) {
      setErrors((e) => ({ ...e, image: err.message }))
    } finally {
      setUploading(false)
    }
  }

  async function launch(resume = false) {
    if (!connected) return openDialog()
    if (!resume && !validate()) return
    setFailure(null)
    try {
      let job = resume ? pendingLaunch.current : null
      if (!job) {
        setProgress('Publishing metadata')
        const uri = await publishMetadata(draft, draft.image)
        setProgress(`Finding a mint address ending in ${MINT_SUFFIX}`)
        const { keypair } = await grindMint()
        job = { uri, keypair, done: 0 }
        pendingLaunch.current = job
      }
      setProgress('Building transactions')
      const hooks = quantumMode
        ? {
            ...draft.hooks,
            splits: draft.splits.map((s) => ({ wallet: s.wallet, bps: Number(s.bps) })),
            lock:
              draft.lock.enabled && devLamports
                ? {
                    bps: Number(draft.lock.bps),
                    cliffSecs: Math.round(Number(draft.lock.cliffDays) * 86400),
                    durationSecs: Math.round(Number(draft.lock.durationDays) * 86400),
                  }
                : null,
          }
        : null
      const { groups } = await launchInstructions({
        launcher: address,
        mint: job.keypair.publicKey,
        name: draft.name.trim(),
        symbol: draft.symbol.trim(),
        uri: job.uri,
        quantum: quantumMode,
        hooks,
        devBuyLamports: devLamports || 0n,
        slippagePct: draft.slippage,
        platform,
      })
      const { transactions, lastValidBlockHeight } = await packTransactions(address, groups, {
        units: 500_000,
        lookupTableAddresses: lookupTable ? [lookupTable] : [],
      })
      const remaining = transactions.slice(job.done)
      const signatures = await sendTransactions(remaining, {
        lastValidBlockHeight,
        signers: [job.keypair],
        onStatus: ({ phase, index, total }) =>
          setProgress(
            phase === 'sign'
              ? `Approve ${total > 1 ? `${total} transactions` : 'the transaction'} in your wallet`
              : `${phase === 'send' ? 'Sending' : 'Confirming'} ${total > 1 ? `${index + 1} of ${total}` : 'launch'}`,
          ),
      }).catch((err) => {
        job.done += err.completed?.length || 0
        throw err
      })
      const mint = job.keypair.publicKey.toBase58()
      setProgress('Indexing your coin')
      const createSignature = signatures.at(-1)
      let registered = false
      for (const signature of [...signatures].reverse()) {
        try {
          await api('/api/launches', { signature })
          registered = true
          break
        } catch {}
      }
      if (!registered) await api('/api/coins/track', { mint }).catch(() => {})
      pendingLaunch.current = null
      localStorage.removeItem(DRAFT_KEY)
      toast({
        title: `${draft.symbol.trim()} is live`,
        body: 'Your coin is on pump.fun.',
        tone: 'success',
        signature: createSignature,
      })
      navigate(`/coin/${mint}`)
    } catch (err) {
      setFailure({ message: friendlyWalletError(err), partial: !!pendingLaunch.current?.done })
    } finally {
      setProgress(null)
    }
  }

  const preview = useMemo(
    () => ({ name: draft.name || 'Your coin', symbol: draft.symbol || 'TICKER' }),
    [draft.name, draft.symbol],
  )

  return (
    <div className="wrap launch">
      <header className="page-head">
        <h1>Launch a coin</h1>
        <p className="muted">
          Your coin is created on pump.fun. Wire it to Quantum Hooks and its creator fees follow the
          rules you set here, forever.
        </p>
      </header>

      <div className="launch-grid">
        <div className="launch-form">
          <section className="panel launch-section" aria-labelledby="coin-step">
            <h2 id="coin-step">
              <span className="step-index">1</span> Coin
            </h2>
            <div className="identity-row">
              <button
                type="button"
                className={`art-drop ${errors.image ? 'art-drop-error' : ''}`}
                onClick={() => fileInput.current?.click()}
                aria-label={draft.image ? 'Replace artwork' : 'Upload artwork'}
              >
                {uploading ? (
                  <Spinner />
                ) : draft.image ? (
                  <img src={draft.image} alt="" />
                ) : (
                  <ImagePlus size={28} />
                )}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(e) => onImage(e.target.files?.[0])}
              />
              <div className="identity-fields">
                <div className="field">
                  <label htmlFor="coin-name">Name</label>
                  <input
                    id="coin-name"
                    className="input"
                    value={draft.name}
                    maxLength={40}
                    aria-invalid={!!errors.name}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                  {errors.name && <span className="error-text">{errors.name}</span>}
                </div>
                <div className="field">
                  <label htmlFor="coin-symbol">Ticker</label>
                  <input
                    id="coin-symbol"
                    className="input"
                    value={draft.symbol}
                    maxLength={12}
                    aria-invalid={!!errors.symbol}
                    onChange={(e) =>
                      set({ symbol: e.target.value.replace(/^\$/, '').toUpperCase() })
                    }
                  />
                  {errors.symbol && <span className="error-text">{errors.symbol}</span>}
                </div>
              </div>
            </div>
            {errors.image && <p className="error-text">{errors.image}</p>}
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="coin-description">Description</label>
              <textarea
                id="coin-description"
                className="textarea"
                value={draft.description}
                maxLength={500}
                onChange={(e) => set({ description: e.target.value })}
              />
              <span className="hint">{draft.description.length}/500</span>
            </div>
            <div className="links-row">
              {[
                ['website', 'Website'],
                ['twitter', 'X (Twitter)'],
                ['telegram', 'Telegram'],
              ].map(([key, label]) => (
                <div className="field" key={key}>
                  <label htmlFor={`coin-${key}`}>{label}</label>
                  <input
                    id={`coin-${key}`}
                    className="input"
                    placeholder="https://"
                    value={draft[key]}
                    aria-invalid={!!errors[key]}
                    onChange={(e) => set({ [key]: e.target.value.trim() })}
                  />
                  {errors[key] && <span className="error-text">{errors[key]}</span>}
                </div>
              ))}
            </div>
          </section>

          <section className="panel launch-section" aria-labelledby="hooks-step">
            <h2 id="hooks-step">
              <span className="step-index">2</span> Quantum Hooks
            </h2>
            <Segmented
              label="Launch type"
              value={wantsQuantum ? 'quantum' : 'standard'}
              onChange={(mode) => set({ mode })}
              options={[
                ['quantum', 'Quantum launch'],
                ['standard', 'Standard pump.fun'],
              ]}
            />
            {quantumBlocked && (
              <p className="notice notice-warn" style={{ marginTop: 14 }}>
                Quantum Hooks are not live on mainnet yet. You can design your hooks now; to launch
                today, switch to a standard pump.fun launch.
              </p>
            )}
            {wantsQuantum ? (
              <>
                <p className="muted" style={{ margin: '14px 0' }}>
                  Every pulse of creator fees is split this way
                  {quantum.protocolBps
                    ? ` after the ${bps(quantum.protocolBps)} Quant Pad protocol share`
                    : ''}
                  . These rules are locked at launch.
                </p>
                <div className="preset-row">
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="btn btn-sm"
                      onClick={() => set({ hooks: p.hooks })}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="sliders">
                  {MODULES.map((m) => {
                    const value = draft.hooks[m.key]
                    return (
                      <div className="slider-row" key={m.key} style={{ '--c': m.color }}>
                        <label htmlFor={`hook-${m.key}`}>
                          <strong>{m.name}</strong>
                          <span className="faint">{m.short}</span>
                        </label>
                        <input
                          id={`hook-${m.key}`}
                          type="range"
                          className="range"
                          min={0}
                          max={10000}
                          step={100}
                          value={value}
                          style={{ '--p': `${value / 100}%` }}
                          onChange={(e) =>
                            set({ hooks: setAllocation(draft.hooks, m.key, e.target.value) })
                          }
                        />
                        <span className="num slider-value">{bps(value)}</span>
                      </div>
                    )
                  })}
                </div>

                <div className="sub-section">
                  <h3>Superposition</h3>
                  <p className="faint">
                    Send part of the creator share to up to four more wallets.
                  </p>
                  {draft.splits.map((s, i) => (
                    <div className="split-row" key={i}>
                      <input
                        className="input"
                        placeholder="Wallet address"
                        value={s.wallet}
                        aria-label={`Split wallet ${i + 1}`}
                        aria-invalid={!!errors[`split-${i}`]}
                        onChange={(e) =>
                          set({
                            splits: draft.splits.map((x, j) =>
                              j === i ? { ...x, wallet: e.target.value.trim() } : x,
                            ),
                          })
                        }
                      />
                      <div className="input-affix split-share">
                        <input
                          className="input num"
                          inputMode="decimal"
                          aria-label={`Share for wallet ${i + 1}`}
                          value={Number(s.bps) / 100}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(100, Number(e.target.value) || 0))
                            set({
                              splits: draft.splits.map((x, j) =>
                                j === i ? { ...x, bps: Math.round(v * 100) } : x,
                              ),
                            })
                          }}
                        />
                        <span className="affix">%</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost icon-btn"
                        aria-label={`Remove wallet ${i + 1}`}
                        onClick={() => set({ splits: draft.splits.filter((_, j) => j !== i) })}
                      >
                        <Trash2 size={16} />
                      </button>
                      {errors[`split-${i}`] && (
                        <span className="error-text split-error">{errors[`split-${i}`]}</span>
                      )}
                    </div>
                  ))}
                  {errors.splits && <p className="error-text">{errors.splits}</p>}
                  {draft.splits.length < MAX_SPLITS && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => set({ splits: [...draft.splits, { wallet: '', bps: 2500 }] })}
                    >
                      <Plus size={14} /> Add wallet
                    </button>
                  )}
                </div>

                <div className="sub-section">
                  <h3>Time Dilation</h3>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={draft.lock.enabled}
                      onChange={(e) => set({ lock: { ...draft.lock, enabled: e.target.checked } })}
                    />
                    <span>Lock part of my dev buy and vest it over time</span>
                  </label>
                  {draft.lock.enabled && (
                    <div className="lock-grid">
                      <div className="field">
                        <label htmlFor="lock-share">Share of dev buy</label>
                        <div className="input-affix">
                          <input
                            id="lock-share"
                            className="input num"
                            inputMode="decimal"
                            value={Number(draft.lock.bps) / 100}
                            onChange={(e) =>
                              set({
                                lock: {
                                  ...draft.lock,
                                  bps: Math.round(
                                    Math.max(1, Math.min(100, Number(e.target.value) || 0)) * 100,
                                  ),
                                },
                              })
                            }
                          />
                          <span className="affix">%</span>
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="lock-cliff">Cliff</label>
                        <div className="input-affix">
                          <input
                            id="lock-cliff"
                            className="input num"
                            inputMode="numeric"
                            value={draft.lock.cliffDays}
                            onChange={(e) =>
                              set({
                                lock: {
                                  ...draft.lock,
                                  cliffDays: e.target.value.replace(/\D/g, ''),
                                },
                              })
                            }
                          />
                          <span className="affix">days</span>
                        </div>
                      </div>
                      <div className="field">
                        <label htmlFor="lock-duration">Fully vested after</label>
                        <div className="input-affix">
                          <input
                            id="lock-duration"
                            className="input num"
                            inputMode="numeric"
                            value={draft.lock.durationDays}
                            onChange={(e) =>
                              set({
                                lock: {
                                  ...draft.lock,
                                  durationDays: e.target.value.replace(/\D/g, ''),
                                },
                              })
                            }
                          />
                          <span className="affix">days</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {errors.lock && <p className="error-text">{errors.lock}</p>}
                </div>
              </>
            ) : (
              <p className="muted" style={{ marginTop: 14 }}>
                A standard launch makes you the pump.fun creator. You collect creator fees yourself
                on pump.fun and no hooks run.
              </p>
            )}
          </section>

          <section className="panel launch-section" aria-labelledby="buy-step">
            <h2 id="buy-step">
              <span className="step-index">3</span> Dev buy
            </h2>
            <p className="muted">
              Buy your own coin in the same transaction that creates it, before anyone else can. Use
              0 to skip.
            </p>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="dev-buy">Amount</label>
              <div className="input-affix">
                <input
                  id="dev-buy"
                  className="input num"
                  inputMode="decimal"
                  value={draft.devBuy}
                  aria-invalid={!!errors.devBuy}
                  onChange={(e) => set({ devBuy: e.target.value.replace(',', '.') })}
                />
                <span className="affix">SOL</span>
              </div>
              <div className="ticket-presets">
                {['0', '0.25', '0.5', '1', '2'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-sm"
                    onClick={() => set({ devBuy: p })}
                  >
                    {p === '0' ? 'None' : `${p} SOL`}
                  </button>
                ))}
              </div>
              {errors.devBuy && <span className="error-text">{errors.devBuy}</span>}
              {devTokens > 0n && (
                <span className="hint">
                  About {formatUnits(devTokens, 6, 0)} {preview.symbol} ({supplyPct.toFixed(2)}% of
                  supply)
                </span>
              )}
            </div>
            <div className="field">
              <span className="label">Slippage limit</span>
              <Segmented
                label="Slippage"
                value={draft.slippage}
                onChange={(slippage) => set({ slippage })}
                options={[
                  [1, '1%'],
                  [2, '2%'],
                  [5, '5%'],
                ]}
              />
            </div>
          </section>
        </div>

        <aside className="launch-aside">
          <div className="panel launch-summary">
            <div className="summary-id">
              <CoinAvatar src={draft.image} symbol={preview.symbol} size={56} />
              <div>
                <strong>{preview.name}</strong>
                <span className="muted">${preview.symbol}</span>
              </div>
            </div>
            {wantsQuantum ? (
              <>
                <h3 className="summary-label">Fee routing</h3>
                <AllocationBar hooks={draft.hooks} />
                {draft.splits.length > 0 && (
                  <p className="faint summary-note">
                    Superposition sends {bps(splitTotal)} of the creator share to{' '}
                    {draft.splits.length} wallet
                    {draft.splits.length > 1 ? 's' : ''}.
                  </p>
                )}
                {draft.lock.enabled && devTokens > 0n && (
                  <p className="faint summary-note">
                    Time Dilation locks{' '}
                    {formatUnits((devTokens * BigInt(draft.lock.bps)) / 10000n, 6, 0)}{' '}
                    {preview.symbol}, vesting over {draft.lock.durationDays} days after a{' '}
                    {draft.lock.cliffDays}-day cliff.
                  </p>
                )}
              </>
            ) : (
              <p className="muted summary-note">Standard pump.fun launch. You are the creator.</p>
            )}
            <dl className="kv summary-costs">
              <dt>Dev buy</dt>
              <dd className="num">{sol(toSol(devLamports || 0n))}</dd>
              {fee > 0n && (
                <>
                  <dt>Quant Pad fee ({bps(platform.feeBps)})</dt>
                  <dd className="num">{sol(toSol(fee))}</dd>
                </>
              )}
              <dt>Network fees and rent</dt>
              <dd className="num">about {quantumMode ? '0.03' : '0.02'} SOL</dd>
            </dl>
            {failure && (
              <div className="notice notice-error" role="alert">
                <p>{failure.message}</p>
                {failure.partial && (
                  <button
                    className="btn btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => launch(true)}
                  >
                    Finish the remaining steps
                  </button>
                )}
              </div>
            )}
            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={!!progress || uploading || (connected && quantumBlocked)}
              onClick={() => launch(false)}
            >
              {progress ? (
                <>
                  <Spinner /> {progress}
                </>
              ) : !connected ? (
                'Connect wallet to launch'
              ) : quantumBlocked ? (
                'Quantum Hooks are not live yet'
              ) : (
                `Launch ${draft.symbol ? '$' + draft.symbol : 'coin'}`
              )}
            </button>
            <p className="faint summary-note">
              You sign{' '}
              {quantumMode ? 'up to three transactions in one wallet prompt' : 'one transaction'}.
              Nothing is sent until you approve.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
