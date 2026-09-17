import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../../src/lib/api.js'

test('API requests have a deadline and preserve explicit cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(
    globalThis,
    'fetch',
    async (_, { signal }) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
  )
  const timedOut = assert.rejects(api('/api/status'), /took too long/)
  t.mock.timers.tick(30000)
  await timedOut
  const controller = new AbortController()
  const cancelled = assert.rejects(api('/api/status', undefined, controller.signal), {
    name: 'AbortError',
  })
  controller.abort()
  await cancelled
  await assert.rejects(api('/api/status', undefined, controller.signal), { name: 'AbortError' })
})

test('API errors are readable, server validation survives, and successful JSON is returned', async (t) => {
  const mocked = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>outage</html>', { status: 502 }),
  )
  await assert.rejects(api('/api/status'), /unreadable response/)
  mocked.mock.mockImplementation(async () => {
    throw new TypeError('Failed to fetch')
  })
  await assert.rejects(api('/api/status'), /could not be reached/)
  mocked.mock.mockImplementation(async () =>
    Response.json({ error: 'Invalid recipe' }, { status: 400 }),
  )
  await assert.rejects(
    api('/api/hooks/register', {}),
    (e) => e.status === 400 && e.message === 'Invalid recipe',
  )
  mocked.mock.mockImplementation(async () => Response.json({ items: [] }))
  assert.deepEqual(await api('/api/market'), { items: [] })
})
