import { useState } from 'react'
import {
  Check,
  FlaskConical,
  ImagePlus,
  Plus,
  Shield,
  Trash2,
  ArrowUpRight,
  Pencil,
} from 'lucide-react'
import { Button, BrandMark } from './UI'
import { Field } from './StudioFields'
import { number, safeLink, short } from '../lib/api'
import {
  openingMarketCap,
  recipientVesting,
  vestingLabel,
  vestingPresets,
  vestingSeconds,
} from '../lib/protocolDraft'

export function PoolStep({ draft, input, update }) {
  const fee = Number(draft.fee) / 10000
  return (
    <>
      <Field
        label="Trade against"
        hint="USDC is the quote asset supported by the active Hookbrew factory."
      >
        <div className="launch-quote">
          <BrandMark name="usdc" />
          <div>
            <strong>USDC</strong>
            <span>USD Coin · Arc</span>
          </div>
          <Check size={18} />
        </div>
      </Field>
      <Field
        label="Opening market cap · USDC"
        hint="Optional · leave blank for $5,000. This sets a starting valuation, not money raised."
      >
        {input('targetMcap', {
          type: 'number',
          min: 2000,
          max: 10000,
          step: '0.000001',
          placeholder: '5,000',
          className: 'launch-amount',
        })}
      </Field>
      <div className="launch-slider">
        <div>
          <span>Starting valuation</span>
          <strong>
            {!draft.targetMcap && <small>Default </small>}${number(openingMarketCap(draft))}
          </strong>
        </div>
        <input
          aria-label="Opening valuation slider"
          type="range"
          min="2000"
          max="10000"
          step="100"
          value={openingMarketCap(draft)}
          onChange={(e) => update('targetMcap', e.target.value)}
          style={{
            '--range-fill': `${Math.max(0, Math.min(100, (Number(openingMarketCap(draft)) - 2000) / 80))}%`,
          }}
        />
        <div className="launch-range-labels">
          <span>$2,000</span>
          <span>$6,000</span>
          <span>$10,000</span>
        </div>
      </div>
      <div className="launch-slider">
        <div>
          <label htmlFor="pool-fee">Pool fee tier</label>
          <strong>{fee}%</strong>
        </div>
        <input
          id="pool-fee"
          type="range"
          min="1"
          max="5"
          step="1"
          value={fee}
          onChange={(e) => update('fee', String(Number(e.target.value) * 10000))}
          style={{ '--range-fill': `${(fee - 1) * 25}%` }}
        />
        <div className="launch-range-labels">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`Set pool fee to ${n}%`}
              aria-pressed={n === fee}
              onClick={() => update('fee', String(n * 10000))}
            >
              {n}%
            </button>
          ))}
        </div>
        <p className="fine-print">
          {fee === 1
            ? 'Lower swap cost. A smaller fee on each trade.'
            : fee === 5
              ? 'Higher fee on each trade. More expensive swaps for traders.'
              : 'Balance the cost of trading with the fee collected on each swap.'}
        </p>
      </div>
      <div className="launch-economics">
        <Shield size={18} />
        <p>
          Fixed 1 billion supply. Permanent seed liquidity. Harvested seed-position fees are split{' '}
          <strong>70% to creators / 30% to the protocol.</strong>
        </p>
      </div>
    </>
  )
}

export function HookStep({ draft, update, input }) {
  return (
    <>
      <div className="launch-economics">
        <Check size={18} />
        <p>
          Both options include your <strong>{Number(draft.fee) / 10000}% pool fee</strong>, the
          70/30 fee split, and permanent seed liquidity. The guard adds temporary rules for opening
          trades.
        </p>
      </div>
      <div className="launch-hook-grid">
        <button
          type="button"
          className="launch-hook-card"
          aria-pressed={!draft.guarded}
          onClick={() => update('guarded', false)}
        >
          <span className="launch-choice-icon">
            <FlaskConical size={23} />
          </span>
          <span className="launch-choice-check">{!draft.guarded && <Check size={15} />}</span>
          <strong>Open market</strong>
          <span>
            The base Hookbrew hook. Anyone can buy or sell as soon as your launch confirms.
          </span>
          <small>BASE V1 · CREATOR FEES</small>
        </button>
        <button
          type="button"
          className="launch-hook-card"
          aria-pressed={draft.guarded}
          onClick={() => update('guarded', true)}
        >
          <span className="launch-choice-icon">
            <Shield size={23} />
          </span>
          <span className="launch-choice-check">{draft.guarded && <Check size={15} />}</span>
          <strong>Guarded opening</strong>
          <span>
            Set temporary buy caps that relax over time, with optional spacing between buys.
          </span>
          <small>BASE V1 + CUSTOM BUY GUARD</small>
        </button>
      </div>
      {draft.guarded && (
        <div className="launch-inset">
          <div className="launch-subheading">
            <h3>Configure your guard</h3>
            <span>Expires automatically</span>
          </div>
          <div className="product-grid-2">
            <Field label="Guard duration · seconds" hint="1–3,600 seconds">
              {input('window', { type: 'number', min: 1, max: 3600 })}
            </Field>
            <Field label="Global buy spacing · seconds" hint="0 disables spacing · maximum 60">
              {input('interval', { type: 'number', min: 0, max: 60 })}
            </Field>
            <Field label="Starting buy cap · %" hint="Share of virtual USDC reserves per swap">
              {input('startCap', { type: 'number', min: 0.01, max: 50, step: 0.01 })}
            </Field>
            <Field label="Ending buy cap · %" hint="Ramps linearly from the starting cap">
              {input('endCap', { type: 'number', min: 0.01, max: 50, step: 0.01 })}
            </Field>
          </div>
          <p className="fine-print">
            Sells stay open and the founder buy is exempt. Per-swap caps do not guarantee protection
            from bots or multiple wallets.
          </p>
        </div>
      )}
      <p className="fine-print">
        Fee claims are hold-gated: recipients of founder tokens must retain that allocation,
        including unreleased vesting. Hook settings are permanent after launch.
      </p>
    </>
  )
}

export function TokenStep({ draft, input, update, upload, uploading }) {
  return (
    <>
      <div className="product-grid-2">
        <Field label="Token name" hint="1–32 UTF-8 bytes">
          {input('name', { placeholder: 'e.g. Moon Milk', autoComplete: 'off', maxLength: 32 })}
        </Field>
        <Field label="Ticker symbol" hint="1–12 UTF-8 bytes · no spaces">
          {input('symbol', { placeholder: 'e.g. MILK', autoComplete: 'off', maxLength: 12 })}
        </Field>
      </div>
      <div className="studio-brand-row launch-artwork">
        <div className="studio-upload-preview">
          {draft.image ? (
            <img src={safeLink(draft.image)} alt="Token artwork preview" />
          ) : (
            <ImagePlus size={26} />
          )}
        </div>
        <Field label="Token image · optional" hint="PNG, JPG or WebP · up to 1.5 MB">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={uploading}
            onChange={(e) => upload(e.target.files?.[0])}
          />
        </Field>
        {draft.image && <Button onClick={() => update('image', '')}>Remove</Button>}
      </div>
      <Field label="Description · optional" hint={`${draft.description.length}/280 characters`}>
        <textarea
          value={draft.description}
          onChange={(e) => update('description', e.target.value)}
          maxLength={280}
          rows={3}
          placeholder="What is your token about?"
        />
      </Field>
      <div className="product-grid-2">
        <Field label="Website · optional">
          {input('website', { type: 'url', placeholder: 'https://your-project.com' })}
        </Field>
        <Field label="X / Twitter · optional">
          {input('twitter', { type: 'url', placeholder: 'https://x.com/yourproject' })}
        </Field>
      </div>
      <Field label="Telegram · optional">
        {input('telegram', { type: 'url', placeholder: 'https://t.me/yourproject' })}
      </Field>
    </>
  )
}

function CustomVesting({ value, onChange, prefix = '' }) {
  return (
    <div className="product-grid-2 launch-custom-vesting">
      {[
        ['cliff', 'Cliff'],
        ['duration', 'Linear duration'],
      ].map(([key, label]) => (
        <div className="launch-duration" key={key}>
          <Field label={`${prefix}${label}`}>
            <input
              type="number"
              min="0"
              step="1"
              value={value[key]}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            />
          </Field>
          <Field label="Unit">
            <select
              aria-label={`${prefix}${label} unit`}
              value={value[`${key}Unit`]}
              onChange={(e) => onChange({ ...value, [`${key}Unit`]: e.target.value })}
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </Field>
        </div>
      ))}
    </div>
  )
}
function matchesPreset(value, preset) {
  try {
    const a = vestingSeconds(value),
      b = vestingSeconds(preset)
    return a.cliff === b.cliff && a.duration === b.duration
  } catch {
    return false
  }
}

export function PayoutStep({ draft, update, input, wallet }) {
  const value = recipientVesting(draft)
  const [custom, setCustom] = useState(
    () => !vestingPresets.some((p) => matchesPreset(value, p.value)),
  )
  const hasBuy = Number(draft.initialBuy) > 0
  const splitUpdate = (index, patch) =>
    update(
      'splits',
      draft.splits.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    )
  return (
    <>
      <div className="product-grid-2">
        <Field label="Founder buy · USDC" hint="Optional · leave empty for no founder allocation.">
          {input('initialBuy', { inputMode: 'decimal', placeholder: '0.00' })}
        </Field>
        <Field label="Slippage tolerance · %" hint="Applies to the founder buy · 0.1–10%.">
          {input('slippage', { type: 'number', min: 0.1, max: 10, step: 0.1 })}
        </Field>
      </div>
      <p className="fine-print launch-buy-note">
        Your USDC buys tokens in the launch transaction, capped at 10% of supply. You approve only
        the entered amount before launching.
      </p>
      <section className="launch-vesting" aria-label="Founder vesting">
        <div className="launch-subheading">
          <h3>Vesting</h3>
          <span>For your founder tokens</span>
        </div>
        <div className="launch-vesting-grid">
          {vestingPresets.map((p, i) => (
            <button
              key={p.name}
              type="button"
              aria-pressed={!custom && matchesPreset(value, p.value)}
              disabled={!hasBuy && i !== 0}
              onClick={() => {
                setCustom(false)
                update('vesting', p.value)
              }}
            >
              <strong>{p.name}</strong>
              <span>{p.description}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={custom}
            disabled={!hasBuy}
            onClick={() => setCustom(true)}
          >
            <strong>Custom</strong>
            <span>Set your own cliff and unlock period.</span>
          </button>
        </div>
        {custom && <CustomVesting value={value} onChange={(v) => update('vesting', v)} />}
        <p className="fine-print">
          {hasBuy
            ? 'This schedule applies to every split wallet unless you give it a custom schedule. Linear vesting starts after the cliff.'
            : 'Add a founder buy to unlock vesting options.'}{' '}
          Vesting applies to tokens, never pool liquidity or fees.
        </p>
      </section>
      <section className="launch-payouts" aria-label="Payout split">
        <div className="launch-subheading">
          <h3>
            Payout split <small>optional</small>
          </h3>
          {!!draft.splits.length && (
            <span
              className={
                draft.splits.reduce((sum, s) => sum + Number(s.percent || 0), 0) === 100
                  ? 'launch-total-complete'
                  : ''
              }
            >
              {number(draft.splits.reduce((sum, s) => sum + Number(s.percent || 0), 0))}% / 100%
            </span>
          )}
        </div>
        <p className="fine-print">
          One list routes both your creator fee share and your founder tokens. Wallets and
          percentages are permanent after launch.
        </p>
        {!draft.splits.length && (
          <div className="launch-default-wallet">
            <span className="launch-choice-icon">
              <ArrowUpRight size={20} />
            </span>
            <div>
              <strong>
                100% to {wallet.account ? short(wallet.account) : 'your launching wallet'}
              </strong>
              <span>Add wallets to share with a team or treasury.</span>
            </div>
          </div>
        )}
        {draft.splits.map((s, i) => (
          <div className="recipient-card" key={i}>
            <div className="product-inline">
              <h3>Wallet {i + 1}</h3>
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
            <div className="launch-recipient-fields">
              <Field label={`Wallet address ${i + 1}`}>
                <input
                  value={s.wallet}
                  onChange={(e) => splitUpdate(i, { wallet: e.target.value })}
                  placeholder="0x…"
                  spellCheck="false"
                />
              </Field>
              <Field label={`Share · % · wallet ${i + 1}`}>
                <input
                  type="number"
                  min="0.01"
                  max="100"
                  step="0.01"
                  value={s.percent}
                  onChange={(e) => splitUpdate(i, { percent: e.target.value })}
                />
              </Field>
            </div>
            <label className="launch-checkbox">
              <input
                type="checkbox"
                checked={!!s.vesting}
                onChange={(e) =>
                  splitUpdate(i, { vesting: e.target.checked ? { ...value } : null })
                }
              />
              Custom vesting for wallet {i + 1}
            </label>
            {s.vesting && (
              <CustomVesting
                value={s.vesting}
                prefix={`Wallet ${i + 1} `}
                onChange={(v) => splitUpdate(i, { vesting: v })}
              />
            )}
          </div>
        ))}
        <Button
          disabled={draft.splits.length >= 10}
          onClick={() =>
            update('splits', [
              ...draft.splits,
              {
                wallet: draft.splits.length ? '' : wallet.account || '',
                percent: draft.splits.length ? '' : '100',
                vesting: null,
              },
            ])
          }
        >
          <Plus size={16} />
          Add wallet
        </Button>
      </section>
    </>
  )
}

export function ReviewStep({ draft, platform, wallet, go }) {
  const groups = [
    {
      title: 'Pool',
      step: 0,
      rows: [
        ['Launch currency', 'USDC · Arc / Uniswap V4'],
        [
          'Starting market cap',
          `$${number(openingMarketCap(draft))}${!draft.targetMcap ? ' (default)' : ''}`,
        ],
        ['Pool fee', `${Number(draft.fee) / 10000}% on each swap`],
      ],
    },
    {
      title: 'Hook',
      step: 1,
      rows: [
        ['Preset', draft.guarded ? 'Guarded opening' : 'Open market · base V1'],
        ...(draft.guarded
          ? [
              [
                'Buy guard',
                `${draft.window}s · ${draft.startCap}% → ${draft.endCap}% cap · ${draft.interval}s spacing`,
              ],
            ]
          : []),
        ['Economics', '70% creators / 30% protocol · hold-gated'],
        ['Seed liquidity', 'Permanently locked in the hook'],
      ],
    },
    {
      title: 'Token',
      step: 2,
      rows: [
        ['Name / symbol', `${draft.name} / $${draft.symbol}`],
        ['Supply', '1,000,000,000 · fixed'],
        ...(draft.description ? [['Description', draft.description]] : []),
        ...['website', 'twitter', 'telegram']
          .filter((key) => draft[key])
          .map((key) => [
            key === 'twitter' ? 'X / Twitter' : key === 'website' ? 'Website' : 'Telegram',
            draft[key],
          ]),
      ],
    },
    {
      title: 'Payouts',
      step: 3,
      rows: [
        ['Founder buy', `${number(draft.initialBuy || 0, 6)} USDC`],
        ['Buy slippage', `${draft.slippage}%`],
        ...(!draft.splits.length
          ? [
              ['Recipient', wallet.account || 'Your launching wallet'],
              ['Vesting', vestingLabel(recipientVesting(draft))],
            ]
          : draft.splits.flatMap((s, i) => [
              [`Wallet ${i + 1} · ${s.percent}%`, s.wallet],
              [`Wallet ${i + 1} vesting`, vestingLabel(recipientVesting(draft, s))],
            ])),
        ['Protocol treasury', platform.treasury || 'Unavailable'],
      ],
    },
  ]
  return (
    <div className="launch-flow-review">
      {groups.map((group) => (
        <section key={group.title} aria-label={`${group.title} review`}>
          <div className="launch-subheading">
            <h3>{group.title}</h3>
            <button
              type="button"
              onClick={() => go(group.step)}
              aria-label={`Edit ${group.title.toLowerCase()}`}
            >
              <Pencil size={13} />
              Edit
            </button>
          </div>
          {group.title === 'Token' && draft.image && (
            <img className="launch-flow-review-art" src={safeLink(draft.image)} alt="Token artwork" />
          )}
          <dl className="review-list">
            {group.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}
