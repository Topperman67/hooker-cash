import {
  createWalletClient,
  custom,
  erc20Abi,
  keccak256,
  decodeEventLog,
  parseAbi,
  encodeFunctionData,
} from 'viem'
import abis from '../generated/protocol.json'
import { publicClient } from './chain'
import { robinhood } from '../config/network'
import { network, hasNativeConfiguration } from '../../shared/network.mjs'
export { abis }
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
export const quoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
])
import { nativeBudget } from './protocolDraft.js'
export {
  amount,
  defaultDraft,
  launchParams,
  minimum,
  slippageBps,
  validateDraft,
} from './protocolDraft.js'
export async function checkWallet(wallet) {
  if (!wallet.account || !wallet.selected?.provider) throw Error('Connect your wallet first.')
  const provider = wallet.selected.provider
  const [accounts, chain] = await Promise.all([
    provider.request({ method: 'eth_accounts' }),
    provider.request({ method: 'eth_chainId' }),
  ])
  if (!same(accounts?.[0], wallet.account))
    throw Error('Wallet account changed. Review the transaction again.')
  if (Number(chain) !== robinhood.id)
    throw Error('Switch your wallet to Robinhood Chain before continuing.')
  return createWalletClient({
    chain: robinhood,
    account: wallet.account,
    transport: custom(provider),
  })
}
export async function verifyDeployment(d) {
  if (
    !d ||
    !['hookbrew-v2', 'hookbrew-modular-v2'].includes(d.abiVersion) ||
    d.chainId !== robinhood.id
  )
    throw Error('Deploy and activate Hookbrew v2 before submitting transactions.')
  if ((await publicClient.getChainId()) !== d.chainId) throw Error('RPC network mismatch.')
  if (!hasNativeConfiguration(d))
    throw Error('Deployment currency or launch fee does not match Robinhood ETH configuration.')
  const [fc, rc, treasury, quote, factory, launchFee, manager] = await Promise.all([
    publicClient.getCode({ address: d.factory }),
    publicClient.getCode({ address: d.router }),
    publicClient.readContract({
      address: d.factory,
      abi: abis.HookbrewFactory,
      functionName: 'treasury',
    }),
    publicClient.readContract({
      address: d.factory,
      abi: abis.HookbrewFactory,
      functionName: 'quote',
    }),
    publicClient.readContract({
      address: d.router,
      abi: abis.HookbrewRouter,
      functionName: 'factory',
    }),
    read(d.factory, abis.HookbrewFactory, 'launchFee'),
    read(d.factory, abis.HookbrewFactory, 'poolManager'),
  ])
  if (
    !fc ||
    !rc ||
    keccak256(fc) !== d.factoryCodeHash ||
    keccak256(rc) !== d.routerCodeHash ||
    !same(treasury, d.treasury) ||
    !same(quote, d.quote) ||
    launchFee !== BigInt(network.launchFee) ||
    !same(manager, d.poolManager) ||
    !same(factory, d.factory)
  )
    throw Error('Deployment verification failed. No transaction was sent.')
}
export async function simulate(wallet, request) {
  await checkWallet(wallet)
  const result = await publicClient.simulateContract({ ...request, account: wallet.account })
  const gas = await publicClient.estimateContractGas({ ...request, account: wallet.account })
  const gasPrice = await publicClient.getGasPrice()
  const native = await publicClient.getBalance({ address: wallet.account })
  if (native < nativeBudget(gas, gasPrice, request.value || 0n))
    throw Error('Insufficient ETH for the purchase, launch fee, and network gas together.')
  return { ...result, gas, gasCost: gas * gasPrice }
}
export async function send(wallet, request) {
  const client = await checkWallet(wallet)
  return client.writeContract(request)
}
export function transactionIdentity(wallet, request) {
  return {
    account: wallet.account,
    to: request.address,
    inputHash: keccak256(encodeFunctionData(request)),
    value: String(request.value || 0n),
  }
}
export const read = (address, abi, functionName, args = []) =>
  publicClient.readContract({ address, abi, functionName, args })
export async function balances(d, token, account, spender) {
  const input = token || d.quote
  if (same(input, network.quote))
    return {
      balance: await publicClient.getBalance({ address: account }),
      allowance: null,
      native: true,
    }
  const [balance, allowance] = await Promise.all([
    read(input, erc20Abi, 'balanceOf', [account]),
    read(input, erc20Abi, 'allowance', [account, spender]),
  ])
  return { balance, allowance }
}
export function approval(input, spender, value) {
  if (same(input, network.quote)) throw Error('Native ETH does not use token approvals.')
  return { address: input, abi: erc20Abi, functionName: 'approve', args: [spender, value] }
}
export async function quoteTrade(d, token, buy, input, account) {
  const poolKey = await read(d.factory, abis.HookbrewFactory, 'poolKey', [token])
  const { result } = await publicClient.simulateContract({
    address: d.quoter,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        poolKey,
        zeroForOne: same(poolKey.currency0, buy ? d.quote : token),
        exactAmount: input,
        hookData: '0x',
      },
    ],
    ...(account ? { account } : {}),
  })
  if (!result[0]) throw Error('No output is available for this trade.')
  return { output: result[0], gasEstimate: result[1], at: Date.now() }
}
export function eventFrom(receipt, address, abi, name) {
  for (const log of receipt.logs) {
    if (!same(log.address, address)) continue
    try {
      const event = decodeEventLog({ abi, ...log })
      if (event.eventName === name) return event.args
    } catch {}
  }
  throw Error(`Confirmed transaction is missing the expected ${name} event.`)
}
