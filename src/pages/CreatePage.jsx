import { useOutletContext } from 'react-router-dom'
import { launchDeployment } from '../config/launchDeployment'
import { PageHeading } from '../components/UI'
import LaunchForm from '../components/LaunchForm'
import LaunchStudio from '../components/LaunchStudio'
import ChainStatus from '../components/ChainStatus'
export default function CreatePage() {
  const { onConnect } = useOutletContext()
  // The separately reviewed historical adapter remains opt-in; its ABI is never
  // used for the new Hookbrew deployment returned by /api/status.
  if (!launchDeployment) return <LaunchStudio />
  return (
    <>
      <PageHeading
        title="Launch your token."
        description="Review the configured legacy deployment and sign with your wallet."
      />
      <div className="create-grid">
        <div className="create-main">
          <LaunchForm config={launchDeployment} onConnect={onConnect} />
        </div>
        <div className="create-aside">
          <ChainStatus />
        </div>
      </div>
    </>
  )
}
