import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApplication } from '../../server/application.mjs'
test('media API enforces origin, file type, size/quota, hash identity and safe metadata', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'hookbrew-media-test-'))
  const app = await createApplication({ dataDir, mediaLimitBytes: 1000 }),
    server = createServer((req, res) => app.middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, site = origin) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { Origin: site, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    assert.equal((await post('/api/media', { data: 'x' }, 'https://attacker.example')).status, 403)
    assert.equal(
      (await post('/api/media', { data: 'data:image/svg+xml;base64,PHN2Zz4=' })).status,
      400,
    )
    assert.equal((await post('/api/media', { data: 'data:image/png;base64,YWJjZA==' })).status, 400)
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII='
    const one = await post('/api/media', { data: png }),
      a = await one.json(),
      b = await (await post('/api/media', { data: png })).json()
    assert.equal(one.status, 201)
    assert.equal(a.url, b.url)
    const file = await fetch(a.url)
    assert.equal(file.headers.get('content-type'), 'image/png')
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(file.status, 200)
    assert.equal(
      (
        await post('/api/metadata', {
          name: 'Brew',
          symbol: 'BREW',
          website: 'javascript:alert(1)',
        })
      ).status,
      400,
    )
    assert.equal(
      (await post('/api/metadata', { name: '🧪'.repeat(9), symbol: 'BREW' })).status,
      400,
    )
    const metadata = await post('/api/metadata', {
      name: 'Brew',
      symbol: 'BREW',
      image: a.url,
      description: 'Test metadata',
    })
    assert.equal(metadata.status, 201)
    const meta = await (await fetch((await metadata.json()).uri)).json()
    assert.equal(meta.image, a.url)
    assert.equal(meta.name, 'Brew')
    const big = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(950)])
    assert.equal(
      (await post('/api/media', { data: 'data:image/png;base64,' + big.toString('base64') }))
        .status,
      507,
    )
    assert.equal((await fetch(origin + '/media/not-a-hash.png')).status, 404)
  } finally {
    app.close()
    await new Promise((r) => server.close(r))
    assert.ok(dataDir.startsWith(join(tmpdir(), 'hookbrew-media-test-')))
    await rm(dataDir, { recursive: true, force: true })
  }
})
