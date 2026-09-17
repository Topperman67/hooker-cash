import { test, expect } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hooker_vamp_access_v1', '1'))
  await page.route('**/api/status', (r) =>
    r.fulfill({
      json: { deployment: null, treasury: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4' },
    }),
  )
  await page.route('**/api/hooks', (r) => r.fulfill({ json: { items: [] } }))
})
for (const width of [1440, 390])
  test(`hook presets and module composition at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/create')
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(page.getByRole('heading', { name: 'Your hook', exact: true })).toBeVisible()
    await page.screenshot({ path: `artifacts/hook-builder/presets-${width}.png`, fullPage: true })
    await page.getByRole('button', { name: 'Browse community hooks', exact: true }).click()
    await expect(
      page.getByText('No community recipes have been built yet.', { exact: false }),
    ).toBeVisible()
    await page.getByRole('button', { name: /Build a custom hook/ }).click()
    await page.getByRole('button', { name: 'Install Buy spacing', exact: true }).click()
    await page.getByLabel('Seconds between buys', { exact: true }).fill('10')
    await page.getByRole('button', { name: 'Install Rising buy cap', exact: true }).click()
    await page.getByRole('button', { name: 'Install Buyback & burn', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Remove Price history', exact: true }),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Install Holder rewards', exact: true }).click()
    await page.getByRole('slider', { name: 'Holder rewards · % of creator share' }).fill('40')
    await expect(
      page.getByLabel(/USDC fees: protocol 30%, creator 28%, Holders 28%, Buyback 14%/),
    ).toBeVisible()
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(page.getByRole('alert')).toContainText('Build or select')
    await expect(page.getByRole('heading', { name: 'Your hook', exact: true })).toBeVisible()
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: `artifacts/hook-builder/builder-${width}.png`, fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.reload()
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(page.getByLabel('Seconds between buys', { exact: true })).toHaveValue('10')
    await page.getByRole('button', { name: 'Back to presets', exact: true }).click()
    await page.getByRole('button', { name: /Open market/ }).click()
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(page.getByRole('heading', { name: 'Your token', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
