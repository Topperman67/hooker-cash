import { Navigate, useSearchParams } from 'react-router-dom'
import { isAddress } from 'viem'
import MarketPage from './MarketPage'
export default function TradePage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  return isAddress(token || '') ? (
    <Navigate to={`/token/${token}`} replace />
  ) : (
    <MarketPage trading />
  )
}
