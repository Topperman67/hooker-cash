import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import headers from '../server/security-headers.json' with { type: 'json' }

let server, dataDir
const origin = 'http://127.0.0.1:4183'
test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'hookbrew-production-'))
  server = spawn(process.execPath, ['server/start.mjs'], {
    env: { ...process.env, PORT: '4183', HOOKBREW_DATA_DIR: dataDir },
    stdio: 'pipe',
    windowsHide: true,
  })
  let logs = ''
  server.stdout.on('data', (s) => {
    logs += s
  })
  server.stderr.on('data', (s) => {
    logs += s
  })
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error('Production server failed: ' + logs)
    try {
      if ((await fetch(origin + '/api/status')).ok) return
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw Error('Production server did not start: ' + logs)
})
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = new Promise((resolve) => server.once('exit', resolve))
    server.kill()
    await stopped
  }
  if (dataDir) {
    expect(dataDir.startsWith(join(tmpdir(), 'hookbrew-production-'))).toBe(true)
    await rm(dataDir, { recursive: true, force: true })
  }
})
test('production headers allow the built app, glass, wallet chooser and mobile studio', async ({
  page,
  request,
}) => {
  const vercel = JSON.parse(await readFile('vercel.json', 'utf8'))
  expect(
    Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key, value])),
  ).toEqual(headers)
  const response = await request.get(origin + '/create')
  expect(response.status()).toBe(200)
  for (const [key, value] of Object.entries(headers))
    expect(response.headers()[key.toLowerCase()]).toBe(value)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    localStorage.setItem('hooker_vamp_access_v1', '1')
    window.__cspViolations = []
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI),
    )
  })
  await page.goto(origin)
  await expect(page.getByRole('heading', { name: 'Brew something worth trading.' })).toBeVisible()
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Connect a wallet' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/production-wallet.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(origin + '/create')
  await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('button', { name: /Build a custom hook/ })).toBeVisible()
  await page.getByRole('button', { name: /Build a custom hook/ }).click()
  await expect(page.getByRole('heading', { name: 'Shape the opening' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({ path: 'artifacts/production-mobile.png', fullPage: true })
})
