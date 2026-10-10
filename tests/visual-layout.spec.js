import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hooker_vamp_access_v1', '1'))
})

test('workspace headers and content stay separate across every route and screen size', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const routes = [
    '/',
    '/market',
    '/create',
    '/trade',
    '/liquidity',
    '/leaderboard',
    '/modules',
    '/agents',
    '/docs',
    '/setup',
    '/terms',
  ]
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 })
    for (const route of routes) {
      await page.goto(route)
      await expect(page.locator('main h1')).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const layout = await page.evaluate(() => {
        const topbar = document.querySelector('.topbar').getBoundingClientRect()
        const title = document.querySelector('main h1').getBoundingClientRect()
        const controls = [...document.querySelectorAll('.top-search, .top-actions')]
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          obscuredTitle: title.top < topbar.bottom,
          escapedControls: controls.some((el) => el.getBoundingClientRect().bottom > topbar.bottom),
        }
      })
      expect(layout, `${route} at ${width}px`).toEqual({
        overflow: false,
        obscuredTitle: false,
        escapedControls: false,
      })
      if (width === 1440 || width === 390) {
        await page.screenshot({
          path: `artifacts/visual-revamp/${route.slice(1) || 'home'}-${width}.png`,
          fullPage: true,
          animations: 'disabled',
        })
      }
    }
  }
  await page.goto('/docs')
  await page
    .getByRole('navigation', { name: 'Guide sections' })
    .getByRole('link', { name: 'Creator fees & liquidity' })
    .click()
  await expect(page).toHaveURL(/\/docs#creator-fees$/)
  await expect(
    page.getByRole('heading', { name: 'Creator fees and seed liquidity' }),
  ).toBeInViewport()
  expect(errors).toEqual([])
})

test('the launch summary follows the edited draft and survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/create')
  const summary = page.getByRole('complementary', { name: 'Your draft summary' })
  await expect(summary).toBeVisible()
  await page.getByLabel('Opening market cap · ETH', { exact: true }).fill('3.2')
  await page.getByRole('button', { name: 'Set pool fee to 3%', exact: true }).click()
  await expect(summary).toContainText('3.2 ETH')
  await expect(summary).toContainText('3%')
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByRole('button', { name: /Guarded opening/ }).click()
  await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByLabel('Token name', { exact: false }).fill('Draft preview check')
  await page.getByLabel('Ticker symbol', { exact: false }).fill('BREW')
  await expect(summary).toContainText('Draft preview check')
  await expect(summary).toContainText('$BREW')
  await expect(summary).toContainText('Guarded opening')
  await page.reload()
  await expect(summary).toContainText('Draft preview check')
  await expect(summary).toContainText('3.2 ETH')
  await expect(summary).toContainText('3%')
  await expect(summary).toContainText('Guarded opening')
  await expect(summary).toContainText('Draft')
})
