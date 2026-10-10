// Solana wallets through the Wallet Standard (Phantom, Solflare, Backpack, Glow, …). Transactions
// are signed by the wallet and sent through Quant Pad's RPC proxy, then confirmed by polling.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getWallets } from '@wallet-standard/app'
import { VersionedTransaction } from '@solana/web3.js'
import {
  connection,
  confirmSignature,
  friendlyWalletError,
  instructionPrograms,
  solBalance,
} from '../lib/solana.js'
import { sendAndConfirmAll, sendSigned } from '../lib/txflow.js'

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

  // Sign every transaction in one wallet prompt, then send and confirm them in order. Resolves to
  // confirmed signatures only. On failure the error carries `completed` (the signatures that
  // confirmed), `failedIndex` / `failedSignature` (the one that did not) and `unknown` when that
  // transaction may still land.
  const sendTransactions = useCallback(
    async (transactions, { lastValidBlockHeight, signers = [], onStatus } = {}) => {
      if (!wallet || !account) throw Error('Connect a wallet first.')
      if (!transactions.length) return []
      for (const tx of transactions) {
        const needed = tx.message.staticAccountKeys
          .slice(0, tx.message.header.numRequiredSignatures)
          .map((k) => k.toBase58())
        const local = signers.filter((s) => needed.includes(s.publicKey.toBase58()))
        if (local.length) tx.sign(local)
      }
      onStatus?.({ phase: 'sign', index: 0, total: transactions.length })
      let signed
      try {
        if (wallet.features['solana:signTransaction']) {
          const outputs = await wallet.features['solana:signTransaction'].signTransaction(
            ...transactions.map((tx) => ({ account, chain: CHAIN, transaction: tx.serialize() })),
          )
          signed = outputs.map((o) => VersionedTransaction.deserialize(o.signedTransaction))
        }
      } catch (e) {
        throw Object.assign(Error(friendlyWalletError(e)), { friendly: true, completed: [] })
      }
      const { default: bs58 } = await import('bs58')
      const programs = transactions.map(instructionPrograms)
      const send = async (i) => {
        if (signed) {
          // The signature is known before sending, so a send whose outcome is unclear can still
          // be looked up; re-sending the same bytes cannot execute twice, and a re-send refused
          // as "already processed" is confirmed by polling like any other send (sendSigned).
          return sendSigned(
            bs58.encode(signed[i].signatures[0]),
            () =>
              connection.sendRawTransaction(signed[i].serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
              }),
            { explain: (e) => friendlyWalletError(e, { programIds: programs[i] }) },
          )
        }
        try {
          const [output] = await wallet.features[
            'solana:signAndSendTransaction'
          ].signAndSendTransaction({
            account,
            chain: CHAIN,
            transaction: transactions[i].serialize(),
          })
          return bs58.encode(output.signature)
        } catch (e) {
          throw Object.assign(Error(friendlyWalletError(e, { programIds: programs[i] })), {
            friendly: true,
            cause: e,
          })
        }
      }
      try {
        return await sendAndConfirmAll(transactions.length, {
          send,
          confirm: (signature, i) =>
            confirmSignature(signature, lastValidBlockHeight, { programIds: programs[i] }),
          onStatus,
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
