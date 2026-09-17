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
  await expect(page.getByRole('heading', { name: 'Brew something worth trading.' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.gate-screen')).toHaveCount(0)
})

test('sidebar uses distinct section icons and keeps the glass surface', async ({ page }) => {
  await unlock(page)
  await page.addInitScript(() => localStorage.setItem('hooker_glass_lightweight_v1', '1'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
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
    { width: 1024, height: 881 },
    { width: 1024, height: 880 },
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
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open navigation' }).click()
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
      animations: 'disabled',
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

test('wallet picker loads every official logo and handles broken extension icons', async ({
  page,
}) => {
  await unlock(page)
  await page.addInitScript(() => {
    const names = ['Rabby Wallet', 'Coinbase Wallet', 'MetaMask', 'Phantom', 'TronLink']
    const wallets = names.map((name) => ({
      info: { uuid: name, name },
      provider: {
        request: async () => {
          throw Error('Unexpected connection request')
        },
      },
    }))
    wallets.push({
      info: {
        uuid: 'broken-icon',
        name: 'Broken icon wallet',
        icon: 'data:image/png;base64,broken',
      },
      provider: {
        request: async () => {
          throw Error('Unexpected connection request')
        },
      },
    })
    window.ethereum = {
      isMetaMask: true,
      request: async () => {
        throw Error('Unexpected connection request')
      },
    }
    window.addEventListener('eip6963:requestProvider', () => {
      wallets.forEach((detail) =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })),
      )
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.wallet-option')).toHaveCount(7)
  await expect(
    dialog
      .getByRole('button', { name: 'Broken icon wallet', exact: true })
      .locator('.wallet-logo svg'),
  ).toBeVisible()
  const images = dialog.locator('.wallet-option img')
  await expect(images).toHaveCount(6)
  await expect
    .poll(() =>
      images.evaluateAll((items) =>
        items.every((image) => image.complete && image.naturalWidth > 0),
      ),
    )
    .toBe(true)
  for (const name of [
    'Rabby Wallet',
    'Coinbase Wallet',
    'MetaMask',
    'Phantom',
    'TronLink',
    'Browser wallet',
  ]) {
    await expect(dialog.getByRole('button', { name, exact: true })).toBeEnabled()
  }
  await dialog.screenshot({ path: 'artifacts/wallet-logos-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.screenshot({ path: 'artifacts/wallet-logos-mobile.png' })
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
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
  await expect(page.getByRole('heading', { name: 'The pool' })).toBeVisible()
  await page.goto('/trade')
  await expect(page.getByRole('heading', { name: 'Find your next trade.' })).toBeVisible()
})

test('mobile navigation preserves focus and does not overflow', async ({ page }) => {
  await unlock(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('dialog', { name: 'Site navigation' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('link', { name: 'Help & resources' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeFocused()
  await expect(page.locator('.main-col')).toHaveAttribute('inert', '')
  await page.screenshot({ path: 'artifacts/hookbrew-real-mobile-nav.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('home keeps an icon rail and navigation expands, collapses, and follows routes', async ({
  page,
}) => {
  await unlock(page)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/market?sort=newest', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  )
  await page.goto('/')
  const launcher = page.getByRole('button', { name: 'Open navigation' })
  await expect(launcher).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Quick navigation' })).toBeVisible()
  await expect(page.locator('.rail-artwork')).toHaveCount(9)
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0)
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '')
  await expect(page.getByRole('link', { name: 'Launch a token', exact: true })).toHaveAttribute(
    'href',
    '/create',
  )
  await expect(page.getByRole('link', { name: 'Explore the market' })).toHaveAttribute(
    'href',
    '/market',
  )
  await expect(page.getByRole('heading', { name: 'The next launch could be yours.' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(page.locator('.hook-layer')).toHaveCount(3)
  await expect(page.locator('.brew-flask')).toHaveCount(0)
  const railTrade = page
    .getByRole('navigation', { name: 'Quick navigation' })
    .getByRole('link', { name: 'Trade', exact: true })
  await railTrade.hover()
  await expect(railTrade.locator('.rail-tooltip')).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: 'artifacts/hookbrew-home-redesign-desktop.png',
    fullPage: true,
    animations: 'disabled',
  })
  await launcher.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.locator('.main-col')).not.toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeFocused()
  await expect(page.getByRole('navigation', { name: 'Quick navigation' })).toHaveCount(0)
  await page.screenshot({
    path: 'artifacts/hookbrew-home-redesign-expanded.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Collapse navigation' }).click()
  await expect(launcher).toBeFocused()
  await page
    .getByRole('navigation', { name: 'Quick navigation' })
    .getByRole('link', { name: 'Market', exact: true })
    .click()
  await expect(page).toHaveURL(/\/market$/)
  await expect(launcher).toBeVisible()
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '')
  await page.goto('/')
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 600 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(page.getByRole('heading', { name: 'Brew something worth trading.' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: `artifacts/hookbrew-home-redesign-${viewport.width}.png`,
      fullPage: true,
    })
  }
  await page.getByRole('link', { name: 'Launch a token', exact: true }).click()
  await expect(page).toHaveURL(/\/create$/)
  await expect(page.getByRole('heading', { name: 'The pool' })).toBeVisible()
  expect(errors).toEqual([])
})

test('glass layers respond to the pointer and respect reduced motion', async ({ page }) => {
  await unlock(page)
  await page.goto('/')
  const stack = page.locator('.hook-stack')
  const layer = page.locator('.hook-layer-swap')
  const bounds = await stack.boundingBox()
  const resting = await layer.evaluate((el) => getComputedStyle(el).transform)
  await page.mouse.move(bounds.x + bounds.width * 0.85, bounds.y + bounds.height * 0.3)
  await expect(stack).toHaveAttribute('data-active', 'true')
  await expect.poll(() => layer.evaluate((el) => getComputedStyle(el).transform)).not.toBe(resting)
  await page.screenshot({
    path: 'artifacts/hookbrew-glass-hover.png',
    fullPage: true,
    animations: 'disabled',
  })
  await page.mouse.move(500, 40)
  await expect(stack).toHaveAttribute('data-active', 'false')
  await expect.poll(() => layer.evaluate((el) => getComputedStyle(el).transform)).toBe(resting)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.6)
  await expect(stack).toHaveAttribute('data-active', 'false')
  expect(await layer.evaluate((el) => getComputedStyle(el).transform)).toBe(resting)
})

test('compact icon rail fits short desktop windows and expands from its arrow', async ({
  page,
}) => {
  await unlock(page)
  await page.goto('/')
  for (const height of [900, 680, 600, 500]) {
    await page.setViewportSize({ width: 1024, height })
    await expect(page.getByRole('navigation', { name: 'Quick navigation' })).toBeVisible()
    expect(
      await page.locator('.navigation-rail').evaluate((el) => {
        const bounds = el.getBoundingClientRect()
        return (
          el.scrollHeight <= el.clientHeight &&
          [...el.querySelectorAll('.rail-link')]
            .filter((link) => link.getClientRects().length)
            .every((link) => link.getBoundingClientRect().bottom <= bounds.bottom)
        )
      }),
    ).toBe(true)
  }
  await page.getByRole('button', { name: 'Expand navigation' }).click()
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: 'Quick navigation' })).toBeVisible()
})

test('home distinguishes loading, errors, and real market data with retry', async ({ page }) => {
  await unlock(page)
  let release
  const pending = new Promise((resolve) => {
    release = resolve
  })
  let recovered = false
  await page.route('**/api/market?sort=newest', async (route) => {
    await pending
    await route.fulfill(
      recovered
        ? {
            json: {
              items: [
                {
                  address: tokenAddress,
                  name: 'Fixture Token',
                  symbol: 'TEST',
                  marketCap: 12345,
                  volume24h: null,
                },
              ],
              total: 1,
            },
          }
        : { status: 503, json: { error: 'Test service unavailable' } },
    )
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Checking the latest launches…' })).toBeVisible()
  await expect(page.getByText('The next launch could be yours.')).toHaveCount(0)
  release()
  await expect(page.getByText('The market is temporarily unavailable.')).toBeVisible()
  recovered = true
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('table')).toContainText('Fixture Token')
  await expect(page.getByRole('table')).toContainText('12.35K')
  await expect(page.getByRole('table')).toContainText('—')
  await expect(page.getByRole('link', { name: 'Trade TEST' })).toHaveAttribute(
    'href',
    `/token/${tokenAddress}`,
  )
  await expect(page.locator('.landing-market-error')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('wrong RPC chain is an error, not a connected Arc status', async ({ page }) => {
  await page.unrouteAll()
  await rpc(page, { wrongChain: true })
  await unlock(page)
  await page.goto('/')
  await expect(page.locator('.landing-network-error')).toContainText('Arc connection unavailable')
  await expect(page.locator('.network-chip .status-dot')).toHaveClass(/status-offline/)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByLabel('Arc network status')).toContainText('Connection unavailable')
  await expect(page.locator('.sidebar-network-block')).toContainText('—')
  await expect(page.getByRole('button', { name: 'Retry network' })).toBeVisible()
})

test('homepage and market render uploaded token icons with a safe missing-image fallback', async ({
  page,
}) => {
  await unlock(page)
  let restored = false
  const artwork = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=',
    'base64',
  )
  const tokens = [
    {
      address: tokenAddress,
      name: 'Artwork Brew',
      symbol: 'ART',
      metadata: { image: 'http://127.0.0.1:4173/media/artwork-test.png' },
    },
    {
      address: account,
      name: 'Broken Artwork',
      symbol: 'BAD',
      metadata: { image: 'http://127.0.0.1:4173/media/missing-test.png' },
    },
    {
      address: '0x3333333333333333333333333333333333333333',
      name: 'No Artwork',
      symbol: 'NONE',
      metadata: null,
    },
    {
      address: '0x4444444444444444444444444444444444444444',
      name: 'Unsafe Artwork',
      symbol: 'SAFE',
      metadata: { image: 'javascript:alert(1)' },
    },
  ]
  await page.route('**/api/market?**', (route) =>
    route.fulfill({ json: { items: tokens, total: 4, deployment: true } }),
  )
  await page.route('**/media/artwork-test.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  )
  await page.route('**/media/missing-test.png', (route) =>
    route.fulfill(
      restored ? { contentType: 'image/png', body: artwork } : { status: 404, body: '' },
    ),
  )
  for (const path of ['/', '/market']) {
    await page.goto(path)
    const good = page.getByRole('link', { name: 'Artwork Brew ART', exact: true })
    await expect(good.locator('img')).toBeVisible()
    await expect
      .poll(() => good.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0))
      .toBe(true)
    await expect(
      page
        .getByRole('link', { name: 'Broken Artwork BAD', exact: true })
        .locator('.token-initials'),
    ).toHaveText('BA')
    await expect(
      page.getByRole('link', { name: 'No Artwork NONE', exact: true }).locator('.token-initials'),
    ).toHaveText('NO')
    await expect(
      page
        .getByRole('link', { name: 'Unsafe Artwork SAFE', exact: true })
        .locator('.token-initials'),
    ).toHaveText('SA')
  }
  restored = true
  const recovered = page
    .getByRole('link', { name: 'Broken Artwork BAD', exact: true })
    .locator('img')
  await expect(recovered).toBeVisible({ timeout: 15000 })
  await expect
    .poll(() => recovered.evaluate((image) => image.complete && image.naturalWidth > 0))
    .toBe(true)
})

test('a failed route chunk offers reload and preserves drafts and pending receipts', async ({
  page,
}) => {
  await unlock(page)
  const draft = JSON.stringify({ name: 'Retained draft' })
  const pending = JSON.stringify({ scope: 'launch', hash: '0x' + 'b'.repeat(64) })
  await page.goto('/')
  await page.evaluate(
    ({ draft, pending }) => {
      localStorage.setItem('hookbrew:recovery-test-draft', draft)
      sessionStorage.setItem('hookbrew:pending-transaction:v1', pending)
    },
    { draft, pending },
  )
  await page.route('**/src/pages/SetupPage*', (route) => route.abort('failed'))
  await page.goto('/setup')
  await expect(page.getByRole('heading', { name: 'Let’s get you back to Hookbrew.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible()
  await page.unroute('**/src/pages/SetupPage*')
  await page.getByRole('button', { name: 'Reload page' }).click()
  await expect(page.getByRole('heading', { name: 'Bring the brewery on-chain.' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hookbrew:recovery-test-draft'))).toBe(
    draft,
  )
  expect(await page.evaluate(() => sessionStorage.getItem('hookbrew:pending-transaction:v1'))).toBe(
    pending,
  )
})
