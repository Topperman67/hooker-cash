// $QUANTP's page: its Payouts and Burns panel under About, read from /api/quantp/ledger.
import { test, expect } from '@playwright/test'
import { QUANTP } from '../../shared/network.mjs'
import { enter, quantpLedger, quantpSnapshot, stubApi, stubQuantp } from './fixtures.js'

const ledgerPanel = (page) => page.getByRole('region', { name: 'Payouts & burns' })

test('payouts list round 1 as one burst with its totals, and Burns says plainly there are none yet', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await expect(panel).toBeVisible()
  // it sits right under the About card in the side column
  const order = await page.evaluate(() =>
    [...document.querySelector('.qp-side').children].map((el) => el.className),
  )
  expect(order.at(-2)).toContain('qp-about')
  expect(order.at(-1)).toContain('qp-ledger')

  const tabs = panel.getByRole('group', { name: 'Show payouts or burns' })
  await expect(tabs.getByRole('button', { name: 'Payouts' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Paid out0.55 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Wallets paid51')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Holders’ share earned1.937 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('In the payout wallet1.58 SOL')
  await expect(panel).toContainText(
    'The team pays holders in bursts: small ones now, bigger ones as the market cap grows.',
  )
  // the burst is one row; its three transactions open under it, in the order sent
  const rows = panel.locator('tbody tr')
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('2h')
  await expect(rows.nth(0)).toContainText('0.55')
  await expect(rows.nth(0)).toContainText('51 wallets')
  const toggle = rows.nth(0).getByRole('button', { name: '3 txs' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1)).toContainText('0.358')
  await expect(rows.nth(1)).toContainText('20 wallets')
  await expect(rows.nth(3)).toContainText('0.0152')
  await expect(rows.nth(3)).toContainText('11 wallets')
  await expect(rows.nth(3).getByRole('link', { name: '5qDPLw' })).toHaveAttribute(
    'href',
    'https://solscan.io/tx/5qDPLwq9SdL1ABciwN8ovnjigV8NTk9ktX41DUHyZpsNkYSnjNzfDtWrp4sKWg6fUgQUBaocyvXZFRjo2pKg9JeR',
  )
  await expect(panel.getByRole('link', { name: 'GLAn…FAvn' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${QUANTP.payoutWallet}`,
  )

  await tabs.getByRole('button', { name: 'Burns' }).click()
  await expect(tabs.getByRole('button', { name: 'Burns' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('tbody tr')).toHaveCount(0)
  await expect(panel).toContainText('No burns yet.')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Burned0 QUANTP')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Buyback share earned1.291 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Bought, not burned yet0 SOL')
  await expect(panel.getByRole('link', { name: '3B53…LvHc' })).toBeVisible()

  // the tokenomics fine print links here
  await page.getByRole('link', { name: 'See what has been paid out and burned' }).click()
  await expect(page).toHaveURL(/#payouts$/)
})

test('burns show the tokens burned and the SOL their buyback spent; burns by others are noted', async ({
  page,
}) => {
  const now = Math.floor(Date.now() / 1000)
  const burns = [
    {
      signature: `4bb${'1'.repeat(85)}`,
      slot: 457_700_100,
      timestamp: now - 300,
      wallet: QUANTP.payoutWallet,
      method: 'burn',
      amount: '2000000000000',
      solSpent: '500000000',
    },
    {
      signature: `3cc${'1'.repeat(85)}`,
      slot: 457_700_000,
      timestamp: now - 90_000,
      wallet: QUANTP.creator,
      method: 'incinerator',
      amount: '1000000000000',
      solSpent: null,
    },
  ]
  await stubApi(page)
  // 5M are gone from the supply: 3M by the team, 2M by others
  await stubQuantp(page, {
    snapshot: quantpSnapshot({ burned: '5000000000000' }),
    ledger: quantpLedger({
      payouts: [],
      burns,
      unburned: { lamports: '150000000', amount: '1000000000000' },
    }),
  })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await expect(panel).toContainText('No payouts yet.')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Paid out0 SOL')
  await panel.getByRole('button', { name: 'Burns' }).click()
  const rows = panel.locator('tbody tr')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('5m')
  await expect(rows.nth(0)).toContainText('2,000,000')
  await expect(rows.nth(0)).toContainText('0.5')
  await expect(rows.nth(1)).toContainText('1d')
  await expect(rows.nth(1)).toContainText('1,000,000')
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('—')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Burned3M QUANTP')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('SOL spent0.5 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Bought, not burned yet0.15 SOL')
  await expect(panel).toContainText('Other wallets have burned 2M QUANTP.')
})

test('long lists show the first rows, then all of them on request', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000)
  // twelve bursts of one transaction each, to one wallet
  const payouts = Array.from({ length: 12 }, (_, i) => {
    const timestamp = now - 3600 * (i + 1)
    const tx = {
      signature: `${i + 2}pp${'1'.repeat(84)}`,
      slot: 457_600_000 - i,
      timestamp,
      lamports: '10000000',
      recipients: 1,
    }
    return {
      timestamp,
      lamports: '10000000',
      recipients: 1,
      recipient: '57uMvKGYH1xcrwPSXHjtQFbzApmDGhQi1RVa6pzvXb2u',
      transactions: [tx],
    }
  })
  await stubApi(page)
  await stubQuantp(page, { ledger: quantpLedger({ payouts }) })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await expect(panel.locator('tbody tr')).toHaveCount(8)
  // a payout to one wallet names it
  const first = panel.locator('tbody tr').first()
  await expect(first.getByRole('link', { name: '57uM…Xb2u' })).toBeVisible()
  // a burst of one transaction links it straight away
  await expect(first.getByRole('link', { name: '2pp111' })).toBeVisible()
  await expect(first.getByRole('button')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Show all 12' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(12)
  await panel.getByRole('button', { name: 'Show fewer' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(8)
})

test('while the ledger cannot be read, the panel says so and the page still works', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { ledger: 503 })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await expect(panel).toContainText(
    'Payouts and burns are unavailable right now. Retrying shortly.',
  )
  await expect(page.getByRole('heading', { name: `About $${QUANTP.symbol}` })).toBeVisible()
})

test('the $QUANTP page headings never skip a level', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto(QUANTP.path)
  await expect(ledgerPanel(page).locator('tbody tr')).toHaveCount(1)
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')]
      .filter((h) => h.getClientRects().length)
      .map((h) => Number(h.tagName[1])),
  )
  expect(levels).toContain(1)
  for (let i = 1; i < levels.length; i++)
    expect(levels[i] - levels[i - 1], levels.join(' ')).toBeLessThanOrEqual(1)
})

for (const theme of ['light', 'dark'])
  test(`on a phone (${theme}): the panel comes after About and nothing overflows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.addInitScript((t) => localStorage.setItem('quantpad:theme', t), theme)
    await stubApi(page)
    await stubQuantp(page)
    await enter(page)
    await page.goto(QUANTP.path)
    const panel = ledgerPanel(page)
    await expect(panel.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    // with the burst open too
    await panel.getByRole('button', { name: '3 txs' }).click()
    await expect(panel.locator('tbody tr')).toHaveCount(4)
    const [about, ledger] = await Promise.all(
      ['.qp-about', '.qp-ledger'].map((s) =>
        page.locator(s).evaluate((el) => el.getBoundingClientRect().top),
      ),
    )
    expect(ledger).toBeGreaterThan(about)
    await page.waitForTimeout(400)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
    const box = await panel.boundingBox()
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(361)
    // the rows fit without scrolling sideways
    const wrap = panel.locator('.table-wrap')
    expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
  })
