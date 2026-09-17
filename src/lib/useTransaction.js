import { useEffect, useRef, useState } from 'react'
import { publicClient, readableError } from './chain'
import { keccak256 } from 'viem'
const key = 'hookbrew:pending-transaction:v1'
let activeRequest = false
function load(scope) {
  try {
    const v = JSON.parse(sessionStorage.getItem(key))
    return v?.scope === scope && /^0x[\da-f]{64}$/i.test(v.hash) ? v : null
  } catch {
    return null
  }
}
// A submitted hash is persisted before confirmation. Retrying confirmation never resends funds.
export function useTransaction(scope, onSuccess) {
  const [pending, setPending] = useState(() => load(scope))
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState('')
  const lock = useRef(false),
    callback = useRef(onSuccess)
  callback.current = onSuccess
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function confirm(record) {
    setStatus('Waiting for two confirmations…')
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: record.hash,
      confirmations: 2,
      timeout: 120000,
      onReplaced: (replacement) => {
        record = { ...record, hash: replacement.transaction.hash }
        sessionStorage.setItem(key, JSON.stringify(record))
        setPending(record)
      },
    })
    if (receipt.status !== 'success') {
      sessionStorage.removeItem(key)
      setPending(null)
      throw Error('Transaction reverted. No launch or trade completed.')
    }
    const transaction = await publicClient.getTransaction({ hash: receipt.transactionHash })
    if (
      record.inputHash &&
      (keccak256(transaction.input) !== record.inputHash ||
        String(transaction.value) !== record.value ||
        transaction.from.toLowerCase() !== record.account.toLowerCase() ||
        String(transaction.to).toLowerCase() !== String(record.to).toLowerCase())
    ) {
      sessionStorage.removeItem(key)
      setPending(null)
      throw Error(
        'The transaction was replaced with a different action. It did not complete the reviewed request.',
      )
    }
    if (!mounted.current) return
    await callback.current?.(receipt, record)
    sessionStorage.removeItem(key)
    setPending(null)
    setStatus('Confirmed on Arc.')
  }
  async function run(prepare) {
    if (lock.current || pending) return
    if (activeRequest) {
      setError('Finish the wallet request already in progress.')
      return
    }
    activeRequest = true
    lock.current = true
    setBusy(true)
    setError('')
    setStatus('Checking transaction…')
    try {
      const other = JSON.parse(sessionStorage.getItem(key) || 'null')
      if (other)
        throw Error(
          'Another transaction needs confirmation. Return to its page before sending another.',
        )
      // Fail before asking for a signature if this browser cannot retain a receipt hash.
      sessionStorage.setItem(`${key}:check`, '1')
      sessionStorage.removeItem(`${key}:check`)
      const { hash, ...details } = await prepare(setStatus)
      const record = { ...details, scope, hash }
      setPending(record)
      sessionStorage.setItem(key, JSON.stringify(record))
      await confirm(record)
    } catch (e) {
      setError(readableError(e))
      setStatus('')
    } finally {
      lock.current = false
      activeRequest = false
      setBusy(false)
    }
  }
  async function resume() {
    if (lock.current || !pending || activeRequest) return
    activeRequest = true
    lock.current = true
    setBusy(true)
    setError('')
    try {
      await confirm(pending)
    } catch (e) {
      setError(readableError(e))
      setStatus('')
    } finally {
      lock.current = false
      activeRequest = false
      setBusy(false)
    }
  }
  return { run, resume, pending, busy, status, error, setError }
}
