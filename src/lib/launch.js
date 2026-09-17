import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  zeroAddress,
} from 'viem'
import { launchAbi, launchPolicyAbi, launchHookAbi } from './launchAbi.js'

const sameAddress = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const bytes32 = (value) => /^0x[0-9a-fA-F]{64}$/.test(value || '')
const validAddress = (value) => isAddress(value || '') && !sameAddress(value, zeroAddress)
const byteLength = (value) => new TextEncoder().encode(value).length

export function validateDeployment(config) {
  if (!config) throw new Error('A launch deployment has not been selected.')
  if (config.chainId !== 5042 || config.abiVersion !== 'hooker-arc-v10')
    throw new Error('This launcher requires the reviewed Arc V10 interface.')
  for (const key of ['factory', 'policy', 'treasury', 'quote'])
    if (!validAddress(config[key])) throw new Error(`Invalid deployment ${key}.`)
  if (!sameAddress(config.quote, '0x3600000000000000000000000000000000000000'))
    throw new Error('This integration requires Arc USDC as its quote asset.')
  if (
    typeof config.sourceReference !== 'string' ||
    !config.sourceReference.trim() ||
    !/^\d+$/.test(String(config.startBlock))
  )
    throw new Error('Source reference and deployment block are required.')
  if (!Number.isInteger(config.poolFee) || config.poolFee <= 0 || config.poolFee >= 1000000)
    throw new Error('Invalid configured pool fee.')
  if (!/^\d+$/.test(config.totalSupply || '') || BigInt(config.totalSupply) <= 0n)
    throw new Error('An exact whole-token supply is required.')
  if (!bytes32(config.factoryCodeHash) || !bytes32(config.policyCodeHash))
    throw new Error('Reviewed factory and policy code hashes are required.')
  if (!Array.isArray(config.presets) || config.presets.length === 0)
    throw new Error('No reviewed hook presets are configured.')
  const ids = new Set()
  for (const preset of config.presets) {
    if (
      !preset.id ||
      ids.has(preset.id) ||
      !preset.name ||
      !validAddress(preset.address) ||
      !bytes32(preset.codeHash)
    )
      throw new Error('Invalid or duplicate hook preset configuration.')
    ids.add(preset.id)
  }
  return config
}

export function validateLaunchDraft(draft, config) {
  validateDeployment(config)
  const name = String(draft.name || '').trim()
  const symbol = String(draft.symbol || '').trim()
  const description = String(draft.description || '').trim()
  if (!name || byteLength(name) > 32) throw new Error('Token name must contain 1–32 UTF-8 bytes.')
  if (!symbol || byteLength(symbol) > 12) throw new Error('Symbol must contain 1–12 UTF-8 bytes.')
  if (byteLength(description) > 280) throw new Error('Description must fit within 280 UTF-8 bytes.')
  const preset = config.presets.find((item) => item.id === draft.presetId)
  if (!preset) throw new Error('Select a configured hook preset.')
  return { name, symbol, description, preset }
}

export async function readLaunchConfiguration(client, config) {
  validateDeployment(config)
  if ((await client.getChainId()) !== config.chainId)
    throw new Error('Launch RPC is on the wrong network.')
  const blockNumber = await client.getBlockNumber()
  if (blockNumber < BigInt(config.startBlock))
    throw new Error('RPC is behind the deployment block.')
  const contract = (address, abi, functionName, args) =>
    client.readContract({ address, abi, functionName, args, blockNumber })
  const [launchFee, policy, treasury, policyTreasury, quoteAllowed] = await Promise.all([
    contract(config.factory, launchAbi, 'launchFee'),
    contract(config.factory, launchAbi, 'policy'),
    contract(config.factory, launchAbi, 'treasury'),
    contract(config.policy, launchPolicyAbi, 'treasury'),
    contract(config.policy, launchPolicyAbi, 'allowedQuoteCurrency', [config.quote]),
  ])
  if (!sameAddress(policy, config.policy))
    throw new Error('The factory policy changed. Deployment review is required.')
  if (!sameAddress(treasury, config.treasury) || !sameAddress(policyTreasury, config.treasury))
    throw new Error('The protocol fee recipient changed. Deployment review is required.')
  if (!quoteAllowed) throw new Error('The policy no longer permits this quote asset.')
  const pinned = [
    { address: config.factory, codeHash: config.factoryCodeHash, name: 'Factory' },
    { address: config.policy, codeHash: config.policyCodeHash, name: 'Policy' },
    ...config.presets,
  ]
  for (const item of pinned) {
    const code = await client.getCode({ address: item.address, blockNumber })
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== item.codeHash.toLowerCase())
      throw new Error(`${item.name} code differs from the reviewed deployment.`)
  }
  return { launchFee, blockNumber, treasury, policy }
}

export async function prepareLaunch({ client, config, draft, account, reviewedFee }) {
  if (!validAddress(account)) throw new Error('Connect a wallet account first.')
  const fields = validateLaunchDraft(draft, config)
  const live = await readLaunchConfiguration(client, config)
  if (typeof reviewedFee !== 'bigint' || live.launchFee !== reviewedFee)
    throw new Error('The launch fee changed. Refresh and review the current fee before continuing.')
  const args = [
    fields.name,
    fields.symbol,
    parseUnits(config.totalSupply, 18),
    0n,
    fields.preset.address,
    config.poolFee,
    { description: fields.description, imageURI: '', website: '', twitter: '', telegram: '' },
    { vanitySalt: toHex(crypto.getRandomValues(new Uint8Array(32))), targetMcap: 0n },
    config.quote,
    0n,
    [],
  ]
  const data = encodeFunctionData({ abi: launchAbi, functionName: 'launch', args })
  const request = {
    account: getAddress(account),
    to: getAddress(config.factory),
    data,
    value: live.launchFee,
  }
  const balance = await client.getBalance({ address: account })
  if (balance <= live.launchFee)
    throw new Error('Insufficient native USDC for the launch fee and network gas.')
  const simulation = await client.simulateContract({
    address: config.factory,
    abi: launchAbi,
    functionName: 'launch',
    args,
    account,
    value: live.launchFee,
  })
  if (!validAddress(simulation.result))
    throw new Error('Launch simulation returned an invalid token address.')
  const [gas, gasPrice] = await Promise.all([client.estimateGas(request), client.getGasPrice()])
  if (balance < live.launchFee + gas * gasPrice)
    throw new Error('Insufficient native USDC for the estimated launch cost.')
  return {
    request,
    args,
    fields,
    live,
    predictedToken: getAddress(simulation.result),
    estimatedGas: gas,
    gasPrice,
  }
}

export async function assertWallet(provider, account, chainId) {
  const [accounts, network] = await Promise.all([
    provider.request({ method: 'eth_accounts' }),
    provider.request({ method: 'eth_chainId' }),
  ])
  if (!sameAddress(accounts?.[0], account))
    throw new Error('Wallet account changed. Review the launch again.')
  if (Number(network) !== chainId)
    throw new Error('Wallet network changed. Switch to Arc and review again.')
}

export async function sendPreparedLaunch({
  client,
  provider,
  config,
  prepared,
  isCurrent = () => true,
}) {
  validateDeployment(config)
  // No automatic retries of wallet requests. Re-read state and re-simulate the
  // EXACT calldata immediately before asking the wallet to send it.
  const live = await readLaunchConfiguration(client, config)
  if (live.launchFee !== prepared.request.value)
    throw new Error('Launch fee changed. Review the launch again.')
  await client.call(prepared.request)
  await assertWallet(provider, prepared.request.account, config.chainId)
  if (!isCurrent()) throw new Error('Launch review changed. No wallet request was sent.')
  return provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: prepared.request.account,
        to: prepared.request.to,
        data: prepared.request.data,
        value: toHex(prepared.request.value),
        chainId: toHex(config.chainId),
      },
    ],
  })
}

export async function verifyLaunchReceipt({ client, config, prepared, hash, onReplacement }) {
  validateDeployment(config)
  if ((await client.getChainId()) !== config.chainId)
    throw new Error('Receipt RPC is on the wrong network.')
  if (!bytes32(hash)) throw new Error('The wallet did not return a valid transaction hash.')
  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 180000,
    onReplaced: (replacement) => onReplacement?.(replacement.transactionReceipt.transactionHash),
  })
  if (receipt.status !== 'success')
    throw Object.assign(new Error('The launch transaction reverted on-chain.'), {
      code: 'LAUNCH_REVERTED',
    })
  const transaction = await client.getTransaction({ hash: receipt.transactionHash })
  if (
    !sameAddress(transaction.from, prepared.request.account) ||
    !sameAddress(transaction.to, config.factory) ||
    transaction.input !== prepared.request.data ||
    transaction.value !== prepared.request.value
  )
    throw new Error(
      'The confirmed transaction differs from the reviewed launch. Inspect it in the explorer.',
    )
  const events = receipt.logs
    .filter((log) => sameAddress(log.address, config.factory))
    .flatMap((log) => {
      try {
        return [decodeEventLog({ abi: launchAbi, ...log, strict: true })]
      } catch {
        return []
      }
    })
    .filter(
      (event) =>
        event.eventName === 'TokenLaunched' &&
        sameAddress(event.args.creator, prepared.request.account) &&
        sameAddress(event.args.hook, prepared.fields.preset.address) &&
        event.args.totalSupply === prepared.args[2] &&
        event.args.fee === config.poolFee &&
        event.args.creatorAllocation === prepared.args[3],
    )
  if (events.length !== 1)
    throw new Error(
      'The receipt does not contain one matching launch event. No token address can be confirmed.',
    )
  const token = getAddress(events[0].args.token)
  if (!sameAddress(token, prepared.predictedToken))
    throw new Error('Deployed token differs from the simulated address. Inspect the receipt.')
  const blockNumber = receipt.blockNumber
  const code = await client.getCode({ address: token, blockNumber })
  if (!code || code === '0x') throw new Error('The confirmed token has no deployed code.')
  const readToken = (functionName) =>
    client.readContract({ address: token, abi: erc20Abi, functionName, blockNumber })
  const [name, symbol, decimals, totalSupply, registered] = await Promise.all([
    readToken('name'),
    readToken('symbol'),
    readToken('decimals'),
    readToken('totalSupply'),
    client.readContract({
      address: prepared.fields.preset.address,
      abi: launchHookAbi,
      functionName: 'launchedToken',
      args: [token],
      blockNumber,
    }),
  ])
  if (
    name !== prepared.fields.name ||
    symbol !== prepared.fields.symbol ||
    decimals !== 18 ||
    totalSupply !== prepared.args[2] ||
    !registered
  )
    throw new Error('Post-launch contract state differs from the reviewed token details.')
  return {
    token,
    transactionHash: receipt.transactionHash,
    blockNumber,
    poolId: events[0].args.poolId,
    account: prepared.request.account,
  }
}
