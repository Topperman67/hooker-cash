import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEther } from 'viem'
import { network, storageNamespace } from '../../shared/network.mjs'
import {
  maximumNativeSpend,
  nativeBudget,
  defaultDraft,
  validateDraft,
} from '../../src/lib/protocolDraft.js'
import { restoreDraft, draftKey } from '../../src/lib/launchDraft.js'
import { createApplication } from '../../server/application.mjs'
import { sharedStore } from '../fixtures/shared-store.mjs'
import { createRedisStore, configuredStore } from '../../server/storage.mjs'
import { eth } from '../../src/lib/api.js'
import {
  estimateNativeTransaction,
  assertCanonicalReceipt,
} from '../../src/lib/transactionChecks.js'
import { createHookRegistry } from '../../server/hooks.mjs'

test('deployment signing refreshes gas, balance and chain instead of trusting the review', async () => {
  let balance = 1000n,
    gasPrice = 2n,
    gas = 100n,
    chain = 4663
  const client = {
    getChainId: async () => chain,
    getGasPrice: async () => gasPrice,
    getBalance: async () => balance,
    estimateGas: async (request) => {
      assert.equal(request.gas, undefined)
      return gas
    },
  }
  const request = { gas: 1n, value: 500n }
  const check = () => estimateNativeTransaction(client, '0xabc', request)
  assert.equal((await check()).required, 740n)
  balance = 739n
  await assert.rejects(check, /Insufficient ETH/)
  balance = 1000n
  gasPrice = 5n
  await assert.rejects(check, /Insufficient ETH/)
  gasPrice = 2n
  gas = 250n
  await assert.rejects(check, /Insufficient ETH/)
  chain = 5042
  await assert.rejects(check, /RPC network mismatch/)
})

test('receipt confirmation rejects reorganizations and waits for two L2 blocks', async () => {
  const receipt = { blockNumber: 100n, blockHash: '0xabc' }
  let hash = receipt.blockHash,
    head = 101n
  const client = {
    getBlock: async () => ({ hash }),
    getBlockNumber: async () => head,
  }
  await assertCanonicalReceipt(client, receipt)
  head = 100n
  await assert.rejects(
    () => assertCanonicalReceipt(client, receipt),
    /pending transaction is saved/,
  )
  head = 102n
  hash = '0xdef'
  await assert.rejects(
    () => assertCanonicalReceipt(client, receipt),
    /pending transaction is saved/,
  )
})

test('native ETH prices, volumes and rewards remain visible below a cent', () => {
  assert.equal(eth('0.0004'), '0.0004')
  assert.equal(eth('0.00000000101234'), '0.00000000101234')
  assert.equal(eth('0.000000000000000001'), '0.000000000000000001')
  assert.equal(eth(0), '0')
})

test('native MAX estimates the full calldata, reserves gas and rechecks changed costs', async () => {
  const balance = parseEther('0.01'),
    gasPrice = 1000000000n
  const values = []
  const estimate = async (value) => {
    values.push(value)
    return value > balance / 2n ? 220000n : 200000n
  }
  const value = await maximumNativeSpend(balance, gasPrice, estimate)
  assert.equal(value, balance - nativeBudget(220000n, gasPrice))
  assert.ok(values.length >= 3)
  assert.equal(values.at(-1), value)
  await assert.rejects(() => maximumNativeSpend(100n, gasPrice, estimate), /enough ETH/)
  await assert.rejects(() => maximumNativeSpend(0n, gasPrice, estimate), /enough ETH/)
})

test('valuation boundaries and wei precision are enforced without a dollar conversion', () => {
  for (const targetMcap of ['0.5', '1', '5']) validateDraft({ ...defaultDraft, targetMcap }, 0)
  for (const targetMcap of ['0.499999999999999999', '5.000000000000000001', '5000'])
    assert.throws(() => validateDraft({ ...defaultDraft, targetMcap }, 0), /0.5–5 ETH/)
  assert.equal(network.launchFee, String(parseEther('0.0001')))
  assert.equal(network.quoteDecimals, 18)
  assert.equal(network.chainId, 4663)
})

test('Arc drafts cannot become ETH purchases or carry old custom deployments forward', () => {
  const storage = new Map([
    [
      'hookbrew:launch-draft:v1',
      JSON.stringify({ ...defaultDraft, name: 'Arc draft', initialBuy: '2500' }),
    ],
  ])
  assert.ok(draftKey.startsWith(storageNamespace))
  assert.deepEqual(restoreDraft({ getItem: (key) => storage.get(key) }), defaultDraft)
})

test('existing storage prefixes are suffixed with the new chain and version', async () => {
  const calls = []
  const store = createRedisStore({
    url: 'https://fixture.invalid',
    token: 'test',
    request: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return Response.json({ result: null })
    },
  })
  await store.get('deployment')
  assert.equal(calls[0][1], `${storageNamespace}:deployment`)
  assert.equal(configuredStore({}), null)
})

test('stored Arc deployments and old ABI versions are rejected before activation', async () => {
  for (const extra of [
    { chainId: 5042 },
    { abiVersion: 'hookbrew-v1' },
    { quote: '0x3600000000000000000000000000000000000000' },
    { launchFee: '1000000000000000000' },
    { quoteDecimals: 6 },
    { quoteIsNative: false },
    { quoteSymbol: 'USDC' },
    { minMcap: '500000000' },
    { maxMcap: '5000000000' },
    { defaultMcap: 1 },
  ]) {
    const store = sharedStore()
    await store.set('deployment', {
      ...network,
      abiVersion: 'hookbrew-v2',
      treasury: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4',
      ...extra,
    })
    const app = await createApplication({ store, serverless: true })
    await assert.rejects(() => app.sync(), /Stored deployment/)
    app.close()
    await store.set('hooks', {
      bad: { ...network, abiVersion: 'hookbrew-modular-v2', treasury: '0xabc', ...extra },
    })
    const hooks = createHookRegistry({
      store,
      infrastructure: network,
      treasury: '0xabc',
      dataDir: '.',
    })
    await assert.rejects(() => hooks.list(), /Stored hook/)
  }
})
