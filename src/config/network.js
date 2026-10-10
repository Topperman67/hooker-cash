import { defineChain } from 'viem'
import { network } from '../../shared/network.mjs'

export const robinhood = defineChain({
  id: network.chainId,
  name: network.name,
  nativeCurrency: { name: 'Ether', symbol: network.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
  blockExplorers: { default: { name: 'Robinhood Blockscout', url: network.explorerUrl } },
})
export const explorerAddress = (address) => network.explorerUrl + '/address/' + address
export const explorerTransaction = (hash) => network.explorerUrl + '/tx/' + hash
export function shortenAddress(address) {
  return address ? address.slice(0, 6) + '…' + address.slice(-4) : ''
}
