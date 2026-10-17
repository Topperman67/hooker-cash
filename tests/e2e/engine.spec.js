// The payout engine's page (/engine): where the engine stands and what its next run pays, from
// /api/quantp/engine; its tiers and rules; and every payout and burn, from /api/quantp/ledger.
import { test, expect } from '@playwright/test'
import { QUANTP } from '../../shared/network.mjs'
import { enter, quantpEngine, stubApi, stubQuantp } from './fixtures.js'

const ENGINE = '/engine'
const hero = (page) => page.locator('.eg-hero')
const now = () => Math.floor(Date.now() / 1000)

test('the engine page shows its state, the next run, the tiers and rules, and every payout', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  await enter(page)
  await page.goto(ENGINE)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Payout Engine')
  await expect(hero(page)).toContainText('Running hourly')
  await expect(hero(page)).toContainText('Next run0.0083 SOL')
  await expect(hero(page)).toContainText('0.005 SOL to 28 wallets')
  await expect(hero(page)).toContainText('0.0033 SOL to buy back and burn')
  await expect(hero(page)).toContainText(/Last run 20m ago · next in about 40 min/)
  await expect(hero(page).getByRole('link', { name: 'Payout wallet' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${QUANTP.payoutWallet}`,
  )

  const stats = page.locator('.eg-stats')
  await expect(stats).toContainText('Released a day20%')
  await expect(stats).toContainText('In the payout wallet1.022 SOL')
  await expect(stats).toContainText('Wallets eligible now31')
  await expect(stats).toContainText('Paid to holders0.55 SOL')

  const tiers = page.getByRole('region', { name: 'Released per day, by market cap' })
  await expect(tiers.locator('.is-now')).toHaveCount(1)
  await expect(tiers.locator('.is-now')).toContainText('Below $100KNow20%')
  await expect(tiers).toContainText('Each run releases at most 1 SOL and keeps 0.02 SOL')

  const rules = page.getByRole('region', { name: 'The rules' })
  await expect(rules).toContainText('at least 0.15% of the supply (1.5M $QUANTP)')
  await expect(rules).toContainText('Liquidity pools and the team’s wallets')

  // the ledger, without the engine block this page already shows in full
  const ledger = page.getByRole('region', { name: 'Payouts & burns' })
  await expect(ledger.locator('tbody tr')).toHaveCount(1)
  await expect(ledger.locator('.qp-engine')).toHaveCount(0)
})

test('an engine switched on but not run yet says so here and on the $QUANTP page', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ lastRunAt: null }) })
  await enter(page)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText('Waiting for its first run')
  await expect(hero(page)).toContainText('Switched on, and waiting for its first automatic run.')
  await expect(hero(page)).not.toContainText('Running hourly')
  await page.goto(QUANTP.path)
  const block = page.locator('.qp-engine')
  await expect(block).toContainText('Waiting for its first run')
  await block.getByRole('link', { name: 'How it works' }).click()
  await expect(page).toHaveURL(ENGINE)
})

test('an engine behind its schedule runs late, and a paused one shows no next run', async ({
  page,
}) => {
  await stubApi(page)
  let engine = quantpEngine({ lastRunAt: now() - 3 * 3600 })
  await stubQuantp(page, { engine })
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await enter(page)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText('Running late')
  await expect(hero(page)).toContainText('Last run 3h ago: it is behind its hourly schedule.')

  engine = quantpEngine({ live: false, reason: 'paused' })
  await page.reload()
  await expect(hero(page)).toContainText('Paused')
  await expect(hero(page)).toContainText('Next run—')
  await expect(hero(page)).toContainText('no payouts or buybacks run')
})

test('the header, the phone menu and the footer link to the engine page', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  await enter(page)
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Payout Engine' })
    .click()
  await expect(page).toHaveURL(ENGINE)
  await expect(page.getByRole('link', { name: 'Payout Engine' }).first()).toHaveClass(/active/)
  await expect(
    page.locator('.footer-links').getByRole('link', { name: 'Payout Engine' }),
  ).toHaveAttribute('href', ENGINE)

  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.locator('#mobile-nav').getByRole('link', { name: 'Payout Engine' }).click()
  await expect(page).toHaveURL(ENGINE)
})

test('the engine page headings never skip a level', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  await enter(page)
  await page.goto(ENGINE)
  await expect(
    page.getByRole('region', { name: 'Payouts & burns' }).locator('tbody tr'),
  ).toHaveCount(1)
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')]
      .filter((h) => h.getClientRects().length)
      .map((h) => Number(h.tagName[1])),
  )
  expect(levels[0]).toBe(1)
  for (let i = 1; i < levels.length; i++)
    expect(levels[i] - levels[i - 1], levels.join(' ')).toBeLessThanOrEqual(1)
})

for (const theme of ['light', 'dark'])
  test(`on a phone (${theme}): the engine page fits and keeps how it works first`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.addInitScript((t) => localStorage.setItem('quantpad:theme', t), theme)
    await stubApi(page)
    await stubQuantp(page, { engine: quantpEngine() })
    await enter(page)
    await page.goto(ENGINE)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(
      page.getByRole('region', { name: 'Payouts & burns' }).locator('tbody tr'),
    ).toHaveCount(1)
    const tops = await Promise.all(
      ['.eg-how', '.eg-tiers', '.qp-ledger', '.eg-rules', '.eg-disclose'].map((s) =>
        page.locator(s).evaluate((el) => el.getBoundingClientRect().top),
      ),
    )
    expect([...tops].sort((a, b) => a - b)).toEqual(tops)
    await page.waitForTimeout(400)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })
