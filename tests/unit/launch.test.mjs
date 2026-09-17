import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseUnits,
} from 'viem'
import { launchAbi } from '../../src/lib/launchAbi.js'
import {
  assertWallet,
  prepareLaunch,
  readLaunchConfiguration,
  sendPreparedLaunch,
  validateLaunchDraft,
  verifyLaunchReceipt,
} from '../../src/lib/launch.js'

// Fixtures exist only in tests. The production deployment remains unset.
const address = (digit) => `0x${digit.repeat(40)}`
const account = address('1'),
  factory = address('2'),
  policy = address('3'),
  treasury = address('4'),
  hook = address('5'),
  token = address('6')
const hash = `0x${'a'.repeat(64)}`
const code = '0x60006000'
const config = {
  chainId: 5042,
  abiVersion: 'hooker-arc-v10',
  factory,
  policy,
  treasury,
  quote: '0x3600000000000000000000000000000000000000',
  sourceReference: 'test fixture only',
  startBlock: '1',
  poolFee: 10000,
  totalSupply: '1000000000',
  factoryCodeHash: keccak256(code),
  policyCodeHash: keccak256(code),
  presets: [{ id: 'plain', name: 'Plain test hook', address: hook, codeHash: keccak256(code) }],
}
const draft = {
  name: 'Test token',
  symbol: 'TEST',
  description: 'Test-only metadata',
  presetId: 'plain',
}
const fee = parseUnits('1', 18)
function fixture() {
  const state = { fee, treasury, chainId: 5042, code, status: 'success', tokenName: draft.name }
  const calls = []
  const client = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => 100n,
    getCode: async () => state.code,
    getBalance: async () => parseUnits('10', 18),
    getGasPrice: async () => 1000n,
    estimateGas: async () => 100000n,
    readContract: async ({ functionName }) =>
      ({
        launchFee: state.fee,
        policy,
        treasury: state.treasury,
        allowedQuoteCurrency: true,
        name: state.tokenName,
        symbol: draft.symbol,
        decimals: 18,
        totalSupply: parseUnits(config.totalSupply, 18),
        launchedToken: true,
      })[functionName],
    simulateContract: async (request) => {
      calls.push(request)
      return { result: token }
    },
    call: async (request) => {
      calls.push(request)
      return { data: token }
    },
  }
  return { state, calls, client }
}
const prepare = (client, changes = {}) =>
  prepareLaunch({ client, config, draft, account, reviewedFee: fee, ...changes })

test('validation counts UTF-8 bytes and rejects unknown hook selections', () => {
  assert.equal(validateLaunchDraft({ ...draft, name: '💧'.repeat(8) }, config).name.length, 16)
  assert.throws(() => validateLaunchDraft({ ...draft, name: '💧'.repeat(9) }, config), /32 UTF-8/)
  assert.throws(() => validateLaunchDraft({ ...draft, symbol: 'é'.repeat(7) }, config), /12 UTF-8/)
  assert.throws(
    () => validateLaunchDraft({ ...draft, description: '💧'.repeat(71) }, config),
    /280 UTF-8/,
  )
  assert.throws(
    () => validateLaunchDraft({ ...draft, presetId: 'unknown' }, config),
    /configured hook/,
  )
  assert.throws(() => validateLaunchDraft(draft, null), /not been selected/)
})

test('configuration checks reject changed recipient, bytecode and network', async () => {
  for (const [key, value, message] of [
    ['treasury', account, /fee recipient changed/],
    ['code', '0x6001', /code differs/],
    ['chainId', 1, /wrong network/],
  ]) {
    const { state, client } = fixture()
    state[key] = value
    await assert.rejects(readLaunchConfiguration(client, config), message)
  }
})

test('preparation encodes an actual no-buy launch and requires sufficient fees', async () => {
  const { client, calls, state } = fixture()
  const prepared = await prepare(client)
  const decoded = decodeFunctionData({ abi: launchAbi, data: prepared.request.data })
  assert.equal(decoded.functionName, 'launch')
  assert.equal(decoded.args[0], draft.name)
  assert.equal(decoded.args[2], parseUnits('1000000000', 18))
  assert.equal(decoded.args[3], 0n)
  assert.equal(decoded.args[9], 0n)
  assert.equal(prepared.request.value, fee)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].account, account)
  state.fee++
  await assert.rejects(prepare(client), /fee changed/)
  state.fee = fee
  client.getBalance = async () => fee
  await assert.rejects(prepare(client), /Insufficient/)
})

test('wallet send uses the exact reviewed call and never approves ERC-20 spending', async () => {
  const { client } = fixture()
  const prepared = await prepare(client)
  const requests = []
  const provider = {
    request: async (request) => {
      requests.push(request)
      return request.method === 'eth_accounts'
        ? [account]
        : request.method === 'eth_chainId'
          ? '0x13b2'
          : hash
    },
  }
  assert.equal(await sendPreparedLaunch({ client, provider, config, prepared }), hash)
  assert.equal(requests.filter((item) => item.method === 'eth_sendTransaction').length, 1)
  assert.deepEqual(requests.at(-1).params[0], {
    from: account,
    to: factory,
    data: prepared.request.data,
    value: '0xde0b6b3a7640000',
    chainId: '0x13b2',
  })
})

test('account/network changes, a cancelled review, and a declined signature never trigger retries', async () => {
  const { client } = fixture()
  const prepared = await prepare(client)
  let sends = 0
  const provider = {
    request: async ({ method }) => {
      if (method === 'eth_accounts') return [treasury]
      if (method === 'eth_chainId') return '0x13b2'
      sends++
      throw Object.assign(new Error('declined'), { code: 4001 })
    },
  }
  await assert.rejects(
    sendPreparedLaunch({ client, provider, config, prepared }),
    /account changed/,
  )
  assert.equal(sends, 0)
  await assert.rejects(
    assertWallet(
      { request: async ({ method }) => (method === 'eth_accounts' ? [account] : '0x1') },
      account,
      5042,
    ),
    /network changed/,
  )
  provider.request = async ({ method }) => {
    if (method === 'eth_accounts') return [account]
    if (method === 'eth_chainId') return '0x13b2'
    sends++
    throw Object.assign(new Error('declined'), { code: 4001 })
  }
  await assert.rejects(
    sendPreparedLaunch({ client, provider, config, prepared, isCurrent: () => false }),
    /review changed/,
  )
  assert.equal(sends, 0)
  await assert.rejects(sendPreparedLaunch({ client, provider, config, prepared }), /declined/)
  assert.equal(sends, 1)
})

function receiptFixture(prepared, state, client) {
  const event = launchAbi.find((item) => item.type === 'event' && item.inputs.length === 8)
  const log = {
    address: factory,
    topics: encodeEventTopics({
      abi: [event],
      eventName: 'TokenLaunched',
      args: { token, creator: account, hook },
    }),
    data: encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      [`0x${'b'.repeat(64)}`, 10000, 100000n, parseUnits(config.totalSupply, 18), 0n],
    ),
  }
  const receipt = { transactionHash: hash, blockNumber: 100n, status: 'success', logs: [log] }
  const transaction = { from: account, to: factory, input: prepared.request.data, value: fee }
  client.waitForTransactionReceipt = async () => ({ ...receipt, status: state.status })
  client.getTransaction = async () => transaction
  return { receipt, transaction, log }
}

test('a launch is confirmed only with matching transaction, event, deployed code and token state', async () => {
  const { client, state } = fixture()
  const prepared = await prepare(client)
  const { receipt, transaction, log } = receiptFixture(prepared, state, client)
  const verify = () => verifyLaunchReceipt({ client, config, prepared, hash })
  const result = await verify()
  assert.equal(result.token, token)
  assert.equal(result.transactionHash, hash)
  state.status = 'reverted'
  await assert.rejects(verify(), /reverted on-chain/)
  state.status = 'success'
  transaction.input = '0x'
  await assert.rejects(verify(), /differs from the reviewed/)
  transaction.input = prepared.request.data
  log.address = hook
  await assert.rejects(verify(), /matching launch event/)
  log.address = factory
  receipt.logs.push(log)
  await assert.rejects(verify(), /matching launch event/)
  receipt.logs.pop()
  state.code = '0x'
  await assert.rejects(verify(), /no deployed code/)
  state.code = code
  state.tokenName = 'Different token'
  await assert.rejects(verify(), /Post-launch contract state/)
})
