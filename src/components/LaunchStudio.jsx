import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { ArrowRight, ArrowLeft, Check, FlaskConical, LockKeyhole } from 'lucide-react'
import { formatUnits, toHex } from 'viem'
import Glass from './Glass'
import { Button } from './UI'
import TransactionStatus from './TransactionStatus'
import { usePlatform } from '../context/PlatformContext'
import { useWallet } from '../context/WalletContext'
import { api, number, short } from '../lib/api'
import {
  abis,
  approval,
  amount,
  balances,
  eventFrom,
  launchParams,
  minimum,
  read,
  same,
  send,
  simulate,
  validateDraft,
  verifyDeployment,
  transactionIdentity,
} from '../lib/protocol'
import { useTransaction } from '../lib/useTransaction'
import { readableError } from '../lib/chain'
import { draftKey, stepKey, legacyStepKey, restoreDraft, restoreStep } from '../lib/launchDraft'

import { PoolStep, HookStep, TokenStep, PayoutStep, ReviewStep } from './LaunchSteps'
import './launch-flow.css'

const steps = ['Pool', 'Hook', 'Token', 'Payouts', 'Review']
export { Field, Metric } from './StudioFields'
export default function LaunchStudio() {
  const location = useLocation()
  const resumeReview = location.state?.resumeLaunchReview === true
  const entryKey = useRef(location.key)
  const [draft, setDraft] = useState(restoreDraft),
    [step, setStep] = useState(() => restoreStep(draft, { resumeReview })),
    [error, setError] = useState(''),
    [uploading, setUploading] = useState(false),
    [estimate, setEstimate] = useState(null),
    [checking, setChecking] = useState(false)
  const platform = usePlatform(),
    wallet = useWallet(),
    { onConnect } = useOutletContext(),
    navigate = useNavigate()
  const deployment = platform.deployment,
    revision = useRef(0),
    editor = useRef(null)
  const tx = useTransaction('launch', async (receipt, record) => {
    if (record.kind === 'approval') {
      setEstimate(null)
      return
    }
    const e = eventFrom(receipt, record.factory, abis.HookbrewFactory, 'TokenLaunched')
    if (!same(e.creator, record.account) || !same(e.token, record.token))
      throw Error('Receipt does not match your reviewed launch.')
    await api('/api/sync', {}).catch(() => {})
    try {
      localStorage.removeItem(draftKey)
      localStorage.removeItem(stepKey)
      localStorage.removeItem(legacyStepKey)
    } catch {}
    navigate(`/token/${e.token}?launched=${receipt.transactionHash}`)
  })
  const locked = tx.busy || !!tx.pending
  useLayoutEffect(() => {
    if (entryKey.current === location.key) return
    entryKey.current = location.key
    // Clicking Create again is a new entry, without interrupting a submitted transaction.
    if (!locked) {
      setStep(restoreStep(draft, { resumeReview }))
      setError('')
      setEstimate(null)
    }
  }, [location.key, resumeReview, draft, locked])
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft))
    } catch {}
  }, [draft])
  useEffect(() => {
    revision.current++
    setEstimate(null)
  }, [draft, wallet.account, wallet.chainId, deployment])
  const update = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setError('')
  }
  const input = (key, props = {}) => (
    <input value={draft[key]} onChange={(e) => update(key, e.target.value)} {...props} />
  )
  function go(next) {
    try {
      if (next > step) validateDraft(draft, next - 1)
      setError('')
      setStep(next)
      editor.current?.focus()
    } catch (e) {
      setError(e.message)
    }
  }
  async function upload(file) {
    if (!file) return
    setUploading(true)
    setError('')
    try {
      if (file.size > 1500000) throw Error('Choose a PNG, JPEG or WebP under 1.5 MB.')
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const { url } = await api('/api/media', { data })
      update('image', url)
    } catch (e) {
      setError(readableError(e))
    } finally {
      setUploading(false)
    }
  }
  async function inspect() {
    setChecking(true)
    setError('')
    setEstimate(null)
    const version = revision.current
    try {
      validateDraft(draft)
      await currentDeployment()
      await verifyDeployment(deployment)
      if (!wallet.account) throw Error('Connect a wallet to simulate your launch.')
      const initialBuy = Number(draft.initialBuy) ? amount(draft.initialBuy) : 0n
      if (initialBuy) {
        const funds = await balances(deployment, null, wallet.account, deployment.factory)
        if (funds.balance < initialBuy)
          throw Error(
            'Insufficient USDC for the founder buy. Keep additional USDC available for the launch fee and gas.',
          )
        if (funds.allowance < initialBuy) {
          if (version === revision.current) setEstimate({ needsApproval: true, value: initialBuy })
          return
        }
      }
      const { uri } = await api('/api/metadata', {
        name: draft.name.trim(),
        symbol: draft.symbol.trim(),
        description: draft.description,
        image: draft.image,
        website: draft.website,
        twitter: draft.twitter,
        telegram: draft.telegram,
      })
      if (!uri.startsWith('https://'))
        throw Error(
          'Set HOOKBREW_PUBLIC_URL to your public HTTPS host before a live launch, so token metadata remains accessible.',
        )
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const params = launchParams(draft, uri, salt, 0n, wallet.account)
      const value = await read(deployment.factory, abis.HookbrewFactory, 'launchFee')
      const request = {
        address: deployment.factory,
        abi: abis.HookbrewFactory,
        functionName: 'launch',
        args: [params],
        value,
      }
      const first = await simulate(wallet, request)
      params.minTokensOut = minimum(first.result[1], draft.slippage)
      const checked = await simulate(wallet, { ...request, args: [params] })
      if (version === revision.current)
        setEstimate({
          request: checked.request,
          token: checked.result[0],
          bought: checked.result[1],
          gasCost: checked.gasCost,
          launchFee: value,
          at: Date.now(),
          version,
        })
    } catch (e) {
      if (version === revision.current) setError(readableError(e))
    } finally {
      setChecking(false)
    }
  }
  async function currentDeployment() {
    const current = await platform.refresh()
    if (!current)
      throw Error(
        'Could not verify launch availability. Your draft is saved. Retry status before signing.',
      )
    if (current.storage?.ready === false) throw Error(current.storage.error)
    if (
      !current.deployment ||
      !same(current.deployment.factory, deployment?.factory) ||
      !same(current.deployment.router, deployment?.router)
    )
      throw Error(
        'The active deployment changed. Your draft is saved; refresh the simulation before signing.',
      )
  }
  async function approve() {
    await tx.run(async (status) => {
      await currentDeployment()
      await verifyDeployment(deployment)
      const request = approval(deployment.quote, deployment.factory, estimate.value)
      const checked = await simulate(wallet, request)
      status('Approve the exact founder-buy amount in your wallet.')
      const hash = await send(wallet, checked.request)
      return { hash, kind: 'approval', ...transactionIdentity(wallet, request) }
    })
  }
  async function launch() {
    await tx.run(async (status) => {
      if (
        !estimate?.request ||
        estimate.version !== revision.current ||
        Date.now() - estimate.at > 60000
      )
        throw Error('Refresh the launch simulation before confirming.')
      await currentDeployment()
      await verifyDeployment(deployment)
      const checked = await simulate(wallet, estimate.request)
      if (!same(checked.result[0], estimate.token))
        throw Error('Predicted token changed. Review again.')
      status('Confirm the launch in your wallet.')
      const hash = await send(wallet, checked.request)
      return {
        hash,
        kind: 'launch',
        factory: deployment.factory,
        token: estimate.token,
        ...transactionIdentity(wallet, estimate.request),
      }
    })
  }
  return (
    <div className="launch-flow">
      <Glass className="studio-editor launch-panel" radius={26}>
        <header className="launch-header">
          <div className="launch-title-row">
            <span className="eyebrow">THE HOOKBREW LAUNCH STUDIO</span>
            <span className="product-badge">
              <span className="status-dot" />
              Arc · V4
            </span>
          </div>
          <h1>
            Launch a <span>token.</span>
          </h1>
          <p>
            A fixed supply. A market from day one. Choose your pool, shape the hook, and make it
            yours. Your seed liquidity stays permanently locked.
          </p>
        </header>
        <nav className="launch-steps" aria-label="Launch steps">
          {steps.map((label, i) => (
            <button
              key={label}
              disabled={locked || checking || uploading || i > step + 1}
              onClick={() => go(i)}
              aria-current={i === step ? 'step' : undefined}
              data-complete={i < step}
            >
              <span>{i < step ? <Check size={13} /> : i + 1}</span>
              <strong>{label}</strong>
            </button>
          ))}
        </nav>
        <div className="studio-section-heading" tabIndex={-1} ref={editor}>
          <h2>{['The pool', 'Your hook', 'Your token', 'Your cut', 'Review your launch'][step]}</h2>
          <p>
            {
              [
                'Set your token’s pair, starting valuation, and trading fee.',
                'Choose the rules that sit on top of your pool’s base economics.',
                'Give your token an identity your community can recognize.',
                'Buy your founder allocation, then decide where tokens and fees go.',
                'One final look. Check every detail before signing in your wallet.',
              ][step]
            }
          </p>
        </div>
        <fieldset disabled={locked || checking} className="studio-fields">
          {step === 0 && <PoolStep draft={draft} input={input} update={update} />}
          {step === 1 && <HookStep draft={draft} input={input} update={update} />}
          {step === 2 && (
            <TokenStep
              draft={draft}
              input={input}
              update={update}
              upload={upload}
              uploading={uploading}
            />
          )}
          {step === 3 && <PayoutStep draft={draft} input={input} update={update} wallet={wallet} />}
          {step === 4 && (
            <>
              <ReviewStep draft={draft} platform={platform} wallet={wallet} go={go} />
              {platform.loading || platform.error || platform.storage?.ready === false ? (
                <div className="product-note" role={platform.loading ? 'status' : 'alert'}>
                  <div>
                    <h3>
                      {platform.loading
                        ? 'Checking launch availability…'
                        : 'Launch temporarily unavailable'}
                    </h3>
                    <p>
                      {platform.error ||
                        platform.storage?.error ||
                        'Checking the active contracts before continuing.'}
                    </p>
                    <p>Your token draft and review step are saved.</p>
                    {!platform.loading && <Button onClick={platform.refresh}>Retry status</Button>}
                  </div>
                </div>
              ) : !deployment ? (
                <div className="product-note">
                  <FlaskConical size={23} />
                  <div>
                    <h3>Activate your Hookbrew contracts</h3>
                    <p>
                      Your draft is saved. Deploy the new factory and router with your treasury to
                      open live launches.
                    </p>
                    <Button to="/setup?returnTo=launch">
                      Open deployment setup <ArrowRight size={16} />
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="fine-print">
                    One USDC balance covers the founder buy, launch fee, and gas. Contract
                    simulation checks the combined cost before signing.
                  </p>
                  {!wallet.account ? (
                    <Button primary onClick={onConnect}>
                      Connect wallet to review
                    </Button>
                  ) : wallet.chainId !== 5042 ? (
                    <Button primary onClick={wallet.switchNetwork}>
                      Switch to Arc
                    </Button>
                  ) : (
                    <Button onClick={inspect} disabled={checking || locked}>
                      {checking ? 'Simulating…' : 'Simulate launch & refresh costs'}
                    </Button>
                  )}
                  {estimate?.needsApproval && (
                    <div className="product-note">
                      <div>
                        <p>
                          Approve exactly {formatUnits(estimate.value, 6)} ERC20 USDC for the
                          Hookbrew factory, then simulate again.
                        </p>
                        <Button primary onClick={approve} disabled={locked}>
                          Approve founder buy
                        </Button>
                      </div>
                    </div>
                  )}
                  {estimate?.request && (
                    <>
                      <div className="review-list">
                        <div>
                          <span>Launch fee</span>
                          <strong>{formatUnits(estimate.launchFee, 18)} native USDC</strong>
                        </div>
                        <div>
                          <span>Estimated network fee</span>
                          <strong>
                            {number(formatUnits(estimate.gasCost, 18), 6)} native USDC
                          </strong>
                        </div>
                        <div>
                          <span>Founder tokens received</span>
                          <strong>
                            {number(formatUnits(estimate.bought, 18), 2)} {draft.symbol}
                          </strong>
                        </div>
                        <div>
                          <span>Predicted contract</span>
                          <strong>{short(estimate.token)}</strong>
                        </div>
                      </div>
                      <Button primary className="full-width" onClick={launch} disabled={locked}>
                        Confirm & launch token <ArrowRight size={17} />
                      </Button>
                      <p className="fine-print">
                        Simulation expires after 60 seconds. Your wallet signs the exact reviewed
                        call. New Hookbrew contracts have not had an independent security audit.
                      </p>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </fieldset>
        {uploading && <p role="status">Uploading artwork…</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <TransactionStatus tx={tx} />
        <div className="studio-navigation launch-navigation">
          {step > 0 && (
            <Button disabled={locked || checking || uploading} onClick={() => go(step - 1)}>
              <ArrowLeft size={15} />
              Back
            </Button>
          )}
          {step < 4 && (
            <Button
              primary
              className="launch-continue"
              disabled={locked || checking || uploading}
              onClick={() => go(step + 1)}
            >
              {step === 3 ? 'Review launch' : 'Continue'}
              <ArrowRight size={16} />
            </Button>
          )}
          {step === 4 && (
            <span>
              <LockKeyhole size={13} /> You confirm every transaction in your wallet
            </span>
          )}
        </div>
      </Glass>
      <p className="launch-draft-status">
        <Check size={13} /> Draft saved on this device<span>Step {step + 1} of 5</span>
      </p>
    </div>
  )
}
