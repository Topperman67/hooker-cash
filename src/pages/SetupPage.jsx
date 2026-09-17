import { useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  encodeDeployData,
  getCreate2Address,
  getAddress,
  keccak256,
  toHex,
  formatUnits,
} from 'viem'
import { Check, FlaskConical, Shield } from 'lucide-react'
import Glass from '../components/Glass'
import { Button, PageHeading } from '../components/UI'
import TransactionStatus from '../components/TransactionStatus'
import { usePlatform } from '../context/PlatformContext'
import { useWallet } from '../context/WalletContext'
import { api, number, short } from '../lib/api'
import { publicClient, readableError } from '../lib/chain'
import { checkWallet, same } from '../lib/protocol'
import { useTransaction } from '../lib/useTransaction'
const proxyCode =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
const key = 'hookbrew:deployment-progress:v1'
function restore() {
  try {
    return JSON.parse(localStorage.getItem(key)) || {}
  } catch {
    return {}
  }
}
export default function SetupPage() {
  const platform = usePlatform(),
    wallet = useWallet(),
    { onConnect } = useOutletContext()
  const [progress, setProgress] = useState(restore),
    [prepared, setPrepared] = useState(null),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState('')
  const generation = useRef(0),
    i = platform.infrastructure
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  const tx = useTransaction('deployment', (receipt, record) => {
    const next =
      record.kind === 'factory'
        ? {
            factory: record.factory,
            factoryTx: receipt.transactionHash,
            chainId: 5042,
            treasury: record.treasury,
            buildHash: record.buildHash,
          }
        : { ...progress, router: receipt.contractAddress, routerTx: receipt.transactionHash }
    if (record.kind === 'router' && !receipt.contractAddress)
      throw Error('No router address in the deployment receipt.')
    localStorage.setItem(key, JSON.stringify(next))
    setProgress(next)
    setPrepared(null)
  })
  async function prepare() {
    if (!i) return
    setBusy(true)
    setError('')
    setPrepared(null)
    const version = ++generation.current
    try {
      await checkWallet(wallet)
      if ((await publicClient.getChainId()) !== i.chainId)
        throw Error('Deployment RPC is on the wrong chain.')
      const [
        factoryArtifact,
        routerArtifact,
        proxy,
        managerCode,
        quoteCode,
        quoterCode,
        stateCode,
      ] = await Promise.all([
        fetch('/protocol/HookbrewFactory.json').then((r) => r.json()),
        fetch('/protocol/HookbrewRouter.json').then((r) => r.json()),
        publicClient.getCode({ address: i.create2 }),
        publicClient.getCode({ address: i.poolManager }),
        publicClient.getCode({ address: i.quote }),
        publicClient.getCode({ address: i.quoter }),
        publicClient.getCode({ address: i.stateView }),
      ])
      if (
        proxy !== proxyCode ||
        [managerCode, quoteCode, quoterCode, stateCode].some((c) => !c || c === '0x')
      )
        throw Error('Arc deployment infrastructure verification failed.')
      const data = encodeDeployData({
        abi: factoryArtifact.abi,
        bytecode: factoryArtifact.bytecode,
        args: [i.poolManager, i.quote, getAddress(platform.treasury), 10n ** 18n],
      })
      const buildHash = keccak256(data)
      let request, factory, kind
      if (!progress.factoryTx) {
        setStatus('Finding a valid V4 hook address…')
        let salt,
          attempts = 0,
          nonce = BigInt(toHex(crypto.getRandomValues(new Uint8Array(24))))
        while (version === generation.current) {
          salt = toHex(nonce++, { size: 32 })
          factory = getCreate2Address({ from: i.create2, salt, bytecodeHash: buildHash })
          if ((BigInt(factory) & 0x3fffn) === 0x2080n) break
          if (++attempts % 300 === 0) {
            setStatus(`Finding a valid V4 hook address… ${attempts.toLocaleString()} checked`)
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }
        if (version !== generation.current) return
        if (await publicClient.getCode({ address: factory }))
          throw Error('That deployment address is already occupied. Prepare again for a new salt.')
        request = { to: i.create2, data: salt + data.slice(2), value: 0n }
        kind = 'factory'
      } else {
        if (
          progress.chainId !== i.chainId ||
          !same(progress.treasury, platform.treasury) ||
          progress.buildHash !== buildHash
        )
          throw Error(
            'Saved deployment uses a different build or treasury. Use its original build to finish, or export and clear the local record.',
          )
        const receipt = await publicClient.getTransactionReceipt({ hash: progress.factoryTx })
        const original = await publicClient.getTransaction({ hash: progress.factoryTx })
        factory = getCreate2Address({
          from: i.create2,
          salt: original.input.slice(0, 66),
          bytecodeHash: buildHash,
        })
        if (
          receipt.status !== 'success' ||
          !same(original.to, i.create2) ||
          original.input.slice(66) !== data.slice(2) ||
          !same(factory, progress.factory)
        )
          throw Error('Saved factory receipt does not match this Hookbrew build.')
        request = {
          data: encodeDeployData({
            abi: routerArtifact.abi,
            bytecode: routerArtifact.bytecode,
            args: [factory],
          }),
          value: 0n,
        }
        kind = 'router'
      }
      setStatus('Simulating deployment and estimating gas…')
      const gas = await publicClient.estimateGas({ ...request, account: wallet.account }),
        gasPrice = await publicClient.getGasPrice(),
        balance = await publicClient.getBalance({ address: wallet.account })
      if (balance < (gas * gasPrice * 120n) / 100n)
        throw Error('Your deployer wallet needs more native USDC for deployment gas.')
      if (version === generation.current) {
        setPrepared({
          request,
          factory,
          kind,
          buildHash,
          gasCost: gas * gasPrice,
          account: wallet.account,
          at: Date.now(),
        })
        setStatus('Deployment simulated. Review the contract and network fee below.')
      }
    } catch (e) {
      setError(readableError(e))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }
  async function deploy() {
    await tx.run(async (setTxStatus) => {
      if (!prepared || Date.now() - prepared.at > 120000 || !same(prepared.account, wallet.account))
        throw Error('Prepare the deployment again to refresh its estimate.')
      const client = await checkWallet(wallet)
      await publicClient.estimateGas({ ...prepared.request, account: wallet.account })
      setTxStatus(`Confirm ${prepared.kind} deployment in your wallet.`)
      const hash = await client.sendTransaction(prepared.request)
      return {
        hash,
        kind: prepared.kind,
        factory: prepared.factory,
        treasury: platform.treasury,
        buildHash: prepared.buildHash,
        account: wallet.account,
        to: prepared.request.to || null,
        inputHash: keccak256(prepared.request.data),
        value: '0',
      }
    })
  }
  async function activate() {
    setBusy(true)
    setError('')
    setStatus('Requesting treasury authorization…')
    try {
      const client = await checkWallet(wallet)
      if (!same(wallet.account, platform.treasury))
        throw Error(`Connect the treasury wallet ${platform.treasury} to activate this venue.`)
      const challenge = await api('/api/deployment/challenge', {
        factoryTx: progress.factoryTx,
        routerTx: progress.routerTx,
      })
      const signature = await client.signMessage({ message: challenge.message })
      await api('/api/deployment/activate', {
        ...challenge,
        signature,
        factoryTx: progress.factoryTx,
        routerTx: progress.routerTx,
      })
      platform.refresh()
      setStatus('Hookbrew is active. The indexer is following your factory.')
    } catch (e) {
      setError(readableError(e))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }
  const locked = busy || tx.busy || !!tx.pending
  return (
    <>
      <PageHeading
        title="Your contracts. Your venue."
        description="Deploy Hookbrew’s factory, vesting vault, and swap router on Arc. Protocol fees go to your treasury."
      />
      <div className="setup-layout">
        <Glass className="setup-main" radius={26}>
          <span className="eyebrow">HOOKBREW PROTOCOL / V1</span>
          <h2>{platform.deployment ? 'Hookbrew is activated.' : 'Bring the brewery on-chain.'}</h2>
          <p>
            The factory is also your Uniswap V4 hook. Its constructor creates the vesting vault. The
            router enables exact-input buys and sells directly in Hookbrew.
          </p>
          <div className="review-list">
            <div>
              <span>Network</span>
              <strong>Arc · chain 5042</strong>
            </div>
            <div>
              <span>Protocol treasury</span>
              <a
                href={`https://explorer.arc.io/address/${platform.treasury}`}
                target="_blank"
                rel="noreferrer"
              >
                {platform.treasury || 'Loading…'}
              </a>
            </div>
            <div>
              <span>Flat launch fee</span>
              <strong>1 native USDC</strong>
            </div>
            <div>
              <span>Seed-position fees</span>
              <strong>70% creators / 30% treasury</strong>
            </div>
            <div>
              <span>Compiler</span>
              <strong>Solidity 0.8.26 · Cancun · optimizer 200</strong>
            </div>
          </div>
          {platform.deployment ? (
            <>
              <div className="product-note">
                <Check size={24} />
                <div>
                  <h3>Factory and router verified</h3>
                  <p>{platform.deployment.factory}</p>
                </div>
              </div>
              <Button primary to="/create">
                Launch your first token
              </Button>
            </>
          ) : (
            <>
              <div className="setup-steps">
                {[
                  ['Factory + vesting', progress.factory, progress.factoryTx],
                  ['Trading router', progress.router, progress.routerTx],
                  ['Treasury activation', null, null],
                ].map(([label, address, hash], index) => (
                  <div key={label}>
                    <span className={hash ? 'complete' : ''}>
                      {hash ? <Check size={16} /> : index + 1}
                    </span>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {address
                          ? short(address)
                          : index === 2
                            ? 'Signed activation; no gas'
                            : 'Wallet-signed deployment'}
                      </small>
                    </div>
                    {hash && (
                      <a
                        href={`https://explorer.arc.io/tx/${hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Receipt ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
              {!wallet.account ? (
                <Button primary onClick={onConnect}>
                  Connect deployer wallet
                </Button>
              ) : wallet.chainId !== 5042 ? (
                <Button primary onClick={wallet.switchNetwork}>
                  Switch to Arc
                </Button>
              ) : progress.routerTx ? (
                <Button primary onClick={activate} disabled={locked}>
                  Authorize & activate Hookbrew
                </Button>
              ) : (
                <Button onClick={prepare} disabled={locked || !i}>
                  {busy
                    ? 'Preparing…'
                    : `Prepare ${progress.factoryTx ? 'router' : 'factory'} deployment`}
                </Button>
              )}
              {prepared && (
                <div className="deployment-review">
                  <h3>Review {prepared.kind} deployment</h3>
                  <p>
                    Factory / hook: <code>{prepared.factory}</code>
                  </p>
                  <p>
                    Estimated gas:{' '}
                    <strong>{number(formatUnits(prepared.gasCost, 18), 6)} native USDC</strong>
                  </p>
                  <p>
                    The fee destination is fixed at deployment. Review your treasury above before
                    signing.
                  </p>
                  <Button primary onClick={deploy} disabled={locked}>
                    Deploy {prepared.kind} with wallet
                  </Button>
                </div>
              )}
              {status && <p role="status">{status}</p>}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <TransactionStatus tx={tx} />
              {
                <details>
                  <summary>Deployment records</summary>
                  <p>
                    Save these transaction hashes if moving to a public host. No private key is
                    stored here.
                  </p>
                  <pre>{JSON.stringify(progress, null, 2)}</pre>
                  <Button
                    disabled={locked || !progress.factoryTx}
                    onClick={() => {
                      const blob = new Blob([JSON.stringify(progress, null, 2)], {
                        type: 'application/json',
                      })
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = 'hookbrew-deployment-progress.json'
                      a.click()
                      URL.revokeObjectURL(url)
                    }}
                  >
                    Export record
                  </Button>
                  <label className="studio-field">
                    <span>Restore deployment record</span>
                    <input
                      type="file"
                      accept="application/json"
                      disabled={locked}
                      onChange={async (e) => {
                        try {
                          if (!e.target.files?.[0]) return
                          if (e.target.files[0].size > 10000)
                            throw Error('Deployment record is too large.')
                          const value = JSON.parse(await e.target.files[0].text())
                          if (
                            value.chainId !== 5042 ||
                            !/^0x[\da-f]{64}$/i.test(value.factoryTx) ||
                            (value.routerTx && !/^0x[\da-f]{64}$/i.test(value.routerTx))
                          )
                            throw Error('Invalid deployment record.')
                          localStorage.setItem(key, JSON.stringify(value))
                          setProgress(value)
                          setPrepared(null)
                        } catch (e) {
                          setError(e.message)
                        }
                      }}
                    />
                  </label>
                </details>
              }
            </>
          )}
        </Glass>
        <aside>
          <Glass className="setup-aside" radius={24}>
            <FlaskConical size={36} />
            <h3>Separate from Hooker.</h3>
            <p>
              This is Hookbrew’s own source and deployment. The shared Uniswap V4 infrastructure
              supplies the pool engine.
            </p>
            <div className="product-note">
              <Shield size={18} />
              <p>
                Local lifecycle tests cover real V4 launches and swaps. These new contracts have not
                had an independent security audit.
              </p>
            </div>
            <p className="fine-print">
              Before launching tokens, run this app on a persistent HTTPS host with
              HOOKBREW_PUBLIC_URL set. Keep its data directory backed up for token artwork and
              metadata.
            </p>
          </Glass>
        </aside>
      </div>
    </>
  )
}
