import { network as chainConfig } from '../../shared/network.mjs'
import { Link } from 'react-router-dom'
import { useChain } from '../context/ChainContext'
import { usePlatform } from '../context/PlatformContext'
import Glass from './Glass'
import { Button } from './UI'

export default function ChainStatus({ deploymentStatus = true }) {
  const { status, network, error, retry } = useChain()
  const { deployment } = usePlatform()
  return (
    <Glass className="panel-pad chain-status" aria-label="Network and deployment status">
      <div className="preview-stat">
        <span>Robinhood Chain mainnet</span>
        <strong>
          {status === 'ready'
            ? 'RPC connected'
            : status === 'loading'
              ? 'Connecting…'
              : 'Connection unavailable'}
        </strong>
      </div>
      {network && (
        <div className="preview-stat">
          <span>{status === 'ready' ? 'Latest checked block' : 'Last successful block'}</span>
          <a
            href={`${chainConfig.explorerUrl}/block/${network.blockNumber}`}
            target="_blank"
            rel="noreferrer"
          >
            {network.blockNumber}
          </a>
        </div>
      )}
      {status === 'error' && (
        <>
          <p className="form-error" role="status">
            {error}
          </p>
          <Button onClick={retry}>Retry network</Button>
        </>
      )}
      {deploymentStatus && !deployment?.factory && (
        <p className="fine-print">
          Hookbrew’s contracts are ready for wallet-signed deployment. Activate your venue to open
          launches and trading.{' '}
          <Link to="/setup" className="text-link">
            Contract setup
          </Link>
        </p>
      )}
      {deploymentStatus && deployment?.factory && (
        <p className="fine-print">
          Hookbrew v2 active ·{' '}
          <a
            href={`${chainConfig.explorerUrl}/address/${deployment.factory}`}
            target="_blank"
            rel="noreferrer"
          >
            View factory ↗
          </a>
        </p>
      )}
    </Glass>
  )
}
