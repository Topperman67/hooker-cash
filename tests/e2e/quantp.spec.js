// $QUANTP's page: its Payouts, Burns and Runs panel under About, read from /api/quantp/ledger, the
// payout copy it shares with the home page, and the dev-only buyback burner at /burn.
import { Buffer } from 'node:buffer'
import { test, expect } from '@playwright/test'
import { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, decodeBurnCheckedInstruction } from '@solana/spl-token'
import { QUANTP } from '../../shared/network.mjs'
import {
  enter,
  quantpEngine,
  quantpLedger,
  quantpSnapshot,
  stubApi,
  stubQuantp,
} from './fixtures.js'

const ledgerPanel = (page) => page.getByRole('region', { name: 'Payouts & burns' })
const HOLDERS_RULE =
  'In SOL about once an hour, to wallets holding at least 0.15% of the supply, by balance.'
const BUYBACK_RULE =
  'About once an hour it buys $QUANTP in its pool and burns it, when its share is at least 0.002 SOL.'

test('the payout engine shows once it runs: the hourly rule at this tier, who it pays, its runs', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  await enter(page)
  await page.goto(QUANTP.path)
  const engine = ledgerPanel(page).locator('.qp-engine')
  await expect(engine).toContainText('Automatic payouts')
  await expect(engine).toContainText('Running hourly')
  await expect(engine.locator('.chip')).toHaveClass(/chip-grad/)
  // an hourly rate, and what it adds up to over a day, not "20% a day"
  await expect(engine).toContainText(
    'releases 0.83% of its SOL (about 18% of it a day at this market cap): 60% to wallets holding at least 1.5M $QUANTP (0.15% of the supply), by balance, and 40% to buy back and burn $QUANTP.',
  )
  await expect(engine).toContainText(
    'Next run pays 28 of 31 eligible wallets, releasing about 0.0083 SOL',
  )
  // the newest transaction of the newest burst, sent 7,192 s before the fixture was made
  await expect(engine).toContainText(/last payout [12]h ago/)
  await expect(engine).not.toContainText('figures may be out of date')
  await expect(engine.getByRole('link', { name: 'GLAn…FAvn' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${QUANTP.payoutWallet}`,
  )
})

test('engine figures the chain could not refresh are not shown as live', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ state: 'stale' }) })
  await enter(page)
  await page.goto(QUANTP.path)
  const engine = ledgerPanel(page).locator('.qp-engine')
  await expect(engine).toContainText('figures may be out of date')
  await expect(engine.locator('.chip')).toHaveText('Running hourly')
  await expect(engine.locator('.chip')).not.toHaveClass(/chip-grad/)
})

test('the tokenomics show what was really paid and bought back, and how the engine pays', async ({
  page,
}) => {
  await stubApi(page)
  // 5M are gone from the supply, 3M of them burned by the team's buybacks
  await stubQuantp(page, {
    snapshot: quantpSnapshot({
      burned: '5000000000000',
      payouts: { ...quantpSnapshot().payouts, burnedAmount: '3000000000000' },
    }),
  })
  await enter(page)
  await page.goto(QUANTP.path)
  await expect(page.locator('.qp-tokenomics h3')).toHaveText('How the payout wallet is paid out')
  const split = page.locator('.qp-split-legend')
  await expect(split).toContainText(HOLDERS_RULE)
  await expect(split).toContainText('0.55 SOL paid so far to 51 wallets')
  await expect(split).toContainText(BUYBACK_RULE)
  // the buyback row counts the team's burns; the Burned stat counts the whole supply's
  await expect(split).toContainText('0.553 SOL bought back · 3M burned')
  await expect(page.locator('.qp-stats')).toContainText('Burned5M QUANTP')
  await expect(
    page.locator('.qp-stats .stat', { hasText: 'Burned' }).locator('span'),
  ).toHaveAttribute('title', '5,000,000 QUANTP burned in all')
  await expect(page.locator('.qp-tokenomics')).toContainText(
    'The team sends SOL from the creator’s fee claims to the payout wallet when it chooses; nothing on-chain makes it. Quant Pad’s payout engine aims to release a slice of what that wallet holds once each UTC hour',
  )
  const disclose = page.locator('#before-you-trade')
  await expect(disclose).toContainText(
    'The 60/40 split is the team’s discretionary policy, not on-chain code: Quant Pad’s payout engine pays it out about once an hour from a wallet the team funds',
  )
  await expect(disclose).toContainText('Holding $QUANTP gives no right to any payment.')
  // no estimate is shown as if holders had it, and no fixed hour is promised
  await expect(page.locator('main')).not.toContainText('earned')
  await expect(page.locator('main')).not.toContainText('every hour')
  // the age of the figures is not announced on every poll; their state is
  await expect(page.locator('.qp-updated')).not.toHaveAttribute('aria-live')
  await expect(page.locator('.qp-quote [role="status"]')).toHaveText('Live figures are shown.')
})

test('the home page shows the same real figures and rules for $QUANTP', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, {
    snapshot: quantpSnapshot({
      burned: '5000000000000',
      payouts: { ...quantpSnapshot().payouts, burnedAmount: '3000000000000' },
    }),
  })
  await enter(page)
  await page.goto('/')
  await expect(page.locator('.fw-lede')).toContainText(
    'What reaches the payout wallet is paid out about once an hour:',
  )
  const rows = page.locator('.fw-rows')
  await expect(rows).toContainText(HOLDERS_RULE)
  await expect(rows).toContainText(BUYBACK_RULE)
  await expect(rows).toContainText('0.55 SOL paid so far')
  // the team's burns under the buyback row, not the supply's
  await expect(rows).toContainText('0.553 SOL bought back · 3M burned')
  const note = page.locator('.qps-note')
  await expect(note).toContainText(
    'Its 60/40 split is paid by Quant Pad’s payout engine about once an hour from a wallet the team funds; nothing on-chain enforces it.',
  )
  await expect(note).toContainText('holding $QUANTP gives no right to any payment')
  // the hero's split is an example for coins launched here, not $QUANTP's
  await expect(page.locator('.refractor-caption')).toHaveText(
    'Example Quantum Hooks split for a coin launched here. $QUANTP’s own fees go 60% to holders and 40% to buyback and burn through the payout engine.',
  )
  await expect(page.locator('main')).not.toContainText('earned')
  await expect(page.locator('main')).not.toContainText('every hour')
})

test('while /api/quantp is down, nothing reads as if $QUANTP had not graduated', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page)
  await page.route('**/api/quantp', (route) =>
    route.fulfill({ status: 503, json: { error: 'Unavailable', code: 'QUANTP_UNAVAILABLE' } }),
  )
  await enter(page)
  await page.goto(QUANTP.path)
  await expect(page.locator('.qp-chips')).toContainText('Graduated to DAMM v2')
  await expect(page.locator('#before-you-trade')).toContainText(
    'Meteora removed its transfer hook at graduation',
  )
  await expect(page.getByRole('link', { name: 'DAMM v2 pool' }).last()).toHaveAttribute(
    'href',
    'https://solscan.io/account/EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw',
  )
  await expect(page.locator('main')).not.toContainText('On the bonding curve')
  await expect(page.locator('main')).not.toContainText('Bonding curve pool')
  await page.goto('/')
  await expect(page.locator('.fw-lede')).toContainText('in its DAMM v2 pool')
  await expect(page.locator('.qps-curve')).toContainText('Graduated to Meteora DAMM v2')
  await page.goto('/docs')
  await expect(page.locator('#quantp ~ ul').first()).toContainText(
    'Meteora removed the hook when the curve graduated',
  )
})

test('the docs give the 60/40 split once, then each share’s rule', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto('/docs')
  const bullet = page.locator('#quantp ~ ul > li').filter({ hasText: 'payout engine aims' })
  await expect(bullet).toHaveCount(1)
  await expect(bullet).toContainText(
    `60% to holders, 40% to buy back and burn $QUANTP. It runs on Quant Pad’s server, not in an on-chain program. Holders: ${HOLDERS_RULE} Buyback and burn: ${BUYBACK_RULE}`,
  )
  const text = await bullet.textContent()
  expect(text.match(/60%/g)).toHaveLength(1)
  expect(text.match(/40%/g)).toHaveLength(1)
})

test('an engine that is set up but not running yet is not shown', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ live: false, reason: 'no-key' }) })
  await enter(page)
  await page.goto(QUANTP.path)
  await expect(ledgerPanel(page).locator('tbody tr')).toHaveCount(1)
  await expect(ledgerPanel(page).locator('.qp-engine')).toHaveCount(0)
})

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

  const tabs = panel.getByRole('group', { name: 'Show payouts, burns or runs' })
  await expect(tabs.getByRole('button', { name: 'Payouts' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Paid out0.55 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Wallets paid51')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Wallets eligible now—')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('In the payout wallet1.58 SOL')
  await expect(panel).toContainText(
    'Each row is one payout of SOL from the payout wallet GLAn…FAvn (transactions sent together count as one), read from the chain.',
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
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Bought back0 SOL')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Not burned yet0 SOL')
  await expect(panel.getByRole('link', { name: '3B53…LvHc' })).toBeVisible()

  // the tokenomics fine print links here
  await page.getByRole('link', { name: 'See every transaction' }).click()
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
      unread: 1,
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
  // the SOL a burn spent can include earlier buys it burned
  await expect(rows.nth(0).locator('td').nth(2)).toHaveAttribute(
    'title',
    'Includes earlier buys whose $QUANTP this transaction burned',
  )
  // a transaction link says what it is and that it opens a new tab, and still reads as its start
  await expect(
    rows.nth(0).getByRole('link', { name: 'Transaction 4bb111 (opens in a new tab)' }),
  ).toHaveText(/4bb111/)
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Burned3M QUANTP')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Bought back0.65 SOL')
  // with the tokens it bought
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Not burned yet0.15 SOL1M QUANTP')
  await expect(panel).toContainText('Other wallets have burned 2M QUANTP.')
  // a transaction the server could not read yet is said, not hidden
  await expect(panel).toContainText(
    '1 transaction of the team’s wallets could not be read yet: these lists may be missing it.',
  )
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

for (const theme of ['light', 'dark'])
  test(`on a phone (${theme}): the Runs table fits, transaction links and all`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.addInitScript((t) => localStorage.setItem('quantpad:theme', t), theme)
    await stubApi(page)
    await stubQuantp(page, { ledger: wideRuns() })
    await enter(page)
    await page.goto(QUANTP.path)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    const panel = ledgerPanel(page)
    await panel.getByRole('button', { name: 'Runs' }).click()
    await expect(panel.locator('tbody tr.qp-run')).toHaveCount(3)
    await page.waitForTimeout(400)
    const wrap = panel.locator('.table-wrap')
    expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
    // every transaction link is inside the panel, none cut off
    const box = await panel.boundingBox()
    for (const link of await panel.locator('.qp-run-txs a').all()) {
      const b = await link.boundingBox()
      expect(b.x).toBeGreaterThanOrEqual(box.x)
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1)
    }
  })

test('a buyback too small to show at 3 decimals still shows, never as 0 SOL', async ({ page }) => {
  await stubApi(page)
  // the 1,492.75 $QUANTP bought for 0.000266 SOL on 2026-10-16
  await stubQuantp(page, {
    ledger: quantpLedger({ unburned: { lamports: '265899', amount: '1492751997' } }),
  })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Burns' }).click()
  const totals = panel.locator('.qp-ledger-totals')
  await expect(totals).toContainText('Not burned yet0.000266 SOL1.49K QUANTP')
  await expect(totals).not.toContainText('Not burned yet0 SOL')
  await expect(totals).toContainText('Bought back0.000266 SOL')
})

test('the Burns note says when the engine buys back, and when this hour’s share is too small', async ({
  page,
}) => {
  await stubApi(page)
  let engine = quantpEngine()
  await stubQuantp(page, { engine })
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Burns' }).click()
  await expect(panel).toContainText(
    'The payout engine buys back and burns about once an hour when its share is at least 0.002 SOL.',
  )
  // a 0.0016 SOL share is under the minimum: skipped, and it stays in the wallet
  engine = quantpEngine({
    next: { release: '4000000', holders: '2400000', buyback: '0', paying: 28 },
  })
  await page.reload()
  await panel.getByRole('button', { name: 'Burns' }).click()
  await expect(panel).toContainText(
    'No buyback this hour: its share is under 0.002 SOL and stays in the wallet.',
  )
  await expect(panel).not.toContainText('buys back and burns about once an hour')
  await expect(panel.locator('.qp-ledger-totals')).toContainText('Next buyback0 SOL')
})

test('an engine whose next run sends nothing says it is idle, not late', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, {
    engine: quantpEngine({
      lastRunAt: Math.floor(Date.now() / 1000) - 5 * 3600,
      next: { release: '30000', holders: '18000', buyback: '0', paying: 0 },
    }),
  })
  await enter(page)
  await page.goto(QUANTP.path)
  const engine = ledgerPanel(page).locator('.qp-engine')
  await expect(engine.locator('.chip')).toHaveText('Idle: below the payout minimums')
  await expect(engine).toContainText('Next run pays 0 of 31 eligible wallets')
})

test('the Runs tab lists the engine wallet’s runs by UTC hour, with how each one went', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page)
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Runs' }).click()
  await expect(panel.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true')
  // the default ledger: round 1's figures dated two hours ago, so after the engine's first run: one
  // burst of three transactions and no buyback that hour
  const runs = panel.locator('tbody tr.qp-run')
  const status = panel.locator('tbody tr.qp-run-status')
  await expect(runs).toHaveCount(1)
  const hour = Math.floor((Date.now() / 1000 - 7200) / 3600) * 3600
  const at = new Date(hour * 1000).toLocaleString('en-US', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  await expect(runs.first().locator('td').first()).toContainText(at)
  await expect(runs.first().locator('td').nth(1)).toContainText('0.55')
  await expect(runs.first().locator('td').nth(1)).toContainText('51 wallets')
  await expect(runs.first().locator('td').nth(2)).toHaveText('—')
  await expect(runs.first().locator('td').nth(3)).toHaveText('—')
  // its status, then its transactions, on the line under it
  await expect(runs.first().getByRole('link')).toHaveCount(0)
  await expect(status.first().getByRole('link')).toHaveCount(3)
  await expect(status.first().getByRole('link').first()).toHaveText(
    'Transaction 5B9NLS (opens in a new tab)',
  )
  await expect(status.first().locator('.chip')).toHaveText(['buyback did not go through'])
  await expect(panel.getByRole('button', { name: 'Show the last 7 days' })).toHaveCount(0)
})

// Runs-tab ledgers: a signature, a payout burst of one transaction, a burst of several (each
// [signature, lamports, wallets paid, seconds after the first]; `recipients` is its distinct
// wallets, their sum unless given), and a burn by the engine wallet.
const sig = (tag, i = 0) => `${tag}${String(i).padStart(4, '1')}${'1'.repeat(80)}`
const burstOf = (timestamp, txs, { wallet = QUANTP.payoutWallet, recipients } = {}) => {
  const transactions = txs.map(([signature, lamports, n, after = 0], i) => ({
    signature,
    slot: 1 + i,
    timestamp: timestamp + after,
    lamports,
    recipients: n,
  }))
  return {
    timestamp,
    wallet,
    lamports: transactions.reduce((s, x) => s + BigInt(x.lamports), 0n).toString(),
    recipients: recipients ?? transactions.reduce((s, x) => s + x.recipients, 0),
    recipient: null,
    transactions,
  }
}
const burst = (timestamp, lamports, recipients, signature, wallet) =>
  burstOf(timestamp, [[signature, lamports, recipients]], { wallet })
const engineBurn = (timestamp, amount, solSpent, signature) => ({
  signature,
  slot: 9,
  timestamp,
  wallet: QUANTP.payoutWallet,
  method: 'burn',
  amount,
  solSpent,
})
// Round 1, paid by hand from the payout wallet before the engine's first run.
const ROUND_1_AT = 1792126586
// The live ledger's widest runs: an hour that bought 0.5556 SOL of $QUANTP back (with earlier
// buys) and burned 3.12M in four transactions, a repeated hour of six, and round 1.
const wideRuns = () => {
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600
  return quantpLedger({
    payouts: [
      burstOf(hour - 3600 + 37, [
        [sig('W', 1), '1100000', 14],
        [sig('W', 2), '1100000', 14, 1],
        [sig('W', 3), '1000000', 12, 2],
      ]),
      burstOf(hour - 7200 + 2000, [
        [sig('R', 1), '2100000', 20],
        [sig('R', 2), '2100000', 20, 1],
        [sig('R', 3), '1000000', 7, 2],
      ]),
      burstOf(hour - 7200 + 22, [
        [sig('R', 4), '2100000', 20],
        [sig('R', 5), '2100000', 20, 1],
        [sig('R', 6), '1000000', 7, 2],
      ]),
      burstOf(ROUND_1_AT, [
        [sig('M', 1), '358024234', 20],
        [sig('M', 2), '176743573', 20, 4],
        [sig('M', 3), '15232167', 11, 9],
      ]),
    ],
    burns: [engineBurn(hour - 3600 + 40, '3119233145959', '555616844', sig('W', 4))],
  })
}

test('runs: complete, below the buyback minimum, missing a buyback, repeated; then a week', async ({
  page,
}) => {
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600
  const payouts = [
    // the last hour: paid, and bought back and burned
    burst(hour - 3600 + 60, '5000000', 28, sig('A')),
    // two hours ago: its 0.0013 SOL buyback share was under the 0.002 SOL minimum
    burst(hour - 7200 + 60, '2000000', 9, sig('B')),
    // three hours ago: two bursts in one hour, and no buyback
    burst(hour - 10800 + 2000, '10000000', 30, sig('C', 2)),
    burst(hour - 10800 + 60, '10000000', 30, sig('C', 1)),
    // a payout from another wallet is not one of the engine's runs
    burst(hour - 3600 + 90, '7000000', 3, sig('D'), QUANTP.creator),
  ]
  const burns = [
    {
      signature: sig('E'),
      slot: 2,
      timestamp: hour - 3600 + 70,
      wallet: QUANTP.payoutWallet,
      method: 'burn',
      amount: '49758399868',
      solSpent: '3322871',
    },
    // a burn by the creator wallet is not a run either
    {
      signature: sig('F'),
      slot: 3,
      timestamp: hour - 7200 + 100,
      wallet: QUANTP.creator,
      method: 'incinerator',
      amount: '1000000000',
      solSpent: null,
    },
  ]
  await stubApi(page)
  await stubQuantp(page, { ledger: quantpLedger({ payouts, burns }) })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Runs' }).click()
  const runs = panel.locator('tbody tr.qp-run')
  const status = panel.locator('tbody tr.qp-run-status')
  await expect(runs).toHaveCount(3)
  await expect(runs.nth(0).locator('td').nth(1)).toContainText('0.005')
  await expect(runs.nth(0).locator('td').nth(1)).toContainText('28 wallets')
  await expect(runs.nth(0).locator('td').nth(2)).toHaveText('0.0033')
  await expect(runs.nth(0).locator('td').nth(3)).toHaveText('49.76K')
  await expect(status.nth(0).getByRole('link')).toHaveCount(2)
  await expect(status.nth(0).locator('.chip')).toHaveText(['complete'])
  await expect(status.nth(0).locator('.chip')).toHaveClass(/chip-grad/)
  await expect(status.nth(1).locator('.chip')).toHaveText(['no buyback (below minimum)'])
  await expect(status.nth(2).locator('.chip')).toHaveText([
    'buyback did not go through',
    'repeated',
  ])
  await expect(status.nth(2).getByRole('link')).toHaveCount(2)
  await expect(runs.nth(2).locator('td').nth(1)).toContainText('0.02')
  // the same 30 wallets paid twice are 60 payments, not 60 wallets
  await expect(runs.nth(2).locator('td').nth(1)).toContainText('60 payments')

  // thirty hourly runs: the last 24, then the week
  const many = Array.from({ length: 30 }, (_, i) =>
    burst(hour - 3600 * (i + 1) + 60, '5000000', 28, sig('G', i)),
  )
  await page.route('**/api/quantp/ledger', (route) =>
    route.fulfill({ json: quantpLedger({ payouts: many }) }),
  )
  await page.reload()
  await panel.getByRole('button', { name: 'Runs' }).click()
  await expect(runs).toHaveCount(24)
  await panel.getByRole('button', { name: 'Show the last 7 days' }).click()
  await expect(runs).toHaveCount(30)
  await panel.getByRole('button', { name: 'Show the last 24' }).click()
  await expect(runs).toHaveCount(24)
})

test('runs: two runs in one burst are repeated; one burst across two hours is two runs', async ({
  page,
}) => {
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600
  const payouts = [
    // runs at :50 and :05 of the next hour, 15 minutes apart: the ledger joins them in one burst
    burstOf(
      hour - 7200 + 3000,
      [
        [sig('H', 1), '5000000', 28],
        [sig('H', 2), '5000000', 28, 900],
      ],
      { recipients: 28 },
    ),
    // the same two wallets paid at :00 and again at :20 of one hour: one burst, four payments
    burstOf(
      hour - 10800 + 10,
      [
        [sig('J', 1), '2000000', 2],
        [sig('J', 2), '2000000', 2, 1200],
      ],
      { recipients: 2 },
    ),
  ]
  await stubApi(page)
  await stubQuantp(page, { ledger: quantpLedger({ payouts }) })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Runs' }).click()
  const runs = panel.locator('tbody tr.qp-run')
  const status = panel.locator('tbody tr.qp-run-status')
  await expect(runs).toHaveCount(3)
  for (const i of [0, 1]) {
    await expect(runs.nth(i).locator('td').nth(1)).toContainText('0.005')
    await expect(runs.nth(i).locator('td').nth(1)).toContainText('28 wallets')
    await expect(status.nth(i).locator('.chip')).toHaveText(['buyback did not go through'])
    await expect(status.nth(i).getByRole('link')).toHaveCount(1)
  }
  await expect(runs.nth(2).locator('td').nth(1)).toContainText('0.004')
  await expect(runs.nth(2).locator('td').nth(1)).toContainText('4 payments')
  await expect(status.nth(2).locator('.chip')).toHaveText([
    'buyback did not go through',
    'repeated',
  ])
})

test('runs: round 1, paid by hand before the engine, is manual; earlier buys are flagged', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { ledger: wideRuns() })
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await panel.getByRole('button', { name: 'Runs' }).click()
  const runs = panel.locator('tbody tr.qp-run')
  const status = panel.locator('tbody tr.qp-run-status')
  await expect(runs).toHaveCount(3)
  // the engine's burn of what the team bought by hand before: its SOL includes those buys
  await expect(runs.nth(0).locator('td').nth(2)).toHaveText('0.5556')
  await expect(runs.nth(0).locator('td').nth(2)).toHaveAttribute(
    'title',
    'Includes earlier buys whose $QUANTP this run burned',
  )
  await expect(runs.nth(0).locator('td').nth(3)).toHaveText('3.12M')
  await expect(status.nth(0).locator('.chip')).toHaveText(['complete'])
  await expect(status.nth(0).getByRole('link')).toHaveCount(4)
  await expect(runs.nth(1).locator('td').nth(1)).toContainText('94 payments')
  await expect(status.nth(1).locator('.chip')).toHaveText([
    'buyback did not go through',
    'repeated',
  ])
  await expect(status.nth(1).getByRole('link')).toHaveCount(6)
  // round 1: the engine did not run it, so it owed no buyback
  await expect(runs.nth(2).locator('td').first()).toContainText('Oct 16')
  await expect(runs.nth(2).locator('td').nth(1)).toContainText('51 wallets')
  await expect(status.nth(2).locator('.chip')).toHaveText(['manual payout'])
  await expect(status.nth(2).locator('.chip')).not.toHaveClass(/chip-grad/)
  await expect(panel.locator('.qp-fine').first()).toContainText(
    'Rows marked manual are the team’s own, by hand, from before the engine’s first run on Oct 17, 2026.',
  )
  // the day under each hour stays on one line, in the page's side column too
  const wrapped = await panel
    .locator('.qp-run-day')
    .evaluateAll((els) =>
      els
        .filter(
          (el) => el.getBoundingClientRect().height > 2 * parseFloat(getComputedStyle(el).fontSize),
        )
        .map((el) => el.textContent),
    )
  expect(wrapped).toEqual([])
})

test('when the ledger answers with its newest rows only, Show all asks it for every one', async ({
  page,
}) => {
  const now = Math.floor(Date.now() / 1000)
  const burstAt = (i) => {
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
  }
  const all = Array.from({ length: 12 }, (_, i) => burstAt(i))
  const asked = []
  await stubApi(page)
  await stubQuantp(page)
  await page.route(
    (url) => url.pathname === '/api/quantp/ledger',
    (route) => {
      const full = new URL(route.request().url()).searchParams.get('all') === '1'
      asked.push(full ? 'all' : 'newest')
      const body = quantpLedger({ payouts: full ? all : all.slice(0, 10) })
      return route.fulfill({
        json: {
          ...body,
          payoutCount: 12,
          more: !full,
          // still reading older history
          complete: false,
          since: Date.UTC(2026, 9, 15, 12) / 1000,
        },
      })
    },
  )
  await enter(page)
  await page.goto(QUANTP.path)
  const panel = ledgerPanel(page)
  await expect(panel.locator('tbody tr')).toHaveCount(8)
  await expect(panel).toContainText(
    'Showing history since Oct 15, 2026; older transactions are still loading.',
  )
  await panel.getByRole('button', { name: 'Show all 12' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(12)
  expect(asked).toContain('all')
})

test('on a 360 px phone the stats fit their boxes, even 12.35M burned', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await stubApi(page)
  await stubQuantp(page, {
    snapshot: quantpSnapshot({ burned: '12345678000000', volume24hUsd: 1_234_567 }),
  })
  await enter(page)
  await page.goto(QUANTP.path)
  await expect(page.locator('.qp-stats')).toContainText('12.35M QUANTP')
  const overflow = await page
    .locator('.qp-stats dd')
    .evaluateAll((dds) =>
      dds.filter((dd) => dd.scrollWidth > dd.clientWidth + 1).map((dd) => dd.textContent),
    )
  expect(overflow).toEqual([])
})

// ---- the dev-only buyback burner (/burn, served by `vite dev` only) ----------------------------

// A $QUANTP token account (the payout wallet's on mainnet), which the stub below answers as the
// connected wallet's, whichever wallet that is.
const QUANTP_ACCOUNT = 'AykJHeRomzjcYSGMTVUhbCEEDD6LwF7hgXVbpLcBJWUd'
const HELD = '3070967498088'

/**
 * JSON-RPC for the burner: the wallet's $QUANTP account, a blockhash and a passing simulation. A
 * send is refused and kept in `sends`, so nothing ever leaves. Registered after stubApi, so it
 * answers first and hands everything else to it.
 */
async function stubBurnRpc(page, sends) {
  await page.route('**/api/rpc', (route) => {
    const body = route.request().postDataJSON()
    const calls = Array.isArray(body) ? body : [body]
    const context = { slot: 300_000_000 }
    const answer = (call) => {
      const ok = (result) => ({ jsonrpc: '2.0', id: call.id, result })
      if (call.method === 'getTokenAccountsByOwner')
        return ok({
          context,
          value: [
            {
              pubkey: QUANTP_ACCOUNT,
              account: {
                data: {
                  program: 'spl-token-2022',
                  parsed: {
                    type: 'account',
                    info: {
                      isNative: false,
                      mint: QUANTP.mint,
                      owner: call.params[0],
                      state: 'initialized',
                      tokenAmount: {
                        amount: HELD,
                        decimals: 6,
                        uiAmount: 3070967.498088,
                        uiAmountString: '3070967.498088',
                      },
                    },
                  },
                  space: 182,
                },
                executable: false,
                lamports: 2157600,
                owner: TOKEN_2022_PROGRAM_ID.toBase58(),
                rentEpoch: 0,
                space: 182,
              },
            },
          ],
        })
      if (call.method === 'getLatestBlockhash')
        return ok({
          context,
          value: {
            blockhash: '11111111111111111111111111111111',
            lastValidBlockHeight: 400_000_000,
          },
        })
      if (call.method === 'simulateTransaction')
        return ok({
          context,
          value: {
            err: null,
            logs: ['Program log: Instruction: BurnChecked'],
            accounts: null,
            unitsConsumed: 2370,
            returnData: null,
          },
        })
      if (call.method === 'sendTransaction') {
        sends.push(call)
        return {
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32002, message: 'The e2e fixtures never send transactions.' },
        }
      }
      return null
    }
    const answers = calls.map(answer)
    if (answers.some((a) => !a)) return route.fallback()
    return route.fulfill({ json: Array.isArray(body) ? answers : answers[0] })
  })
}

/** The BurnChecked instructions in a transaction the wallet was asked to sign (base64). */
function burnsIn(base64) {
  const { message } = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
  const keys = message.staticAccountKeys
  return {
    payer: keys[0].toBase58(),
    burns: message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex].equals(TOKEN_2022_PROGRAM_ID))
      .map((ix) =>
        decodeBurnCheckedInstruction(
          new TransactionInstruction({
            programId: TOKEN_2022_PROGRAM_ID,
            keys: ix.accountKeyIndexes.map((i) => ({
              pubkey: keys[i],
              isSigner: message.isAccountSigner(i),
              isWritable: message.isAccountWritable(i),
            })),
            data: Buffer.from(ix.data),
          }),
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
  }
}

test('the burner fills in what was bought back and builds one BurnChecked from the wallet', async ({
  page,
}) => {
  const sends = []
  await stubApi(page)
  await stubQuantp(page, {
    ledger: quantpLedger({ unburned: { lamports: '320013872', amount: '1432024251739' } }),
  })
  await stubBurnRpc(page, sends)
  // the creator wallet: the payout wallet's tokens are the engine's to burn
  await enter(page, { wallet: true, address: QUANTP.creator })
  await page.goto('/burn')
  await expect(page.getByRole('heading', { name: '$QUANTP buyback burn' })).toBeVisible()
  await expect(page.getByText('1,432,024.251739 $QUANTP for 0.32 SOL')).toBeVisible()
  await page.getByRole('button', { name: 'Connect the wallet holding the $QUANTP' }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByText('holds 3,070,967.498088 $QUANTP')).toBeVisible()
  // one of the team's wallets: no warning
  await expect(page.locator('.notice-warn')).toHaveCount(0)

  // it starts at what was bought back, priced at what that cost
  const amount = page.getByLabel('Amount to burn')
  await expect(amount).toHaveValue('1432024.251739')
  await expect(page.getByText('Bought back with about 0.32 SOL')).toBeVisible()
  await page.getByRole('button', { name: 'All it holds' }).click()
  await expect(amount).toHaveValue('3070967.498088')
  await expect(page.getByText(/Bought back with about/)).toHaveCount(0)
  await page.getByRole('button', { name: 'What was bought back' }).click()
  await expect(amount).toHaveValue('1432024.251739')
  // more than it holds cannot be burned
  await amount.fill('5000000')
  await expect(page.getByRole('button', { name: 'Burn 5,000,000 $QUANTP' })).toBeDisabled()
  await amount.fill('1,432,024.251739')
  const burn = page.getByRole('button', { name: 'Burn 1,432,024.251739 $QUANTP' })

  // declining the confirm asks the wallet for nothing
  page.once('dialog', (d) => d.dismiss())
  await burn.click()
  expect(await page.evaluate(() => window.__signRequests?.length ?? 0)).toBe(0)

  // confirmed: simulated, then one transaction to sign; the refused send shows as an error
  page.once('dialog', (d) => d.accept())
  await burn.click()
  await expect(page.locator('.notice-error')).toBeVisible()
  const requests = await page.evaluate(() => window.__signRequests)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toHaveLength(1)
  expect(sends).toHaveLength(1)
  const { payer, burns } = burnsIn(requests[0][0])
  expect(payer).toBe(QUANTP.creator)
  expect(burns).toHaveLength(1)
  expect(burns[0].keys.account.pubkey.toBase58()).toBe(QUANTP_ACCOUNT)
  expect(burns[0].keys.mint.pubkey.toBase58()).toBe(QUANTP.mint)
  expect(burns[0].keys.owner.pubkey.toBase58()).toBe(QUANTP.creator)
  expect(burns[0].keys.owner.isSigner).toBe(true)
  expect(burns[0].data.amount).toBe(1_432_024_251_739n)
  expect(burns[0].data.decimals).toBe(6)
})

test('the burner leaves the payout engine’s wallet to the engine', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, {
    ledger: quantpLedger({ unburned: { lamports: '320013872', amount: '1432024251739' } }),
  })
  await stubBurnRpc(page, [])
  await enter(page, { wallet: true, address: QUANTP.engine.wallet })
  await page.goto('/burn')
  await page.getByRole('button', { name: 'Connect the wallet holding the $QUANTP' }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByText('holds 3,070,967.498088 $QUANTP')).toBeVisible()
  await expect(page.locator('.panel .notice')).toHaveText(
    'The payout engine burns this wallet’s $QUANTP in its next hourly buyback.',
  )
  const amount = page.getByLabel('Amount to burn')
  await expect(amount).toHaveValue('')
  await expect(amount).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Burned by the payout engine' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'All it holds' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__signRequests?.length ?? 0)).toBe(0)
})

test('with nothing waiting to be burned, the burner fills in nothing', async ({ page }) => {
  await stubApi(page)
  // the default ledger: nothing bought back and not burned
  await stubQuantp(page)
  await stubBurnRpc(page, [])
  await enter(page, { wallet: true, address: QUANTP.creator })
  await page.goto('/burn')
  await page.getByRole('button', { name: 'Connect the wallet holding the $QUANTP' }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.getByText('holds 3,070,967.498088 $QUANTP')).toBeVisible()
  // not the wallet's whole balance
  await expect(page.getByLabel('Amount to burn')).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Enter an amount' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'What was bought back' })).toHaveCount(0)
})

test('the burner warns when the wallet is not one of the team’s', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page)
  await stubBurnRpc(page, [])
  await enter(page, { wallet: true })
  await page.goto('/burn')
  await page.getByRole('button', { name: 'Connect the wallet holding the $QUANTP' }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(page.locator('.notice-warn')).toContainText('This is not one of the team’s wallets')
})
