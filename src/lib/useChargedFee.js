// The platform fee to show before someone signs: the fee their transaction will actually carry.
import { useEffect, useState } from 'react'
import { chargedPlatformFee } from './amounts.js'
import { treasuryBalance } from './solana.js'
import { RENT_EXEMPT_MINIMUM } from './txflow.js'

// While the treasury is not rent-exempt its balance is re-read this often, so a fee that becomes
// payable (someone funds the treasury) shows up without a reload.
const RECHECK_MS = 60_000

/**
 * The platform fee a trade or dev buy of `lamports` will be charged: chargedPlatformFee, the rule
 * platformFeeInstruction builds the transfer by, applied to the treasury balance. The balance is
 * read once (and re-read every minute until the treasury is rent-exempt, after which it is never
 * read again), so typing an amount costs no RPC calls. Until the first read lands the balance is
 * unknown, which, like an unreadable balance when building, leaves out fees below the rent minimum.
 */
export function useChargedPlatformFee(platform, lamports) {
  const treasury = platform?.treasury || null
  const feeBps = platform?.feeBps || 0
  const [read, setRead] = useState({ treasury: null, balance: null })
  useEffect(() => {
    if (!treasury || !feeBps) return
    let live = true
    let timer
    const check = async () => {
      const balance = await treasuryBalance(treasury)
      if (!live) return
      setRead({ treasury, balance })
      if (balance == null || balance < RENT_EXEMPT_MINIMUM) timer = setTimeout(check, RECHECK_MS)
    }
    check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [treasury, feeBps])
  return chargedPlatformFee(
    platform,
    lamports ?? 0n,
    read.treasury === treasury ? read.balance : null,
  )
}
