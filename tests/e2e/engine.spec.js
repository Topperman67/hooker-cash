// The Payout Engine page (/engine): $QUANTP's payout engine as a dashboard, from /api/quantp/ledger
// (what was paid and burned, read from the team's wallets) and /api/quantp/engine (where it stands
// and what its next run pays), with its tiers, rules, how it works and what to know before buying.
import { test, expect } from '@playwright/test'
import { QUANTP } from '../../shared/network.mjs'
import { enter, quantpEngine, quantpLedger, stubApi, stubQuantp } from './fixtures.js'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** A holder address whose short form (holder(0) is "WaAA…AAzz") is its own. */
const holder = (i) => {
  const c = B58[9 + i]
  return `Wa${c}${c}${'1'.repeat(36)}${c}${c}zz`
}
const now = () => Math.floor(Date.now() / 1000)

/** `count` paid wallets, most paid first; the creator wallet fifth. */
const paidWallets = (count = 30) =>
  Array.from({ length: count }, (_, i) => ({
    wallet: i === 4 ? QUANTP.creator : holder(i),
    lamports: String((count + 1 - i) * 1_000_000),
    rounds: i < 10 ? 3 : 1,
    lastAt: now() - 600,
  }))

/** A payout burst `ago` seconds old. */
const burst = (ago, lamports, recipients, signature) => ({
  timestamp: now() - ago,
  lamports: String(lamports),
  recipients,
  recipient: null,
  transactions: [
    { signature, slot: 1, timestamp: now() - ago, lamports: String(lamports), recipients },
  ],
})
const SIG = (c) => c.repeat(88)

test('the header’s Payout Engine link opens the engine: what it paid, its state, its next run', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, {
    engine: quantpEngine(),
    ledger: quantpLedger({ paidWallets: paidWallets() }),
  })
  await enter(page)
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Payout Engine' })
    .click()
  await expect(page).toHaveURL(/\/engine$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fees engine')

  const hero = page.getByRole('region', { name: 'Fees engine' })
  await expect(hero.locator('.eng-hero-figure')).toContainText('Paid to holders0.55 SOL')
  await expect(hero.locator('.eng-hero-figure')).toContainText('to 51 wallets in 1 round')
  await expect(hero.locator('.eng-state')).toHaveText('Running hourly')
  // the last run was 20 minutes ago; the next comes in the clock hour after it
  await expect(hero.locator('.eng-clock strong')).toHaveText(/^(\d\d:\d\d|This hour)$/)
  await expect(hero.locator('.eng-clock')).toContainText('≈ 0.0083 SOL')
  await expect(hero.locator('.eng-runline')).toHaveText(
    /^Last run 20m ago · next (in about \d+ min|this hour)$/,
  )
  await expect(hero.getByRole('link', { name: '$QUANTP page' })).toHaveAttribute(
    'href',
    QUANTP.path,
  )
  await expect(hero.getByRole('link', { name: 'GLAn…FAvn' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${QUANTP.engine.wallet}`,
  )
  // the flow: the pool's fee, the wallet, what the next run sends each way
  const flow = hero.locator('.eng-flow')
  await expect(flow.locator('.eng-node-in')).toContainText(
    'Trading fee5%per trade; the creator’s share funds the engine',
  )
  await expect(flow.locator('.eng-node-core')).toContainText('Engine wallet1.022 SOL')
  await expect(flow.locator('.eng-node-core')).toContainText('releases 20% a day')
  await expect(flow.locator('.eng-node-out').first()).toContainText('60% to holders0.005 SOL')
  await expect(flow.locator('.eng-node-out').first()).toContainText('31 wallets eligible')
  await expect(flow.locator('.eng-node-out').last()).toContainText('40% buyback & burn0.0033 SOL')

  const kpis = page.locator('.eng-kpis')
  await expect(kpis).toContainText('Wallets paid5131 eligible now')
  await expect(kpis).toContainText('Payout rounds1last 2h ago')
  await expect(kpis).toContainText('QUANTP burned00.000% of the supply')
  await expect(kpis).toContainText('Spent on buybacks0 SOL0 burns')
  await expect(kpis).toContainText('In the engine wallet1.022 SOL')
  await expect(kpis).toContainText('Release rate20% / dayat $6.38K market cap')

  const plan = page.getByRole('region', { name: 'Next run' })
  await expect(plan.locator('.eng-plan-kv')).toContainText('Holders paid28 of 31')
  await expect(plan.locator('.eng-plan-kv')).toContainText('Minimum to hold1.5M QUANTP')
  await expect(plan.locator('.eng-tiers li.is-now')).toContainText('Under $100KNow')
  await expect(plan.locator('.eng-tiers li.is-now')).toContainText('20% a day')
  // the rules
  await expect(plan).toContainText('liquidity pools and the team’s wallets are never paid')
  await expect(plan).toContainText('Each run releases at most 1 SOL and keeps 0.02 SOL')

  const how = page.getByRole('region', { name: 'How it works' })
  await expect(how.locator('li')).toHaveCount(5)
  await expect(how).toContainText('60% goes to holders')
  await expect(how).toContainText('at least 0.15% of the supply (1.5M $QUANTP), by balance')
  await expect(how).toContainText('pays a 5% fee in its Meteora DAMM v2 pool')
  await expect(page.getByRole('region', { name: 'Before you buy' })).toContainText(
    'Nothing on-chain enforces it.',
  )
})

test('every wallet paid is listed, most paid first, and can be found by its address', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { ledger: quantpLedger({ paidWallets: paidWallets() }) })
  await enter(page)
  await page.goto('/engine')
  const panel = page.getByRole('region', { name: 'Wallets paid' })
  const rows = panel.locator('tbody tr')
  await expect(rows).toHaveCount(25)
  await expect(rows.first()).toContainText('1WaAA…AAzz0.031')
  await expect(rows.first().getByRole('link', { name: 'WaAA…AAzz' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${holder(0)}`,
  )
  // the creator wallet is the team's
  await expect(rows.nth(4)).toContainText('3B53…LvHc')
  await expect(rows.nth(4).locator('.eng-team')).toHaveText('Team')
  await expect(panel).toContainText('25 of 30')
  await panel.getByRole('button', { name: 'Show more' }).click()
  await expect(rows).toHaveCount(30)

  const search = panel.getByRole('searchbox', { name: 'Find a wallet' })
  await search.fill(holder(12).slice(-6))
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('13WaNN…NNzz')
  await expect(rows.first().getByRole('link')).toHaveAttribute(
    'href',
    `https://solscan.io/account/${holder(12)}`,
  )
  await search.fill('nobody here')
  await expect(panel).toContainText('No paid wallet matches “nobody here”.')
})

test('an older server without wallet totals still lists the rounds and burns', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto('/engine')
  await expect(page.getByRole('region', { name: 'Wallets paid' })).toContainText(
    'The wallet totals are not available yet.',
  )
  await expect(page.getByRole('region', { name: 'Payout rounds' }).locator('tbody tr')).toHaveCount(
    1,
  )
})

test('burns list each burn with what its buyback spent; none yet says so plainly', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto('/engine')
  const burnsPanel = page.getByRole('region', { name: 'Burns' })
  await expect(burnsPanel).toContainText('No burns yet.')
  await expect(page.getByRole('region', { name: 'QUANTP burned' })).toContainText(
    'No burns yet. The total climbs with each hourly buyback and burn.',
  )

  const burns = [
    {
      signature: SIG('b'),
      slot: 3,
      timestamp: now() - 300,
      wallet: QUANTP.payoutWallet,
      method: 'burn',
      amount: '2000000000000',
      solSpent: '500000000',
    },
    {
      signature: SIG('c'),
      slot: 2,
      timestamp: now() - 4000,
      wallet: QUANTP.creator,
      method: 'incinerator',
      amount: '1000000000000',
      solSpent: null,
    },
  ]
  await page.unroute('**/api/quantp/ledger')
  await page.route('**/api/quantp/ledger', (route) =>
    route.fulfill({
      json: quantpLedger({ burns, unburned: { lamports: '150000000', amount: '600000000000' } }),
    }),
  )
  await page.reload()
  const rows = burnsPanel.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('2,000,0000.5BurnedEngine')
  await expect(rows.last()).toContainText('1,000,000—Sent to the incineratorCreator')
  await expect(rows.first().locator('.eng-tx')).toHaveAttribute(
    'href',
    `https://solscan.io/tx/${SIG('b')}`,
  )
  await expect(burnsPanel.locator('.eng-waiting')).toContainText(
    '0.15 SOL of $QUANTP bought back (600,000) is waiting for its burn.',
  )
  await expect(page.locator('.eng-kpis')).toContainText('QUANTP burned3M0.300% of the supply')
  await expect(page.locator('.eng-kpis')).toContainText('Spent on buybacks0.65 SOL')
  await expect(page.getByRole('region', { name: 'QUANTP burned' })).toContainText('3M QUANTP')

  // the feed mixes them with the payout, newest first
  const feed = page.getByRole('region', { name: 'Activity' }).locator('li')
  await expect(feed).toHaveCount(3)
  await expect(feed.nth(0)).toContainText('Burned 2M QUANTP')
  await expect(feed.nth(0)).toContainText('bought for 0.5 SOL')
  await expect(feed.nth(1)).toContainText('Burned 1M QUANTP')
  await expect(feed.nth(1)).toContainText('held tokens')
  await expect(feed.nth(2)).toContainText('Paid 0.55 SOL')
  await expect(feed.nth(2)).toContainText('to 51 wallets')
})

test('a payout round sent in several transactions opens to list each of them', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto('/engine')
  const panel = page.getByRole('region', { name: 'Payout rounds' })
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel.locator('tbody tr').first()).toContainText('0.55510.010784')
  await panel.getByRole('button', { name: '3 txs' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(4)
  await expect(panel.locator('.eng-sub-row').first()).toContainText('0.358')
})

test('the paid chart reads out each round under the pointer and with the arrow keys', async ({
  page,
}) => {
  await stubApi(page)
  const payouts = [
    burst(600, 4_958_000, 28, SIG('d')),
    burst(3600, 5_000_000, 30, SIG('e')),
    burst(7200, 549_999_974, 51, SIG('f')),
  ]
  await stubQuantp(page, { engine: quantpEngine(), ledger: quantpLedger({ payouts }) })
  await enter(page)
  await page.goto('/engine')
  const chart = page.getByRole('group', { name: /SOL paid to holders over time, 3 rounds/ })
  await chart.focus()
  const tip = page.locator('.eng-chart-green .eng-tip')
  await expect(tip).toContainText('0.56 SOL in all')
  await expect(tip).toContainText('+0.005 SOL to 28 wallets')
  await page.keyboard.press('ArrowLeft')
  await expect(tip).toContainText('0.555 SOL in all')
  await expect(tip).toContainText('+0.005 SOL to 30 wallets')
  await page.keyboard.press('Home')
  await expect(tip).toContainText('+0.55 SOL to 51 wallets')
  await chart.blur()
  await expect(tip).toHaveCount(0)
  // the pointer: the round nearest it
  const box = await chart.boundingBox()
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2)
  await expect(tip).toContainText('0.56 SOL in all')
})

test('an engine that is not sending: paused, no countdown, and the page still lists what was paid', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ live: false, reason: 'no-key' }) })
  await enter(page)
  await page.goto('/engine')
  const hero = page.getByRole('region', { name: 'Fees engine' })
  await expect(hero.locator('.eng-state')).toHaveText('Paused')
  await expect(hero.locator('.eng-runline')).toHaveText(
    'Paused: no payouts or buybacks run until it is switched back on.',
  )
  await expect(hero.locator('.eng-clock strong')).toHaveText('—')
  await expect(hero.locator('.eng-hero-figure')).toContainText('0.55 SOL')
})

test('an engine switched on but not run yet says so here and on the $QUANTP page', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ lastRunAt: null }) })
  await enter(page)
  await page.goto('/engine')
  const hero = page.getByRole('region', { name: 'Fees engine' })
  await expect(hero.locator('.eng-state')).toHaveText('Waiting for its first run')
  await expect(hero.locator('.eng-runline')).toHaveText(
    'Switched on, and waiting for its first automatic run.',
  )
  await expect(hero.locator('.eng-clock strong')).toHaveText('This hour')
  await page.goto(QUANTP.path)
  const block = page.locator('.qp-engine')
  await expect(block).toContainText('Waiting for its first run')
  await block.getByRole('link', { name: 'How it works' }).click()
  await expect(page).toHaveURL(/\/engine$/)
})

test('an engine behind its schedule runs late', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ lastRunAt: now() - 3 * 3600 }) })
  await enter(page)
  await page.goto('/engine')
  const hero = page.getByRole('region', { name: 'Fees engine' })
  await expect(hero.locator('.eng-state')).toHaveText('Running late')
  await expect(hero.locator('.eng-runline')).toHaveText(
    'Last run 3h ago: it is behind its hourly schedule.',
  )
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
  await expect(page).toHaveURL(/\/engine$/)
  await expect(page.getByRole('link', { name: 'Payout Engine' }).first()).toHaveClass(/active/)
  await expect(
    page.locator('.footer-links').getByRole('link', { name: 'Payout Engine' }),
  ).toHaveAttribute('href', '/engine')

  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.locator('#mobile-nav').getByRole('link', { name: 'Payout Engine' }).click()
  await expect(page).toHaveURL(/\/engine$/)
})

test('the engine page headings never skip a level', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, {
    engine: quantpEngine(),
    ledger: quantpLedger({ paidWallets: paidWallets() }),
  })
  await enter(page)
  await page.goto('/engine')
  await expect(page.getByRole('region', { name: 'Wallets paid' }).locator('tbody tr')).toHaveCount(
    25,
  )
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')]
      .filter((h) => h.getClientRects().length)
      .map((h) => Number(h.tagName[1])),
  )
  expect(levels[0]).toBe(1)
  for (let i = 1; i < levels.length; i++)
    expect(levels[i] - levels[i - 1], levels.join(' ')).toBeLessThanOrEqual(1)
})

test('while the ledger cannot be read, the page says so and the engine still shows', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine(), ledger: 503 })
  await enter(page)
  await page.goto('/engine')
  const message = 'Payouts and burns are unavailable right now. Retrying shortly.'
  await expect(page.locator('.eng-loading')).toContainText(message)
  await expect(page.getByRole('region', { name: 'Paid to holders' })).toContainText(message)
  await expect(page.locator('.eng-hero .eng-state')).toHaveText('Running hourly')
  await expect(page.locator('.eng-kpis')).toContainText('In the engine wallet1.022 SOL')
})

for (const theme of ['light', 'dark'])
  test(`no horizontal overflow on mobile: /engine (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.addInitScript((t) => localStorage.setItem('quantpad:theme', t), theme)
    await stubApi(page)
    const burns = [
      {
        signature: SIG('g'),
        slot: 3,
        timestamp: now() - 300,
        wallet: QUANTP.payoutWallet,
        method: 'burn',
        amount: '2000000000000',
        solSpent: '500000000',
      },
    ]
    await stubQuantp(page, {
      engine: quantpEngine(),
      ledger: quantpLedger({
        burns,
        paidWallets: paidWallets(),
        unburned: { lamports: '150000000', amount: '600000000000' },
      }),
    })
    await enter(page)
    await page.goto('/engine')
    await expect(page.locator('.eng-chart svg').first()).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
    // anything wider than the screen must sit inside its own scroll container (the tables)
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
