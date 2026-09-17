import test from 'node:test'
import assert from 'node:assert/strict'
import { createWriteGuard } from '../../server/request-limits.mjs'
import { sharedStore } from '../fixtures/shared-store.mjs'
const request = (ip = '192.0.2.1') => ({
  headers: { host: 'hookbrew.test', origin: 'https://hookbrew.test', 'x-forwarded-for': ip },
  socket: { remoteAddress: '127.0.0.1' },
})
test('Vercel write limits survive cold starts, isolate visitors and reset each minute', async () => {
  const store = sharedStore()
  let clock = 60000
  const options = { store, vercel: true, now: () => clock }
  for (let i = 0; i < 30; i++) await createWriteGuard(options)(request())
  await assert.rejects(() => createWriteGuard(options)(request()), { status: 429 })
  await createWriteGuard(options)(request('192.0.2.2'))
  clock += 60000
  await createWriteGuard(options)(request())
})
test('local hosts ignore spoofed IP headers and reject absent or foreign origins', async () => {
  const guard = createWriteGuard({ now: () => 60000 })
  for (let i = 0; i < 30; i++) await guard(request(`192.0.2.${i}`))
  await assert.rejects(() => guard(request('192.0.2.200')), { status: 429 })
  for (const origin of [
    undefined,
    'null',
    'not a url',
    'https://evil.test',
    'file://hookbrew.test',
  ]) {
    const req = request()
    req.headers.origin = origin
    await assert.rejects(() => guard(req), { status: 403 })
  }
})
