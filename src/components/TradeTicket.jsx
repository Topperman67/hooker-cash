import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '../context/WalletContext.jsx'
import { usePlatform } from '../context/PlatformContext.jsx'
import { useToast } from './Toasts.jsx'
import { Segmented, Spinner } from './UI.jsx'
import { api } from '../lib/api.js'
import { formatUnits, parseUnits, sol, toSol, bps } from '../lib/format.js'
import { packTransactions, friendlyWalletError } from '../lib/solana.js'

const SOL_PRESETS = ['0.1', '0.5', '1', '2']
const SELL_PRESETS = [25, 50, 75, 100]
// Leave room for fees and token-account rent when buying with "max".
const RESERVE = 10_000_000n

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
  const [error, setError] = useState('')

  useEffect(() => {
    import('../lib/trade.js').then(setTrade)
  }, [])

  const refresh = useCallback(async () => {
    if (!trade) return
    try {
      const [state, tokens] = await Promise.all([
        trade.marketState(coin.mint, address),
        address ? trade.tokenBalance(coin.mint, address) : Promise.resolve(0n),
      ])
      setMarket(state)
      setHeld(tokens)
    } catch (e) {
      setMarket(null)
      setError(
        /does not exist/.test(e.message)
          ? e.message
          : 'Could not read this coin’s market from Solana. Retrying shortly.',
      )
    }
  }, [trade, coin.mint, address])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 12000)
    return () => clearInterval(timer)
  }, [refresh])

  const decimals = side === 'buy' ? 9 : 6
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

  const fee =
    platform.treasury && platform.feeBps && raw
      ? ((side === 'buy' ? raw : quote?.lamports || 0n) * BigInt(platform.feeBps)) / 10_000n
      : 0n
  const insufficient =
    connected &&
    raw &&
    (side === 'buy' ? balance != null && raw + fee + 5_000_000n > balance : raw > held)

  async function submit(e) {
    e.preventDefault()
    if (!connected) return openDialog()
    if (!raw)
      return setError(
        side === 'buy' ? 'Enter how much SOL to spend.' : 'Enter how many tokens to sell.',
      )
    setError('')
    setBusy('Preparing')
    try {
      const build = side === 'buy' ? trade.buyInstructions : trade.sellInstructions
      const { instructions } = await build({
        mint: coin.mint,
        user: address,
        ...(side === 'buy' ? { lamports: raw } : { tokens: raw }),
        slippagePct: slippage,
        platform,
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
            phase === 'sign' ? 'Approve in wallet' : phase === 'send' ? 'Sending' : 'Confirming',
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
    } finally {
      setBusy('')
    }
  }

  const venue = market?.venue === 'pool' ? 'PumpSwap pool' : 'pump.fun bonding curve'
  return (
    <form className="panel ticket" onSubmit={submit} aria-label={`Trade ${coin.symbol}`}>
      <div className="ticket-tabs" role="tablist" aria-label="Trade side">
        {['buy', 'sell'].map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={`ticket-tab ticket-tab-${s}`}
            onClick={() => {
              setSide(s)
              setAmount('')
              setError('')
            }}
          >
            {s === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="ticket-amount">{side === 'buy' ? 'You pay' : 'You sell'}</label>
        <div className="input-affix">
          <input
            id="ticket-amount"
            className="input num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.0"
            value={amount}
            aria-invalid={!!insufficient}
            onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
          />
          <span className="affix">{side === 'buy' ? 'SOL' : coin.symbol}</span>
        </div>
        <div className="ticket-presets">
          {side === 'buy'
            ? SOL_PRESETS.map((p) => (
                <button key={p} type="button" className="btn btn-sm" onClick={() => setAmount(p)}>
                  {p} SOL
                </button>
              ))
            : SELL_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn btn-sm"
                  disabled={!held}
                  onClick={() =>
                    setAmount(formatUnits((held * BigInt(p)) / 100n, 6).replace(/,/g, ''))
                  }
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
          {side === 'buy' && balance != null && balance > RESERVE && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                setAmount(
                  formatUnits(
                    balance - RESERVE - (balance * BigInt(platform.feeBps || 0)) / 10_000n,
                    9,
                    4,
                  ).replace(/,/g, ''),
                )
              }
            >
              Max
            </button>
          )}
        </div>
      </div>

      <dl className="kv ticket-quote">
        <dt>{side === 'buy' ? 'You receive about' : 'You receive about'}</dt>
        <dd className="num">
          {!market ? (
            <Spinner />
          ) : quote ? (
            side === 'buy' ? (
              `${formatUnits(quote.tokens, 6, 2)} ${coin.symbol}`
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
        <dt>Route</dt>
        <dd>{market ? venue : '—'}</dd>
        {connected && (
          <>
            <dt>{side === 'buy' ? 'SOL balance' : `${coin.symbol} balance`}</dt>
            <dd className="num">
              {side === 'buy' ? sol(toSol(balance)) : formatUnits(held, 6, 2)}
            </dd>
          </>
        )}
      </dl>

      {insufficient && (
        <p className="error-text">
          Not enough {side === 'buy' ? 'SOL' : coin.symbol} for this amount.
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className={`btn btn-lg btn-block ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
        disabled={!!busy || (connected && (!raw || insufficient || !market))}
      >
        {busy ? (
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
    </form>
  )
}
