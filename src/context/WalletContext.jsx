import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { getAddress, isAddress, toHex } from 'viem'
import { arc } from '../config/network'
import { publicClient, readableError } from '../lib/chain'

const WalletContext = createContext(null)
const normalizeAccount = (accounts) =>
  Array.isArray(accounts) && isAddress(accounts[0] || '') ? getAddress(accounts[0]) : null

export function WalletProvider({ children }) {
  const [wallets, setWallets] = useState([])
  const [selected, setSelected] = useState(null)
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [balance, setBalance] = useState(null)
  const [balanceError, setBalanceError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestId = useRef(0)
  const pending = useRef(false)

  useEffect(() => {
    function announce(event) {
      const detail = event.detail
      if (
        typeof detail?.info?.uuid !== 'string' ||
        typeof detail.info.name !== 'string' ||
        typeof detail.provider?.request !== 'function'
      )
        return
      setWallets((current) =>
        current.some((wallet) => wallet.provider === detail.provider)
          ? current
          : [...current, detail],
      )
    }
    window.addEventListener('eip6963:announceProvider', announce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    if (typeof window.ethereum?.request === 'function') {
      setWallets((current) =>
        current.some((wallet) => wallet.provider === window.ethereum)
          ? current
          : [
              ...current,
              { info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum },
            ],
      )
    }
    return () => window.removeEventListener('eip6963:announceProvider', announce)
  }, [])

  useEffect(() => {
    const provider = selected?.provider
    if (!provider) return
    const accountsChanged = (accounts) => {
      setAccount(normalizeAccount(accounts))
      setBalance(null)
    }
    const chainChanged = (id) => {
      setChainId(Number(id))
      setBalance(null)
    }
    const disconnected = () => {
      requestId.current++
      setAccount(null)
      setChainId(null)
      setBalance(null)
      setSelected(null)
    }
    provider.on?.('accountsChanged', accountsChanged)
    provider.on?.('chainChanged', chainChanged)
    provider.on?.('disconnect', disconnected)
    return () => {
      provider.removeListener?.('accountsChanged', accountsChanged)
      provider.removeListener?.('chainChanged', chainChanged)
      provider.removeListener?.('disconnect', disconnected)
    }
  }, [selected])

  useEffect(() => {
    setBalance(null)
    setBalanceError('')
    if (!account || chainId !== arc.id) return
    let active = true
    let timer
    async function refresh() {
      try {
        const rpcChain = await publicClient.getChainId()
        if (rpcChain !== arc.id) throw new Error('Balance RPC returned the wrong network.')
        const value = await publicClient.getBalance({ address: account })
        if (active) {
          setBalance(value)
          setBalanceError('')
        }
      } catch (error) {
        if (active) {
          setBalance(null)
          setBalanceError(readableError(error))
        }
      } finally {
        if (active) timer = setTimeout(refresh, 30000)
      }
    }
    refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [account, chainId])

  async function connect(wallet) {
    if (pending.current) return
    pending.current = true
    const id = ++requestId.current
    setBusy(true)
    setError('')
    try {
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' })
      const connectedAccount = normalizeAccount(accounts)
      if (!connectedAccount) throw new Error('The wallet did not expose an account.')
      const network = await wallet.provider.request({ method: 'eth_chainId' })
      if (id !== requestId.current) return
      setSelected(wallet)
      setAccount(connectedAccount)
      setChainId(Number(network))
    } catch (error) {
      if (id === requestId.current) setError(readableError(error))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function switchNetwork() {
    if (!selected || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    const id = requestId.current
    try {
      try {
        await selected.provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: toHex(arc.id) }],
        })
      } catch (error) {
        if (error.code !== 4902) throw error
        await selected.provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: toHex(arc.id),
              chainName: arc.name,
              nativeCurrency: arc.nativeCurrency,
              rpcUrls: arc.rpcUrls.default.http,
              blockExplorerUrls: [arc.blockExplorers.default.url],
            },
          ],
        })
        await selected.provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: toHex(arc.id) }],
        })
      }
      const network = Number(await selected.provider.request({ method: 'eth_chainId' }))
      if (id === requestId.current) setChainId(network)
      if (network !== arc.id) throw new Error('Your wallet is still on a different network.')
    } catch (error) {
      if (id === requestId.current) setError(readableError(error))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function disconnect() {
    requestId.current++
    setSelected(null)
    setAccount(null)
    setChainId(null)
    setBalance(null)
    setError('')
  }

  return (
    <WalletContext.Provider
      value={{
        wallets,
        selected,
        account,
        chainId,
        balance,
        balanceError,
        error,
        busy,
        connect,
        disconnect,
        switchNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  return useContext(WalletContext)
}
