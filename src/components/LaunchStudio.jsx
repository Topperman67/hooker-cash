import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react'
import { useNavigate, useOutletContext, Link } from 'react-router-dom'
import { ArrowRight, Check, FlaskConical, ImagePlus, Plus, Shield, Trash2 } from 'lucide-react'
import { formatUnits, toHex } from 'viem'
import Glass from './Glass'
import { Button, PageHeading } from './UI'
import TransactionStatus from './TransactionStatus'
import { usePlatform } from '../context/PlatformContext'
import { useWallet } from '../context/WalletContext'
import { api, number, short, safeLink } from '../lib/api'
import {
  abis,
  approval,
  amount,
  balances,
  defaultDraft,
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

const steps = ['Identity', 'Pool & supply', 'Launch rules', 'Recipients', 'Review & launch']
const draftKey = 'hookbrew:launch-draft:v1'
function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey))
    return { ...defaultDraft, ...saved, splits: Array.isArray(saved?.splits) ? saved.splits : [] }
  } catch {
    return { ...defaultDraft }
  }
}
export function Field({ label, hint, children }) {
  const id = useId()
  return (
    <div className="studio-field">
      <span id={id}>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) && ['input', 'textarea', 'select'].includes(child.type)
          ? cloneElement(child, {
              'aria-labelledby': child.props['aria-label'] ? undefined : id,
              'aria-describedby': hint ? `${id}-hint` : undefined,
            })
          : child,
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  )
}
export function Metric({ label, value }) {
  return (
    <div className="product-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
export default function LaunchStudio() {
  const [draft, setDraft] = useState(initial),
    [step, setStep] = useState(0),
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
    localStorage.removeItem(draftKey)
    navigate(`/token/${e.token}?launched=${receipt.transactionHash}`)
  })
  const locked = tx.busy || !!tx.pending
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
  const splitUpdate = (i, key, value) =>
    update(
      'splits',
      draft.splits.map((s, n) => (n === i ? { ...s, [key]: value } : s)),
    )
  function go(next) {
    try {
      if (next > step) validateDraft(draft, step)
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
      const params = launchParams(draft, uri, salt)
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
  async function approve() {
    await tx.run(async (status) => {
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
    <>
      <PageHeading
        title="Something new is brewing."
        description="Build your token. Shape its launch. Give it a market of its own."
        action={
          <span className="product-badge">
            <span className="status-dot" /> Arc · Uniswap V4
          </span>
        }
      />
      <div className="studio-layout">
        <div className="studio-main">
          <nav className="studio-steps" aria-label="Launch steps">
            {steps.map((label, i) => (
              <button
                key={label}
                disabled={locked || checking || uploading || i > step + 1}
                onClick={() => go(i)}
                aria-current={i === step ? 'step' : undefined}
              >
                <span>{i < step ? <Check size={15} /> : `0${i + 1}`}</span>
                <strong>{label}</strong>
              </button>
            ))}
          </nav>
          <Glass className="studio-editor" radius={26}>
            <div className="studio-section-heading" tabIndex={-1} ref={editor}>
              <span className="eyebrow">THE LAUNCH STUDIO / 0{step + 1}</span>
              <h2>
                {
                  [
                    'Make your first impression.',
                    'Set the opening conditions.',
                    'A fair start, by design.',
                    'Share what you build.',
                    'Ready for the first pour?',
                  ][step]
                }
              </h2>
              <p>
                {
                  [
                    'Give your token an identity people will remember.',
                    'Every token starts with a fixed supply and its own USDC market.',
                    'Choose how trading opens. Rules expire automatically on-chain.',
                    'Route creator fees and your founder allocation to the right wallets.',
                    'Review the economics, simulate the exact transaction, then sign in your wallet.',
                  ][step]
                }
              </p>
            </div>
            <fieldset disabled={locked || checking} className="studio-fields">
              {step === 0 && (
                <>
                  <div className="studio-brand-row">
                    <div className="studio-upload-preview">
                      {draft.image ? (
                        <img src={safeLink(draft.image)} alt="Token artwork preview" />
                      ) : (
                        <ImagePlus size={30} />
                      )}
                    </div>
                    <Field label="Token artwork" hint="PNG, JPG or WebP · up to 1.5 MB">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={uploading}
                        onChange={(e) => upload(e.target.files?.[0])}
                      />
                    </Field>
                    {draft.image && <Button onClick={() => update('image', '')}>Remove</Button>}
                  </div>
                  <div className="product-grid-2">
                    <Field label="Token name" hint="Up to 32 UTF-8 bytes">
                      {input('name', {
                        placeholder: 'e.g. Moon Milk',
                        autoComplete: 'off',
                        maxLength: 32,
                      })}
                    </Field>
                    <Field label="Ticker symbol" hint="Up to 12 UTF-8 bytes">
                      {input('symbol', {
                        placeholder: 'e.g. MILK',
                        autoComplete: 'off',
                        maxLength: 12,
                      })}
                    </Field>
                  </div>
                  <Field
                    label="The story"
                    hint={`${draft.description.length}/280 characters · optional`}
                  >
                    <textarea
                      value={draft.description}
                      onChange={(e) => update('description', e.target.value)}
                      maxLength={280}
                      rows={3}
                      placeholder="What are you brewing?"
                    />
                  </Field>
                  <Field label="Website" hint="Optional">
                    {input('website', { type: 'url', placeholder: 'https://your-project.com' })}
                  </Field>
                  <div className="product-grid-2">
                    <Field label="X / Twitter">
                      {input('twitter', { type: 'url', placeholder: 'https://x.com/yourproject' })}
                    </Field>
                    <Field label="Telegram">
                      {input('telegram', { type: 'url', placeholder: 'https://t.me/yourproject' })}
                    </Field>
                  </div>
                </>
              )}
              {step === 1 && (
                <>
                  <div className="product-grid-2 studio-facts">
                    <Metric label="TOTAL SUPPLY" value="1,000,000,000" />
                    <Metric label="QUOTE ASSET" value="USDC on Arc" />
                  </div>
                  <Field
                    label="Pool trading fee"
                    hint="Charged on each swap. 70% of seed-position fees goes to your recipients; 30% to the Hookbrew treasury."
                  >
                    <div className="choice-row">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          aria-pressed={Number(draft.fee) === n * 10000}
                          onClick={() => update('fee', String(n * 10000))}
                        >
                          {n}%
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field
                    label="Opening market cap · USDC"
                    hint="2,000–10,000 USDC. The actual starting price rounds to a V4 tick; this is a valuation, not money raised."
                  >
                    {input('targetMcap', { type: 'number', min: 2000, max: 10000, step: 100 })}
                    <input
                      aria-label="Opening valuation slider"
                      type="range"
                      min="2000"
                      max="10000"
                      step="100"
                      value={draft.targetMcap}
                      onChange={(e) => update('targetMcap', e.target.value)}
                    />
                  </Field>
                  <div className="product-grid-2">
                    <Field
                      label="Founder buy · USDC"
                      hint="Optional. Purchased at launch and capped on-chain at 10% of supply."
                    >
                      {input('initialBuy', { inputMode: 'decimal', placeholder: '0.00' })}
                    </Field>
                    <Field
                      label="Slippage tolerance · %"
                      hint="Applies to the founder buy. 0.1–10%."
                    >
                      {input('slippage', { type: 'number', min: 0.1, max: 10, step: 0.1 })}
                    </Field>
                  </div>
                  <div className="product-note">
                    <Shield size={19} />
                    <p>
                      The entire supply seeds the pool. Hookbrew’s seed liquidity has no withdrawal
                      function. There is no token mint, freeze, or transfer-tax control.
                    </p>
                  </div>
                </>
              )}
              {step === 2 && (
                <>
                  <div className="rule-choices">
                    <button
                      type="button"
                      aria-pressed={draft.guarded}
                      onClick={() => update('guarded', true)}
                    >
                      <Shield size={24} />
                      <strong>Guarded opening</strong>
                      <span>Temporary buy caps that relax over time.</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={!draft.guarded}
                      onClick={() => update('guarded', false)}
                    >
                      <FlaskConical size={24} />
                      <strong>Open market</strong>
                      <span>Trading opens immediately without a buy cap.</span>
                    </button>
                  </div>
                  {draft.guarded && (
                    <div className="product-grid-2">
                      <Field label="Guard duration · seconds" hint="Up to one hour">
                        {input('window', { type: 'number', min: 1, max: 3600 })}
                      </Field>
                      <Field
                        label="Global buy spacing · seconds"
                        hint="0 disables spacing; up to 60 seconds"
                      >
                        {input('interval', { type: 'number', min: 0, max: 60 })}
                      </Field>
                      <Field
                        label="Starting buy cap · %"
                        hint="Percent of virtual USDC reserves per swap"
                      >
                        {input('startCap', { type: 'number', min: 0.01, max: 50, step: 0.01 })}
                      </Field>
                      <Field label="Ending buy cap · %" hint="Ramps linearly from the starting cap">
                        {input('endCap', { type: 'number', min: 0.01, max: 50, step: 0.01 })}
                      </Field>
                    </div>
                  )}
                  <div className="product-note">
                    <Shield size={19} />
                    <p>
                      {draft.guarded
                        ? 'Sells remain open. The founder buy is exempt. Caps apply to each swap and do not guarantee protection against bots or multiple wallets.'
                        : 'Anyone can buy or sell as soon as the launch confirms.'}{' '}
                      Launch rules cannot be edited after creation.
                    </p>
                  </div>
                  <div className="studio-feature">
                    <span className="product-badge">Included</span>
                    <h3>Creator fee stream</h3>
                    <p>
                      Recipients share 70% of harvested seed-position fees. If a recipient receives
                      founder tokens, they must retain that allocation, including unreleased
                      vesting, to claim fees.
                    </p>
                  </div>
                </>
              )}
              {step === 3 && (
                <>
                  {!draft.splits.length && (
                    <div className="studio-default-recipient">
                      <span className="product-badge">100% to creator</span>
                      <h3>{wallet.account ? short(wallet.account) : 'Your connected wallet'}</h3>
                      <p>
                        All creator fees and the optional founder buy go to the launching wallet.
                        Add recipients to split them or set vesting.
                      </p>
                    </div>
                  )}
                  {draft.splits.map((s, i) => (
                    <div className="recipient-card" key={i}>
                      <div className="product-inline">
                        <h3>Recipient {i + 1}</h3>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove recipient ${i + 1}`}
                          onClick={() =>
                            update(
                              'splits',
                              draft.splits.filter((_, n) => n !== i),
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <Field label={`Wallet address ${i + 1}`}>
                        <input
                          value={s.wallet}
                          onChange={(e) => splitUpdate(i, 'wallet', e.target.value)}
                          placeholder="0x…"
                          spellCheck="false"
                        />
                      </Field>
                      <div className="product-grid-3">
                        <Field label="Share · %">
                          <input
                            type="number"
                            min=".01"
                            max="100"
                            step=".01"
                            value={s.percent}
                            onChange={(e) => splitUpdate(i, 'percent', e.target.value)}
                          />
                        </Field>
                        <Field label="Cliff · days">
                          <input
                            type="number"
                            min="0"
                            value={s.cliffDays}
                            onChange={(e) => splitUpdate(i, 'cliffDays', e.target.value)}
                          />
                        </Field>
                        <Field label="Linear vest · days">
                          <input
                            type="number"
                            min="0"
                            value={s.durationDays}
                            onChange={(e) => splitUpdate(i, 'durationDays', e.target.value)}
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                  <div className="product-inline">
                    <Button
                      disabled={draft.splits.length >= 10}
                      onClick={() =>
                        update('splits', [
                          ...draft.splits,
                          {
                            wallet: draft.splits.length ? '' : wallet.account || '',
                            percent: draft.splits.length ? '' : '100',
                            cliffDays: '0',
                            durationDays: '0',
                          },
                        ])
                      }
                    >
                      <Plus size={16} /> Add recipient
                    </Button>
                    {!!draft.splits.length && (
                      <span>
                        Total:{' '}
                        {number(draft.splits.reduce((sum, s) => sum + Number(s.percent || 0), 0))}%
                        / 100%
                      </span>
                    )}
                  </div>
                  <p className="fine-print">
                    Vesting applies to founder tokens, not fees. Zero cliff and duration means
                    immediate delivery. With a cliff, linear vesting begins after the cliff ends.
                    Recipient addresses and shares are permanent.
                  </p>
                </>
              )}
              {step === 4 && (
                <>
                  <div className="review-list">
                    {[
                      ['Token', `${draft.name} / ${draft.symbol}`],
                      ['Supply', '1 billion · fixed'],
                      ['Opening market cap', `${number(draft.targetMcap)} USDC (target)`],
                      ['Pool fee', `${Number(draft.fee) / 10000}%`],
                      ['Founder buy', `${number(draft.initialBuy || 0)} ERC20 USDC`],
                      [
                        'Buy protection',
                        draft.guarded
                          ? `${draft.window}s · ${draft.startCap}% → ${draft.endCap}% cap`
                          : 'Open market',
                      ],
                      [
                        'Recipients',
                        draft.splits.length
                          ? `${draft.splits.length} wallets · ${draft.splits.some((s) => Number(s.cliffDays) || Number(s.durationDays)) ? 'vesting enabled' : 'immediate delivery'}`
                          : 'Launching wallet',
                      ],
                      ['Protocol treasury', short(platform.treasury)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  {!deployment ? (
                    <div className="product-note">
                      <FlaskConical size={23} />
                      <div>
                        <h3>Activate your Hookbrew contracts</h3>
                        <p>
                          Your draft is saved. Deploy the new factory and router with your treasury
                          to open live launches.
                        </p>
                        <Button to="/setup">
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
                            Simulation expires after 60 seconds. Your wallet signs the exact
                            reviewed call. New Hookbrew contracts have not had an independent
                            security audit.
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
            <div className="studio-navigation">
              <Button disabled={step === 0 || locked || checking} onClick={() => go(step - 1)}>
                Back
              </Button>
              <span>Draft saved on this device</span>
              {step < 4 && (
                <Button
                  primary
                  disabled={locked || checking || uploading}
                  onClick={() => go(step + 1)}
                >
                  Continue <ArrowRight size={16} />
                </Button>
              )}
            </div>
          </Glass>
        </div>
        <aside className="studio-preview">
          <Glass className="token-preview" radius={26}>
            <div className="preview-cover">
              <span className="eyebrow">YOUR NEXT BIG IDEA</span>
              <div className="preview-orbit" />
              <div className="preview-token-art">
                {draft.image ? (
                  <img src={safeLink(draft.image)} alt="" />
                ) : (
                  <FlaskConical size={58} strokeWidth={1.3} />
                )}
              </div>
            </div>
            <div className="preview-body">
              <span className="product-badge">TOKEN PREVIEW</span>
              <h2>{draft.name || 'Your token name'}</h2>
              <p className="preview-ticker">${draft.symbol || 'TICKER'}</p>
              <p>
                {draft.description ||
                  'A fresh idea. A new community. It starts with your first launch.'}
              </p>
              <div className="preview-metrics">
                <Metric label="OPENING MCAP" value={`${number(draft.targetMcap)} USDC`} />
                <Metric label="TRADING FEE" value={`${Number(draft.fee) / 10000}%`} />
              </div>
              <div className="preview-split">
                <span style={{ width: '70%' }} />
                <span style={{ width: '30%' }} />
              </div>
              <div className="preview-split-labels">
                <span>70% creators</span>
                <span>30% protocol</span>
              </div>
              <div className="preview-foot">
                <Shield size={15} /> Permanent seed liquidity
              </div>
            </div>
          </Glass>
          <p className="preview-caption">
            The market begins when your launch confirms. Its first trades build the chart.
          </p>
          <Link to="/market" className="subtle-link">
            Explore the market ↗
          </Link>
        </aside>
      </div>
    </>
  )
}
