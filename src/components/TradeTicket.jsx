// Buy and sell a Meteora coin from the wallet: quotes, the fees the trade pays and the swap itself
// all come from the chain (src/lib/trade.js through /api/rpc), never from the indexer, so a coin
// trades even while the store behind /api/coins is down.
//
// `coin` needs only:
//   mint       the coin's mint (base58)
//   symbol     its ticker, for labels ("QUANTP")
//   dbcPool    its Meteora DBC pool; or `dbcConfig`, its DBC config, to derive the pool from
//   decimals   optional, the coin's decimals (default 6)
// Any other field of a /api/coins record is ignored. A coin record (CoinPage) and a fixed object
// such as { mint: QUANTP.mint, symbol: QUANTP.symbol, decimals: QUANTP.decimals, dbcPool:
// QUANTP.pool } (the $QUANTP page) both work. `onTraded` runs after a confirmed trade.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { useToast } from './Toasts.jsx'
import { Segmented, Spinner } from './UI.jsx'
import { api } from '../lib/api.js'
import { formatUnits, parseUnits, pct, sol, toSol, bps } from '../lib/format.js'
import { packTransactions, friendlyWalletError } from '../lib/solana.js'
import { buyExceedsBalance, maxBuy } from '../lib/amounts.js'
import { useChargedPlatformFee } from '../lib/useChargedFee.js'
import { explorer, tierForConfig } from '../../shared/network.mjs'

const SOL_PRESETS = ['0.1', '0.5', '1', '2']
const SELL_PRESETS = [25, 50, 75, 100]
const SIDES = ['buy', 'sell']

// Price impact as text: under a hundredth of a percent reads "<0.01%".
const impactText = (impact) => (impact < 0.0001 ? '<0.01%' : pct(impact * 100, { sign: false }))

export default function TradeTicket({ coin, onTraded }) {
  const { connected, address, balance, openDialog, sendTransactions } = useWallet()
  const { platform, lookupTable } = usePlatform()
  const toast = useToast()
  const [side, setSide] = useState('buy')
  const [amount, setAmount] = useState('')
  const [slippage, setSlippage] = useState(2)
  const [trade, setTrade] = useState(null)
  const [market, setMarket] = useState(null)
  const [held, setHeld] = useState(0n)
  const [busy, setBusy] = useState('')
  // `error` is the last trade's outcome; `marketError` only the latest market refresh's.
  const [error, setError] = useState('')
  const [errorSignature, setErrorSignature] = useState(null)
  const [marketError, setMarketError] = useState('')
  const tabs = useRef({})
  // The curve filled and Meteora has not opened the coin's DAMM v2 pool yet: nothing can trade
  // until it does (usually moments). The market keeps refreshing, so trading opens with the pool.
  const migrated = market?.venue === 'migrating'

  useEffect(() => {
    import('../lib/trade.js').then(setTrade)
  }, [])

  const tokenDecimals = coin.decimals ?? 6
  // A coin known only by its config (no indexed record) trades in the pool derived from it.
  const dbcPool =
    coin.dbcPool || (trade && coin.dbcConfig ? trade.dbcPoolFor(coin.dbcConfig, coin.mint) : null)

  // Results are applied only if they are for the coin and wallet shown now.
  const current = useRef('')
  const key = `${coin.mint}|${address || ''}`
  useEffect(() => {
    current.current = key
    setMarket(null)
    setHeld(0n)
    setMarketError('')
  }, [key])

  const refresh = useCallback(async () => {
    if (!trade) return
    const requested = `${coin.mint}|${address || ''}`
    try {
      const [state, tokens] = await Promise.all([
        trade.marketState(coin.mint, address, dbcPool),
        address ? trade.tokenBalance(coin.mint, address) : Promise.resolve(0n),
      ])
      if (current.current !== requested) return
      setMarket(state)
      setHeld(tokens)
      setMarketError('')
    } catch (e) {
      if (current.current !== requested) return
      setMarket(null)
      setMarketError(
        /does not exist/.test(e.message)
          ? e.message
          : 'Could not read this coin’s market from Solana. Retrying shortly.',
      )
    }
  }, [trade, coin.mint, address, dbcPool])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, migrated ? 5000 : 12000)
    return () => clearInterval(timer)
  }, [refresh, migrated])

  const decimals = side === 'buy' ? 9 : tokenDecimals
  const raw = parseUnits(amount, decimals)
  const quote = useMemo(() => {
    if (!trade || !market || !raw) return null
    try {
      return side === 'buy'
        ? trade.quoteBuy(market, raw, slippage)
        : trade.quoteSell(market, raw, slippage)
    } catch {
      return null
    }
  }, [trade, market, raw, side, slippage])

  const venue = market?.venue === 'pool' ? 'pool' : 'curve'
  // A market Quant Pad cannot trade (a Token-2022 extension it does not handle, or a transfer hook
  // it cannot serve); the migrating state has its own note.
  const unsupported = !migrated && trade && market ? trade.tradeBlocker(market) : null
  const ready = !!market && !unsupported
  // A curve buy larger than what is left fills to the threshold and refunds the rest.
  const fills = side === 'buy' && !!raw && quote?.spend != null && quote.spend < raw
  // The fee this trade's transaction will carry (none while the treasury cannot take it yet).
  const fee = useChargedPlatformFee(
    platform,
    raw ? (side === 'buy' ? (quote?.spend ?? raw) : quote?.lamports || 0n) : 0n,
  )
  const tier = tierForConfig(coin.dbcConfig || market?.pool?.config)
  // In a launch's first 2 minutes the curve's tax is higher (anti-sniper), falling to the tier's.
  const taxNow = trade && market ? trade.currentTaxBps(market) : null
  // A coin outside Quant Pad's tiers shows its pool's own fee, read from the pool (a flat 2% on
  // $QUANTP's curve, 5% in its DAMM v2 pool), with the amount this trade pays from the quote.
  const poolFee = !tier && trade && market ? trade.poolFeeBps(market, side) : null
  const poolFeeAmount =
    quote?.fee > 0n
      ? quote.feeToken === 'token'
        ? `${formatUnits(quote.fee, tokenDecimals, 2)} ${coin.symbol}`
        : sol(toSol(quote.fee))
      : null
  // The amount entered is the most a buy spends on either venue; the check adds the fee, network
  // fees and the token (and, for a pool, temporary WSOL) account rent.
  // Boolean, not `raw &&`: an amount of 0 is 0n, which React would render as a stray "0".
  const insufficient =
    !migrated &&
    connected &&
    !!raw &&
    (side === 'buy'
      ? buyExceedsBalance(raw, balance, { feeBps: platform.feeBps, venue })
      : raw > held)
  const maxLamports = balance != null ? maxBuy(balance, { feeBps: platform.feeBps, venue }) : 0n

  function chooseSide(next, { focus = false } = {}) {
    if (focus) tabs.current[next]?.focus()
    // re-selecting the current side keeps what the user typed
    if (next === side) return
    setSide(next)
    setAmount('')
    setError('')
    setErrorSignature(null)
  }

  // Tabs pattern: arrow keys, Home and End move between Buy and Sell.
  function onTabKey(e) {
    const index = SIDES.indexOf(side)
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? SIDES[(index + 1) % SIDES.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? SIDES[(index + SIDES.length - 1) % SIDES.length]
          : e.key === 'Home'
            ? SIDES[0]
            : e.key === 'End'
              ? SIDES[SIDES.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    chooseSide(next, { focus: true })
  }

  async function submit(e) {
    e.preventDefault()
    if (migrated) return
    if (!connected) return openDialog()
    if (!raw)
      return setError(
        side === 'buy' ? 'Enter how much SOL to spend.' : 'Enter how many tokens to sell.',
      )
    setError('')
    setErrorSignature(null)
    setBusy('Preparing')
    try {
      const build = side === 'buy' ? trade.buyInstructions : trade.sellInstructions
      const { instructions } = await build({
        mint: coin.mint,
        user: address,
        ...(side === 'buy' ? { lamports: raw } : { tokens: raw }),
        slippagePct: slippage,
        platform,
        dbcPool,
      })
      const { transactions, lastValidBlockHeight } = await packTransactions(
        address,
        [instructions],
        {
          units: 300_000,
          lookupTableAddresses: lookupTable ? [lookupTable] : [],
        },
      )
      const [signature] = await sendTransactions(transactions, {
        lastValidBlockHeight,
        onStatus: ({ phase }) =>
          setBusy(
            phase === 'check'
              ? 'Checking'
              : phase === 'sign'
                ? 'Approve in wallet'
                : phase === 'send'
                  ? 'Sending'
                  : 'Confirming',
          ),
      })
      toast({
        title: side === 'buy' ? `Bought ${coin.symbol}` : `Sold ${coin.symbol}`,
        tone: 'success',
        signature,
      })
      setAmount('')
      api('/api/sync', { mint: coin.mint }).catch(() => {})
      await refresh()
      onTraded?.()
    } catch (err) {
      setError(friendlyWalletError(err))
      // Sent but not confirmed yet: point at the transaction instead of inviting a second trade.
      setErrorSignature(err?.unknown ? err.failedSignature || err.signature || null : null)
    } finally {
      setBusy('')
    }
  }

  const venueLabel = market?.venue === 'pool' ? 'Meteora DAMM v2 pool' : 'Meteora bonding curve'
  const tabId = (s) => `ticket-tab-${s}`
  return (
    <form className="instrument ticket" onSubmit={submit} aria-label={`Trade ${coin.symbol}`}>
      <div className="ticket-tabs" role="tablist" aria-label="Trade side">
        {SIDES.map((s) => (
          <button
            key={s}
            ref={(node) => (tabs.current[s] = node)}
            id={tabId(s)}
            type="button"
            role="tab"
            aria-selected={side === s}
            aria-controls="ticket-panel"
            tabIndex={side === s ? 0 : -1}
            className={`ticket-tab ticket-tab-${s}`}
            onClick={() => chooseSide(s)}
            onKeyDown={onTabKey}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <div
        id="ticket-panel"
        role="tabpanel"
        aria-labelledby={tabId(side)}
        style={{ display: 'grid', gap: 16, minWidth: 0 }}
      >
        <div className="field">
          <label htmlFor="ticket-amount">{side === 'buy' ? 'You pay at most' : 'You sell'}</label>
          <div className="input-affix">
            <input
              id="ticket-amount"
              className="input num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={amount}
              disabled={migrated}
              aria-invalid={!!insufficient}
              aria-describedby={
                migrated ? 'ticket-migrated' : insufficient ? 'ticket-insufficient' : undefined
              }
              onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
            />
            <span className="affix">{side === 'buy' ? 'SOL' : coin.symbol}</span>
          </div>
          <div className="ticket-presets">
            {side === 'buy'
              ? SOL_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-sm"
                    disabled={migrated}
                    onClick={() => setAmount(p)}
                  >
                    {p} SOL
                  </button>
                ))
              : SELL_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="btn btn-sm"
                    disabled={migrated || !held}
                    onClick={() =>
                      setAmount(
                        formatUnits((held * BigInt(p)) / 100n, tokenDecimals).replace(/,/g, ''),
                      )
                    }
                  >
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
            {side === 'buy' && maxLamports > 0n && !migrated && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setAmount(formatUnits(maxLamports, 9, 4).replace(/,/g, ''))}
              >
                Max
              </button>
            )}
          </div>
        </div>

        <dl className="kv ticket-quote">
          <dt>You receive about</dt>
          <dd className="num">
            {migrated ? (
              '—'
            ) : !market ? (
              <Spinner />
            ) : quote ? (
              side === 'buy' ? (
                `${formatUnits(quote.tokens, tokenDecimals, 2)} ${coin.symbol}`
              ) : (
                sol(toSol(quote.lamports))
              )
            ) : (
              '—'
            )}
          </dd>
          <dt>Slippage limit</dt>
          <dd>
            <Segmented
              label="Slippage"
              value={slippage}
              onChange={setSlippage}
              options={[
                [1, '1%'],
                [2, '2%'],
                [5, '5%'],
                [15, '15%'],
              ]}
            />
          </dd>
          {platform.feeBps > 0 && (
            <>
              <dt>Quant Pad fee ({bps(platform.feeBps)})</dt>
              <dd className="num">{sol(toSol(fee))}</dd>
            </>
          )}
          {poolFee != null && (
            <>
              <dt>Pool fee</dt>
              <dd className="num">
                {bps(poolFee)}
                {poolFeeAmount && ` · ${poolFeeAmount}`}
              </dd>
            </>
          )}
          {tier && (
            <>
              <dt>Trading tax</dt>
              <dd className="num">
                {/* The settled fee reads a hair above the tax (on-chain rounding): only a whole
                    basis point or more above it is still the anti-sniper window. */}
                {taxNow != null && taxNow - tier.feeBps >= 1
                  ? `${bps(taxNow)} now, falling to ${bps(tier.feeBps)}`
                  : bps(tier.feeBps)}
              </dd>
            </>
          )}
          {quote?.impact != null && (
            <>
              <dt>Price impact</dt>
              <dd className="num">{impactText(quote.impact)}</dd>
            </>
          )}
          <dt>Route</dt>
          <dd>{migrated ? 'Moving to Meteora DAMM v2' : market ? venueLabel : '—'}</dd>
          {connected && (
            <>
              <dt>{side === 'buy' ? 'SOL balance' : `${coin.symbol} balance`}</dt>
              <dd className="num">
                {migrated
                  ? '—'
                  : side === 'buy'
                    ? sol(toSol(balance))
                    : formatUnits(held, tokenDecimals, 2)}
              </dd>
            </>
          )}
        </dl>

        {insufficient && (
          <p className="error-text" id="ticket-insufficient">
            Not enough {side === 'buy' ? 'SOL' : coin.symbol} for this amount
            {side === 'buy' ? ', its fees and account rent' : ''}.
          </p>
        )}
        {migrated && (
          <p className="muted ticket-note" id="ticket-migrated">
            <strong>Graduating.</strong> The bonding curve is full. Trading opens here as soon as
            Meteora moves this coin to its DAMM v2 pool, usually within a minute.
          </p>
        )}
        {unsupported && <p className="error-text">{unsupported}</p>}
        {fills && !unsupported && (
          <p className="muted ticket-note">
            This fills the rest of the bonding curve: about {sol(toSol(quote.spend))} is used and
            the rest stays in your wallet.
          </p>
        )}
        {marketError && !error && !migrated && <p className="error-text">{marketError}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
            {errorSignature && (
              <>
                {' '}
                <a href={explorer.tx(errorSignature)} target="_blank" rel="noreferrer">
                  Check it on Solscan
                </a>
              </>
            )}
          </p>
        )}
        <button
          type="submit"
          className={`btn btn-lg btn-block${migrated ? '' : side === 'buy' ? ' btn-buy' : ' btn-sell'}`}
          disabled={migrated || !!busy || (connected && (!raw || insufficient || !ready))}
        >
          {migrated ? (
            'Graduating to DAMM v2'
          ) : busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : !connected ? (
            'Connect wallet to trade'
          ) : side === 'buy' ? (
            `Buy ${coin.symbol}`
          ) : (
            `Sell ${coin.symbol}`
          )}
        </button>
      </div>
    </form>
  )
}
