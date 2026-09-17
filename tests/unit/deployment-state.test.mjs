import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApplication } from '../../server/application.mjs'
import { sharedStore } from '../fixtures/shared-store.mjs'
import { treasury, arcInfrastructure } from '../../server/settings.mjs'

async function fixture(run, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'hookbrew-state-test-'))
  const store = sharedStore()
  const apps = await Promise.all(
    [0, 1].map(() => createApplication({ dataDir, serverless: true, store, ...options })),
  )
  let next = 0
  const server = createServer((req, res) => apps[next++ % apps.length].middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = async (path, body) => {
    const response = await fetch(
      origin + path,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    return { status: response.status, data: await response.json() }
  }
  try {
    await run({ apps, store, call, origin, dataDir })
  } finally {
    apps.forEach((app) => app.close())
    await new Promise((r) => server.close(r))
    assert.ok(dataDir.startsWith(join(tmpdir(), 'hookbrew-state-test-')))
    await rm(dataDir, { recursive: true, force: true })
  }
}
const transactions = { factoryTx: `0x${'11'.repeat(32)}`, routerTx: `0x${'22'.repeat(32)}` }
const deployment = {
  ...arcInfrastructure,
  ...transactions,
  treasury,
  factory: `0x${'33'.repeat(20)}`,
  startBlock: 1,
}

test('warm instances observe activation; retries return existing deployment and conflicting receipts never replace it', async () => {
  await fixture(async ({ call, store }) => {
    assert.equal((await call('/api/status')).data.deployment, null)
    assert.equal((await call('/api/status')).data.deployment, null)
    await store.set('deployment', deployment)
    for (let i = 0; i < 4; i++)
      assert.deepEqual((await call('/api/status')).data.deployment, deployment)
    for (const path of ['/api/deployment/challenge', '/api/deployment/activate']) {
      const retry = await call(path, transactions)
      assert.equal(retry.status, 200)
      assert.equal(retry.data.alreadyActive, true)
      assert.deepEqual(retry.data.deployment, deployment)
      const conflict = await call(path, { ...transactions, routerTx: transactions.factoryTx })
      assert.equal(conflict.status, 409)
      assert.deepEqual(conflict.data.deployment, deployment)
    }
    assert.deepEqual(await store.get('deployment'), deployment)
  })
})
test('authorization survives a different instance but still requires the treasury signature', async () => {
  await fixture(
    async ({ call, store }) => {
      const { data: challenge } = await call('/api/deployment/challenge', transactions)
      assert.match(challenge.message, /Activate Hookbrew/)
      const rejected = await call('/api/deployment/activate', {
        ...transactions,
        ...challenge,
        signature: '0xdead',
      })
      assert.match(rejected.data.error, /treasury wallet/)
      assert.equal(await store.get('deployment'), null)
      const expired = await store.get(`challenge:${challenge.nonce}`)
      await store.set(`challenge:${challenge.nonce}`, { ...expired, expires: Date.now() - 1 })
      assert.match(
        (await call('/api/deployment/activate', { ...transactions, ...challenge })).data.error,
        /expired/,
      )
    },
    { client: { verifyMessage: async () => false } },
  )
})
test('metadata remains accessible from another instance and after a cold start', async () => {
  await fixture(async ({ call, apps, store, dataDir }) => {
    const created = await call('/api/metadata', { name: 'Brew', symbol: 'BREW' })
    assert.equal(created.status, 201)
    assert.match(created.data.uri, /^https:/)
    const path = new URL(created.data.uri).pathname
    apps.push(await createApplication({ dataDir, serverless: true, store }))
    for (let i = 0; i < 6; i++) assert.equal((await call(path)).data.name, 'Brew')
  })
})
test('unconfigured Vercel storage blocks activation and uploads before signatures or transactions', async () => {
  await fixture(
    async ({ call }) => {
      const status = await call('/api/status')
      assert.equal(status.data.storage.ready, false)
      for (const path of [
        '/api/deployment/challenge',
        '/api/deployment/activate',
        '/api/metadata',
      ]) {
        const response = await call(path, transactions)
        assert.equal(response.status, 503)
        assert.equal(response.data.code, 'STORAGE_UNCONFIGURED')
      }
    },
    { store: null },
  )
})
