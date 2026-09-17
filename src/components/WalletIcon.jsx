import { useState } from 'react'
import { Wallet } from 'lucide-react'
import { walletIconSource } from '../lib/walletBranding'

export default function WalletIcon({ wallet }) {
  const source = walletIconSource(wallet)
  const [failedSource, setFailedSource] = useState(null)
  return (
    <span className="wallet-logo" aria-hidden="true">
      {source && source !== failedSource ? (
        <img src={source} alt="" width="32" height="32" onError={() => setFailedSource(source)} />
      ) : (
        <Wallet size={23} />
      )}
    </span>
  )
}
