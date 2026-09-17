import { createPublicClient, erc20Abi, fallback, getAddress, http, isAddress } from 'viem'
import { arc } from '../config/network'

export const publicClient = createPublicClient({
  chain: arc,
  transport: fallback(
    arc.rpcUrls.default.http.map((url) => http(url, { timeout: 10000, retryCount: 1 })),
  ),
})

export async function readNetwork() {
  const chainId = await publicClient.getChainId()
  if (chainId !== arc.id) throw new Error(`RPC returned chain ${chainId}; expected ${arc.id}.`)
  const block = await publicClient.getBlock()
  return {
    chainId,
    blockNumber: block.number.toString(),
    timestamp: Number(block.timestamp) * 1000,
    checkedAt: Date.now(),
  }
}

export async function readToken(input) {
  if (!isAddress(input)) throw new Error('Enter a valid token contract address.')
  const address = getAddress(input)
  const chainId = await publicClient.getChainId()
  if (chainId !== arc.id) throw new Error('The RPC is connected to a different network.')
  const blockNumber = await publicClient.getBlockNumber()
  const code = await publicClient.getCode({ address, blockNumber })
  if (!code || code === '0x') throw new Error('No contract exists at this address on Arc.')
  const call = (functionName) =>
    publicClient.readContract({ address, abi: erc20Abi, functionName, blockNumber })
  const [name, symbol, decimals, totalSupply] = await Promise.all(
    ['name', 'symbol', 'decimals', 'totalSupply'].map(call),
  )
  return {
    id: address,
    address,
    name,
    symbol,
    decimals,
    totalSupply,
    blockNumber: blockNumber.toString(),
    chainId,
    checkedAt: Date.now(),
  }
}

export function readableError(error) {
  let cause = error
  for (let depth = 0; cause && depth < 12; depth++, cause = cause.cause) {
    if (cause.code === 4001 || cause.name === 'UserRejectedRequestError')
      return 'The request was declined in your wallet.'
  }
  if (error?.code === -32002) return 'A wallet request is already open. Check your wallet.'
  return error?.shortMessage || error?.message || 'The request could not be completed.'
}
