import { defineChain } from 'viem'
import { launchDeployment } from './launchDeployment.js'

// Arc's official network settings: https://docs.arc.io/arc/references/connect-to-arc
// Native USDC uses 18 decimals; the ERC-20 interface uses 6. Never interchange units.
export const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

export const deployment = Object.freeze(
  launchDeployment || {
    chainId: arc.id,
    factory: null,
    sourceCommit: null,
    startBlock: null,
  },
)

export function explorerAddress(address) {
  return `${arc.blockExplorers.default.url}/address/${address}`
}

export function shortenAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''
}
