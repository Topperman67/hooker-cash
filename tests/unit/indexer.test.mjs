import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../../server/application.mjs'
import { createIndexer } from '../../server/indexer.mjs'
import { sharedStore } from '../fixtures/shared-store.mjs'
import { arcInfrastructure, treasury } from '../../server/settings.mjs'
import abi from '../../src/generated/protocol.json' with { type: 'json' }

const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const config = { ...arcInfrastructure, treasury, factory: `0x${'11'.repeat(20)}`, startBlock: 1 }
function clientFixture() {
  return {
    getChainId: async () => arcInfrastructure.chainId,
    getBlockNumber: async () => 5n,
    getBlock: async ({ blockNumber }) => ({
      hash: hash(blockNumber),
      timestamp: 100n + blockNumber,
    }),
    getLogs: async () => [],
  }
}

test('custom indexing rotates across cold instances and reaches every registered recipe', async () => {
  const store = sharedStore(),
    visited = new Set(),
    client = clientFixture()
  client.getLogs = async ({ address }) => {
    visited.add(address)
    return []
  }
  const hooks = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      hash(i + 1),
      {
        ...config,
        factory: `0x${(i + 100).toString(16).padStart(40, '0')}`,
        recipeHash: hash(i + 1),
      },
    ]),
  )
  await store.set('hooks', hooks)
  for (let i = 0; i < 3; i++) {
    const app = await createApplication({ store, client, serverless: true })
    try {
      await app.sync()
    } finally {
      app.close()
    }
  }
  assert.equal(visited.size, 8)
  for (const h of Object.values(hooks)) {
    const saved = await store.get(`index:${config.chainId}:${h.factory}`)
    assert.equal(saved.cursor, 3)
    assert.equal(saved.error, null)
  }
})

test('a reorganization during a batch cannot commit mixed chain data', async () => {
  const store = sharedStore(),
    client = clientFixture()
  let forked = false
  client.getBlock = async ({ blockNumber }) => ({
    hash: hash(blockNumber + (forked ? 100n : 0n)),
    timestamp: 100n,
  })
  client.getLogs = async () => {
    forked = true
    return []
  }
  const first = createIndexer({ store, client, config, abi, dataDir: '.' })
  await first.sync()
  const failed = await store.get(`index:${config.chainId}:${config.factory}`)
  assert.equal(failed.cursor, 0)
  assert.equal(failed.blockHash, null)
  assert.match(failed.error, /Chain changed/)
  const next = createIndexer({ store, client, config, abi, dataDir: '.' })
  await next.sync()
  assert.equal(next.status().cursor, 3)
  assert.equal(next.status().error, null)
})

test('failed index reloads cannot replace durable state with an empty checkpoint', async () => {
  const store = sharedStore(),
    key = `index:${config.chainId}:${config.factory}`
  const checkpoint = {
    factory: config.factory,
    chainId: config.chainId,
    cursor: 3,
    blockHash: hash(3),
    tokens: {},
    trades: {},
    error: null,
  }
  await store.set(key, checkpoint)
  const get = store.get
  store.get = async (name) => {
    if (name === key) throw Error('private RPC credentials')
    return get(name)
  }
  const indexer = createIndexer({ store, client: clientFixture(), config, abi, dataDir: '.' })
  await indexer.sync()
  assert.deepEqual(await get(key), checkpoint)
  assert.doesNotMatch(indexer.status().error, /private|credentials/)
})
