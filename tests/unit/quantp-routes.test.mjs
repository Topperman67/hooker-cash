// The $QUANTP routes (server/application.mjs) with a stub ledger and engine, and the payout
// engine's own RPC connection (server/solana.mjs createConnection).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from '../../server/solana.mjs'

/** A JSON-RPC endpoint on localhost answering each call with `answer(n)` (n counts calls). */
async function rpcServer(answer) {
  let calls = 0
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => answer(++calls, res))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls: () => calls,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}

test('the engine’s connection gives up on a call after its timeout, and on a 429 at once', async () => {
  // never answers
  const silent = await rpcServer(() => {})
  try {
    const started = Date.now()
    await assert.rejects(() =>
      createConnection(silent.url, { timeoutMs: 300 }).getSlot('confirmed'),
    )
    assert.ok(Date.now() - started < 3_000, 'aborted at the timeout')
  } finally {
    await silent.close()
  }
  // rate limited: one call, no retries
  const limited = await rpcServer((n, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"},"id":"1"}')
  })
  try {
    const connection = createConnection(limited.url, {
      timeoutMs: 2_000,
      disableRetryOnRateLimit: true,
    })
    await assert.rejects(() => connection.getSlot('confirmed'), /429/)
    assert.equal(limited.calls(), 1)
  } finally {
    await limited.close()
  }
  // an answering node is read as usual, and the default connection sets no timeout
  const fine = await rpcServer((n, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","result":457000000,"id":"1"}')
  })
  try {
    assert.equal(await createConnection(fine.url, { timeoutMs: 2_000 }).getSlot(), 457000000)
    assert.equal(await createConnection(fine.url).getSlot(), 457000000)
  } finally {
    await fine.close()
  }
})
