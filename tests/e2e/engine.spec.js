// The payout engine's page (/engine): where the engine stands, when it runs next and what that run
// pays, from /api/quantp/engine; a holder's own wallet, from /api/quantp/holder; who the next run
// pays; its tiers and rules; and every payout and burn, from /api/quantp/ledger.
import { test, expect } from '@playwright/test'
import { QUANTP, explorer } from '../../shared/network.mjs'
import { ENGINE_STATE_LABEL, engineState } from '../../src/components/quantpPayouts.js'
import {
  WALLET_ADDRESS,
  enter,
  quantpEngine,
  quantpHolder,
  quantpHolders,
  quantpSnapshot,
  stubApi,
  stubQuantp,
} from './fixtures.js'

const ENGINE = '/engine'
const hero = (page) => page.locator('.eg-hero')
const runLine = (page) => page.locator('.eg-hero .qp-updated')
const now = () => Math.floor(Date.now() / 1000)
// Times on the day the engine went live. Tests that read the next run pin the page's clock to one.
const at = (hh, mm, ss = 0) => Date.UTC(2026, 9, 16, hh, mm, ss) / 1000
const pin = (page, seconds) => page.clock.setFixedTime(new Date(seconds * 1000))
// The bare /api/quantp/holder request the wallet panel makes to learn whether the server has it.
const holderProbe = (page) => page.waitForResponse((r) => r.url().includes('/api/quantp/holder'))

test('the engine page shows its state, the next run, the tiers and rules, and every payout', async ({
  page,
}) => {
  await pin(page, at(7, 17))
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ lastRunAt: at(7, 0), updatedAt: at(7, 16) }) })
  await enter(page)
  const probe = holderProbe(page)
  await page.goto(ENGINE)
  await expect(page).toHaveTitle('Payout Engine · Quant Pad')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Payout EnginePays $QUANTP holders in SOL and burns $QUANTP, about once an hour.',
  )
  await expect(hero(page)).toContainText('Running hourly')
  await expect(hero(page)).toContainText('Next run0.0083 SOL')
  await expect(hero(page)).toContainText('0.005 SOL to 28 of 31 eligible wallets')
  await expect(hero(page)).toContainText('0.0033 SOL to buy back and burn')
  await expect(hero(page).getByRole('list')).toHaveCount(1)
  await expect(runLine(page)).toHaveText(
    'Last run 17m ago · next run from 08:00 UTC (in about 43 min) · updated 1m ago',
  )
  // the time moves on its own, and only the state is announced
  await expect(runLine(page)).not.toHaveAttribute('aria-live')
  await expect(hero(page).locator('[role="status"]')).toHaveText('Payout engine: Running hourly.')
  await expect(page.locator('.eg-fresh')).toHaveText('Engine figures from 1m ago')
  await expect(hero(page).getByRole('link', { name: 'Payout wallet' })).toHaveAttribute(
    'href',
    `https://solscan.io/account/${QUANTP.payoutWallet}`,
  )

  const stats = page.locator('.eg-stats')
  await expect(stats).toContainText('Release rate1.67% / hour')
  await expect(stats).toContainText('In the payout wallet1.022 SOL')
  await expect(stats).toContainText('Eligible / paid next run31 / 28')
  await expect(stats).toContainText('Paid to holders0.55 SOL')
  await expect(stats).toContainText('Bought back and burned0 QUANTP')

  const how = page.getByRole('region', { name: 'How it works' })
  await expect(how.getByRole('listitem')).toHaveCount(5)
  await expect(how).toContainText(
    'The team funds the payout wallet' +
      'Every $QUANTP buy and sell pays a 5% fee in its Meteora DAMM v2 pool. The team sends SOL ' +
      'from the creator’s fee claims to the payout wallet when it chooses; nothing on-chain makes it.',
  )
  await expect(how).toContainText(
    'A slice is released each hour' +
      'Each hourly run releases 1.67% of what the wallet holds at today’s market cap (about 33% ' +
      'of it over a day if nothing new comes in).',
  )
  await expect(how).toContainText('(1.5M $QUANTP), by balance. Pools and the team’s wallets')
  await expect(how).not.toContainText('hold more, get more')
  await expect(how).toContainText('Any $QUANTP already in the engine wallet is burned with it.')

  const tiers = page.getByRole('region', { name: 'Release rate, by market cap' })
  await expect(tiers.locator('.is-now')).toHaveCount(1)
  await expect(tiers.locator('.is-now')).toHaveText(
    'Below $100KNow1.67%of the wallet each hour, about 33% of it a day',
  )
  await expect(tiers).toContainText('$100K to $1M4.17%of the wallet each hour, about 64% of it')
  await expect(tiers).toContainText('Above $1M8.33%of the wallet each hour, about 88% of it a day')
  await expect(tiers).not.toContainText('all of the wallet')
  await expect(tiers).toContainText('Each run releases at most 1 SOL and keeps 0.02 SOL')

  const rules = page.getByRole('region', { name: 'The rules' })
  await expect(rules).toContainText('About once each UTC hour while it is running')
  await expect(rules).toContainText('at least 0.15% of the supply (1.5M $QUANTP)')
  await expect(rules).toContainText('Liquidity pools and the team’s wallets')
  await expect(rules).toContainText(
    'A holder’s share under 0.00002 SOL, or under 0.00089 SOL to a wallet holding no SOL (the ' +
      'least a new account can receive), is skipped that run and stays in the payout wallet; ' +
      'keep a little SOL in your wallet to be paid.',
  )
  await expect(rules).toContainText(
    'Small buybacksA buyback under 0.002 SOL is skipped that run and stays in the wallet.',
  )

  const disclose = page.getByRole('region', { name: 'Before you buy' })
  await expect(disclose).toContainText('Payouts are small at today’s market cap and can be zero.')
  await expect(disclose).toContainText(
    'Payouts and buybacks are the team’s discretionary policy: they can change, pause or stop ' +
      'at any time, and holding $QUANTP gives no right to any payment.',
  )

  // the ledger, without the engine block this page already shows in full
  const ledger = page.getByRole('region', { name: 'Payouts & burns' })
  await expect(ledger.locator('tbody tr')).toHaveCount(1)
  await expect(ledger.locator('.qp-engine')).toHaveCount(0)

  // a server without /api/quantp/holder, and a status without its holders, show neither panel
  expect((await probe).status()).toBe(404)
  await expect(page.locator('.eg-wallet')).toHaveCount(0)
  await expect(page.locator('.eg-holders')).toHaveCount(0)

  // leaving the page gives the tab its title back
  await page.getByRole('link', { name: '$QUANTP page' }).click()
  await expect(page).toHaveURL(QUANTP.path)
  await expect(page).not.toHaveTitle('Payout Engine · Quant Pad')
})

test('a run that is due says so, with stale figures and the last payout, burn and run', async ({
  page,
}) => {
  await pin(page, at(7, 5))
  await stubApi(page)
  const engine = quantpEngine({
    lastRunAt: at(6, 7),
    updatedAt: at(7, 4),
    state: 'stale',
    lastPaidAt: at(6, 7, 12),
    lastBurnAt: at(6, 7, 30),
    lastRun: { at: at(6, 7) * 1000, ok: true, payouts: ['a', 'b'], buyback: 'c', skipped: [] },
  })
  await stubQuantp(page, { engine })
  await enter(page)
  await page.goto(ENGINE)
  await expect(runLine(page)).toHaveText(
    'Last run 58m ago · a run is due now (usually within a few minutes) · updated 1m ago: the ' +
      'chain could not be read just now',
  )
  // figures that could not be refreshed are not shown as healthy
  await expect(hero(page).locator('.chip', { hasText: 'Running hourly' })).not.toHaveClass(
    /chip-grad/,
  )
  await expect(hero(page).locator('[role="status"]')).toHaveText(
    'Payout engine: Running hourly (its figures may be out of date).',
  )
  await expect(page.locator('.eg-fresh')).toHaveText(
    'Engine figures from 1m ago · last payout 06:07 UTC · last burn 06:07 UTC · Last run at ' +
      '06:07 UTC: 2 payout transactions, bought back and burned',
  )
})

test('the last run says what it sent, when a batch failed or it stopped early', async ({
  page,
}) => {
  await pin(page, at(7, 5))
  await stubApi(page)
  // the engine's lastRun: a failed batch is recorded as its error, and the run goes on
  const run = (over) => ({
    at: at(7, 0),
    ok: false,
    stopped: null,
    error: 'Transaction simulation failed',
    payouts: ['a', 'b'],
    buyback: 'c',
    skipped: [],
    ...over,
  })
  const cases = [
    [run(), '2 payout transactions, bought back and burned, but part of it failed'],
    [
      run({ payouts: [], buyback: null }),
      'it hit an error and sent nothing; the next run tries again',
    ],
    [
      run({ error: null, stopped: 'payout not confirmed', payouts: ['a'], buyback: null }),
      '1 payout transaction, no buyback, then it stopped (payout not confirmed)',
    ],
    [
      run({ stopped: 'claim failed', payouts: [], buyback: null, skipped: [{}, {}] }),
      'it stopped (claim failed), 2 wallets skipped',
    ],
  ]
  let engine
  await stubQuantp(page)
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await enter(page)
  for (const [lastRun, text] of cases) {
    engine = quantpEngine({ lastRunAt: at(7, 0), updatedAt: at(7, 4), lastRun })
    await page.goto(ENGINE)
    await expect(page.locator('.eg-fresh')).toHaveText(
      `Engine figures from 1m ago · Last run at 07:00 UTC: ${text}`,
    )
  }
})

test('an engine whose state cannot be read says so and shows no next run', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: 503 })
  await enter(page)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText('The engine’s state is unavailable right now')
  await expect(hero(page)).toContainText('Next run—')
  await expect(hero(page).locator('[role="status"]')).toHaveText(
    'The payout engine’s state is unavailable right now.',
  )
  await expect(page.locator('.eg-stats')).toContainText('Eligible / paid next run—')
})

test('a run too small to buy back says why, and when buybacks resume', async ({ page }) => {
  await stubApi(page)
  const small = {
    balance: '500000000',
    next: {
      release: '4000000',
      holders: '2400000',
      buyback: '0',
      skipped: { belowMin: 1, noSol: 1, notPayable: 1 },
    },
  }
  let engine = quantpEngine(small)
  await stubQuantp(page, { engine })
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await enter(page)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText(
    '0.0024 SOL to 28 of 31 eligible wallets (1 below the minimum, 1 needs SOL, 1 not a wallet)',
  )
  await expect(hero(page)).toContainText(
    'No buyback this run: its share (0.0016 SOL) is under 0.002 SOL and stays in the wallet; ' +
      'buybacks resume once the wallet holds more than 0.32 SOL or the market cap reaches the ' +
      'next tier.',
  )
  await expect(hero(page)).not.toContainText('to buy back and burn')

  // an engine that batches small buybacks says how often it buys instead
  engine = quantpEngine({
    ...small,
    next: { ...small.next, buybackPot: '1600000', buybackEveryHours: 2 },
  })
  await page.reload()
  await expect(hero(page)).toContainText(
    'No buyback this run: its share (0.0016 SOL) is under 0.002 SOL; it buys every 2 hours instead.',
  )
  await expect(page.getByRole('region', { name: 'The rules' })).toContainText(
    'A buyback under 0.002 SOL is batched every few hours.',
  )
})

test('an engine with nothing above the payout minimums shows what it would send', async ({
  page,
}) => {
  await pin(page, at(7, 17))
  await stubApi(page)
  const engine = quantpEngine({
    lastRunAt: at(7, 0),
    updatedAt: at(7, 16),
    balance: '25000000',
    next: { release: '41666', holders: '0', buyback: '0', paying: 0 },
  })
  await stubQuantp(page, { engine })
  await enter(page)
  await page.goto(ENGINE)
  // 'Idle: below the payout minimums' once engineState knows the idle state; until then, running
  const state = engineState(engine, at(7, 17))
  await expect(hero(page).locator('.qp-chips')).toContainText(ENGINE_STATE_LABEL[state])
  await expect(hero(page)).toContainText('0 SOL to 0 of 31 eligible wallets')
  await expect(hero(page)).toContainText('No buyback this run: its share (0.0000167 SOL)')
  await expect(runLine(page)).toHaveText(
    state === 'idle'
      ? 'Last run 17m ago: every share is under the payout minimums, so runs send nothing until ' +
          'the wallet holds more · next run from 08:00 UTC (in about 43 min) · updated 1m ago'
      : 'Last run 17m ago · next run from 08:00 UTC (in about 43 min) · updated 1m ago',
  )
  await expect(page.locator('.eg-stats')).toContainText('Eligible / paid next run31 / 0')
})

test('the eligible wallets of the next run are listed, largest first', async ({ page }) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine(quantpHolders()) })
  await enter(page)
  await page.goto(ENGINE)
  const holders = page.getByRole('region', { name: 'Eligible wallets, next run' })
  await expect(holders).toContainText('Each 1M $QUANTP held earns about 0.0000117 SOL this run.')
  const rows = holders.locator('tbody tr')
  await expect(rows).toHaveCount(10)
  const { holders: list } = quantpHolders()
  const first = list[0].wallet
  await expect(rows.first()).toHaveText(
    `${first.slice(0, 4)}…${first.slice(-4)}90M20.99%0.001052Paid`,
  )
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', explorer.account(first))
  // a program account is never paid, and has no share of what the others hold
  await expect(rows.nth(5)).toContainText('25M——Not a wallet')
  await holders.getByRole('button', { name: 'Show all 31' }).click()
  await expect(rows).toHaveCount(31)
  await expect(rows.nth(29)).toContainText('2M0.47%—Needs SOL')
  await expect(rows.nth(30)).toContainText('1.5M0.35%—Below minimum')
  // the shares add up to the whole of what the payable wallets hold
  const shares = await rows
    .locator('.eg-share')
    .evaluateAll((cells) => cells.map((c) => parseFloat(c.textContent)).filter(Number.isFinite))
  expect(shares).toHaveLength(30)
  expect(Math.abs(shares.reduce((s, x) => s + x, 0) - 100)).toBeLessThan(0.1)
})

test('a holder looks up their wallet, prefilled once a wallet is connected', async ({ page }) => {
  await stubApi(page)
  const other = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
  const { holders: rows } = quantpHolders()
  const row = (wallet) => rows.find((r) => r.wallet === wallet)
  await stubQuantp(page, {
    engine: quantpEngine(quantpHolders()),
    holder: (wallet) =>
      wallet === WALLET_ADDRESS
        ? quantpHolder({ wallet })
        : row(wallet)
          ? quantpHolder({ wallet, engine: row(wallet) })
          : quantpHolder({
              wallet,
              engine: { eligible: false },
              paid: { lamports: '0', payouts: 0, lastAt: null, items: [] },
            }),
  })
  await enter(page, { wallet: true })
  await page.goto(ENGINE)
  const panel = page.getByRole('region', { name: 'Your wallet' })
  const address = panel.getByLabel('Wallet address')
  await expect(address).toHaveValue('')

  await address.fill('not an address')
  await panel.getByRole('button', { name: 'Look up' }).click()
  await expect(panel).toContainText('Enter a Solana wallet address.')
  await expect(address).toHaveAttribute('aria-invalid', 'true')

  await address.fill(other)
  await address.press('Enter')
  // a wallet the engine leaves out may hold any amount: it may be a pool or the team's
  await expect(panel).toContainText(
    'EligibleNo: not among the next run’s eligible wallets (it needs at least 1.5M $QUANTP; ' +
      'pools and the team’s wallets are never paid)',
  )
  await expect(panel).not.toContainText('holds under')
  await expect(panel).toContainText('Paid so far0 SOL in 0 payouts')
  await expect(panel).toContainText('Last payoutNone yet')

  // a skipped wallet's share, which the engine does not list, is worked out from its status
  await address.fill(rows[30].wallet)
  await address.press('Enter')
  await expect(panel).toContainText(
    'Next runSkipped this run: its share (0.0000175 SOL) is under 0.00002 SOL and stays in the ' +
      'payout wallet',
  )
  await address.fill(rows[29].wallet)
  await address.press('Enter')
  await expect(panel).toContainText(
    'Next runSkipped this run: the wallet holds no SOL and its share (0.0000234 SOL) is under ' +
      '0.00089 SOL; keep a little SOL in it to be paid',
  )
  await expect(panel).not.toContainText('(—)')

  // connecting fills in the wallet only when the field holds nothing typed
  await address.fill('')
  await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Test Wallet' }).click()
  await expect(address).toHaveValue(WALLET_ADDRESS)
  await expect(panel).toContainText('EligibleYes')
  await expect(panel).toContainText('Holds90,000,000 $QUANTP')
  await expect(panel).toContainText('Next run0.001052 SOL')
  await expect(panel).toContainText('Paid so far0.0998 SOL in 3 payouts')
  await expect(panel).toContainText('Last payout0.001424 SOL, 20m ago · Solscan')
  await expect(panel.getByRole('link', { name: /Solscan/ })).toHaveAttribute(
    'href',
    explorer.tx(quantpHolder().paid.items[0].signature),
  )
  // the address never goes into the page's URL
  expect(page.url()).not.toContain(WALLET_ADDRESS)
  expect(page.url()).not.toContain(other)
})

test('an engine switched on but not run yet says so here and on the $QUANTP page', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine({ lastRunAt: null }) })
  await enter(page)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText('Waiting for its first run')
  await expect(hero(page)).toContainText('Switched on, and waiting for its first automatic run')
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
  await expect(hero(page)).toContainText('Last run 3h ago: it is behind its hourly schedule')

  engine = quantpEngine({ live: false, reason: 'paused' })
  await page.reload()
  await expect(hero(page)).toContainText('Paused')
  await expect(hero(page)).toContainText('Next run—')
  await expect(hero(page)).toContainText('no payouts or buybacks run')
})

test('the engine drawing is decoration: one wallet per holder paid, still when it cannot move', async ({
  page,
}) => {
  await stubApi(page)
  let engine = quantpEngine()
  await stubQuantp(page, { engine })
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await enter(page)
  await page.goto(ENGINE)
  const art = hero(page).locator('.eg-art')
  await expect(art.locator('svg')).toHaveAttribute('aria-hidden', 'true')
  await expect(art.locator('.eg-node')).toHaveCount(28)
  await expect(art).toHaveAttribute('data-motion', 'on')

  // reduced motion stands it still, with nothing animating
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(art).toHaveAttribute('data-motion', 'still')
  expect(await art.locator('.eg-rotor').evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  )

  // a paused engine dims it, and it stays still
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  engine = quantpEngine({ live: false, reason: 'paused' })
  await page.reload()
  await expect(art).toHaveAttribute('data-mode', 'off')
  await expect(art).toHaveAttribute('data-motion', 'still')

  // and with the engine's state unavailable it still stands, idle
  await page.unroute('**/api/quantp/engine')
  await page.route('**/api/quantp/engine', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable', code: 'ENGINE_UNAVAILABLE' } }),
  )
  await page.reload()
  await expect(hero(page)).toContainText('Next run—')
  await expect(art.locator('svg')).toBeVisible()
  await expect(art).toHaveAttribute('data-mode', 'idle')
})

test('a hidden tab stops polling, and reloads once when it is shown again', async ({ page }) => {
  await page.clock.install()
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  await enter(page)
  let polls = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/api/quantp/engine')) polls++
  })
  const visibility = (state) =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
  await page.goto(ENGINE)
  await expect(hero(page)).toContainText('Running hourly')
  await page.waitForLoadState('networkidle')
  const loaded = polls
  expect(loaded).toBeGreaterThan(0)

  await visibility('hidden')
  await page.clock.runFor(3 * 60_000)
  expect(polls).toBe(loaded)
  // every poller that came due while hidden loads once, then keeps its own interval
  await visibility('visible')
  await expect.poll(() => polls).toBeGreaterThan(loaded)
  await page.waitForTimeout(300)
  const shown = polls
  await visibility('visible')
  await page.clock.runFor(30_000)
  await page.waitForTimeout(300)
  expect(polls).toBe(shown)
})

test('figures already shown stay when a cold server answers without its ledger', async ({
  page,
}) => {
  await page.clock.install()
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  let cold = false
  await page.route('**/api/quantp', (route) =>
    route.fulfill({ json: quantpSnapshot(cold ? { payouts: null } : {}) }),
  )
  await enter(page)
  await page.goto(ENGINE)
  const stats = page.locator('.eg-stats')
  await expect(stats).toContainText('Paid to holders0.55 SOL')
  cold = true
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/quantp'))
  await page.clock.runFor(21_000)
  expect((await (await refreshed).json()).payouts).toBeNull()
  await page.waitForTimeout(300)
  await expect(stats).toContainText('Paid to holders0.55 SOL')
})

// A cold instance on a slow RPC can answer with only its newest history (complete: false): on
// 2026-10-17 it showed 50K $QUANTP burned and 0.042 SOL paid, when the chain held 3.49M and 0.65.
const partialPayouts = {
  paidLamports: '42405758',
  wallets: 62,
  boughtLamports: '9149511',
  burnedAmount: '49979400711',
  waitingLamports: '2768041908',
  complete: false,
  since: 1792256404,
}

test('totals still being read show as "at least" on the engine, $QUANTP and home pages', async ({
  page,
}) => {
  await stubApi(page)
  await stubQuantp(page, {
    snapshot: quantpSnapshot({ payouts: partialPayouts }),
    engine: quantpEngine(),
  })
  await enter(page)
  await page.goto(ENGINE)
  const stats = page.locator('.eg-stats')
  await expect(stats).toContainText('Paid to holders≥ 0.042 SOLstill reading older payouts')
  await expect(stats).toContainText(
    'Bought back and burned≥ 49.98K QUANTPstill reading older burns',
  )
  await expect(stats.locator('dd').last()).toHaveAttribute('title', /^At least 49,979\.4/)
  // the live balance is not a total: it reads as it is
  await expect(stats).toContainText('In the payout wallet2.768 SOL')

  await page.goto(QUANTP.path)
  await expect(page.locator('.qp-split-legend')).toContainText('≥ 0.042 SOL paid so far')
  await expect(page.locator('.qp-split-legend')).toContainText(
    '≥ 0.009 SOL bought back · ≥ 49.98K burned',
  )

  await page.goto('/')
  await expect(page.locator('.fw-rows')).toContainText('≥ 0.042 SOL paid so far')
  await expect(page.locator('.fw-rows')).toContainText('≥ 49.98K burned')
})

test('complete totals already shown stay when a later answer is still reading', async ({
  page,
}) => {
  await page.clock.install()
  await stubApi(page)
  await stubQuantp(page, { engine: quantpEngine() })
  let partial = false
  await page.route('**/api/quantp', (route) =>
    route.fulfill({ json: quantpSnapshot(partial ? { payouts: partialPayouts } : {}) }),
  )
  await enter(page)
  await page.goto(ENGINE)
  const stats = page.locator('.eg-stats')
  await expect(stats).toContainText('Paid to holders0.55 SOLto 51 wallets so far')
  partial = true
  const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/quantp'))
  await page.clock.runFor(21_000)
  expect((await (await refreshed).json()).payouts.complete).toBe(false)
  await page.waitForTimeout(300)
  await expect(stats).toContainText('Paid to holders0.55 SOLto 51 wallets so far')
  await expect(stats).not.toContainText('≥')
  // only the payout wallet's balance, read live, moves on
  await expect(stats).toContainText('In the payout wallet2.768 SOL')
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
  await stubQuantp(page, {
    engine: quantpEngine(quantpHolders()),
    holder: (wallet) => quantpHolder({ wallet }),
  })
  await enter(page)
  await page.goto(ENGINE)
  await expect(
    page.getByRole('region', { name: 'Payouts & burns' }).locator('tbody tr'),
  ).toHaveCount(1)
  await expect(page.locator('.eg-wallet')).toBeVisible()
  await expect(page.locator('.eg-holders')).toBeVisible()
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
    await stubQuantp(page, {
      engine: quantpEngine(quantpHolders()),
      holder: (wallet) => quantpHolder({ wallet }),
    })
    await enter(page)
    await page.goto(ENGINE)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(
      page.getByRole('region', { name: 'Payouts & burns' }).locator('tbody tr'),
    ).toHaveCount(1)
    await expect(page.locator('.eg-wallet')).toBeVisible()
    // the holder's wallet, how it works and the tiers, who the next run pays, the fine print before
    // any payout is listed, then every payout and the rules
    const order = [
      '.eg-wallet',
      '.eg-how',
      '.eg-tiers',
      '.eg-holders',
      '.eg-disclose',
      '.qp-ledger',
      '.eg-rules',
    ]
    const tops = await Promise.all(
      order.map((s) => page.locator(s).evaluate((el) => el.getBoundingClientRect().top)),
    )
    expect([...tops].sort((a, b) => a - b)).toEqual(tops)
    await page.waitForTimeout(400)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow).toBeLessThanOrEqual(1)
  })

for (const width of [360, 375])
  test(`on a ${width} px phone every stat fits its column, burns in the tens of millions included`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 780 })
    await stubApi(page)
    const snapshot = quantpSnapshot()
    await stubQuantp(page, {
      snapshot: {
        ...snapshot,
        payouts: {
          ...snapshot.payouts,
          paidLamports: '12345678901',
          burnedAmount: '12345678000000',
          waitingLamports: '123456789012',
        },
      },
      // the widest figures there can be: at most 666 wallets each hold 0.15% of the supply
      engine: quantpEngine({
        marketCapUsd: 1_234_567,
        dailyBps: 20_000,
        eligible: 666,
        next: { paying: 650 },
      }),
    })
    await enter(page)
    await page.goto(ENGINE)
    const stats = page.locator('.eg-stats')
    await expect(stats).toContainText('Bought back and burned12.35M QUANTP')
    await expect(stats).toContainText('Release rate8.33% / hour')
    await expect(stats).toContainText('Eligible / paid next run666 / 650')
    await expect(stats.locator('dd').last()).toHaveAttribute('title', '12,345,678 QUANTP')
    const clipped = await stats
      .locator('dd')
      .evaluateAll((dds) =>
        dds
          .filter((dd) => dd.scrollWidth > dd.clientWidth + 1)
          .map((dd) => `${dd.textContent}: ${dd.scrollWidth} > ${dd.clientWidth}`),
      )
    expect(clipped).toEqual([])
  })
