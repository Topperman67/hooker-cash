import { useMemo } from 'react'
import { ArrowUpRight } from 'lucide-react'
import MarketChart from '../components/MarketChart.jsx'
import QuantpLedger from '../components/QuantpLedger.jsx'
import TradeTicket from '../components/TradeTicket.jsx'
import TradesTable from '../components/TradesTable.jsx'
import { Address, CurveProgress, Stat } from '../components/UI.jsx'
import Price from '../components/Price.js'
import { useQuantp } from '../context/QuantpContext.jsx'
import { ago, bps, compact, pct, sol, usd } from '../lib/format.js'
import { explorer } from '../../shared/network.mjs'

// The token's X account, from its on-chain metadata.
const X_URL = 'https://x.com/quantpadhook'

const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)

// Where $QUANTP trades now: 'curve' (Meteora's bonding curve), 'graduating' (the curve is full and
// Meteora is opening its DAMM v2 pool: nothing trades for a moment) or 'pool' (DAMM v2).
// Unknown (null) while the chain has not been read.
function stageOf(data) {
  if (data?.migrated) return 'pool'
  const progress = num(data?.curveProgress)
  if (progress == null) return null
  return progress >= 1 ? 'graduating' : 'curve'
}

const STAGE_LABEL = {
  curve: 'On the bonding curve',
  graduating: 'Graduating to DAMM v2',
  pool: 'Graduated to DAMM v2',
}

function ExternalButton({ href, children, className = 'btn' }) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children} <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  )
}

/** A price in USD (or SOL when USD is unknown), drawn by Price for tiny values. */
function TokenPrice({ usdValue, solValue }) {
  if (usdValue != null)
    return (
      <>
        $<Price value={usdValue} />
      </>
    )
  if (solValue != null)
    return (
      <>
        <Price value={solValue} /> SOL
      </>
    )
  return '—'
}

// $QUANTP, Quant Pad's own token: live figures from /api/quantp (chain, DexScreener and a holder
// scan, never the store), its chart and trades from /api/quantp/* (the indexer, else
// GeckoTerminal), its payouts and burns from /api/quantp/ledger (the team's wallets), and the
// trade ticket, which reads the chain itself and follows the token from its bonding curve into
// its DAMM v2 pool. Every part keeps working while Redis is down.
export default function QuantpPage() {
  const q = useQuantp()
  const d = q.data
  const stage = stageOf(d)
  const graduated = stage === 'pool' || stage === 'graduating'
  const change = num(d?.change24h) == null ? null : num(d.change24h) * 100
  const progress = num(d?.curveProgress) == null ? null : num(d.curveProgress) * 100
  const feeNow = num(d?.feeBps)
  const curveFee = graduated ? q.feeBps : (feeNow ?? q.feeBps)
  const postFee = num(d?.postGradFeeBps) ?? q.postGradFeeBps
  const fees = d?.fees
  const trades = d?.txns24h ? d.txns24h.buys + d.txns24h.sells : null
  const burned = d?.burned == null ? null : Number(d.burned) / 10 ** q.decimals
  const delayed = d && (d.sources?.chain !== 'ok' || d.sources?.dex !== 'ok')
  const holdersPct = q.holdersShareBps / 100
  const buybackPct = q.buybackShareBps / 100
  const ticketCoin = useMemo(
    () => ({ mint: q.mint, symbol: q.symbol, name: q.name, decimals: q.decimals, dbcPool: q.pool }),
    [q.mint, q.symbol, q.name, q.decimals, q.pool],
  )
  const poolLink = d?.dammPool ? explorer.account(d.dammPool) : explorer.account(q.pool)

  return (
    <div className="wrap qp-page">
      <header className="qp-hero">
        <span className="qp-hero-lines" aria-hidden="true" />
        <div className="qp-id">
          <span className="qp-lens" aria-hidden="true">
            <img src="/brand/mark.svg" alt="" width="104" height="104" />
          </span>
          <div className="qp-names">
            <div className="qp-chips">
              <span className="chip chip-own">Quant Pad’s own token</span>
              {stage && (
                <span className={`chip ${graduated ? 'chip-grad' : ''}`}>{STAGE_LABEL[stage]}</span>
              )}
            </div>
            <h1 className="qp-title">
              <span className="qp-ticker chrome-text">${q.symbol}</span>
              <span className="qp-name">{q.name}</span>
            </h1>
            <div className="qp-contract">
              <span className="faint">Contract</span>
              <Address value={q.mint} href={explorer.token(q.mint)} head={6} tail={6} />
            </div>
          </div>
        </div>
        <div className="qp-quote">
          <p className="qp-label">Price</p>
          <p className="qp-price num">
            <TokenPrice usdValue={num(d?.priceUsd)} solValue={num(d?.priceSol)} />
          </p>
          <p className="qp-price-sub num">
            {num(d?.priceUsd) != null && num(d?.priceSol) != null && (
              <>
                <Price value={num(d.priceSol)} /> SOL ·{' '}
              </>
            )}
            <span className={change > 0 ? 'up' : change < 0 ? 'down' : ''}>{pct(change)}</span> 24h
          </p>
          <div className="qp-actions">
            <a className="btn btn-primary" href="#trade">
              Buy ${q.symbol}
            </a>
            <ExternalButton href={q.dexscreener}>DexScreener</ExternalButton>
            <ExternalButton href={explorer.token(q.mint)}>Solscan</ExternalButton>
            <ExternalButton href={X_URL}>X</ExternalButton>
          </div>
          <p className="qp-updated faint" aria-live="polite">
            {d
              ? `Live · updated ${ago(d.updatedAt)} ago${delayed ? ' · some figures are delayed' : ''}`
              : q.error
                ? 'Live figures are unavailable right now. Retrying shortly.'
                : 'Reading live figures…'}
          </p>
        </div>
      </header>

      <dl className="qp-stats">
        <Stat label="Market cap">
          <span className="num">
            {num(d?.marketCapUsd) != null
              ? usd(d.marketCapUsd)
              : sol(num(d?.marketCapSol), { digits: 1 })}
          </span>
        </Stat>
        <Stat label="24h volume">
          <span className="num">{usd(num(d?.volume24hUsd))}</span>
        </Stat>
        <Stat label="24h trades">
          <span
            className="num"
            title={d?.txns24h ? `${d.txns24h.buys} buys, ${d.txns24h.sells} sells` : undefined}
          >
            {trades == null ? '—' : trades.toLocaleString('en-US')}
          </span>
        </Stat>
        <Stat label="Holders">
          <span className="num">{num(d?.holders)?.toLocaleString('en-US') ?? '—'}</span>
        </Stat>
        <Stat label="Burned">
          <span className="num">{burned == null ? '—' : `${compact(burned)} ${q.symbol}`}</span>
        </Stat>
        <Stat label="Fee per trade">
          <span className="num">{feeNow == null ? '—' : bps(feeNow)}</span>
        </Stat>
      </dl>

      <p className="notice notice-warn qp-warn">
        <strong>Quant Pad’s own token.</strong> Memecoins are extremely risky. Not financial advice.{' '}
        <a href="#before-you-trade">Read before you trade</a>
      </p>

      <div className="qp-grid">
        <div className="qp-main">
          <div className="qp-chart">
            <MarketChart
              mint={q.mint}
              symbol={q.symbol}
              supply={d?.supply}
              decimals={q.decimals}
              candlesPath="/api/quantp/candles"
            />
          </div>

          <section className="panel qp-tokenomics" aria-labelledby="qp-tokenomics-title">
            <div className="panel-head">
              <h2 id="qp-tokenomics-title" className="h3">
                Tokenomics
              </h2>
              <span className="chip">Live</span>
            </div>
            <div className="qp-fees">
              <div className={`qp-fee ${stage === 'curve' ? 'is-now' : ''}`}>
                <span className="qp-fee-pct num">{bps(curveFee)}</span>
                <span className="qp-fee-text">
                  per buy and sell on the bonding curve
                  {stage === 'curve' && <span className="qp-now">Now</span>}
                </span>
              </div>
              <div className={`qp-fee ${graduated ? 'is-now' : ''}`}>
                <span className="qp-fee-pct num">{bps(postFee)}</span>
                <span className="qp-fee-text">
                  per buy and sell in the DAMM v2 pool after graduation
                  {graduated && <span className="qp-now">Now</span>}
                </span>
              </div>
            </div>
            <p className="muted qp-fine">
              Meteora’s pool takes it in SOL on every buy and sell.
              {stage !== 'pool' && ' The token’s transfer hook takes nothing.'}
            </p>

            <h3 className="qp-sub">Where the creator’s share goes</h3>
            <div
              className="qp-split"
              role="img"
              aria-label={`${holdersPct}% to holders, ${buybackPct}% to buyback and burn`}
            >
              <span className="qp-split-holders" style={{ flexBasis: `${holdersPct}%` }}>
                {holdersPct}%
              </span>
              <span className="qp-split-burn" style={{ flexBasis: `${buybackPct}%` }}>
                {buybackPct}%
              </span>
            </div>
            <dl className="qp-split-legend">
              <div>
                <dt>
                  <i className="qp-dot qp-dot-holders" /> {holdersPct}% to holders
                </dt>
                <dd>In SOL, by time held</dd>
                <dd className="num qp-earned">{sol(num(fees?.holdersSol))} earned so far</dd>
              </div>
              <div>
                <dt>
                  <i className="qp-dot qp-dot-burn" /> {buybackPct}% buyback & burn
                </dt>
                <dd>Buys ${q.symbol} on the market and burns it</dd>
                <dd className="num qp-earned">
                  {sol(num(fees?.buybackSol))} earned so far ·{' '}
                  {burned == null ? '—' : compact(burned)} burned
                </dd>
              </div>
            </dl>
            <p className="faint qp-fine">
              The split is the team’s stated policy for the creator’s share of the fees
              {fees ? (
                <>
                  {' '}
                  ({sol(num(fees.creatorLifetimeSol), { digits: 3 })} of the{' '}
                  {sol(num(fees.lifetimeSol), { digits: 3 })} in fees so far)
                </>
              ) : null}
              . The team pays it out: nothing on-chain enforces it, and these figures are fees
              earned, not payouts. <a href="#payouts">See what has been paid out and burned</a>.
            </p>
          </section>

          <div className="qp-trades">
            <TradesTable
              mint={q.mint}
              symbol={q.symbol}
              decimals={q.decimals}
              tradesPath="/api/quantp/trades"
            />
          </div>
        </div>

        <aside className="qp-side">
          <div id="trade" className="qp-ticket">
            <TradeTicket coin={ticketCoin} onTraded={q.refresh} />
          </div>

          <section className="panel qp-grad" aria-labelledby="qp-grad-title">
            <h2 id="qp-grad-title" className="h3">
              Graduation
            </h2>
            <CurveProgress
              progress={progress ?? 0}
              complete={graduated}
              migrated={stage === 'pool'}
            />
            <p className="faint qp-fine">
              {stage === 'pool' ? (
                <>
                  The curve filled and Meteora moved ${q.symbol} into a{' '}
                  <a href={poolLink} target="_blank" rel="noreferrer">
                    DAMM v2 pool
                  </a>{' '}
                  with its liquidity locked. Trading continues there at {bps(postFee)}.
                </>
              ) : stage === 'graduating' ? (
                'The curve is full. Meteora is opening its DAMM v2 pool, and trading resumes there in a moment.'
              ) : (
                `When the curve fills, Meteora moves $${q.symbol} into a DAMM v2 pool with its liquidity locked. Trading continues there at ${bps(postFee)}, and this page follows it.`
              )}
            </p>
          </section>

          <section
            id="before-you-trade"
            className="panel qp-disclose"
            aria-labelledby="qp-disclose-title"
          >
            <h2 id="qp-disclose-title" className="h3">
              Before you trade
            </h2>
            <ul>
              <li>${q.symbol} is Quant Pad’s own token, and Quant Pad promotes it on this site.</li>
              <li>
                It launched on a Meteora bonding curve and has graduated to a Meteora DAMM v2 pool.
              </li>
              <li>
                The 60/40 split is a promise, not code. The team pays it out off-chain, and the
                figures here are fees earned, not payouts.
              </li>
              {stage === 'pool' ? (
                <li>
                  Meteora removed its transfer hook at graduation, for good: it is now a plain
                  Token-2022 coin.
                </li>
              ) : (
                <li>
                  On the curve its transfers run a transfer-hook program. It takes no fee today, and
                  its owner can upgrade it. Meteora removes it at graduation.
                </li>
              )}
              <li>
                Memecoins are extremely risky and can lose all their value. Nothing here is
                financial advice.
              </li>
            </ul>
          </section>

          <section className="panel qp-about" aria-labelledby="qp-about-title">
            <h2 id="qp-about-title" className="h3">
              About ${q.symbol}
            </h2>
            <dl className="kv">
              <dt>Contract</dt>
              <dd>
                <Address value={q.mint} href={explorer.token(q.mint)} />
              </dd>
              <dt>Token</dt>
              <dd>Token-2022, {q.decimals} decimals</dd>
              <dt>Supply</dt>
              <dd className="num">{compact(Number(d?.supply ?? q.supply) / 10 ** q.decimals)}</dd>
              <dt>Launched</dt>
              <dd>
                {new Date((d?.launchedAt ?? q.launchedAt) * 1000).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </dd>
              <dt>Meteora</dt>
              <dd>
                <a href={poolLink} target="_blank" rel="noreferrer">
                  {d?.dammPool ? 'DAMM v2 pool' : 'Bonding curve pool'}
                </a>
              </dd>
            </dl>
            <div className="about-links">
              <ExternalButton href={q.dexscreener} className="btn btn-sm">
                DexScreener
              </ExternalButton>
              <ExternalButton href={explorer.token(q.mint)} className="btn btn-sm">
                Solscan
              </ExternalButton>
              <ExternalButton href={X_URL} className="btn btn-sm">
                X
              </ExternalButton>
            </div>
          </section>

          <QuantpLedger symbol={q.symbol} decimals={q.decimals} fees={fees} burned={burned} />
        </aside>
      </div>
    </div>
  )
}
