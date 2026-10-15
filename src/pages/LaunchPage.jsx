import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ImagePlus, Plus, Trash2 } from 'lucide-react'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { useToast } from '../components/Toasts.jsx'
import { AllocationBar, Segmented, Spinner } from '../components/UI.jsx'
import HoloCard from '../components/HoloCard.jsx'
import { api } from '../lib/api.js'
import { MODULES, PRESETS, MAX_SPLITS, setAllocation } from '../lib/hooks.js'
import { bps, formatUnits, parseUnits, sol, toSol } from '../lib/format.js'
import { friendlyWalletError, packTransactions } from '../lib/solana.js'
import { platformFee } from '../lib/amounts.js'
import { useChargedPlatformFee } from '../lib/useChargedFee.js'
import {
  assertQuantumOpen,
  devBuyQuote,
  grindMint,
  launchTooLargeError,
  publishMetadata,
  reconcileLaunch,
  remainingLaunchGroups,
  uploadArtwork,
  MINT_SUFFIX,
} from '../lib/launch.js'
import {
  createSignature,
  hasProgress,
  launchComplete,
  launchSnapshot,
  needsRegister,
  newJob,
  pruneJobs,
  recordConfirmed,
  recordPending,
  registerOnce,
  saveJob,
  stagesPerTransaction,
} from '../lib/launchPlan.js'
import { explorer, isAddress } from '../../shared/network.mjs'
import Glass from '../components/Glass.jsx'

const DRAFT_KEY = 'quantpad:launch-draft:v1'
const EMPTY = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  website: '',
  twitter: '',
  telegram: '',
  mode: 'standard',
  hooks: { creatorBps: 3000, burnBps: 3000, entangleBps: 2000, fusionBps: 2000 },
  splits: [],
  lock: { enabled: false, bps: 5000, cliffDays: 7, durationDays: 90 },
  devBuy: '0.5',
  slippage: 2,
}
const bytes = (s) => new TextEncoder().encode(s).length
const storage = () => {
  try {
    return localStorage
  } catch {
    return null
  }
}

// Field error → the control that should take focus and carry aria-describedby.
const ERROR_TARGETS = [
  ['name', 'coin-name'],
  ['symbol', 'coin-symbol'],
  ['image', 'coin-art'],
  ['description', 'coin-description'],
  ['website', 'coin-website'],
  ['twitter', 'coin-twitter'],
  ['telegram', 'coin-telegram'],
  ['splits', 'split-wallet-0'],
  ['lock', 'lock-share'],
  ['devBuy', 'dev-buy'],
]
const errorId = (key) => `${key}-error`
// Props that tie a control to its error message.
const invalid = (errors, key) =>
  errors[key]
    ? { 'aria-invalid': true, 'aria-describedby': errorId(key) }
    : { 'aria-invalid': false }

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
  const { platform, quantum, lookupTable, dbcConfig } = usePlatform()
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
  const quantumPaused = quantumBlocked && !!quantum.paused
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
      devBuyQuote(devLamports, dbcConfig)
        .then((v) => live && setDevTokens(v))
        .catch(() => live && setDevTokens(0n))
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [devLamports, dbcConfig])

  const splitTotal = draft.splits.reduce((s, x) => s + Number(x.bps || 0), 0)
  // The balance check counts the full fee (a treasury funded before the launch is sent takes it);
  // the summary shows only a fee the launch transaction will actually carry.
  const fee = platformFee(devLamports || 0n, platform.treasury ? platform.feeBps : 0)
  const feeCharged = useChargedPlatformFee(platform, devLamports || 0n)
  const supplyPct = devTokens ? (Number(devTokens) / 1e15) * 100 : 0

  function validate() {
    const e = {}
    if (!draft.name.trim()) e.name = 'Give your coin a name.'
    else if (bytes(draft.name.trim()) > 32) e.name = 'Names are limited to 32 bytes on Meteora.'
    if (!draft.symbol.trim()) e.symbol = 'Choose a ticker.'
    else if (bytes(draft.symbol.trim()) > 10) e.symbol = 'Tickers are limited to 10 bytes.'
    if (draft.description.length > 500) e.description = 'Keep the description under 500 characters.'
    if (!draft.image) e.image = 'Add artwork for your coin.'
    for (const key of ['website', 'twitter', 'telegram'])
      if (draft[key] && !/^https?:\/\/\S+$/i.test(draft[key]))
        e[key] = 'Use a full link starting with https:// or http://'
    if (devLamports === null) e.devBuy = 'Enter a SOL amount, or 0 to skip the dev buy.'
    // The create + dev buy only fit in one transaction with the lookup table, and are never split.
    else if (devLamports > 0n && !lookupTable)
      e.devBuy =
        'A dev buy must land in the same transaction as the create, which needs the Quant Pad lookup table. This site has none configured, so set the dev buy to 0.'
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
    // The dev buy may cost up to its amount plus the slippage limit.
    const devBuyCap = devLamports
      ? devLamports + (devLamports * BigInt(Math.round(draft.slippage * 100))) / 10_000n
      : 0n
    if (
      !e.devBuy &&
      connected &&
      balance != null &&
      devLamports != null &&
      devBuyCap + fee + 40_000_000n > balance
    )
      e.devBuy =
        'Your wallet needs the dev buy, its slippage limit and about 0.04 SOL for fees and account rent.'
    setErrors(e)
    return e
  }

  // After a failed submit, move focus to the first invalid field, in form order.
  function focusFirstError(e) {
    const order = [
      ...ERROR_TARGETS.slice(0, 7),
      ...draft.splits.map((_, i) => [`split-${i}`, `split-wallet-${i}`]),
      ...ERROR_TARGETS.slice(7),
    ]
    const id = order.find(([key]) => e[key])?.[1]
    if (id) document.getElementById(id)?.focus()
  }

  const launchHooks = () =>
    quantumMode
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

  // A launch is a job: inputs frozen at the first submit, plus the stages that landed (persisted
  // per mint). "Finish the remaining steps" resumes the same job and never reads the form again.
  async function launch(resume = false) {
    if (!connected) return openDialog()
    if (!resume) {
      const found = validate()
      if (Object.keys(found).length) return focusFirstError(found)
    }
    setFailure(null)
    let job = resume ? pendingLaunch.current : null
    try {
      if (!job) {
        // check before publishing anything: a paused program would strand the metadata
        if (quantumMode) {
          setProgress('Checking that Quantum launches are open')
          await assertQuantumOpen()
        }
        setProgress('Publishing metadata')
        const uri = await publishMetadata(draft, draft.image)
        setProgress(`Finding a mint address ending in ${MINT_SUFFIX}`)
        const { keypair } = await grindMint()
        job = newJob({
          mint: keypair.publicKey.toBase58(),
          keypair,
          snapshot: launchSnapshot({
            launcher: address,
            name: draft.name.trim(),
            symbol: draft.symbol.trim(),
            uri,
            quantum: quantumMode,
            hooks: launchHooks(),
            devBuyLamports: devLamports || 0n,
            slippagePct: draft.slippage,
            platform,
            lookupTable,
            dbcConfig,
          }),
        })
        pendingLaunch.current = job
      } else if (job.snapshot.launcher !== address) {
        throw Object.assign(
          Error('Switch back to the wallet that started this launch to finish it.'),
          { friendly: true },
        )
      }
      if (resume) {
        setProgress('Checking what already landed')
        await reconcileLaunch(job)
        saveJob(storage(), job)
      }
      // register fails while Quantum Hooks is paused, and the status this page loaded can be a
      // minute old: read the config right before asking the wallet to sign.
      if (needsRegister(job)) {
        setProgress('Checking that Quantum launches are open')
        await assertQuantumOpen()
      }
      // One pass for a normal launch. A resume after the coin was created may take one pass for a
      // dev buy rebuilt from the live curve and one for a lock sized from the tokens received.
      for (let pass = 0; pass < 3 && !launchComplete(job); pass++) {
        setProgress('Building transactions')
        const plan = await remainingLaunchGroups(job)
        if (!plan.groups.length) break
        const { transactions, groupIndexes, lastValidBlockHeight } = await packTransactions(
          address,
          plan.groups,
          {
            units: 500_000,
            lookupTableAddresses: job.snapshot.lookupTable ? [job.snapshot.lookupTable] : [],
            requireLookupTables: true,
          },
        ).catch((e) => {
          throw launchTooLargeError(e, { devBuy: job.snapshot.devBuyLamports > 0n })
        })
        const txStages = stagesPerTransaction(groupIndexes, plan.stages)
        try {
          const signatures = await sendTransactions(transactions, {
            lastValidBlockHeight,
            signers: job.keypair ? [job.keypair] : [],
            onStatus: ({ phase, index, total }) =>
              setProgress(
                phase === 'sign'
                  ? `Approve ${total > 1 ? `${total} transactions` : 'the transaction'} in your wallet`
                  : `${phase === 'send' ? 'Sending' : 'Confirming'} ${total > 1 ? `${index + 1} of ${total}` : 'launch'}`,
              ),
          })
          recordConfirmed(job, txStages, signatures)
        } catch (err) {
          recordConfirmed(job, txStages, err.completed || [])
          recordPending(job, txStages, err)
          throw err
        } finally {
          saveJob(storage(), job)
        }
      }
      if (!launchComplete(job))
        throw Object.assign(Error('Some launch steps did not complete. Finish them to go live.'), {
          friendly: true,
        })
      setProgress('Indexing your coin')
      const registration = await registerOnce(job, { post: api, storage: storage() })
      pendingLaunch.current = null
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch {}
      toast({
        title: `${job.snapshot.symbol} is live`,
        body:
          registration.status === 'failed'
            ? 'Your coin is live on Meteora. Quant Pad is still indexing it.'
            : registration.status === 'capped'
              ? 'Your coin is live on Meteora. Quant Pad is not listing new launches right now.'
              : 'Your coin is live on Meteora.',
        tone: 'success',
        signature: createSignature(job) || undefined,
      })
      navigate(`/coin/${job.mint}`)
    } catch (err) {
      // The coin exists: register it now (with retries) even though a later step failed.
      if (job?.done.launch && !job.registered)
        registerOnce(job, { post: api, storage: storage() }).catch(() => {})
      setFailure({
        message: friendlyWalletError(err),
        // Resumable: something landed or may have, or a retryable error (the lookup table did not
        // load) before anything was sent, which the same job can simply retry.
        partial: hasProgress(job) || (!!job && !!err?.retryable),
        created: !!job?.done.launch,
        progressed: hasProgress(job),
        signature: err?.unknown ? err.failedSignature || err.signature : null,
      })
    } finally {
      setProgress(null)
    }
  }

  function discardLaunch() {
    pendingLaunch.current = null
    setFailure(null)
  }

  useEffect(() => pruneJobs(storage()), [])

  const preview = useMemo(
    () => ({ name: draft.name || 'Your coin', symbol: draft.symbol || 'TICKER' }),
    [draft.name, draft.symbol],
  )

  return (
    <div className="wrap launch">
      <header className="page-head">
        <h1>Launch a coin</h1>
        <p className="muted">
          Your coin launches on Meteora’s Dynamic Bonding Curve and graduates to a DAMM v2 pool with
          its liquidity locked. Wire it to Quantum Hooks and its creator fees follow the rules you
          set here, forever.
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
                id="coin-art"
                type="button"
                className={`art-drop ${errors.image ? 'art-drop-error' : ''}`}
                onClick={() => fileInput.current?.click()}
                aria-label={draft.image ? 'Replace artwork' : 'Upload artwork'}
                {...invalid(errors, 'image')}
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
                    {...invalid(errors, 'name')}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                  {errors.name && (
                    <span className="error-text" id={errorId('name')}>
                      {errors.name}
                    </span>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="coin-symbol">Ticker</label>
                  <input
                    id="coin-symbol"
                    className="input"
                    value={draft.symbol}
                    maxLength={12}
                    {...invalid(errors, 'symbol')}
                    onChange={(e) =>
                      set({ symbol: e.target.value.replace(/^\$/, '').toUpperCase() })
                    }
                  />
                  {errors.symbol && (
                    <span className="error-text" id={errorId('symbol')}>
                      {errors.symbol}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {errors.image && (
              <p className="error-text" id={errorId('image')}>
                {errors.image}
              </p>
            )}
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="coin-description">Description</label>
              <textarea
                id="coin-description"
                className="textarea"
                value={draft.description}
                maxLength={500}
                {...invalid(errors, 'description')}
                onChange={(e) => set({ description: e.target.value })}
              />
              <span className="hint">{draft.description.length}/500</span>
              {errors.description && (
                <span className="error-text" id={errorId('description')}>
                  {errors.description}
                </span>
              )}
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
                    {...invalid(errors, key)}
                    onChange={(e) => set({ [key]: e.target.value.trim() })}
                  />
                  {errors[key] && (
                    <span className="error-text" id={errorId(key)}>
                      {errors[key]}
                    </span>
                  )}
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
                ['standard', 'Standard Meteora'],
              ]}
            />
            {quantumBlocked && (
              <p className="notice notice-warn" style={{ marginTop: 14 }}>
                {quantumPaused
                  ? 'Quantum launches are paused right now. You can design your hooks now; to launch today, switch to a standard Meteora launch.'
                  : 'Quantum Hooks are not live on mainnet yet. You can design your hooks now; to launch today, switch to a standard Meteora launch.'}
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
                          aria-valuetext={bps(value)}
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
                        id={`split-wallet-${i}`}
                        className="input"
                        placeholder="Wallet address"
                        value={s.wallet}
                        aria-label={`Split wallet ${i + 1}`}
                        {...invalid(errors, `split-${i}`)}
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
                          {...invalid(errors, 'splits')}
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
                        <span className="error-text split-error" id={errorId(`split-${i}`)}>
                          {errors[`split-${i}`]}
                        </span>
                      )}
                    </div>
                  ))}
                  {errors.splits && (
                    <p className="error-text" id={errorId('splits')}>
                      {errors.splits}
                    </p>
                  )}
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
                            {...invalid(errors, 'lock')}
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
                            {...invalid(errors, 'lock')}
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
                            {...invalid(errors, 'lock')}
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
                  {errors.lock && (
                    <p className="error-text" id={errorId('lock')}>
                      {errors.lock}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <p className="muted" style={{ marginTop: 14 }}>
                A standard launch makes you the coin’s Meteora creator. You claim its creator fees
                yourself on Meteora and no hooks run.
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
                  {...invalid(errors, 'devBuy')}
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
              {errors.devBuy && (
                <span className="error-text" id={errorId('devBuy')}>
                  {errors.devBuy}
                </span>
              )}
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
          <HoloCard
            compact
            name={preview.name}
            symbol={preview.symbol}
            image={draft.image}
            quantum={wantsQuantum}
            hooks={draft.hooks}
          />
          <Glass variant="panel" className="panel launch-summary">
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
              <p className="muted summary-note">Standard Meteora launch. You are the creator.</p>
            )}
            <dl className="kv summary-costs">
              <dt>Dev buy</dt>
              <dd className="num">{sol(toSol(devLamports || 0n))}</dd>
              {feeCharged > 0n && (
                <>
                  <dt>Quant Pad fee ({bps(platform.feeBps)})</dt>
                  <dd className="num">{sol(toSol(feeCharged))}</dd>
                </>
              )}
              <dt>Network fees and rent</dt>
              <dd className="num">about {quantumMode ? '0.03' : '0.02'} SOL</dd>
            </dl>
            {failure && (
              <div className="notice notice-error" role="alert">
                <p>{failure.message}</p>
                {failure.signature && (
                  <p>
                    <a href={explorer.tx(failure.signature)} target="_blank" rel="noreferrer">
                      Check the transaction on Solscan
                    </a>
                  </p>
                )}
                {failure.partial && (
                  <>
                    <p className="faint">
                      {failure.created
                        ? 'Your coin is already live on Meteora. '
                        : failure.progressed
                          ? 'Part of this launch may already be on-chain. '
                          : ''}
                      Finishing uses the settings you started it with; edits to the form apply only
                      to a new launch.
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                      <button className="btn btn-sm" onClick={() => launch(true)}>
                        Finish the remaining steps
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={discardLaunch}>
                        Discard
                      </button>
                    </div>
                  </>
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
                quantumPaused ? (
                  'Quantum launches are paused'
                ) : (
                  'Quantum Hooks are not live yet'
                )
              ) : (
                `Launch ${draft.symbol ? '$' + draft.symbol : 'coin'}`
              )}
            </button>
            <p className="faint summary-note">
              You sign{' '}
              {quantumMode ? 'up to three transactions in one wallet prompt' : 'one transaction'}.
              Nothing is sent until you approve.
            </p>
          </Glass>
        </aside>
      </div>
    </div>
  )
}
