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

for (const width of [1440, 390])
  test(`hook allocation sliders balance the budget at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/create')
    await page.getByRole('button', { name: /Continue/ }).click()
    await page.getByRole('button', { name: /Burn & reward/ }).click()
    await page.getByRole('button', { name: 'Install Buyback & burn', exact: true }).click()
    await page.getByRole('button', { name: 'Install Liquidity reinvestment', exact: true }).click()
    const slider = (title) => page.getByRole('slider', { name: `${title} · % of creator share` })
    const budget = page.getByRole('group', { name: 'Creator-share budget' })
    await slider('Buyback & burn').fill('74')
    await expect(slider('Fee burn')).toHaveValue('2')
    await expect(slider('Holder rewards')).toHaveValue('22')
    await expect(slider('Liquidity reinvestment')).toHaveValue('2')
    await expect(budget).toContainText('Modules 100%')
    await expect(budget).toContainText('Available 0%')
    await slider('Liquidity reinvestment').fill('57')
    await expect(slider('Fee burn')).toHaveValue('0')
    await expect(slider('Holder rewards')).toHaveValue('0')
    await expect(slider('Buyback & burn')).toHaveValue('43')
    await slider('Holder rewards').fill('27')
    await expect(slider('Buyback & burn')).toHaveValue('29.5')
    await expect(slider('Liquidity reinvestment')).toHaveValue('43.5')
    await slider('Buyback & burn').fill('100')
    await expect(slider('Holder rewards')).toHaveValue('0')
    await expect(slider('Liquidity reinvestment')).toHaveValue('0')
    await page.reload()
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(slider('Fee burn')).toHaveValue('0')
    await expect(slider('Holder rewards')).toHaveValue('0')
    await expect(slider('Liquidity reinvestment')).toHaveValue('0')
    await page.getByRole('button', { name: 'Remove Buyback & burn', exact: true }).click()
    await expect(budget).toContainText('Available 100%')
    await page.getByRole('button', { name: 'Install Buyback & burn', exact: true }).click()
    await slider('Holder rewards').fill('60')
    await expect(budget).toContainText('Modules 80%')
    await expect(budget).toContainText('Available 20%')
    await page.getByRole('button', { name: /Continue/ }).click()
    await expect(page.getByRole('alert')).toContainText('Build or select')
    await expect(
      page.getByText('Value modules can use at most 100%', { exact: false }),
    ).toHaveCount(0)
    await budget.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `artifacts/hook-builder/budget-${width}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })

test('old over-allocated drafts are repaired when reopening the builder', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'hookbrew:launch-draft:v1',
      JSON.stringify({
        hook: {
          mode: 'custom',
          deployment: null,
          recipe: {
            window: 0,
            interval: 0,
            startCapBps: 0,
            endCapBps: 0,
            oracle: true,
            burnBps: 0,
            rewardBps: 2700,
            buybackBps: 7400,
            liquidityBps: 5700,
          },
        },
      }),
    ),
  )
  await page.goto('/create')
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(
    page.getByText('Your saved allocations were automatically balanced to 100%.'),
  ).toBeVisible()
  await expect(page.getByRole('group', { name: 'Creator-share budget' })).toContainText(
    'Modules 100%',
  )
  await expect(
    page.getByRole('slider', { name: 'Holder rewards · % of creator share' }),
  ).toHaveValue('7.66')
  await expect(
    page.getByRole('slider', { name: 'Buyback & burn · % of creator share' }),
  ).toHaveValue('54.67')
  await expect(
    page.getByRole('slider', { name: 'Liquidity reinvestment · % of creator share' }),
  ).toHaveValue('37.67')
  await page.getByRole('button', { name: /Continue/ }).click()
  await expect(page.getByRole('alert')).toContainText('Build or select')
})
