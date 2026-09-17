import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify, parseEnv } from 'node:util'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRedisStore } from '../../server/storage.mjs'

const container = process.env.HOOKBREW_REDIS_TEST_CONTAINER
const remote = process.env.HOOKBREW_REDIS_TEST_ENV_FILE
  ? parseEnv(readFileSync(process.env.HOOKBREW_REDIS_TEST_ENV_FILE, 'utf8'))
  : null
const exec = promisify(execFile)
test(
  'Redis persistence, atomic activation, expiring authorization, quota and stale-writer fencing',
  { skip: !container && !remote },
  async () => {
    const prefix = `hookbrew-test:${randomUUID()}`
    const options = {
      url: remote
        ? remote.UPSTASH_REDIS_REST_URL || remote.KV_REST_API_URL
        : 'https://redis-fixture.invalid',
      token: remote
        ? remote.UPSTASH_REDIS_REST_TOKEN || remote.KV_REST_API_TOKEN
        : 'local-test-only',
      prefix,
      // Run the exact REST command payload against an isolated local Redis.
      async request(url, init) {
        if (remote) return fetch(url, init)
        assert.equal(url, 'https://redis-fixture.invalid')
        assert.equal(init.headers.Authorization, 'Bearer local-test-only')
        const args = JSON.parse(init.body)
        const { stdout } = await exec(
          'docker',
          ['exec', container, 'redis-cli', '--json', ...args.map(String)],
          { windowsHide: true },
        )
        return new Response(JSON.stringify({ result: JSON.parse(stdout) }))
      },
    }
    const first = createRedisStore(options),
      second = createRedisStore(options)
    try {
      const results = await Promise.all([
        first.set('deployment', { factory: 'first' }, { nx: true }),
        second.set('deployment', { factory: 'second' }, { nx: true }),
      ])
      assert.equal(results.filter(Boolean).length, 1)
      assert.deepEqual(await first.get('deployment'), await second.get('deployment'))
      await first.set('challenge', { message: 'authorization' }, { ttl: 10000 })
      assert.equal((await second.get('challenge')).message, 'authorization')
      await first.set('expired', true, { ttl: 1 })
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(await second.get('expired'), null)

      await first.putMedia('one', Buffer.from('abc'), 5)
      await second.putMedia('one', Buffer.from('abc'), 5)
      assert.equal(Buffer.from(await second.get('media:one'), 'base64').toString(), 'abc')
      await assert.rejects(() => second.putMedia('two', Buffer.from('def'), 5), /storage is full/)
      assert.equal(await first.get('media:bytes'), 3)

      await first.set('index:lock', 'old-owner', { ttl: 1 })
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(await second.set('index:lock', 'new-owner', { nx: true, ttl: 10000 }), true)
      await first.release('index:lock', 'old-owner')
      assert.equal(await second.get('index:lock'), 'new-owner')
      await assert.rejects(
        () => first.saveIndex('index', { cursor: 1 }, 'old-owner'),
        /lease expired/,
      )
      await second.saveIndex('index', { cursor: 2 }, 'new-owner')
      assert.equal((await first.get('index')).cursor, 2)
      await second.release('index:lock', 'new-owner')
      assert.equal(await first.get('index:lock'), null)
    } finally {
      for (const key of [
        'deployment',
        'challenge',
        'expired',
        'media:one',
        'media:two',
        'media:bytes',
        'index',
        'index:lock',
      ])
        await first.delete(key)
    }
  },
)

test('Redis errors never expose credentials or upstream response bodies', async () => {
  const store = createRedisStore({
    url: 'https://redis-fixture.invalid',
    token: 'secret-fixture',
    request: async () =>
      new Response(JSON.stringify({ error: 'upstream details secret-fixture' }), { status: 401 }),
  })
  await assert.rejects(
    () => store.get('deployment'),
    (error) =>
      /storage is unavailable/.test(error.message) && !error.message.includes('secret-fixture'),
  )
})
