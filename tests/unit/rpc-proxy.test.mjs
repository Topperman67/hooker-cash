import test from 'node:test'
import assert from 'node:assert/strict'
import { createRpcProxy } from '../../server/rpc-proxy.mjs'
import { createLimiter } from '../../server/request-limits.mjs'

const req = (origin = 'https://quantpad.test', host = 'quantpad.test') => ({
  headers: { origin, host },
  socket: { remoteAddress: '203.0.113.9' },
})
const call = (method, id = 1) => ({ jsonrpc: '2.0', id, method, params: [] })

test('forwards allowed methods (single and batch) to the private endpoint', async () => {
  const seen = []
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid/?api-key=hidden',
    limiter: createLimiter({}),
    request: async (url, init) => {
      seen.push(url)
      const body = JSON.parse(init.body)
      const reply = (c) => ({ jsonrpc: '2.0', id: c.id, result: c.method })
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)))
    },
  })
  assert.deepEqual((await proxy(req(), call('getSlot'))).body.result, 'getSlot')
  const batch = await proxy(req(), [call('getBalance', 1), call('getLatestBlockhash', 2)])
  assert.deepEqual(
    batch.body.map((r) => r.result),
    ['getBalance', 'getLatestBlockhash'],
  )
  assert.equal(seen[0], 'https://rpc.invalid/?api-key=hidden')
})

test('refuses heavy or unknown methods, foreign origins and oversized batches', async () => {
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: createLimiter({}),
    request: async () => assert.fail('must not call upstream'),
  })
  await assert.rejects(() => proxy(req(), call('getProgramAccounts')), { status: 403 })
  await assert.rejects(() => proxy(req('https://evil.test'), call('getSlot')), { status: 403 })
  await assert.rejects(
    () =>
      proxy(
        req(),
        Array.from({ length: 26 }, (_, i) => call('getSlot', i)),
      ),
    /between 1 and 25/,
  )
  await assert.rejects(() => proxy(req(), { method: 'getSlot' }), /Invalid JSON-RPC/)
})

test('rate limits per visitor across batch cost', async () => {
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid',
    limiter: createLimiter({}),
    request: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 })),
  })
  const batch = Array.from({ length: 25 }, (_, i) => call('getSlot', i))
  for (let i = 0; i < 36; i++) await proxy(req(), batch)
  await assert.rejects(() => proxy(req(), batch), { status: 429 })
})

test('never relays non-JSON upstream bodies that could echo the provider URL', async () => {
  const proxy = createRpcProxy({
    rpcUrl: 'https://rpc.invalid/?api-key=hidden',
    limiter: createLimiter({}),
    request: async () =>
      new Response('<html>bad gateway https://rpc.invalid/?api-key=hidden</html>', { status: 502 }),
  })
  const error = await proxy(req(), call('getSlot')).catch((e) => e)
  assert.equal(error.status, 502)
  assert.doesNotMatch(error.message, /hidden/)
})
