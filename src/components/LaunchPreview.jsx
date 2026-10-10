import { FlaskConical, LockKeyhole } from 'lucide-react'
import { formatUnits } from 'viem'
import { BrandMark, TokenAvatar } from './UI'
import { openingMarketCap } from '../lib/protocolDraft'
import { network } from '../../shared/network.mjs'

export default function LaunchPreview({ draft, step }) {
  return (
    <aside className="launch-preview" aria-label="Your draft summary">
      <div className="launch-preview-top">
        <FlaskConical size={17} />
        <span>Your brew</span>
        <span>Draft</span>
      </div>
      <div className="launch-preview-identity">
        {draft.symbol || draft.image ? (
          <TokenAvatar token={draft} />
        ) : (
          <span className="draft-emblem">
            <FlaskConical size={29} strokeWidth={1.3} />
          </span>
        )}
        <h2>{draft.name || 'An idea in the making.'}</h2>
        <p>{draft.symbol ? `$${draft.symbol}` : 'Your token starts here'}</p>
      </div>
      <div className="launch-preview-pair">
        <BrandMark name="robinhood" />
        <span>Robinhood Chain</span>
        <span>ETH pair</span>
      </div>
      <dl>
        <div>
          <dt>Opening valuation</dt>
          <dd>{openingMarketCap(draft)} ETH</dd>
        </div>
        <div>
          <dt>Pool fee</dt>
          <dd>{Number(draft.fee) / 10000}%</dd>
        </div>
        <div>
          <dt>Initial supply</dt>
          <dd>1 billion</dd>
        </div>
        <div>
          <dt>Hook recipe</dt>
          <dd>
            {draft.hook?.mode === 'custom'
              ? 'Custom'
              : draft.guarded
                ? 'Guarded opening'
                : 'Open market'}
          </dd>
        </div>
      </dl>
      <div className="launch-preview-cost">
        <span>Launch fee</span>
        <strong>
          {formatUnits(BigInt(network.launchFee), network.quoteDecimals)} <small>ETH</small>
        </strong>
        <p>Network gas and any founder buy are additional.</p>
      </div>
      <div className="launch-preview-footer">
        <LockKeyhole size={15} />
        <span>
          Seed liquidity stays locked.
          <br />
          You sign when you’re ready.
        </span>
      </div>
      <div className="launch-preview-progress" aria-label={`Draft progress: step ${step + 1} of 5`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} data-reached={i <= step} />
        ))}
      </div>
    </aside>
  )
}
