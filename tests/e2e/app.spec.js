import { test, expect } from '@playwright/test'
import { coin, enter, stubApi, stubTrades, MINT } from './fixtures.js'

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
  // The menu carries a second (hidden) copy of the search; the visible one is the header's.
  const search = page
    .getByRole('search', { name: 'Site search' })
    .getByRole('textbox', { name: 'Search coins or paste a mint address' })
  await search.fill(MINT)
  await search.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/coin/${MINT}$`))
})

test('the mobile menu search is labelled on its own and ids are unique', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await stubApi(page)
  await enter(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  const input = page
    .locator('#mobile-nav')
    .getByRole('textbox', { name: 'Search coins or paste a mint address' })
  await expect(input).toBeVisible()
  // Its own label points at it (not at the hidden header copy), and no id repeats on the page.
  expect(await input.evaluate((el) => [...el.labels].map((l) => l.textContent.trim()))).toEqual([
    'Search coins or paste a mint address',
  ])
  const duplicates = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id)
    return ids.filter((id, i) => ids.indexOf(id) !== i)
  })
  expect(duplicates).toEqual([])
  await input.fill(MINT)
  await input.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/coin/${MINT}$`))
})

test('landmarks: the tape is a named region and the two searches have distinct names', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page)
  await page.goto('/market')
  await expect(page.getByRole('region', { name: 'Trending coins' })).toBeVisible()
  await expect(page.getByRole('search', { name: 'Site search' })).toBeVisible()
  await expect(page.getByRole('search', { name: 'Search the market' })).toBeVisible()
  await expect(page.getByRole('search')).toHaveCount(2)
})

test('tiny prices show a zero count in the brand font and copy as the full decimal', async ({
  page,
}) => {
  await stubApi(page)
  await enter(page)
  await page.goto(`/coin/${MINT}`)
  const value = page.locator('.coin-stats .price-tiny')
  await expect(value).toHaveText('0.0000000412')
  await expect(value).toHaveAttribute('title', '0.0000000412')
  const drawn = await value.evaluate((el) => {
    const sub = el.querySelector('sub.price-zeros')
    const selection = getSelection()
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.addRange(range)
    const copied = selection.toString()
    selection.removeAllRanges()
    return {
      count: getComputedStyle(sub, '::before').content,
      hidden: sub.getAttribute('aria-hidden'),
      font: getComputedStyle(sub).fontFamily,
      copied,
      subscriptDigits: /[₀-₉]/.test(el.textContent),
    }
  })
  expect(drawn).toEqual({
    count: '"7"',
    hidden: 'true',
    font: expect.stringContaining('Martian Mono'),
    copied: '0.0000000412',
    subscriptDigits: false,
  })
})

// Chromium copies HTML with computed styles inlined, which would carry the zero run's font-size: 0
// into a rich-text paste and show "0.0412". The page writes its own HTML for such copies.
test('a tiny price pasted into a rich-text editor reads as the full decimal', async ({
  page,
  context,
}) => {
  await stubApi(page)
  await enter(page)
  await page.goto(`/coin/${MINT}`)
  await expect(page.locator('.coin-stats .price-tiny')).toHaveText('0.0000000412')
  await page.evaluate(() => {
    // Read during the copy event, after the page's own handler (copy data is readable then).
    window.__copied = null
    window.addEventListener('copy', (e) => {
      window.__copied = {
        prevented: e.defaultPrevented,
        plain: e.clipboardData.getData('text/plain'),
        html: e.clipboardData.getData('text/html'),
      }
    })
    // The price stat's value: "<price> SOL".
    const value = document.querySelector('.coin-stats .price-tiny').parentElement
    const range = document.createRange()
    range.selectNodeContents(value)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.keyboard.press('ControlOrMeta+C')
  const copied = await page.evaluate(() => window.__copied)
  expect(copied).toMatchObject({ prevented: true, plain: '0.0000000412 SOL' })
  expect(copied.html).toContain('0.0000000412')
  expect(copied.html).not.toMatch(/font-size|price-zero-run|<sub/)

  // Paste into a plain rich-text editor on another page, as into a mail composer.
  const editor = await context.newPage()
  await editor.setContent('<div contenteditable="true" style="font: 16px sans-serif"></div>')
  await editor.locator('[contenteditable]').focus()
  await editor.keyboard.press('ControlOrMeta+V')
  await expect(editor.locator('[contenteditable]')).not.toBeEmpty()
  const pasted = await editor.locator('[contenteditable]').evaluate((box) => {
    // The text a reader sees: text nodes that are drawn at a non-zero size.
    const seen = []
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const style = getComputedStyle(node.parentElement)
      if (parseFloat(style.fontSize) > 0 && style.visibility !== 'hidden') seen.push(node.data)
    }
    return {
      html: box.innerHTML,
      seen: seen.join('').replace(/\s+/g, ' ').trim(),
      zeroSized: [...box.querySelectorAll('*')].some(
        (el) => parseFloat(getComputedStyle(el).fontSize) === 0,
      ),
    }
  })
  expect(pasted.html).not.toMatch(/font-size:\s*0/)
  expect(pasted.zeroSized).toBe(false)
  expect(pasted.seen).toBe('0.0000000412 SOL')
  await editor.close()
})

test('a coin that migrated off pump.fun says so and cannot be traded here', async ({ page }) => {
  const migrated = coin({
    complete: true,
    progress: 100,
    poolMissing: true,
    price: null,
    marketCap: null,
  })
  await stubApi(page, { coins: [migrated] })
  // Registered after stubApi, so it answers first.
  await page.route(`**/api/coins/${MINT}`, (route) =>
    route.fulfill({ json: { coin: { ...migrated, meta: {} } } }),
  )
  await enter(page, { wallet: true })
  await page.goto(`/coin/${MINT}`)
  const ticket = page.getByRole('form', { name: 'Trade ECAT' })
  await expect(ticket.getByRole('button', { name: 'Migrated off pump.fun' })).toBeDisabled()
  await expect(ticket.getByLabel('You pay at most')).toBeDisabled()
  await expect(ticket).toContainText('cannot be traded here')
  await expect(page.locator('.coin-side .curve-meta')).toContainText('Migrated off pump.fun')
  await expect(page.getByText('Graduated to PumpSwap')).toHaveCount(0)
  // Connecting a wallet does not open the ticket, and no market read is retried.
  await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByRole('button', { name: 'Wallet details' })).toBeVisible()
  await expect(ticket.getByRole('button', { name: 'Migrated off pump.fun' })).toBeDisabled()
  await expect(ticket).not.toContainText('Could not read this coin')
  await page.goto('/market')
  await expect(page.locator('.coin-card .curve-meta').first()).toContainText(
    'Migrated off pump.fun',
  )
})

for (const withTrades of [false, true]) {
  test(`coin page headings never skip a level (${withTrades ? 'with' : 'no'} trades)`, async ({
    page,
  }) => {
    await stubApi(page)
    if (withTrades) await stubTrades(page)
    await enter(page)
    await page.goto(`/coin/${MINT}`)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Entangled Cats')
    await expect(page.getByRole('heading', { name: 'Quantum Hooks' })).toBeVisible()
    if (withTrades) await expect(page.locator('table').first()).toBeVisible()
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')]
        .filter((h) => h.getClientRects().length)
        .map((h) => Number(h.tagName[1])),
    )
    expect(levels).toContain(1)
    for (let i = 1; i < levels.length; i++)
      expect(levels[i] - levels[i - 1], levels.join(' ')).toBeLessThanOrEqual(1)
  })
}

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
