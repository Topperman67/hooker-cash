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
import { arc } from '../config/network'
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
  if (Number(chain) !== arc.id) throw Error('Switch your wallet to Arc before continuing.')
  return createWalletClient({ chain: arc, account: wallet.account, transport: custom(provider) })
}
export async function verifyDeployment(d) {
  if (!d || !['hookbrew-v1', 'hookbrew-modular-v1'].includes(d.abiVersion) || d.chainId !== arc.id)
    throw Error('Deploy and activate Hookbrew v1 before submitting transactions.')
  if ((await publicClient.getChainId()) !== d.chainId) throw Error('RPC network mismatch.')
  const [fc, rc, treasury, quote, factory] = await Promise.all([
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
  ])
  if (
    !fc ||
    !rc ||
    keccak256(fc) !== d.factoryCodeHash ||
    keccak256(rc) !== d.routerCodeHash ||
    !same(treasury, d.treasury) ||
    !same(quote, d.quote) ||
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
  const quoteSpend =
    request.functionName === 'launch'
      ? request.args[0].initialBuy
      : request.functionName === 'swap' && request.args[1]
        ? request.args[2]
        : 0n
  if (native < nativeBudget(gas, gasPrice, request.value || 0n, quoteSpend))
    throw Error('Insufficient USDC for the purchase, launch fee, and network gas together.')
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
  const [balance, allowance] = await Promise.all([
    read(input, erc20Abi, 'balanceOf', [account]),
    read(input, erc20Abi, 'allowance', [account, spender]),
  ])
  return { balance, allowance }
}
export function approval(input, spender, value) {
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
