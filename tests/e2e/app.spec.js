import { test, expect } from '@playwright/test'
import { enter, stubApi, stubTrades, MINT } from './fixtures.js'

test('risk notice gates the app once', async ({ page }) => {
  await stubApi(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Before you enter' })).toBeVisible()
  await page.getByRole('button', { name: 'I understand, enter' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Launch on pump.fun')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Launch on pump.fun')
})

test('the terms can be read before accepting the risk notice', async ({ page }) => {
  await stubApi(page)
  await page.goto('/terms')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of use')
  await page.goto('/')
  await expect(page.getByRole('main')).toContainText('Before you enter')
  await page.getByRole('main').getByRole('link', { name: 'terms of use' }).click()
  await expect(page).toHaveURL(/\/terms$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Terms of use')
  // Every other page still asks first.
  await page.goto('/market')
  await expect(page.getByRole('heading', { name: 'Before you enter' })).toBeVisible()
})

test('home shows live coins, hook catalog and navigates', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await stubApi(page)
  await enter(page)
  await page.goto('/')
  await expect(page.locator('.refractor img')).toBeVisible()
  await expect(page.getByRole('banner').getByRole('img', { name: 'Quant Pad' })).toBeVisible()
  await expect(page.getByText('Entangled Cats').first()).toBeVisible()
  await expect(page.locator('.hero-stats')).toContainText('Coins launched')
  await expect(page.locator('.hero-stats dd').first()).toHaveText('2')
  for (const name of ['Quantum Burn', 'Entanglement', 'Fusion', 'Superposition', 'Time Dilation'])
    await expect(page.locator('.hook-tile h3', { hasText: name })).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Market' }).click()
  await expect(page).toHaveURL(/\/market$/)
  expect(errors).toEqual([])
})

test('market filters, switches views and opens a coin', async ({ page }) => {
  await stubApi(page)
  await enter(page)
  await page.goto('/market')
  await expect(page.locator('.coin-card')).toHaveCount(2)
  await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: 'Quantum' }).click()
  await expect(page).toHaveURL(/filter=quantum/)
  await expect(page.locator('.coin-card')).toHaveCount(1)
  await page.getByRole('button', { name: 'Table view' }).click()
  await expect(page.locator('table')).toContainText('ECAT')
  await page.locator('table').getByRole('link', { name: /ECAT/ }).click()
  await expect(page).toHaveURL(new RegExp(`/coin/${MINT}$`))
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Entangled Cats')
})

test('pasting a mint in search opens its coin page', async ({ page }) => {
  await stubApi(page)
  await enter(page)
  await page.goto('/')
  await page.getByLabel('Search coins or paste a mint address').fill(MINT)
  await page.getByLabel('Search coins or paste a mint address').press('Enter')
  await expect(page).toHaveURL(new RegExp(`/coin/${MINT}$`))
})

test('wallet connects through the Wallet Standard and shows the balance', async ({ page }) => {
  await stubApi(page)
  await enter(page, { wallet: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('dialog', { name: 'Connect a Solana wallet' })).toBeVisible()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByRole('button', { name: 'Wallet details' })).toContainText('1.5 SOL')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Wallet details' })).toContainText('1.5 SOL')
})

test('launch studio validates the coin and blocks Quantum launches until the program is live', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page, { wallet: true })
  await page.goto('/launch')
  await page.getByRole('button', { name: 'Connect wallet to launch' }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByRole('button', { name: 'Quantum Hooks are not live yet' })).toBeDisabled()
  await expect(page.getByText('Quantum Hooks are not live on mainnet yet')).toBeVisible()

  // Allocation sliders always total 100%.
  await page.getByRole('button', { name: 'Deflationary' }).click()
  await expect(page.locator('.alloc-legend')).toContainText('Quantum Burn 70%')
  await page.getByLabel(/Entanglement/).fill('2500')
  const values = await page.locator('.slider-value').allTextContents()
  expect(values.reduce((s, v) => s + Number(v.replace('%', '')), 0)).toBe(100)

  await page
    .getByRole('group', { name: 'Launch type' })
    .getByRole('button', { name: 'Standard pump.fun' })
    .click()
  await page.getByRole('button', { name: /^Launch / }).click()
  await expect(page.getByText('Give your coin a name.')).toBeVisible()
  await expect(page.getByText('Choose a ticker.')).toBeVisible()
  await expect(page.getByText('Add artwork for your coin.')).toBeVisible()
  await page.getByLabel('Ticker').fill('$ecat')
  await expect(page.getByLabel('Ticker')).toHaveValue('ECAT')
})

test('coin page shows the trade ticket and hook state for a Quantum coin', async ({ page }) => {
  await stubApi(page)
  await enter(page)
  await page.goto(`/coin/${MINT}`)
  await expect(page.getByText('Quantum Hooks', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Buy' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Sell' }).click()
  await expect(page.getByLabel('You sell')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect wallet to trade' })).toBeVisible()
  await expect(page.getByText('Cats in superposition.')).toBeVisible()
})

for (const path of ['/', '/market', '/launch', '/hooks', '/docs', `/coin/${MINT}`]) {
  test(`no horizontal overflow on mobile: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await stubApi(page)
    await stubTrades(page)
    await enter(page)
    await page.goto(path)
    await page.waitForTimeout(600)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
    // .app clips sideways overflow, so also look for content cut off at the edge: anything wider
    // than the screen must sit inside its own scroll container (like the trades table).
    const cutOff = await page.evaluate(() => {
      const scrolls = (el) => {
        for (let p = el.parentElement; p && !p.classList.contains('app'); p = p.parentElement)
          if (getComputedStyle(p).overflowX !== 'visible') return true
        return false
      }
      return [...document.querySelectorAll('.app-main *')]
        .filter((el) => !el.closest('[aria-hidden="true"], svg'))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && !scrolls(el)
        })
        .map((el) => el.className || el.tagName)
    })
    expect(cutOff).toEqual([])
  })
}

test('mobile menu opens and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await stubApi(page)
  await enter(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.locator('#mobile-nav').getByRole('link', { name: 'Docs' }).click()
  await expect(page).toHaveURL(/\/docs$/)
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})

test('Escape closes the mobile menu and returns focus to its toggle', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await stubApi(page)
  await enter(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#mobile-nav')).toBeVisible()
  await page.locator('#mobile-nav').getByRole('link', { name: 'Market' }).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('#mobile-nav')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeFocused()
})

test('the header keeps its links on one line until it collapses into the menu', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page)
  await page.setViewportSize({ width: 1180, height: 800 })
  await page.goto('/market')
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  for (const height of await nav
    .getByRole('link')
    .evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height)))
    expect(height).toBeLessThan(44)
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible()
})

test('the wallet dialog keeps keyboard focus inside and hands it back on Escape', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page)
  await page.goto('/market')
  await page.getByRole('button', { name: 'Connect' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Connect a Solana wallet' })
  await expect(dialog).toBeVisible()
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key)
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Connect' })).toBeFocused()
})

test('a page whose code fails to load can be retried and does not break other pages', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page)
  let block = true
  await page.route('**/src/pages/LaunchPage.jsx*', (route) =>
    block ? route.fulfill({ status: 404, body: 'gone' }) : route.continue(),
  )
  await page.goto('/market')
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  await nav.getByRole('link', { name: 'Launch' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'This page could not load' }),
  ).toBeVisible()
  await nav.getByRole('link', { name: 'Market' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Market')
  await nav.getByRole('link', { name: 'Launch' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'This page could not load' }),
  ).toBeVisible()
  block = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Launch')
})
