import { formatUnits } from 'viem'
import { ChevronRight } from 'lucide-react'
import { arc, explorerAddress } from '../config/network'
import { useWallet } from '../context/WalletContext'
import { Button, Modal } from './UI'
import WalletIcon from './WalletIcon'

export default function WalletDialog({ open, onClose }) {
  const wallet = useWallet()
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={wallet.account ? 'Your wallet' : 'Connect a wallet'}
    >
      <div className="dialog-icon">
        <WalletIcon wallet={wallet.selected} />
      </div>
      {wallet.account ? (
        <>
          <a
            className="wallet-address"
            href={explorerAddress(wallet.account)}
            target="_blank"
            rel="noreferrer"
          >
            {wallet.account}
          </a>
          <div className="preview-stat">
            <span>Wallet network</span>
            <span>{wallet.chainId === arc.id ? 'Arc' : `Chain ${wallet.chainId}`}</span>
          </div>
          {wallet.chainId === arc.id ? (
            <div className="preview-stat">
              <span>USDC balance</span>
              <span>
                {wallet.balance === null ? 'Unavailable' : formatUnits(wallet.balance, 18)}
              </span>
            </div>
          ) : (
            <Button primary disabled={wallet.busy} onClick={wallet.switchNetwork}>
              Switch to Arc
            </Button>
          )}
          {wallet.balanceError && (
            <p role="status" className="fine-print">
              Balance unavailable: {wallet.balanceError}
            </p>
          )}
          <Button className="full-width" disabled={wallet.busy} onClick={wallet.disconnect}>
            Disconnect
          </Button>
        </>
      ) : (
        <>
          <p>
            Select your installed wallet. Connecting requests your public account; it does not sign
            a transaction.
          </p>
          {wallet.wallets.map((item) => (
            <Button
              key={item.info.uuid}
              className="full-width wallet-option"
              disabled={wallet.busy}
              onClick={() => wallet.connect(item)}
            >
              <WalletIcon wallet={item} />
              <span>{wallet.busy ? 'Check your wallet…' : item.info.name}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          ))}
          {!wallet.wallets.length && (
            <p role="status">
              No wallet was detected. Open Hookbrew in a browser with an Ethereum-compatible wallet
              extension or your wallet’s in-app browser.
            </p>
          )}
        </>
      )}
      {wallet.error && (
        <p className="form-error" role="alert">
          {wallet.error}
        </p>
      )}
    </Modal>
  )
}
