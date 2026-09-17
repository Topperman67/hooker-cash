import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatUnits } from 'viem'
import { readToken, readableError } from '../lib/chain'
import { explorerAddress } from '../config/network'
import Glass from './Glass'
import { TokenAvatar } from './UI'

export function useToken(address) {
  const [result, setResult] = useState({ status: 'idle', token: null, error: '' })
  useEffect(() => {
    let active = true
    if (!address) {
      setResult({ status: 'idle', token: null, error: '' })
      return
    }
    setResult({ status: 'loading', token: null, error: '' })
    readToken(address).then(
      (token) => {
        if (active) setResult({ status: 'ready', token, error: '' })
      },
      (error) => {
        if (active) setResult({ status: 'error', token: null, error: readableError(error) })
      },
    )
    return () => {
      active = false
    }
  }, [address])
  return result
}

export default function TokenLookup({ address, showLink = true }) {
  const { status, token, error } = useToken(address)
  if (status === 'idle') return null
  return (
    <Glass className="panel-pad token-lookup" aria-live="polite">
      {status === 'loading' && <p>Reading token contract on Arc…</p>}
      {status === 'error' && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {token && (
        <>
          <div className="token-top">
            <TokenAvatar token={token} />
            <div>
              <h2>{token.name}</h2>
              <span>{token.symbol}</span>
            </div>
          </div>
          <a
            className="wallet-address"
            href={explorerAddress(token.address)}
            target="_blank"
            rel="noreferrer"
          >
            {token.address}
          </a>
          <div className="preview-stat">
            <span>Decimals</span>
            <span>{token.decimals}</span>
          </div>
          <div className="preview-stat">
            <span>Total supply</span>
            <span className="break-value">
              {formatUnits(token.totalSupply, token.decimals)} {token.symbol}
            </span>
          </div>
          <div className="preview-stat">
            <span>Read at block</span>
            <span>{token.blockNumber}</span>
          </div>
          <p className="fine-print">
            Name, symbol, decimals, and supply were read from this contract. This does not establish
            a Hookbrew launch, a trading pool, or token safety.
          </p>
          {showLink && (
            <Link className="text-link" to={`/token/${token.address}`}>
              View contract details
            </Link>
          )}
        </>
      )}
    </Glass>
  )
}
