import { useCallback, useEffect, useRef, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { useWallet } from '../context/WalletContext.jsx'
import { useResource } from '../lib/api.js'
import { burnInstructions, burnPlan, burnTweet, pendingFor, suggestedBurn } from '../lib/burn.js'
import { formatUnits, parseUnits, short, sol, toSol } from '../lib/format.js'
import { connection, packTransactions } from '../lib/solana.js'
import { friendlyWalletError } from '../lib/txerrors.js'
import { QUANTP, explorer } from '../../shared/network.mjs'

// Dev-only page (App.jsx routes it only under `vite dev`): burns $QUANTP the team bought back,
// from the connected wallet, with Token-2022 BurnChecked. One transaction, simulated before the
// wallet prompts (WalletContext), sent only after a confirm. The amount starts at what the team's
// wallets bought and have not burned yet (/api/quantp/ledger: this wallet's own, once the ledger
// keeps them per wallet), capped at what this wallet holds, and empty when nothing waits. The
// payout engine's wallet is refused: the engine burns its tokens itself in its next hourly
// buyback, and signing here would mean putting the engine's key in a browser wallet.
const ENGINE = QUANTP.engine?.wallet
const TEAM = new Set([QUANTP.payoutWallet, ENGINE, QUANTP.creator].filter(Boolean))
const tokens = (raw) => `${formatUnits(raw, QUANTP.decimals)} $${QUANTP.symbol}`
// the amount field holds a plain decimal (formatUnits groups thousands with commas)
const plain = (raw) => formatUnits(raw, QUANTP.decimals).replaceAll(',', '')

/** The wallet's $QUANTP token accounts with a balance, as { address, amount }. */
async function quantpAccounts(owner) {
  const { value } = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(owner),
    { mint: new PublicKey(QUANTP.mint) },
    'confirmed',
  )
  return value
    .map(({ pubkey, account }) => ({
      address: pubkey.toBase58(),
      amount: BigInt(account.data.parsed.info.tokenAmount.amount),
    }))
    .filter((a) => a.amount > 0n)
}

export default function BurnPage() {
  const { connected, address, openDialog, sendTransactions } = useWallet()
  const ledger = useResource('/api/quantp/ledger', 30_000)
  const unburned = ledger.data?.totals?.unburned
  // this wallet's share of it (all of it from a ledger that pools the team's wallets)
  const pending = pendingFor(ledger.data?.totals, address)
  // { owner, list }: the token accounts belong to the wallet they were read for
  const [accounts, setAccounts] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(null) // { signature, amount, lamports }
  const [filledFor, setFilledFor] = useState(null) // the wallet whose amount was filled in
  const current = useRef(address)
  current.current = address

  // A read for the wallet before a switch never shows (or fills in) for the one after it.
  const list = accounts?.owner === address ? accounts.list : null
  const held = list?.reduce((s, a) => s + a.amount, 0n) ?? null
  const isEngine = !!address && address === ENGINE
  const load = useCallback(async () => {
    if (!address) return setAccounts(null)
    try {
      const read = await quantpAccounts(address)
      if (current.current === address) setAccounts({ owner: address, list: read })
    } catch (e) {
      if (current.current === address) setError(friendlyWalletError(e))
    }
  }, [address])
  useEffect(() => {
    load()
  }, [load])

  // Start, once per wallet, at what was bought back and not burned yet, or all it holds when
  // that is less; empty when nothing waits.
  const bought = pending ? BigInt(pending.amount) : 0n
  const suggested = suggestedBurn(held, bought)
  useEffect(() => {
    if (suggested == null || !pending || filledFor === address) return
    setFilledFor(address)
    setText(suggested > 0n && !isEngine ? plain(suggested) : '')
  }, [suggested, pending, filledFor, address, isEngine])

  const amount = parseUnits(text.replaceAll(',', ''), QUANTP.decimals) || null
  // the SOL these tokens were bought back with, in proportion, when the ledger knows it
  const lamports =
    amount && bought > 0n && amount <= bought ? (BigInt(pending.lamports) * amount) / bought : null

  async function burn() {
    setError('')
    if (isEngine) return
    let plan
    try {
      plan = burnPlan(list || [], amount)
    } catch (e) {
      return setError(e.message)
    }
    if (
      !window.confirm(
        `Burn ${tokens(amount)} from ${short(address)}? Burned tokens are gone for good.`,
      )
    )
      return
    try {
      setBusy('Checking')
      const { transactions, lastValidBlockHeight } = await packTransactions(
        address,
        [burnInstructions(address, plan)],
        { units: 40_000 },
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
      setDone({ signature, amount, lamports })
      setText('')
      await load()
      ledger.refresh()
    } catch (e) {
      setError(friendlyWalletError(e))
    } finally {
      setBusy('')
    }
  }

  const tweet = done && burnTweet(done)

  return (
    <div className="wrap section" style={{ display: 'grid', gap: 20 }}>
      <header>
        <h1 className="h3">${QUANTP.symbol} buyback burn</h1>
        <p className="muted">
          Burns ${QUANTP.symbol} from the connected wallet with a Token-2022 BurnChecked, which
          lowers the supply. The transaction is simulated before the wallet asks to sign.
        </p>
      </header>

      <div className="panel" style={{ padding: 16, display: 'grid', gap: 6 }}>
        <strong>Bought back, not burned yet</strong>
        <span className="muted">
          {unburned
            ? `${tokens(unburned.amount)} for ${sol(toSol(unburned.lamports), { digits: 4 })}, by the team’s wallets`
            : ledger.error || 'Reading the team’s wallets…'}
        </span>
      </div>

      <div className="panel" style={{ padding: 16, display: 'grid', gap: 12 }}>
        {!connected ? (
          <button className="btn btn-primary" onClick={openDialog}>
            Connect the wallet holding the ${QUANTP.symbol}
          </button>
        ) : (
          <>
            <div className="muted">
              Burning from <span className="num">{address}</span>
              {held != null && <> · holds {tokens(held)}</>}
            </div>
            {!TEAM.has(address) && (
              <p className="notice notice-warn">
                This is not one of the team’s wallets ({short(QUANTP.payoutWallet)} or{' '}
                {short(QUANTP.creator)}): the site’s Burns list will not show this burn.
              </p>
            )}
            {isEngine && (
              <p className="notice">
                The payout engine burns this wallet’s ${QUANTP.symbol} in its next hourly buyback.
              </p>
            )}
            <label className="field">
              <span className="label">Amount to burn</span>
              <span className="input-affix">
                <input
                  className="input num"
                  inputMode="decimal"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={!!busy || isEngine}
                />
                <span className="affix">${QUANTP.symbol}</span>
              </span>
            </label>
            {!isEngine && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {held > 0n && (
                  <button
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={() => setText(plain(held))}
                  >
                    All it holds
                  </button>
                )}
                {bought > 0n && held > 0n && (
                  <button
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={() => setText(plain(bought < held ? bought : held))}
                  >
                    What was bought back
                  </button>
                )}
              </div>
            )}
            {lamports != null && (
              <div className="muted">Bought back with about {sol(toSol(lamports))}</div>
            )}
            <button
              className="btn btn-primary"
              disabled={!!busy || isEngine || !amount || held == null || amount > held}
              onClick={burn}
            >
              {busy ||
                (isEngine
                  ? 'Burned by the payout engine'
                  : amount
                    ? `Burn ${tokens(amount)}`
                    : 'Enter an amount')}
            </button>
          </>
        )}
        {error && <p className="notice notice-error">{error}</p>}
      </div>

      {done && (
        <div className="panel" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <strong>
            Burned {tokens(done.amount)} ·{' '}
            <a href={explorer.tx(done.signature)} target="_blank" rel="noreferrer">
              {short(done.signature)}
            </a>
          </strong>
          <textarea className="textarea" readOnly rows={8} value={tweet} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(tweet)}>
            Copy tweet
          </button>
        </div>
      )}
    </div>
  )
}
