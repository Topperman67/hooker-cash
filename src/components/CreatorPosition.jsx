import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { useWallet } from '../context/WalletContext'
import { usePlatform } from '../context/PlatformContext'
import {
  abis,
  read,
  send,
  simulate,
  transactionIdentity,
  verifyDeployment,
  same,
} from '../lib/protocol'
import { useTransaction } from '../lib/useTransaction'
import { number, short } from '../lib/api'
import { Button } from './UI'
import TransactionStatus from './TransactionStatus'
export default function CreatorPosition({ token }) {
  const wallet = useWallet(),
    { deployment: d } = usePlatform(),
    [position, setPosition] = useState(null),
    [error, setError] = useState(''),
    [version, setVersion] = useState(0)
  const tx = useTransaction(`rewards:${token.address.toLowerCase()}`, () =>
    setVersion((v) => v + 1),
  )
  useEffect(() => {
    setPosition(null)
    setError('')
    if (!d) return
    let active = true
    async function load() {
      try {
        const recipients = await read(d.factory, abis.HookbrewFactory, 'getRecipients', [
          token.address,
        ])
        let personal = null,
          protocol = null
        if (wallet.account) {
          const [tokenFees, quoteFees, eligible, vest, releasable] = await Promise.all([
            read(d.factory, abis.HookbrewFactory, 'claimable', [
              token.address,
              wallet.account,
              token.address,
            ]),
            read(d.factory, abis.HookbrewFactory, 'claimable', [
              token.address,
              wallet.account,
              d.quote,
            ]),
            read(d.factory, abis.HookbrewFactory, 'eligible', [token.address, wallet.account]),
            read(d.vesting, abis.HookbrewVesting, 'vests', [token.address, wallet.account]),
            read(d.vesting, abis.HookbrewVesting, 'claimable', [token.address, wallet.account]),
          ])
          personal = { tokenFees, quoteFees, eligible, vest, releasable }
          if (same(wallet.account, d.treasury)) {
            const [tokenFees, quoteFees] = await Promise.all([
              read(d.factory, abis.HookbrewFactory, 'protocolClaimable', [
                token.address,
                token.address,
              ]),
              read(d.factory, abis.HookbrewFactory, 'protocolClaimable', [token.address, d.quote]),
            ])
            protocol = { tokenFees, quoteFees }
          }
        }
        if (active) {
          setPosition({ recipients, personal, protocol })
          setError('')
        }
      } catch (e) {
        if (active) setError(e.shortMessage || e.message)
      }
    }
    load()
    const timer = setInterval(load, 15000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [d, token.address, wallet.account, version])
  async function action(kind) {
    await tx.run(async (status) => {
      await verifyDeployment(d)
      const request =
        kind === 'release'
          ? {
              address: d.vesting,
              abi: abis.HookbrewVesting,
              functionName: 'release',
              args: [token.address, wallet.account],
            }
          : {
              address: d.factory,
              abi: abis.HookbrewFactory,
              functionName: kind,
              args: kind === 'claim' ? [token.address, wallet.account] : [token.address],
            }
      const checked = await simulate(wallet, request)
      status('Confirm in your wallet.')
      return { hash: await send(wallet, checked.request), ...transactionIdentity(wallet, request) }
    })
  }
  const p = position?.personal,
    disabled = tx.busy || !!tx.pending || !wallet.account || wallet.chainId !== 5042
  return (
    <div className="creator-position">
      <h3>Creator rewards & vesting</h3>
      <p>
        70% of seed-position fees is shared between these recipients. Harvest first to move accrued
        pool fees into claimable balances.
      </p>
      <div className="recipient-chips">
        {position?.recipients.map((s) => (
          <span className="product-badge" key={s.wallet}>
            {short(s.wallet)} · {s.bps / 100}% ·{' '}
            {s.cliff || s.duration
              ? `${s.cliff / 86400}d cliff / ${s.duration / 86400}d vest`
              : 'immediate'}
          </span>
        ))}
      </div>
      {p && (
        <>
          <div className="product-grid-3">
            <div>
              <small>Claimable USDC</small>
              <h3>{number(formatUnits(p.quoteFees, 6), 6)}</h3>
            </div>
            <div>
              <small>Claimable {token.symbol}</small>
              <h3>{number(formatUnits(p.tokenFees, 18), 4)}</h3>
            </div>
            <div>
              <small>Vested & releasable</small>
              <h3>{number(formatUnits(p.releasable, 18), 4)}</h3>
            </div>
          </div>
          {!p.eligible && (
            <p className="form-error">
              Restore your original founder allocation to claim creator fees. Vested tokens can
              still be released.
            </p>
          )}
          {p.vest[0] > 0n && (
            <p>
              Vesting allocation: {number(formatUnits(p.vest[0], 18))} {token.symbol}. Released:{' '}
              {number(formatUnits(p.vest[1], 18))}. Cliff ends{' '}
              {new Date((Number(p.vest[2]) + p.vest[3]) * 1000).toLocaleString()}; fully vested{' '}
              {new Date((Number(p.vest[2]) + p.vest[3] + p.vest[4]) * 1000).toLocaleString()}.
            </p>
          )}
        </>
      )}
      <div className="product-actions">
        <Button disabled={disabled} onClick={() => action('harvest')}>
          Harvest pool fees
        </Button>
        <Button
          disabled={disabled || !p?.eligible || !(p.tokenFees || p.quoteFees)}
          onClick={() => action('claim')}
        >
          Claim my fees
        </Button>
        <Button disabled={disabled || !p?.releasable} onClick={() => action('release')}>
          Release vested tokens
        </Button>
      </div>
      {position?.protocol && (
        <div className="trade-review">
          <h3>Protocol treasury</h3>
          <p>
            {number(formatUnits(position.protocol.quoteFees, 6), 6)} USDC +{' '}
            {number(formatUnits(position.protocol.tokenFees, 18), 4)} {token.symbol} claimable.
          </p>
          <Button
            disabled={disabled || !(position.protocol.quoteFees || position.protocol.tokenFees)}
            onClick={() => action('claimProtocol')}
          >
            Claim protocol fees
          </Button>
        </div>
      )}
      {!wallet.account && (
        <p className="fine-print">Connect your wallet to see your claimable balances.</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <TransactionStatus tx={tx} />
    </div>
  )
}
