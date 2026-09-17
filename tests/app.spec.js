import { test, expect } from '@playwright/test'
import { encodeFunctionResult, erc20Abi, toFunctionSelector } from 'viem'

const tokenAddress = '0x1111111111111111111111111111111111111111'
const account = '0x2222222222222222222222222222222222222222'
// All synthetic values in this file are test fixtures. Production has no fallback data.
async function rpc(page, { wrongChain = false } = {}) {
  await page.route(/https:\/\/rpc\.(?:drpc\.)?mainnet\.arc\.io/, async (route) => {
    const request = route.request().postDataJSON()
    const respond = (item) => {
      let result
      if (item.method === 'eth_chainId') result = wrongChain ? '0x1' : '0x13b2'
      else if (item.method === 'eth_blockNumber') result = '0x1234'
      else if (item.method === 'eth_getBlockByNumber')
        result = {
          number: '0x1234',
          timestamp: '0x6aa00000',
          hash: '0x' + 'a'.repeat(64),
          transactions: [],
        }
      else if (item.method === 'eth_getBalance') result = '0x8ac7230489e80000'
      else if (item.method === 'eth_getCode')
        result = item.params[0].toLowerCase() === tokenAddress ? '0x6000' : '0x'
      else if (item.method === 'eth_call') {
        const results = {
          name: 'Fixture Token',
          symbol: 'TEST',
          decimals: 6,
          totalSupply: 1234567890123456789n,
        }
        const functionName = Object.keys(results).find(
          (name) => toFunctionSelector(`${name}()`) === item.params[0].data,
        )
        if (!functionName)
          return {
            jsonrpc: '2.0',
            id: item.id,
            error: { code: -32000, message: 'Unknown test call' },
          }
        result = encodeFunctionResult({
          abi: erc20Abi,
          functionName,
          result: results[functionName],
        })
      } else
        return { jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Unknown test RPC' } }
      return { jsonrpc: '2.0', id: item.id, result }
    }
    await route.fulfill({ json: Array.isArray(request) ? request.map(respond) : respond(request) })
  })
}
async function unlock(page) {
  await page.addInitScript(() => localStorage.setItem('hooker_vamp_access_v1', '1'))
}
async function injectWallet(page, { reject = false, unknownChain = false } = {}) {
  await page.addInitScript(
    ({ reject, unknownChain, account }) => {
      const listeners = new Map()
      let chain = '0x1'
      window.__walletRequests = []
      window.__walletEmit = (event, value) => {
        if (event === 'chainChanged') chain = value
        for (const listener of listeners.get(event) || []) listener(value)
      }
      const provider = {
        on(event, listener) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event).add(listener)
        },
        removeListener(event, listener) {
          listeners.get(event)?.delete(listener)
        },
        async request(request) {
          window.__walletRequests.push(request)
          if (request.method === 'eth_requestAccounts') {
            if (reject) throw { code: 4001, message: 'Rejected' }
            return [account]
          }
          if (request.method === 'eth_chainId') return chain
          if (request.method === 'wallet_switchEthereumChain') {
            if (unknownChain) throw { code: 4902 }
            chain = request.params[0].chainId
            window.__walletEmit('chainChanged', chain)
            return null
          }
          if (request.method === 'wallet_addEthereumChain') {
            unknownChain = false
            return null
          }
          throw new Error('Unexpected wallet method: ' + request.method)
        },
      }
      const detail = {
        info: { uuid: 'hookbrew-test-wallet', name: 'Test wallet', rdns: 'test.hookbrew' },
        provider,
      }
      const announce = () =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { reject, unknownChain, account },
  )
}

test.beforeEach(async ({ page }) => {
  await rpc(page)
})

test('gate requires all acknowledgements and remembers entry', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Confirm all four to continue' })).toBeDisabled()
  for (const rule of await page.locator('.rule').all()) await rule.click()
  await page.getByRole('button', { name: 'Step onto the floor' }).click()
  await expect(page.getByRole('heading', { name: 'Your token. Your rules.' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.gate-screen')).toHaveCount(0)
})

test('sidebar uses distinct section icons and keeps the glass surface', async ({ page }) => {
  await unlock(page)
  await page.addInitScript(() => localStorage.setItem('hooker_glass_lightweight_v1', '1'))
  await page.goto('/')
  const artwork = page.locator('.nav-artwork')
  await expect(artwork).toHaveCount(9)
  await expect(page.locator('a[href="/trade"] .nav-artwork')).toHaveAttribute(
    'src',
    '/brand/navigation/platinum/trade.png',
  )
  await expect(page.locator('a[href="/agents"] .nav-artwork')).toHaveAttribute(
    'src',
    '/brand/navigation/platinum/agents.png',
  )
  await expect
    .poll(() =>
      artwork.evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0),
      ),
    )
    .toBe(true)
  expect(
    await artwork.evaluateAll((images) => new Set(images.map((image) => image.src)).size),
  ).toBe(9)
  await expect(page.locator('.sidebar')).not.toContainText('A little hook.')
  await expect(page.getByRole('link', { name: 'Help & resources' })).toBeVisible()
  await expect(page.getByLabel('Arc network status')).toContainText('Network connected')
  await expect(page.getByLabel('Arc network status')).toContainText('4,660')
  await expect(page.locator('.glass-mode')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /liquid glass|light glass/i })).toHaveCount(0)
  await expect(page.locator('.ql-lens').first()).toBeAttached()
  await expect(page.locator('feDisplacementMap').first()).toBeAttached()
  await expect
    .poll(() =>
      page
        .locator('.ql-lens')
        .first()
        .evaluate((element) => getComputedStyle(element).backdropFilter),
    )
    .toContain('url(')
  await page.screenshot({ path: 'artifacts/hookbrew-real-home.png', fullPage: true })
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 939, height: 898 },
    { width: 1024, height: 861 },
    { width: 1024, height: 860 },
    { width: 1024, height: 821 },
    { width: 1024, height: 820 },
    { width: 1024, height: 600 },
    { width: 1024, height: 500 },
    { width: 390, height: 844 },
    { width: 390, height: 861 },
    { width: 390, height: 821 },
    { width: 844, height: 390 },
    { width: 390, height: 500 },
    { width: 320, height: 480 },
  ]) {
    await page.setViewportSize(viewport)
    if (viewport.width <= 900) {
      await page.getByRole('button', { name: 'Open navigation' }).click()
    }
    const layout = await page.locator('.sidebar').evaluate((sidebar) => {
      const bounds = sidebar.getBoundingClientRect()
      const rows = [
        ...sidebar.querySelectorAll('.nav-item, .sidebar-network, .sidebar-help'),
      ].filter((row) => row.getClientRects().length)
      return {
        fits: rows.every((row) => {
          const rect = row.getBoundingClientRect()
          return (
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom &&
            rect.bottom <= innerHeight &&
            row.scrollWidth <= row.clientWidth
          )
        }),
        scrolls: sidebar.scrollHeight > sidebar.clientHeight,
        footerOverlaps:
          sidebar.querySelector('.sidebar-footer').getBoundingClientRect().top <
          sidebar.querySelector('nav').getBoundingClientRect().bottom,
      }
    })
    expect(layout, `${viewport.width}x${viewport.height}`).toEqual({
      fits: true,
      scrolls: false,
      footerOverlaps: false,
    })
    await page.locator('.sidebar').screenshot({
      path: `artifacts/sidebar-platinum/${viewport.width}x${viewport.height}.png`,
    })
    if (viewport.width <= 900) await page.keyboard.press('Escape')
  }
})

test('real address lookup decodes metadata and preserves full precision', async ({ page }) => {
  await unlock(page)
  await page.goto('/market')
  await page
    .getByRole('textbox', { name: 'Token contract address', exact: true })
    .fill(tokenAddress)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fixture Token' })).toBeVisible()
  await expect(page.locator('.token-lookup')).toContainText('1234567890123.456789 TEST')
  await expect(page.locator('.token-lookup')).toContainText('4660')
  await expect(page.locator('.token-lookup img')).toHaveCount(0)
  await page.getByRole('link', { name: 'View contract details' }).click()
  await expect(page).toHaveURL(new RegExp(`/token/${tokenAddress}`))
  await expect(page.getByRole('heading', { name: 'Fixture Token' })).toBeVisible()
})

test('invalid addresses and absent contracts do not become invented tokens', async ({ page }) => {
  await unlock(page)
  await page.goto('/token/rain')
  await expect(page.getByRole('heading', { name: 'Enter a valid token address' })).toBeVisible()
  await page.goto(`/token/${account}`)
  await expect(page.getByRole('alert')).toContainText('No contract exists')
  await expect(page.locator('.token-lookup .token-top')).toHaveCount(0)
})

test('wallet connects, adds Arc, reads balance, tracks account events and disconnects', async ({
  page,
}) => {
  await injectWallet(page, { unknownChain: true })
  await unlock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Test wallet' }).click()
  await expect(page.getByRole('dialog')).toContainText(account)
  await page.getByRole('button', { name: 'Switch to Arc' }).click()
  await expect(page.getByRole('dialog').locator('.preview-stat').last()).toContainText('10')
  const calls = await page.evaluate(() => window.__walletRequests)
  expect(
    calls.find((call) => call.method === 'wallet_addEthereumChain').params[0].nativeCurrency
      .decimals,
  ).toBe(18)
  expect(calls.some((call) => /send|sign|approve/i.test(call.method))).toBe(false)
  await page.evaluate(() =>
    window.__walletEmit('accountsChanged', ['0x3333333333333333333333333333333333333333']),
  )
  await expect(page.getByRole('dialog')).toContainText('0x3333333333333333333333333333333333333333')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveAccessibleName('Connect a wallet')
  await expect(page.locator('.wallet-address')).toHaveCount(0)
})

test('rejected and missing wallet connections never manufacture an account', async ({ page }) => {
  await injectWallet(page, { reject: true })
  await unlock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Test wallet' }).click()
  await expect(page.getByRole('alert')).toContainText('declined')
  await expect(page.locator('.wallet-address')).toHaveCount(0)
})

test('no installed provider offers instructions instead of a pretend wallet', async ({ page }) => {
  await unlock(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('No wallet was detected')
  await expect(page.getByRole('button', { name: /demo/i })).toHaveCount(0)
})

test('all routes show actual integration status without synthetic markets', async ({ page }) => {
  await unlock(page)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const route of [
    '/',
    '/market',
    '/create',
    '/trade',
    '/liquidity',
    '/leaderboard',
    '/modules',
    '/agents',
    '/docs',
    '/terms',
  ]) {
    await page.goto(route)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('.token-card, .sparkline, .activity-row, .podium-card')).toHaveCount(
      0,
    )
    await expect(page.locator('body')).not.toContainText(
      /Demo market|demo wallet|Sugar Floor|Jitless|Bouncer Club|2,310/,
    )
  }
  expect(errors).toEqual([])
  await page.goto('/create')
  await expect(page.getByRole('heading', { name: 'Make your first impression.' })).toBeVisible()
  await page.goto('/trade')
  await expect(page.getByRole('heading', { name: 'Find your next trade.' })).toBeVisible()
})

test('mobile navigation preserves focus and does not overflow', async ({ page }) => {
  await unlock(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('dialog', { name: 'Site navigation' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/hookbrew-real-mobile-nav.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('wrong RPC chain is an error, not a connected Arc status', async ({ page }) => {
  await page.unrouteAll()
  await rpc(page, { wrongChain: true })
  await unlock(page)
  await page.goto('/')
  await expect(page.getByLabel('Network and deployment status')).toContainText(
    'Connection unavailable',
  )
  await expect(page.locator('.network-chip .status-dot')).toHaveClass(/status-offline/)
  await expect(page.getByLabel('Arc network status')).toContainText('Connection unavailable')
  await expect(page.locator('.sidebar-network-block')).toContainText('—')
  await expect(page.getByRole('button', { name: 'Retry network' })).toBeVisible()
})
