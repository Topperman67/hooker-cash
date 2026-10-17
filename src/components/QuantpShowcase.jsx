import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Address } from './UI.jsx'
import Price from './Price.js'
import { useQuantp } from '../context/QuantpContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { bps, compact, pct, sol, usd } from '../lib/format.js'
import { explorer, QUANTP } from '../../shared/network.mjs'
// The disclosure every $QUANTP surface carries in some form: it is the platform's own token, and
// its fee split is paid out by Quant Pad's engine from a wallet the team funds, not by code on-chain.
import { QUANTP_DISCLOSURE } from './quantpPayouts.js'

const finite = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)

// "quantp", "$quantp", "quant pad" (any case or spacing) or the token's own mint open the $QUANTP
// page: it reads the chain directly, so it works even when the market lists are down.
export const isQuantpQuery = (text) => {
  const value = String(text ?? '').trim()
  if (value === QUANTP.mint) return true
  return ['quantp', 'quantpad'].includes(value.toLowerCase().replace(/^\$/, '').replace(/\s+/g, ''))
}

/**
 * $QUANTP's live figures from /api/quantp, ready to show. Every field is null while the route is
 * loading or down, so each surface prints "—" in the same place instead of moving.
 * `change` is in percent (the route sends a fraction); `progress` is 0..100.
 */
export function quantpFigures(data, solUsd) {
  const priceSol = finite(data?.priceSol)
  const marketCapSol = finite(data?.marketCapSol)
  const change = finite(data?.change24h)
  const progress = finite(data?.curveProgress)
  const migrated = !!data?.migrated
  const burned = finite(data?.burned)
  return {
    ready: !!data,
    priceSol,
    priceUsd: finite(data?.priceUsd) ?? (priceSol != null && solUsd ? priceSol * solUsd : null),
    change: change == null ? null : change * 100,
    marketCapSol,
    marketCapUsd:
      finite(data?.marketCapUsd) ?? (marketCapSol != null && solUsd ? marketCapSol * solUsd : null),
    volumeUsd: finite(data?.volume24hUsd),
    holders: finite(data?.holders),
    burned: burned == null ? null : burned / 10 ** (finite(data?.decimals) ?? 6),
    progress: progress == null ? null : Math.max(0, Math.min(100, progress * 100)),
    migrated,
    // the curve is full but Meteora has not moved it into DAMM v2 yet
    graduating: !migrated && progress != null && progress >= 1,
    feeBps: finite(data?.feeBps),
    postGradFeeBps: finite(data?.postGradFeeBps),
  }
}

/** useQuantp() plus the figures above, priced with the platform's SOL/USD. */
export function useQuantpFigures() {
  const q = useQuantp()
  const { solUsd } = usePlatform()
  return { q, f: quantpFigures(q.data, solUsd) }
}

export const changeClass = (change) => (change > 0 ? 'up' : change < 0 ? 'down' : '')

/** The token price: USD when known (DexScreener, or SOL × SOL/USD), else SOL, else "—". */
export function QuantpPrice({ f }) {
  if (f.priceUsd != null)
    return (
      <>
        $<Price value={f.priceUsd} />
      </>
    )
  if (f.priceSol != null)
    return (
      <>
        <Price value={f.priceSol} /> SOL
      </>
    )
  return '—'
}

export const marketCapText = (f) =>
  f.marketCapUsd != null ? usd(f.marketCapUsd) : sol(f.marketCapSol, { digits: 1 })

export const burnedText = (f) => (f.burned == null ? '—' : `${compact(f.burned)} QUANTP`)

export const stageText = (f) =>
  f.migrated
    ? 'Graduated to Meteora DAMM v2'
    : f.graduating
      ? 'Graduating to Meteora DAMM v2'
      : f.progress == null
        ? 'Unknown'
        : `${f.progress.toFixed(f.progress < 10 ? 1 : 0)}% of the curve filled`

/** The bonding curve's fill, or a full green bar once it has graduated. */
function Graduation({ f }) {
  const done = f.migrated || f.graduating
  const value = done ? 100 : (f.progress ?? 0)
  const known = done || f.progress != null
  return (
    <div className={`qps-curve ${done ? 'is-done' : ''}`}>
      <div className="qps-curve-head">
        <span>
          {f.migrated
            ? 'Graduated to Meteora DAMM v2'
            : f.graduating
              ? 'Graduating to Meteora DAMM v2'
              : 'Bonding curve to graduation'}
        </span>
        <span className="num">{known ? `${Math.round(value)}%` : '—'}</span>
      </div>
      <div
        className="qps-curve-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(value) : undefined}
        aria-valuetext={stageText(f)}
        aria-label="$QUANTP bonding curve progress"
      >
        <div className="qps-curve-fill" style={{ width: `${value}%` }} />
      </div>
      <p className="qps-curve-note">
        {f.migrated
          ? 'The curve filled and Meteora moved it into a DAMM v2 pool.'
          : f.graduating
            ? 'The curve is full. Meteora is moving it into a DAMM v2 pool.'
            : 'Graduates to a Meteora DAMM v2 pool when the curve fills.'}
      </p>
    </div>
  )
}

/** The fee charged now, with the other stage's fee for context. */
function feeNote(f) {
  if (f.feeBps == null) return '2% on the curve, 5% after graduation'
  if (f.migrated) return 'in its DAMM v2 pool (2% on the curve)'
  return `on the curve, ${bps(f.postGradFeeBps ?? 500)} after graduation`
}

// The home page's $QUANTP section, right under the hero: identity and contract on the left, the
// live readout on a graphite instrument on the right. Store-free (GET /api/quantp), so it still
// renders while the market lists are down.
export default function QuantpShowcase() {
  const { q, f } = useQuantpFigures()
  const tone = changeClass(f.change)
  return (
    <article className="qps instrument" aria-labelledby="qps-title">
      <span className="qps-lines" aria-hidden="true" />
      <div className="qps-id">
        <div className="qps-head">
          <span className="qps-mark">
            <img src="/brand/mark.svg" alt="" width="56" height="56" />
          </span>
          <div className="qps-names">
            <p className="qps-eyebrow">Quant Pad’s own token</p>
            <h2 id="qps-title" className="qps-title">
              <span className="qps-name">{q.name}</span>{' '}
              <span className="qps-ticker silver-text">${q.symbol}</span>
            </h2>
          </div>
        </div>
        <div className="qps-ca">
          <span className="qps-ca-label">Contract</span>
          <Address value={q.mint} head={6} tail={6} href={explorer.token(q.mint)} />
        </div>
        <div className="qps-actions">
          <Link to={q.path} className="btn btn-primary">
            Buy ${q.symbol}
          </Link>
          <Link to={`${q.path}?side=sell`} className="btn">
            Sell
          </Link>
          <a href={q.dexscreener} target="_blank" rel="noreferrer" className="btn btn-ghost">
            Chart <ArrowUpRight size={14} aria-hidden="true" />
          </a>
          <a
            href={explorer.token(q.mint)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
          >
            Solscan <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
        <p className="qps-note">{QUANTP_DISCLOSURE}</p>
      </div>

      <div className="qps-read">
        <div className="qps-price">
          <div>
            <span className="qps-label">Price</span>
            <strong className="qps-price-value num">
              <QuantpPrice f={f} />
            </strong>
          </div>
          <div className="qps-change">
            <span className="qps-label">24h</span>
            <strong className={`num ${tone}`}>{pct(f.change)}</strong>
          </div>
        </div>
        <dl className="qps-stats">
          <div>
            <dt>Market cap</dt>
            <dd className="num">{marketCapText(f)}</dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd className="num">{usd(f.volumeUsd)}</dd>
          </div>
          <div>
            <dt>Holders</dt>
            <dd className="num">{f.holders == null ? '—' : compact(f.holders)}</dd>
          </div>
          <div>
            <dt>Burned</dt>
            <dd className="num">{burnedText(f)}</dd>
          </div>
        </dl>
        <div className="qps-bottom">
          <Graduation f={f} />
          <div className="qps-fee">
            <span className="qps-label">Fee per trade</span>
            <strong className="num">{f.feeBps == null ? '—' : bps(f.feeBps)}</strong>
            <span className="qps-fee-note">{feeNote(f)}</span>
          </div>
        </div>
        {q.error && !q.data && (
          <p className="qps-status" role="status">
            Live figures are unavailable right now. They come back on their own.
          </p>
        )}
      </div>
    </article>
  )
}

/**
 * The market's pinned $QUANTP strip: shown first in the default view in every state (loading,
 * empty, store down), so it never moves the list under it.
 */
export function QuantpFeature() {
  const { q, f } = useQuantpFigures()
  return (
    <Link to={q.path} className="qp-feature instrument">
      <span className="qp-feature-id">
        <span className="qps-mark qp-feature-mark">
          <img src="/brand/mark.svg" alt="" width="40" height="40" />
        </span>
        <span className="qp-feature-names">
          <strong>{q.name}</strong>
          <span className="qp-feature-sub">
            <span className="silver-text qp-feature-ticker">${q.symbol}</span>
            <span className="chip qp-chip">Quant Pad’s own token</span>
          </span>
        </span>
      </span>
      <dl className="qp-feature-stats">
        <div>
          <dt>Price</dt>
          <dd className="num">
            <QuantpPrice f={f} />
          </dd>
        </div>
        <div>
          <dt>24h</dt>
          <dd className={`num ${changeClass(f.change)}`}>{pct(f.change)}</dd>
        </div>
        <div>
          <dt>Market cap</dt>
          <dd className="num">{marketCapText(f)}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd className="num">{f.holders == null ? '—' : compact(f.holders)}</dd>
        </div>
        <div>
          <dt>{f.migrated || f.graduating ? 'Pool' : 'Curve'}</dt>
          <dd className="num">
            {f.migrated
              ? 'DAMM v2'
              : f.graduating
                ? 'Graduating'
                : f.progress == null
                  ? '—'
                  : `${Math.round(f.progress)}%`}
          </dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd className="num">{f.feeBps == null ? '—' : bps(f.feeBps)}</dd>
        </div>
      </dl>
      <span className="qp-feature-cta" aria-hidden="true">
        Trade <ArrowUpRight size={14} />
      </span>
      <span className="qp-feature-note">Quant Pad’s own token · not financial advice</span>
    </Link>
  )
}
