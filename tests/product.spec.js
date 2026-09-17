import { test, expect } from '@playwright/test'
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hooker_vamp_access_v1', '1'))
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: { deployment: null, treasury: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4' },
    }),
  )
})
test('studio validates identity, economics, splits and vesting, and restores the local draft', async ({
  page,
}) => {
  await page.goto('/create')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('Token name')
  await page.getByLabel('Token name', { exact: false }).fill('Moon Milk')
  await page.getByLabel('Ticker symbol', { exact: false }).fill('MILK')
  await page.getByLabel('Website', { exact: false }).fill('javascript:alert(1)')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('https or http')
  await page.getByLabel('Website', { exact: false }).fill('https://example.com')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByLabel('Opening market cap', { exact: false }).fill('100')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('2,000')
  await page.getByLabel('Opening market cap', { exact: false }).fill('5000')
  await page.getByLabel('Founder buy', { exact: false }).fill('25')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByRole('button', { name: 'Add recipient' }).click()
  await page.getByLabel('Wallet address 1').fill('0x1111111111111111111111111111111111111111')
  await page.getByLabel('Share · %').fill('90')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('alert')).toContainText('100%')
  await page.getByLabel('Share · %').fill('100')
  await page.getByLabel('Cliff · days').fill('7')
  await page.getByLabel('Linear vest · days').fill('30')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await expect(page.getByRole('heading', { name: 'Ready for the first pour?' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Open deployment setup/ })).toBeVisible()
  await expect(page.locator('.review-list')).toContainText('vesting enabled')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Ready for the first pour?' })).toBeVisible()
  await page.getByRole('button', { name: /Identity/ }).click()
  await expect(page.getByLabel('Token name', { exact: false })).toHaveValue('Moon Milk')
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('hookbrew:launch-draft:v1')).splits[0].durationDays,
    ),
  ).toBe('30')
})
test('mobile studio and deployment setup remain usable without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/create')
  await page.getByLabel('Token name', { exact: false }).fill('Mobile Brew')
  await page.getByLabel('Ticker symbol', { exact: false }).fill('BREW')
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByRole('heading', { name: 'Set the opening conditions.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({
    path: 'artifacts/product-build/studio-mobile-verified.png',
    fullPage: true,
  })
  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: 'Bring the brewery on-chain.' })).toBeVisible()
  await expect(
    page.getByRole('link', { name: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4' }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
