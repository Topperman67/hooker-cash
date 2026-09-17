import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'viem'
import { ArrowDownUp, Settings2 } from 'lucide-react'
import { useOutletContext } from 'react-router-dom'
import Glass from './Glass'
import { Button } from './UI'
import TransactionStatus from './TransactionStatus'
import { Field } from './LaunchStudio'
import { useWallet } from '../context/WalletContext'
import { usePlatform } from '../context/PlatformContext'
import { useTransaction } from '../lib/useTransaction'
import {
  abis,
  amount,
  approval,
  balances,
  eventFrom,
  minimum,
  quoteTrade,
  same,
  send,
  simulate,
  transactionIdentity,
  verifyDeployment,
} from '../lib/protocol'
import { publicClient, readableError } from '../lib/chain'
import { api, number } from '../lib/api'
export default function TradeTicket({ token, onTrade }) {
  const wallet = useWallet(),
    { onConnect } = useOutletContext(),
    { deployment } = usePlatform()
  const [buy, setBuy] = useState(true),
    [input, setInput] = useState(''),
    [slippage, setSlippage] = useState('1'),
    [settings, setSettings] = useState(false),
    [funds, setFunds] = useState(null),
    [quote, setQuote] = useState(null),
    [error, setError] = useState(''),
    [quoting, setQuoting] = useState(false),
    [refresh, setRefresh] = useState(0),
    [review, setReview] = useState(null)
  const revision = useRef(0)
  const decimals = buy ? 6 : 18,
    inputSymbol = buy ? 'USDC' : token.symbol,
    outputSymbol = buy ? token.symbol : 'USDC'
  const tx = useTransaction(`trade:${token.address.toLowerCase()}`, async (receipt, record) => {
    if (record.kind === 'swap') {
      const event = eventFrom(receipt, record.router, abis.HookbrewRouter, 'Trade')
      if (
        !same(event.trader, record.account) ||
        !same(event.token, token.address) ||
        event.buy !== record.buy ||
        event.amountIn !== BigInt(record.amountIn) ||
        event.amountOut < BigInt(record.minOut)
      )
        throw Error('Confirmed trade differs from your reviewed order.')
      setInput('')
      await api('/api/sync', {}).catch(() => {})
      onTrade?.()
    }
    setRefresh((v) => v + 1)
    setReview(null)
  })
  const locked = tx.busy || !!tx.pending
  useEffect(() => {
    revision.current++
    setReview(null)
  }, [input, buy, slippage, wallet.account, wallet.chainId, deployment])
  useEffect(() => {
    setFunds(null)
    if (!deployment || !wallet.account || wallet.chainId !== 5042) return
    let active = true,
      timer
    const load = async () => {
      try {
        const value = await balances(
          deployment,
          buy ? null : token.address,
          wallet.account,
          deployment.router,
        )
        if (active) setFunds(value)
      } catch (e) {
        if (active) setError(readableError(e))
      } finally {
        if (active) timer = setTimeout(load, 12000)
      }
    }
    load()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [deployment, wallet.account, wallet.chainId, buy, token.address, refresh])
  useEffect(() => {
    setQuote(null)
    setError('')
    if (!deployment || !input || Number(input) === 0) return
    let active = true,
      timer
    async function load() {
      setQuoting(true)
      try {
        const n = amount(input, decimals)
        const result = await quoteTrade(deployment, token.address, buy, n, wallet.account)
        const minOut = minimum(result.output, slippage)
        if (!minOut) throw Error('Trade amount is too small.')
        if (active) {
          setQuote({ ...result, input: n, minOut })
          setError('')
        }
      } catch (e) {
        if (active) {
          setQuote(null)
          setError(readableError(e))
        }
      } finally {
        if (active) {
          setQuoting(false)
          timer = setTimeout(load, 15000)
        }
      }
    }
    timer = setTimeout(load, 400)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [deployment, input, decimals, buy, slippage, token.address, wallet.account, refresh])
  const needsApproval = quote && funds && funds.allowance < quote.input
  const insufficient = quote && funds && funds.balance < quote.input
  async function approve() {
    await tx.run(async (status) => {
      await verifyDeployment(deployment)
      const request = approval(
        buy ? deployment.quote : token.address,
        deployment.router,
        quote.input,
      )
      const checked = await simulate(wallet, request)
      status(`Approve exactly ${formatUnits(quote.input, decimals)} ${inputSymbol} in your wallet.`)
      return {
        hash: await send(wallet, checked.request),
        kind: 'approval',
        ...transactionIdentity(wallet, request),
      }
    })
  }
  async function reviewTrade() {
    setError('')
    setReview(null)
    setQuoting(true)
    const version = revision.current
    try {
      await verifyDeployment(deployment)
      const n = amount(input, decimals),
        fresh = await quoteTrade(deployment, token.address, buy, n, wallet.account),
        minOut = minimum(fresh.output, slippage)
      if (!minOut) throw Error('Trade amount is too small.')
      const request = {
        address: deployment.router,
        abi: abis.HookbrewRouter,
        functionName: 'swap',
        args: [token.address, buy, n, minOut, BigInt(Math.floor(Date.now() / 1000) + 300)],
      }
      const checked = await simulate(wallet, request)
      if (version === revision.current)
        setReview({
          request: checked.request,
          gasCost: checked.gasCost,
          output: checked.result,
          minOut,
          version,
          at: Date.now(),
          input: n,
        })
    } catch (e) {
      setError(readableError(e))
    } finally {
      setQuoting(false)
    }
  }
  async function submit() {
    await tx.run(async (status) => {
      if (!review || revision.current !== review.version || Date.now() - review.at > 45000)
        throw Error('Your trade review expired. Get a fresh quote before signing.')
      await verifyDeployment(deployment)
      const checked = await simulate(wallet, review.request)
      status('Confirm the trade in your wallet.')
      return {
        hash: await send(wallet, checked.request),
        kind: 'swap',
        router: deployment.router,
        buy,
        amountIn: String(review.input),
        minOut: String(review.minOut),
        ...transactionIdentity(wallet, review.request),
      }
    })
  }
  async function usePercent(percent) {
    if (!funds) return
    const version = revision.current
    try {
      let spend = (funds.balance * BigInt(percent)) / 100n
      if (buy && percent === 100) {
        const [native, gasPrice] = await Promise.all([
          publicClient.getBalance({ address: wallet.account }),
          publicClient.getGasPrice(),
        ])
        const reserve = ((quote?.gasEstimate || 300000n) + 200000n) * gasPrice * 2n
        const available = native > reserve ? (native - reserve) / 10n ** 12n : 0n
        if (spend > available) spend = available
        if (!spend) throw Error('Keep enough USDC available for network gas.')
      }
      if (version === revision.current) setInput(formatUnits(spend, decimals))
    } catch (e) {
      setError(readableError(e))
    }
  }
  return (
    <Glass className="trade-ticket" radius={24}>
      <div className="ticket-heading">
        <h2>Trade</h2>
        <button
          className="icon-button"
          aria-label="Trade settings"
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={17} />
        </button>
      </div>
      <fieldset disabled={locked} className="studio-fields">
        <div className="trade-side">
          <button
            aria-pressed={buy}
            className="buy"
            onClick={() => {
              setBuy(true)
              setInput('')
            }}
          >
            Buy
          </button>
          <button
            aria-pressed={!buy}
            className="sell"
            onClick={() => {
              setBuy(false)
              setInput('')
            }}
          >
            Sell
          </button>
        </div>
        {settings && (
          <Field
            label="Slippage tolerance · %"
            hint="0.1–10%. Minimum received is enforced on-chain."
          >
            <input
              type="number"
              min=".1"
              max="10"
              step=".1"
              value={slippage}
              onChange={(e) => setSlippage(e.target.value)}
            />
          </Field>
        )}
        <div className="trade-amount-box">
          <div>
            <label htmlFor="trade-amount">You pay</label>
            <span>{inputSymbol}</span>
          </div>
          <input
            id="trade-amount"
            aria-label={`Amount of ${inputSymbol} to ${buy ? 'buy with' : 'sell'}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            autoComplete="off"
          />
          <small>
            Balance: {funds ? number(formatUnits(funds.balance, decimals), 6) : '—'} {inputSymbol}
          </small>
        </div>
        <div className="trade-percent">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} disabled={!funds} onClick={() => usePercent(p)}>
              {p === 100 ? 'MAX' : `${p}%`}
            </button>
          ))}
        </div>
        <div className="trade-direction">
          <ArrowDownUp size={17} />
        </div>
        <div className="trade-output">
          <span>You receive · estimated</span>
          <strong>
            {quote ? number(formatUnits(quote.output, buy ? 18 : 6), 6) : '—'}{' '}
            <small>{outputSymbol}</small>
          </strong>
        </div>
        <div className="ticket-details">
          <div>
            <span>Pool fee</span>
            <strong>{token.fee / 10000}%</strong>
          </div>
          <div>
            <span>Slippage tolerance</span>
            <strong>{slippage}%</strong>
          </div>
          <div>
            <span>Minimum received</span>
            <strong>
              {quote ? number(formatUnits(quote.minOut, buy ? 18 : 6), 6) : '—'} {outputSymbol}
            </strong>
          </div>
          <div>
            <span>Route</span>
            <strong>Hookbrew · Uniswap V4</strong>
          </div>
        </div>
        {!deployment ? (
          <p className="product-note">Trading opens after deployment.</p>
        ) : !wallet.account ? (
          <Button primary className="full-width" onClick={onConnect}>
            Connect wallet
          </Button>
        ) : wallet.chainId !== 5042 ? (
          <Button primary className="full-width" onClick={wallet.switchNetwork}>
            Switch to Arc
          </Button>
        ) : needsApproval ? (
          <Button
            primary
            className="full-width"
            disabled={locked || insufficient}
            onClick={approve}
          >
            {insufficient ? `Insufficient ${inputSymbol}` : `Approve ${inputSymbol}`}
          </Button>
        ) : (
          <Button
            primary
            className="full-width"
            disabled={!quote || !funds || insufficient || quoting || locked}
            onClick={reviewTrade}
          >
            {insufficient
              ? `Insufficient ${inputSymbol}`
              : quoting
                ? 'Getting quote…'
                : `Review ${buy ? 'buy' : 'sell'}`}
          </Button>
        )}
        {review && (
          <div className="trade-review">
            <h3>Review your trade</h3>
            <p>
              Pay {number(formatUnits(review.input, decimals), 6)} {inputSymbol}. Receive at least{' '}
              {number(formatUnits(review.minOut, buy ? 18 : 6), 6)} {outputSymbol}.
            </p>
            <p>Estimated gas: {number(formatUnits(review.gasCost, 18), 6)} native USDC.</p>
            <Button primary className="full-width" onClick={submit} disabled={locked}>
              Confirm {buy ? 'buy' : 'sell'}
            </Button>
            <small>Review expires in 45 seconds. Wallet confirmation required.</small>
          </div>
        )}
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <TransactionStatus tx={tx} />
      <p className="fine-print">
        Quotes include the pool fee. Your USDC balance also pays gas; MAX keeps a gas reserve.
      </p>
    </Glass>
  )
}
