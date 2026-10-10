import { network } from '../../shared/network.mjs'
import { nativeBudget } from './protocolDraft.js'

// Run again immediately before requesting a signature: balances and fees can change
// while the review is open. Never constrain a new estimate by a saved gas limit.
export async function estimateNativeTransaction(client, account, request, estimate) {
  if ((await client.getChainId()) !== network.chainId) throw Error('RPC network mismatch.')
  const { gas: _previousGas, ...fresh } = request
  const [gas, gasPrice, balance] = await Promise.all([
    estimate ? estimate(fresh, account) : client.estimateGas({ ...fresh, account }),
    client.getGasPrice(),
    client.getBalance({ address: account }),
  ])
  const required = nativeBudget(gas, gasPrice, fresh.value || 0n)
  if (balance < required)
    throw Error(
      'Insufficient ETH for this transaction and its buffered network gas. Refresh the estimate after funding your wallet.',
    )
  return { gas, gasCost: gas * gasPrice, required, request: fresh }
}

export async function assertCanonicalReceipt(client, receipt) {
  const [block, head] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlockNumber({ cacheTime: 0 }),
  ])
  if (!receipt.blockHash || block.hash !== receipt.blockHash || head < receipt.blockNumber + 1n)
    throw Error(
      'The transaction receipt changed before two L2 confirmations. Your pending transaction is saved; retry confirmation.',
    )
}
