import { hookModules as modules } from '../data/hookModules'
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Shield,
  Timer,
  TrendingUp,
  ChartNoAxesCombined,
  Flame,
  Users,
  RefreshCw,
  Droplets,
  Blocks,
  ChevronLeft,
  ArrowUpRight,
  LockKeyhole,
  Plus,
  X,
} from 'lucide-react'
import { formatUnits, keccak256, toHex } from 'viem'
import { Button } from './UI'
import { Field } from './StudioFields'
import TransactionStatus from './TransactionStatus'
import { api, number, short, useResource } from '../lib/api'
import { publicClient, readableError } from '../lib/chain'
import { checkWallet, verifyDeployment } from '../lib/protocol'
import {
  emptyRecipe,
  normalizeRecipe,
  recipeHash,
  recipeModules,
  hookBuildData,
  mineHook,
} from '../lib/hookRecipe'
import { useTransaction } from '../lib/useTransaction'
import './hook-builder.css'

const needsOracle = (r) => r.buybackBps || r.liquidityBps
async function estimateHookGas(request, account) {
  // viem's generic estimator omits the supplied gas field. Bound this large CREATE2
  // simulation explicitly so nodes with a per-transaction cap can estimate it.
  const rpcRequest = {
    from: account,
    to: request.to,
    data: request.data,
    value: '0x0',
    gas: toHex(request.gas || 16_000_000n),
  }
  try {
    return BigInt(await publicClient.request({ method: 'eth_estimateGas', params: [rpcRequest] }))
  } catch (error) {
    // Some nodes multiply a successful estimate by three before enforcing their cap.
    // Prove a bounded gas limit with eth_call; never substitute an untested estimate.
    if (!/gas limit.*(?:cap|exceed)/i.test(error.details || error.message)) throw error
    let low = 0n,
      high = request.gas || 16_000_000n
    const probe = (gas) =>
      publicClient.request({
        method: 'eth_call',
        params: [{ ...rpcRequest, gas: toHex(gas) }, 'latest'],
      })
    await probe(high)
    while (high - low > 50000n) {
      const mid = (high + low) / 2n
      try {
        await probe(mid)
        high = mid
      } catch (e) {
        if (
          !/revert|out of gas|intrinsic gas|gas required|insufficient gas/i.test(
            e.details || e.message,
          )
        )
          throw e
        low = mid
      }
    }
    return high
  }
}
function FeeAllocation({ recipe }) {
  return (
    <div className="hook-allocation">
      <h4>Where harvested fees go</h4>
      {[
        [
          'USDC fees',
          [
            ['rewardBps', 'Holders'],
            ['buybackBps', 'Buyback'],
            ['liquidityBps', 'Liquidity'],
          ],
        ],
        [
          'Token fees',
          [
            ['burnBps', 'Burn'],
            ['liquidityBps', 'Liquidity'],
          ],
        ],
      ].map(([label, entries]) => {
        const parts = entries
          .map(([key, name]) => ({ key, name, percent: Number(recipe[key]) * 0.007 }))
          .filter((p) => p.percent)
        const keep = Math.max(0, 70 - parts.reduce((s, p) => s + p.percent, 0))
        return (
          <div className="hook-allocation-row" key={label}>
            <span>{label}</span>
            <div
              className="hook-allocation-bar"
              aria-label={`${label}: protocol 30%, creator ${number(keep, 2)}%${parts.map((p) => `, ${p.name} ${number(p.percent, 2)}%`).join('')}`}
            >
              <i className="hook-protocol" style={{ width: '30%' }} />
              <i className="hook-creator" style={{ width: `${keep}%` }} />
              {parts.map((p) => (
                <i key={p.key} data-module={p.key} style={{ width: `${p.percent}%` }} />
              ))}
            </div>
            <p>
              Protocol <b>30%</b> · You <b>{number(keep, 2)}%</b>
              {parts.map((p) => (
                <span key={p.key}>
                  {' '}
                  · {p.name} <b>{number(p.percent, 2)}%</b>
                </span>
              ))}
            </p>
          </div>
        )
      })}
      <small>
        Module percentages come from your 70% creator share. The protocol’s 30% stays unchanged.
      </small>
    </div>
  )
}
export default function HookBuilder({ draft, update, input, wallet, platform, onConnect, onBusy }) {
  const hook = draft.hook,
    recipe = hook?.recipe || emptyRecipe
  const [view, setView] = useState(hook?.mode === 'custom' ? 'builder' : 'presets')
  const [prepared, setPrepared] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [browse, setBrowse] = useState(false),
    [recoveryHash, setRecoveryHash] = useState('')
  const generation = useRef(0)
  const community = useResource(browse ? '/api/hooks' : null, 0)
  const selected = hook?.deployment
  const tx = useTransaction('hook-build', async (receipt, record) => {
    const { deployment } = await api('/api/hooks/register', {
      recipe: record.recipe,
      transactionHash: receipt.transactionHash,
    })
    await verifyDeployment(deployment)
    update('hook', { mode: 'custom', recipe: record.recipe, deployment })
    setPrepared(null)
    setStatus('Hook confirmed. Continue to your token details.')
  })
  const locked = busy || tx.busy || !!tx.pending
  useEffect(() => {
    onBusy(locked)
    return () => onBusy(false)
  }, [locked, onBusy])
  useEffect(() => {
    generation.current++
    setPrepared(null)
  }, [hook?.recipe, wallet.account, wallet.chainId])
  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )
  function choose(recipe) {
    update('hook', { mode: 'custom', recipe, deployment: null })
    setView('builder')
    setError('')
    setStatus('')
    setPrepared(null)
  }
  function change(key, value) {
    const next = { ...recipe, [key]: value }
    if (key === 'startCapBps' && !value) next.endCapBps = 0
    if (key === 'startCapBps' && value && !next.endCapBps) next.endCapBps = 1000
    if (next.interval || next.startCapBps) next.window ||= 300
    else next.window = 0
    if (needsOracle(next)) next.oracle = true
    choose(next)
  }
  async function prepare() {
    setBusy(true)
    setError('')
    setPrepared(null)
    const version = ++generation.current
    try {
      const canonical = normalizeRecipe(recipe),
        hash = recipeHash(canonical)
      const current = await platform.refresh()
      if (!current || current.storage?.ready === false)
        throw Error(current?.storage?.error || 'Launch service unavailable. Retry shortly.')
      const existing = await api(`/api/hooks/${hash}`)
      if (version !== generation.current) return
      if (existing.deployment) {
        await verifyDeployment(existing.deployment)
        if (version === generation.current)
          setPrepared({ existing: existing.deployment, recipe: canonical })
        setStatus('This exact recipe is already built. Reuse it without a deployment transaction.')
        return
      }
      await checkWallet(wallet)
      const i = current.infrastructure
      const [pack, factory] = await Promise.all(
        ['HookbrewHookPackage', 'HookbrewModularFactory'].map(async (name) => {
          const r = await fetch(`/protocol/${name}.json`)
          if (!r.ok) throw Error('Hook build artifact is unavailable.')
          return r.json()
        }),
      )
      const proxy = await publicClient.getCode({ address: i.create2 })
      if (
        proxy !==
        '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
      )
        throw Error('Deployment infrastructure verification failed.')
      const build = hookBuildData(pack, factory, i, current.treasury, canonical)
      const mined = await mineHook(
        i,
        build,
        (n) => setStatus(`Preparing your hook address… ${n.toLocaleString()} checked`),
        () => generation.current !== version,
      )
      if (await publicClient.getCode({ address: mined.packageAddress }))
        throw Error(
          'This recipe is already on-chain but is not registered yet. Retry its original build confirmation to register it.',
        )
      const request = { to: i.create2, data: mined.data, value: 0n }
      const [gas, gasPrice, balance] = await Promise.all([
        estimateHookGas(request, wallet.account),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address: wallet.account }),
      ])
      if (balance < (gas * gasPrice * 120n) / 100n)
        throw Error('Your wallet needs more native USDC for the hook-build network fee.')
      request.gas = (gas * 120n) / 100n
      if (generation.current === version) {
        setPrepared({
          ...mined,
          request,
          recipe: canonical,
          gasCost: gas * gasPrice,
          account: wallet.account,
          at: Date.now(),
        })
        setStatus('Ready for your wallet confirmation.')
      }
    } catch (e) {
      if (generation.current === version) {
        setError(readableError(e))
        setStatus('')
      }
    } finally {
      setBusy(false)
    }
  }
  async function assemble() {
    await tx.run(async (setStatus) => {
      if (
        !prepared ||
        Date.now() - prepared.at > 120000 ||
        prepared.account !== wallet.account ||
        recipeHash(prepared.recipe) !== recipeHash(recipe)
      )
        throw Error('Review the hook build again to refresh its estimate.')
      const client = await checkWallet(wallet)
      const current = await platform.refresh()
      if (!current || current.storage?.ready === false)
        throw Error('Hook registration is unavailable. Retry before signing.')
      await publicClient.call({ ...prepared.request, account: wallet.account })
      setStatus(
        'Confirm the hook build in your wallet. This deploys contracts; it does not launch your token.',
      )
      const hash = await client.sendTransaction(prepared.request)
      return {
        hash,
        recipe: prepared.recipe,
        account: wallet.account,
        to: prepared.request.to,
        inputHash: keccak256(prepared.request.data),
        value: '0',
      }
    })
  }
  async function recover() {
    setBusy(true)
    setError('')
    const version = ++generation.current
    try {
      const canonical = normalizeRecipe(recipe)
      const { deployment } = await api('/api/hooks/register', {
        recipe: canonical,
        transactionHash: recoveryHash.trim(),
      })
      await verifyDeployment(deployment)
      if (version === generation.current) {
        update('hook', { mode: 'custom', recipe: canonical, deployment })
        setStatus('Build recovered. Your hook is ready for Stage 3.')
      }
    } catch (e) {
      if (version === generation.current) setError(readableError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hook-studio">
      <div className="hook-base-note">
        <Shield size={19} />
        <p>
          Always included: <strong>{Number(draft.fee) / 10000}% pool fee</strong>, 70/30
          creator–protocol split, and permanently locked seed liquidity. Modules add rules to this
          base.
        </p>
      </div>
      {view === 'presets' ? (
        <>
          <div className="hook-presets">
            <button
              type="button"
              className="hook-preset"
              aria-pressed={hook?.mode !== 'custom' && !draft.guarded}
              onClick={() => {
                update('hook', null)
                update('guarded', false)
              }}
            >
              <span className="hook-preset-symbol">
                <Blocks />
              </span>
              <strong>Open market</strong>
              <p>The essentials. Free trading from launch with fees routed to your recipients.</p>
              <span className="hook-chips">
                <small>Base hook</small>
                <small>No build needed</small>
              </span>
              {hook?.mode !== 'custom' && !draft.guarded && (
                <Check className="hook-selected-check" size={18} />
              )}
            </button>
            <button
              type="button"
              className="hook-preset"
              aria-pressed={hook?.mode !== 'custom' && draft.guarded}
              onClick={() => {
                update('hook', null)
                update('guarded', true)
              }}
            >
              <span className="hook-preset-symbol peach">
                <Shield />
              </span>
              <strong>Guarded opening</strong>
              <p>Ease into trading with rising buy limits and optional spacing between buys.</p>
              <span className="hook-chips">
                <small>Opening protection</small>
                <small>No build needed</small>
              </span>
              {hook?.mode !== 'custom' && draft.guarded && (
                <Check className="hook-selected-check" size={18} />
              )}
            </button>
            <button
              type="button"
              className="hook-preset"
              onClick={() => choose({ ...emptyRecipe, burnBps: 2000, rewardBps: 4000 })}
            >
              <span className="hook-preset-symbol rose">
                <Flame />
              </span>
              <strong>Burn & reward</strong>
              <p>Burn token fees and share USDC fees with holders. A ready-to-build recipe.</p>
              <span className="hook-chips">
                <small>20% fee burn</small>
                <small>40% holder rewards</small>
              </span>
            </button>
            <button
              type="button"
              className="hook-preset hook-custom-preset"
              onClick={() => {
                if (hook?.mode === 'custom') setView('builder')
                else choose({ ...emptyRecipe })
              }}
            >
              <span className="hook-preset-symbol">
                <Plus />
              </span>
              <strong>Build a custom hook</strong>
              <p>Assemble your own rules. Configure, review, and build once in your wallet.</p>
              <span className="hook-chips">
                <small>7 modules</small>
                <small>Your recipe</small>
              </span>
              <ArrowUpRight size={18} className="hook-selected-check" />
            </button>
          </div>
          {hook?.mode !== 'custom' && draft.guarded && (
            <div className="launch-inset">
              <h3>Configure your guard</h3>
              <div className="product-grid-2">
                {[
                  ['window', 'Guard duration · seconds', 1, 3600, 1],
                  ['interval', 'Global buy spacing · seconds', 0, 60, 1],
                  ['startCap', 'Starting buy cap · %', 0.01, 50, 0.01],
                  ['endCap', 'Ending buy cap · %', 0.01, 50, 0.01],
                ].map(([key, label, min, max, step]) => (
                  <Field key={key} label={label}>
                    {input(key, { type: 'number', min, max, step })}
                  </Field>
                ))}
              </div>
              <p className="fine-print">
                Sells stay open. The founder buy is exempt. Guards expire automatically.
              </p>
            </div>
          )}
          {selected && (
            <div className="hook-confirmed">
              <Check size={18} />
              <div>
                <strong>Your custom hook is selected</strong>
                <p>
                  {recipeModules(recipe).join(' · ') || 'Base economics'} ·{' '}
                  {short(selected.factory)}
                </p>
              </div>
              <Button onClick={() => setView('builder')}>View recipe</Button>
            </div>
          )}
          <Button onClick={() => setBrowse(!browse)}>
            {browse ? 'Hide' : 'Browse'} community hooks
          </Button>
          {browse && (
            <div className="hook-community">
              {community.loading ? (
                <p>Loading confirmed hooks…</p>
              ) : community.error ? (
                <p role="alert">{community.error}</p>
              ) : !community.data?.items?.length ? (
                <p>
                  No community recipes have been built yet. Your confirmed hook will appear here.
                </p>
              ) : (
                community.data.items.map((d) => (
                  <button
                    key={d.factory}
                    type="button"
                    onClick={() => {
                      update('hook', { mode: 'custom', recipe: d.recipe, deployment: d })
                      setView('builder')
                    }}
                  >
                    <Blocks size={20} />
                    <span>
                      <strong>{recipeModules(d.recipe).join(' + ') || 'Base recipe'}</strong>
                      <small>{short(d.factory)} · Confirmed on Arc</small>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                ))
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="hook-builder-toolbar">
            <button type="button" disabled={locked} onClick={() => setView('presets')}>
              <ChevronLeft size={16} /> Back to presets
            </button>
            <span>
              <LockKeyhole size={13} /> Settings become immutable when built
            </span>
          </div>
          <div className="hook-builder-layout">
            <div className="hook-module-list">
              <div className="hook-process">
                <span>Trade</span>
                <i />
                <span data-lit={!!(recipe.interval || recipe.startCapBps)}>Opening rules</span>
                <i />
                <span>Pool</span>
                <i />
                <span data-lit={!!(recipe.burnBps || recipe.rewardBps || needsOracle(recipe))}>
                  Harvest
                </span>
              </div>
              {['opening', 'value'].map((group) => (
                <section className="hook-module-group" key={group}>
                  <div className="hook-group-heading">
                    <div>
                      <h3>{group === 'opening' ? 'Shape the opening' : 'Put your fees to work'}</h3>
                      <p>
                        {group === 'opening'
                          ? 'Rules at the swap. Price history for market actions.'
                          : 'Choose how much of your creator share each module uses.'}
                      </p>
                    </div>
                    <span>
                      {modules.filter((m) => m.group === group && recipe[m.key]).length} installed
                    </span>
                  </div>
                  {group === 'opening' && (recipe.interval || recipe.startCapBps) ? (
                    <Field
                      label="Opening window · seconds"
                      hint="Shared by buy spacing and the rising buy cap. 1–3,600 seconds."
                    >
                      <input
                        type="number"
                        min="1"
                        max="3600"
                        value={recipe.window}
                        disabled={locked}
                        onChange={(e) => change('window', Number(e.target.value))}
                      />
                    </Field>
                  ) : null}
                  {modules
                    .filter((m) => m.group === group)
                    .map((m) => {
                      const installed = !!recipe[m.key],
                        Icon = m.icon
                      return (
                        <article
                          className="hook-module"
                          data-installed={installed}
                          data-color={m.color}
                          key={m.key}
                        >
                          <div className="hook-module-heading">
                            <span className="hook-module-icon">
                              <Icon size={20} />
                            </span>
                            <h4>{m.title}</h4>
                            <button
                              type="button"
                              disabled={locked || (m.key === 'oracle' && !!needsOracle(recipe))}
                              aria-label={`${installed ? 'Remove' : 'Install'} ${m.title}`}
                              onClick={() =>
                                change(
                                  m.key,
                                  installed ? (m.key === 'oracle' ? false : 0) : m.value,
                                )
                              }
                            >
                              {installed ? <Check size={13} /> : <Plus size={13} />}{' '}
                              {installed ? 'Installed' : 'Install'}
                            </button>
                          </div>
                          <p>{m.text}</p>
                          <details>
                            <summary>How it works</summary>
                            <p>{m.detail}</p>
                          </details>
                          {installed && m.key !== 'oracle' && (
                            <div className="hook-module-settings">
                              {m.group === 'value' ? (
                                <Field label={`${m.title} · % of creator share`}>
                                  <div className="hook-percent-input">
                                    <input
                                      type="range"
                                      aria-label={`${m.title} · % of creator share`}
                                      min="1"
                                      max="100"
                                      step="1"
                                      value={recipe[m.key] / 100}
                                      disabled={locked}
                                      onChange={(e) => change(m.key, Number(e.target.value) * 100)}
                                    />
                                    <output>{number(recipe[m.key] / 100)}%</output>
                                  </div>
                                </Field>
                              ) : m.key === 'interval' ? (
                                <Field label="Seconds between buys">
                                  <input
                                    type="number"
                                    min="1"
                                    max="60"
                                    value={recipe.interval}
                                    disabled={locked}
                                    onChange={(e) => change('interval', Number(e.target.value))}
                                  />
                                </Field>
                              ) : (
                                <div className="product-grid-2">
                                  {[
                                    ['startCapBps', 'Starting cap · %'],
                                    ['endCapBps', 'Ending cap · %'],
                                  ].map(([key, label]) => (
                                    <Field key={key} label={label}>
                                      <input
                                        type="number"
                                        min="0.01"
                                        max="50"
                                        step="0.01"
                                        value={recipe[key] / 100}
                                        disabled={locked}
                                        onChange={(e) =>
                                          change(key, Math.round(Number(e.target.value) * 100))
                                        }
                                      />
                                    </Field>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {m.key === 'oracle' && needsOracle(recipe) ? (
                            <small>Required by your market modules</small>
                          ) : null}
                        </article>
                      )
                    })}
                </section>
              ))}
            </div>
            <aside className="hook-artifact" aria-label="Your assembled hook">
              <div className="hook-artifact-title">
                <Blocks size={21} />
                <span>Your hook</span>
                <small>{selected ? 'Confirmed' : 'Draft recipe'}</small>
              </div>
              <div className="hook-sockets">
                {['opening', 'value'].map((group) => (
                  <div key={group}>
                    <span>{group === 'opening' ? 'Trade' : 'Harvest'}</span>
                    {modules
                      .filter((m) => m.group === group)
                      .map((m) => {
                        const Icon = m.icon
                        return (
                          <span
                            className="hook-socket"
                            data-active={!!recipe[m.key]}
                            data-color={m.color}
                            title={m.title}
                            key={m.key}
                          >
                            <Icon size={19} />
                          </span>
                        )
                      })}
                  </div>
                ))}
                <div className="hook-foundation">
                  <Shield size={16} />
                  <span>
                    Hookbrew base<small>70/30 split · Locked liquidity</small>
                  </span>
                  <LockKeyhole size={13} />
                </div>
              </div>
              <h3>
                {recipeModules(recipe).length
                  ? `${recipeModules(recipe).length} modules. One hook.`
                  : 'Start with the essentials.'}
              </h3>
              <p className="hook-artifact-copy">
                {selected
                  ? 'Your recipe is confirmed on-chain and ready for the token launch.'
                  : 'Install modules, review your recipe, then confirm one build transaction in your wallet.'}
              </p>
              <FeeAllocation recipe={recipe} />
              {selected && (
                <a
                  className="hook-contract-link"
                  href={`https://explorer.arc.io/address/${selected.factory}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(selected.factory)}
                  <ArrowUpRight size={14} />
                </a>
              )}
              {prepared?.request && (
                <div className="hook-build-cost">
                  <span>Estimated network fee</span>
                  <strong>{number(formatUnits(prepared.gasCost, 18), 6)} USDC</strong>
                  <small>One-time contract deployment. No Hookbrew build fee.</small>
                  <span>
                    Hook address <b>{short(prepared.factory)}</b>
                  </span>
                </div>
              )}
              {selected ? (
                <div className="hook-ready">
                  <Check size={16} /> Ready for Stage 3
                </div>
              ) : prepared?.existing ? (
                <Button
                  primary
                  disabled={locked}
                  onClick={() => {
                    update('hook', {
                      mode: 'custom',
                      recipe: prepared.recipe,
                      deployment: prepared.existing,
                    })
                    setPrepared(null)
                  }}
                >
                  Use existing hook
                </Button>
              ) : !wallet.account ? (
                <Button primary disabled={locked} onClick={onConnect}>
                  Connect wallet to build
                </Button>
              ) : wallet.chainId !== 5042 ? (
                <Button primary disabled={locked} onClick={wallet.switchNetwork}>
                  Switch to Arc
                </Button>
              ) : prepared?.request ? (
                <Button primary disabled={locked} onClick={assemble}>
                  Confirm & build hook
                </Button>
              ) : (
                <Button primary disabled={locked} onClick={prepare}>
                  {busy ? 'Preparing hook…' : 'Review hook build'}
                </Button>
              )}
              {status && (
                <p className="hook-build-status" role="status">
                  {status}
                </p>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <TransactionStatus tx={tx} />
              {!selected && !tx.pending && (
                <details className="hook-recovery">
                  <summary>Recover a confirmed build</summary>
                  <p>
                    Use the build transaction from your wallet history. Set the same modules above;
                    the server verifies that the receipt matches.
                  </p>
                  <Field label="Hook build transaction hash">
                    <input
                      value={recoveryHash}
                      disabled={locked}
                      onChange={(e) => setRecoveryHash(e.target.value)}
                      placeholder="0x…"
                      spellCheck="false"
                    />
                  </Field>
                  <Button
                    disabled={locked || !/^0x[\da-f]{64}$/i.test(recoveryHash.trim())}
                    onClick={recover}
                  >
                    Verify existing build
                  </Button>
                </details>
              )}
              <p className="hook-build-footnote">
                New modular contracts. Independently unaudited. Building a hook does not launch or
                buy a token.
              </p>
            </aside>
          </div>
        </>
      )}
    </div>
  )
}
