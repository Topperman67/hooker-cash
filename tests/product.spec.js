import { test, expect } from '@playwright/test'
import { defaultDraft } from '../src/lib/protocolDraft.js'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hooker_vamp_access_v1', '1'))
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: { deployment: null, treasury: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4' },
    }),
  )
})
const advance = (page) => page.getByRole('button', { name: 'Continue', exact: false }).click()
const shot = async (page, name) => {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.screenshot({ path: 'artifacts/launch-flow/' + name + '.png', fullPage: true })
}

test('five-step studio validates each stage, reviews exact choices and restores the draft', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/create')
  await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
  await expect(page.getByLabel('Opening market cap', { exact: false })).toHaveValue('')
  await shot(page, '01-pool-desktop')
  await page.getByLabel('Opening market cap', { exact: false }).fill('100')
  await advance(page)
  await expect(page.getByRole('alert')).toContainText('2,000')
  await page.getByLabel('Opening market cap', { exact: false }).fill('5000')
  await page.getByRole('button', { name: 'Set pool fee to 3%' }).click()
  await advance(page)
  await page.getByRole('button', { name: /Guarded opening/ }).click()
  await page.getByLabel('Guard duration', { exact: false }).fill('4000')
  await advance(page)
  await expect(page.getByRole('alert')).toContainText('3,600')
  await page.getByLabel('Guard duration', { exact: false }).fill('300')
  await shot(page, '02-hook-desktop')
  await advance(page)
  await advance(page)
  await expect(page.getByRole('alert')).toContainText('Token name')
  await page.getByLabel('Token name', { exact: false }).fill('Moon Milk')
  await page.getByLabel('Ticker symbol', { exact: false }).fill('MILK')
  await page
    .getByLabel('Description', { exact: false })
    .fill('A little lunar culture. Brewed on Arc.')
  await page.getByLabel('Website', { exact: false }).fill('javascript:alert(1)')
  await advance(page)
  await expect(page.getByRole('alert')).toContainText('https or http')
  await page.getByLabel('Website', { exact: false }).fill('https://example.com')
  await shot(page, '03-token-desktop')
  await advance(page)
  await expect(page.getByRole('button', { name: /^1h cliff.*24h/ })).toBeDisabled()
  await page.getByLabel('Founder buy', { exact: false }).fill('25')
  await page.getByRole('button', { name: /^1h cliff.*24h/ }).click()
  await page.getByRole('button', { name: 'Add wallet', exact: false }).click()
  await page.getByLabel('Wallet address 1').fill('0x1111111111111111111111111111111111111111')
  await page.getByLabel('Share · % · wallet 1').fill('90')
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('100%')
  await page.getByLabel('Share · % · wallet 1').fill('100')
  await page.getByLabel('Custom vesting for wallet 1').check()
  await page.getByLabel('Wallet 1 Cliff', { exact: true }).fill('7')
  await page.getByLabel('Wallet 1 Cliff unit').selectOption('days')
  await page.getByLabel('Wallet 1 Linear duration', { exact: true }).fill('30')
  await page.getByLabel('Wallet 1 Linear duration unit').selectOption('days')
  await shot(page, '04-payouts-desktop')
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Open deployment setup/ })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Pool review' })).toContainText('3% on each swap')
  await expect(page.getByRole('region', { name: 'Payouts review' })).toContainText(
    '7d cliff + 30d linear',
  )
  await shot(page, '05-review-desktop')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
  await advance(page)
  await advance(page)
  await expect(page.getByLabel('Token name', { exact: false })).toHaveValue('Moon Milk')
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('hookbrew:launch-draft:v1')).splits[0].vesting.duration,
    ),
  ).toBe('30')
  expect(errors).toEqual([])
})

for (const [savedKey, savedStep] of [
  ['hookbrew:launch-step:v1', '0'],
  ['hookbrew:launch-step:v2', '2'],
  ['hookbrew:launch-step:v2', '4'],
]) {
  test(`launch entry starts at Pool despite saved ${savedKey}=${savedStep}`, async ({ page }) => {
    await page.addInitScript(
      ({ savedKey, savedStep, draft }) => {
        localStorage.setItem('hookbrew:launch-draft:v1', JSON.stringify(draft))
        localStorage.setItem(savedKey, savedStep)
      },
      { savedKey, savedStep, draft: { ...defaultDraft, name: 'Saved Brew', symbol: 'BREW' } },
    )
    await page.goto('/')
    await page.getByRole('link', { name: 'Launch a token', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: 'Launch steps' }).locator('[aria-current="step"]'),
    ).toHaveText('1Pool')
    await advance(page)
    await expect(page.getByRole('heading', { name: 'Your hook', exact: true })).toBeVisible()
    await advance(page)
    await expect(page.getByLabel('Token name', { exact: true })).toHaveValue('Saved Brew')
    await page
      .getByRole('navigation', { name: 'Quick navigation' })
      .getByRole('link', { name: 'Create a token', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
    await advance(page)
    await advance(page)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
  })
}

test('all five stages work on mobile, including a solo creator custom vesting schedule', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const noOverflow = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.goto('/create')
  await noOverflow()
  await shot(page, '01-pool-mobile')
  await advance(page)
  await noOverflow()
  await shot(page, '02-hook-mobile')
  await advance(page)
  await page.getByLabel('Token name', { exact: false }).fill('Mobile Brew')
  await page.getByLabel('Ticker symbol', { exact: false }).fill('BREW')
  await noOverflow()
  await shot(page, '03-token-mobile')
  await advance(page)
  await page.getByLabel('Founder buy', { exact: false }).fill('25')
  await page.getByRole('button', { name: /^Custom Set/ }).click()
  await page.getByLabel('Cliff', { exact: true }).fill('2')
  await page.getByLabel('Cliff unit', { exact: true }).selectOption('hours')
  await page.getByLabel('Linear duration', { exact: true }).fill('10')
  await page.getByLabel('Linear duration unit', { exact: true }).selectOption('days')
  await noOverflow()
  await shot(page, '04-payouts-mobile')
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Payouts review' })).toContainText(
    '2h cliff + 10d linear',
  )
  await noOverflow()
  await shot(page, '05-review-mobile')
  await page.getByRole('link', { name: /Open deployment setup/ }).click()
  await expect(page.getByRole('heading', { name: 'Bring the brewery on-chain.' })).toBeVisible()
  await expect(
    page.getByRole('link', { name: '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4' }),
  ).toBeVisible()
  await noOverflow()
})
