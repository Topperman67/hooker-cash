// Solana wallets through the Wallet Standard (Phantom, Solflare, Backpack, Glow, …). Transactions
// are simulated, signed by the wallet one prompt at a time and sent through Quant Pad's RPC proxy,
// then confirmed by polling.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getWallets } from '@wallet-standard/app'
import { connection, confirmSignature, friendlyWalletError, solBalance } from '../lib/solana.js'
import { walletSendAll } from '../lib/txflow.js'

const CHAIN = 'solana:mainnet'
const STORAGE_KEY = 'quantpad:wallet'
const WalletContext = createContext(null)

const isSolanaWallet = (wallet) =>
  wallet.chains?.some((c) => c.startsWith('solana:')) &&
  'standard:connect' in wallet.features &&
  ('solana:signTransaction' in wallet.features ||
    'solana:signAndSendTransaction' in wallet.features)

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
function writeStored(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function WalletProvider({ children }) {
  const [wallets, setWallets] = useState([])
  const [wallet, setWallet] = useState(null)
  const [account, setAccount] = useState(null)
  const [balance, setBalance] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const restored = useRef(false)

  useEffect(() => {
    const api = getWallets()
    const refresh = () => setWallets(api.get().filter(isSolanaWallet))
    refresh()
    const offRegister = api.on('register', refresh)
    const offUnregister = api.on('unregister', refresh)
    return () => {
      offRegister()
      offUnregister()
    }
  }, [])

  const select = useCallback(async (target, { silent = false } = {}) => {
    setError('')
    setBusy(!silent)
    try {
      const { accounts } = await target.features['standard:connect'].connect(
        silent ? { silent: true } : undefined,
      )
      const next =
        accounts.find((a) => a.chains?.includes(CHAIN)) || accounts[0] || target.accounts[0]
      if (!next) throw Error('The wallet did not share an account.')
      setWallet(target)
      setAccount(next)
      writeStored(target.name)
      setDialogOpen(false)
      return next
    } catch (e) {
      if (!silent) setError(friendlyWalletError(e))
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  // Reconnect the last wallet silently once it registers.
  useEffect(() => {
    if (restored.current || !wallets.length) return
    const name = readStored()
    const target = name && wallets.find((w) => w.name === name)
    if (!target) return
    restored.current = true
    select(target, { silent: true })
  }, [wallets, select])

  // Follow account switches inside the wallet.
  useEffect(() => {
    if (!wallet?.features['standard:events']) return
    return wallet.features['standard:events'].on('change', ({ accounts }) => {
      if (!accounts) return
      setAccount(accounts[0] || null)
      if (!accounts.length) writeStored(null)
    })
  }, [wallet])

  const address = account?.address || null
  const refreshBalance = useCallback(async () => {
    if (!address) return setBalance(null)
    try {
      setBalance(await solBalance(address))
    } catch {}
  }, [address])
  useEffect(() => {
    refreshBalance()
    if (!address) return
    const timer = setInterval(refreshBalance, 20000)
    return () => clearInterval(timer)
  }, [address, refreshBalance])

  const disconnect = useCallback(async () => {
    try {
      await wallet?.features['standard:disconnect']?.disconnect()
    } catch {}
    setWallet(null)
    setAccount(null)
    setBalance(null)
    writeStored(null)
  }, [wallet])

  // One wallet prompt per transaction, in order, each shown only after the one before it confirmed:
  // simulated first (one that would fail is refused before the wallet sees it), signed by the
  // wallet before any extra `signers` (the launch's mint key), then sent and confirmed. Resolves to
  // confirmed signatures only. On failure the error carries `completed` (the signatures that
  // confirmed), `failedIndex` / `failedSignature` (the one that did not) and `unknown` when that
  // transaction may still land. See walletSendAll.
  const sendTransactions = useCallback(
    async (transactions, { lastValidBlockHeight, signers = [], onStatus } = {}) => {
      if (!wallet || !account) throw Error('Connect a wallet first.')
      if (!transactions.length) return []
      try {
        return await walletSendAll(transactions, {
          wallet,
          account,
          chain: CHAIN,
          signers,
          lastValidBlockHeight,
          onStatus,
          rpc: {
            simulate: (tx) =>
              connection
                .simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
                .then((r) => r.value),
            sendRaw: (bytes) =>
              connection.sendRawTransaction(bytes, {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
              }),
            latestBlockhash: () => connection.getLatestBlockhash('confirmed'),
            confirm: confirmSignature,
          },
        })
      } finally {
        refreshBalance()
      }
    },
    [wallet, account, refreshBalance],
  )

  // Stable identities: they do not change when wallets, busy, error or balance do.
  const openDialog = useCallback(() => {
    setError('')
    setDialogOpen(true)
  }, [])
  const closeDialog = useCallback(() => setDialogOpen(false), [])

  const value = useMemo(
    () => ({
      wallets,
      wallet,
      address,
      balance,
      busy,
      error,
      connected: !!address,
      dialogOpen,
      openDialog,
      closeDialog,
      select,
      disconnect,
      refreshBalance,
      sendTransactions,
    }),
    [
      wallets,
      wallet,
      address,
      balance,
      busy,
      error,
      dialogOpen,
      openDialog,
      closeDialog,
      select,
      disconnect,
      refreshBalance,
      sendTransactions,
    ],
  )
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export const useWallet = () => useContext(WalletContext)
