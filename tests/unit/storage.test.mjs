import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileStore, createRedisStore, configuredStore } from '../../server/storage.mjs'

test('file store: values, NX, TTL, counters, release and media quota', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-store-')))
  assert.equal(await store.get('missing'), null)
  assert.equal(await store.set('a', { x: 1 }), true)
  assert.deepEqual(await store.get('a'), { x: 1 })
  assert.equal(await store.set('a', 2, { nx: true }), false)
  assert.equal(await store.set('lease', 'owner-1', { nx: true, ttl: 50 }), true)
  assert.equal(await store.set('lease', 'owner-2', { nx: true, ttl: 50 }), false)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(
    await store.set('lease', 'owner-2', { nx: true, ttl: 5000 }),
    true,
    'expired lease can be taken',
  )
  await store.release('lease', 'owner-1')
  assert.equal(await store.get('lease'), 'owner-2', 'only the owner releases')
  await store.release('lease', 'owner-2')
  assert.equal(await store.get('lease'), null)
  assert.equal(await store.increment('n', 3), 3)
  assert.equal(await store.increment('n', 2), 5)
  assert.equal(await store.incrementExpiring('r', 1000), 1)
  assert.equal(await store.incrementExpiring('r', 1000), 2)
  await store.putMedia('one.png', Buffer.from('abc'), 5)
  await store.putMedia('one.png', Buffer.from('abc'), 5)
  assert.equal((await store.getMedia('one.png')).toString(), 'abc')
  await assert.rejects(() => store.putMedia('two.png', Buffer.from('def'), 5), /storage is full/)
  await assert.rejects(() => store.getMedia('nope.png'), { code: 'ENOENT' })
})

test('redis store sends prefixed commands and hides upstream errors', async () => {
  const sent = []
  const store = createRedisStore({
    url: 'https://redis.invalid',
    token: 'secret-token',
    prefix: 'p',
    request: async (url, init) => {
      sent.push(JSON.parse(init.body))
      assert.equal(init.headers.Authorization, 'Bearer secret-token')
      const [cmd] = JSON.parse(init.body)
      if (cmd === 'GET')
        return new Response(JSON.stringify({ result: JSON.stringify({ ok: true }) }))
      if (cmd === 'SET') return new Response(JSON.stringify({ result: 'OK' }))
      return new Response('upstream echoed https://redis.invalid?token=secret-token', {
        status: 500,
      })
    },
  })
  assert.deepEqual(await store.get('k'), { ok: true })
  assert.equal(await store.set('k', 1, { nx: true, ttl: 10 }), true)
  assert.deepEqual(sent[1], ['SET', 'p:k', '1', 'NX', 'PX', 10])
  const error = await store.increment('k').catch((e) => e)
  assert.equal(error.status, 503)
  assert.doesNotMatch(error.message, /secret-token|redis\.invalid/)
})

test('configured store requires both credentials and namespaces by environment', () => {
  assert.equal(configuredStore({}), null)
  assert.throws(() => configuredStore({ UPSTASH_REDIS_REST_URL: 'https://x.invalid' }), /both/)
  assert.ok(configuredStore({ KV_REST_API_URL: 'https://x.invalid', KV_REST_API_TOKEN: 't' }))
})
