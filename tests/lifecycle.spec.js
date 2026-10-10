import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  keccak256,
  getCreate2Address,
  toHex,
  parseUnits,
  erc20Abi,
} from 'viem'
import { createApplication } from '../server/application.mjs'
import { sharedStore } from './fixtures/shared-store.mjs'

// Real Uniswap V4 contracts, isolated local chain and unlocked TEST accounts only.
// No mainnet RPC is contacted, no user's wallet is used, and no fixture data enters production.
let node,
  server,
  app,
  secondApp,
  dataDir,
  origin,
  client,
  creator,
  config,
  applicationOptions,
  errors = []
const rpc = 'http://127.0.0.1:8547'
async function rpcCall(method, params = []) {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const data = await r.json()
  if (data.error) throw Error(data.error.message)
  return data.result
}
async function apiCall(path, body) {
  const r = await fetch(
    origin + path,
    body
      ? {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  )
  const data = await r.json()
  if (!r.ok) throw Error(data.error)
  return data
}
async function artifact(path) {
  return JSON.parse(await readFile(resolve('contracts/protocol/artifacts', path), 'utf8'))
}
test.beforeAll(async () => {
  test.setTimeout(120000)
  dataDir = await mkdtemp(join(tmpdir(), 'hookbrew-browser-'))
  node = spawn(
    process.execPath,
    [
      resolve('contracts/protocol/node_modules/hardhat/internal/cli/cli.js'),
      'node',
      '--hostname',
      '127.0.0.1',
      '--port',
      '8547',
    ],
    {
      cwd: resolve('contracts/protocol'),
      env: { ...process.env, HOOKBREW_TEST_CHAIN_ID: '4663' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let log = ''
  node.stdout.on('data', (b) => {
    log += b.toString()
    if (log.length > 20000) log = log.slice(-20000)
  })
  node.stderr.on('data', (b) => {
    log += b.toString()
  })
  for (let i = 0; i < 100; i++) {
    if (node.exitCode !== null) throw Error('Local test chain failed: ' + log)
    try {
      await rpcCall('eth_chainId')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
    if (i === 99) throw Error('Test chain did not start: ' + log)
  }
  client = createPublicClient({ transport: http(rpc), pollingInterval: 200 })
  const accounts = await rpcCall('eth_accounts'),
    owner = createWalletClient({ account: accounts[0], transport: http(rpc), chain: null })
  creator = accounts[1]
  async function deploy(a, args = []) {
    const hash = await owner.deployContract({ abi: a.abi, bytecode: a.bytecode, args }),
      receipt = await client.waitForTransactionReceipt({ hash })
    expect(receipt.status).toBe('success')
    return { address: receipt.contractAddress, hash, abi: a.abi }
  }
  const manager = await deploy(
    await artifact('@uniswap/v4-core/src/PoolManager.sol/PoolManager.json'),
    [accounts[0]],
  )
  const quote = { address: '0x0000000000000000000000000000000000000000' }
  const quoter = await deploy(
    await artifact('@uniswap/v4-periphery/src/lens/V4Quoter.sol/V4Quoter.json'),
    [manager.address],
  )
  const stateView = await deploy(
    await artifact('@uniswap/v4-periphery/src/lens/StateView.sol/StateView.json'),
    [manager.address],
  )
  const proxy = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
  await rpcCall('hardhat_setCode', [
    proxy,
    '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3',
  ])
  const factoryArtifact = JSON.parse(
      await readFile('public/protocol/HookbrewFactory.json', 'utf8'),
    ),
    routerArtifact = JSON.parse(await readFile('public/protocol/HookbrewRouter.json', 'utf8'))
  const data = encodeDeployData({
      abi: factoryArtifact.abi,
      bytecode: factoryArtifact.bytecode,
      args: [manager.address, quote.address, accounts[0], parseUnits('0.0001', 18)],
    }),
    hash = keccak256(data)
  let salt, factory
  for (let n = 0n; ; n++) {
    salt = toHex(n, { size: 32 })
    factory = getCreate2Address({ from: proxy, salt, bytecodeHash: hash })
    if ((BigInt(factory) & 0x3fffn) === 0x2080n) break
  }
  const factoryTx = await owner.sendTransaction({ to: proxy, data: salt + data.slice(2) })
  await client.waitForTransactionReceipt({ hash: factoryTx })
  const router = await deploy(routerArtifact, [factory])
  await rpcCall('hardhat_mine', ['0x3'])
  await rpcCall('evm_setIntervalMining', [500])
  process.env.HOOKBREW_PUBLIC_URL = 'https://fixture.hookbrew.test'
  applicationOptions = {
    dataDir,
    store: sharedStore(),
    client,
    treasury: accounts[0],
    infrastructure: {
      chainId: 4663,
      poolManager: manager.address,
      quote: quote.address,
      quoter: quoter.address,
      stateView: stateView.address,
      create2: proxy,
      rpcUrl: rpc,
    },
  }
  app = await createApplication(applicationOptions)
  secondApp = await createApplication(applicationOptions)
  let requestNumber = 0
  server = createServer((req, res) => (requestNumber++ % 2 ? secondApp : app).middleware(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${server.address().port}`
  const challenge = await apiCall('/api/deployment/challenge', {
      factoryTx,
      routerTx: router.hash,
    }),
    signature = await owner.signMessage({ message: challenge.message })
  config = (
    await apiCall('/api/deployment/activate', {
      ...challenge,
      signature,
      factoryTx,
      routerTx: router.hash,
    })
  ).deployment
  // A lost response can be retried on either instance without another signature.
  expect(
    (await apiCall('/api/deployment/activate', { factoryTx, routerTx: router.hash })).alreadyActive,
  ).toBe(true)
  expect((await apiCall('/api/status')).deployment.factory).toBe(config.factory)
})
test.afterAll(async () => {
  app?.close()
  secondApp?.close()
  if (server) await new Promise((r) => server.close(r))
  node?.kill()
  if (dataDir) {
    expect(dataDir.startsWith(join(tmpdir(), 'hookbrew-browser-'))).toBe(true)
    await rm(dataDir, { recursive: true, force: true })
  }
  delete process.env.HOOKBREW_PUBLIC_URL
})

test('wallet setup deploys both contracts, refreshes gas funds, activates and exports verified receipts', async ({
  page,
}) => {
  test.setTimeout(180000)
  const setupApp = await createApplication({
    ...applicationOptions,
    store: sharedStore(),
    serverless: true,
  })
  const setupServer = createServer(setupApp.middleware)
  await new Promise((r) => setupServer.listen(0, '127.0.0.1', r))
  const setupOrigin = `http://127.0.0.1:${setupServer.address().port}`
  const account = applicationOptions.treasury
  let insufficientFunds = false
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  try {
    await page.route(
      /https:\/\/rpc\.mainnet\.chain\.robinhood\.com|\/test-wallet-rpc$/,
      async (route) => {
        const request = route.request().postDataJSON()
        if (insufficientFunds && request.method === 'eth_getBalance') {
          await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: '0x1' } })
          return
        }
        const response = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: route.request().postData(),
        })
        await route.fulfill({ status: response.status, json: await response.json() })
      },
    )
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      const response = await fetch(setupOrigin + url.pathname + url.search, {
        method: route.request().method(),
        headers: { Origin: setupOrigin, 'Content-Type': 'application/json' },
        ...(route.request().method() === 'POST' ? { body: route.request().postData() } : {}),
      })
      await route.fulfill({ status: response.status, json: await response.json() })
    })
    await page.addInitScript(
      ({ account }) => {
        localStorage.setItem('hooker_vamp_access_v1', '1')
        window.__sends = []
        window.__signatures = 0
        window.ethereum = {
          on() {},
          removeListener() {},
          async request({ method, params }) {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account]
            if (method === 'eth_chainId') return '0x1237'
            if (method === 'eth_sendTransaction') window.__sends.push(params[0])
            if (method === 'personal_sign') window.__signatures++
            const response = await fetch('/test-wallet-rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
            })
            const body = await response.json()
            if (body.error) throw body.error
            return body.result
          },
        }
      },
      { account },
    )
    await page.goto('/setup')
    await page.getByRole('button', { name: 'Connect deployer wallet' }).click()
    await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
    await page.getByRole('button', { name: 'Close dialog' }).click()
    for (const kind of ['factory', 'router']) {
      await page.getByRole('button', { name: `Prepare ${kind} deployment` }).click()
      await expect(page.getByRole('button', { name: `Deploy ${kind} with wallet` })).toBeVisible({
        timeout: 60000,
      })
      insufficientFunds = true
      await page.getByRole('button', { name: `Deploy ${kind} with wallet` }).click()
      await expect(page.getByRole('alert')).toContainText('Insufficient ETH')
      expect(await page.evaluate(() => window.__sends.length)).toBe(kind === 'factory' ? 0 : 1)
      insufficientFunds = false
      await page.getByRole('button', { name: `Deploy ${kind} with wallet` }).click()
      await expect(
        page.getByRole('button', {
          name: kind === 'factory' ? 'Prepare router deployment' : 'Authorize & activate Hookbrew',
        }),
      ).toBeVisible({ timeout: 45000 })
    }
    await page.getByRole('button', { name: 'Authorize & activate Hookbrew' }).click()
    await expect(page.getByRole('heading', { name: 'Hookbrew is activated.' })).toBeVisible({
      timeout: 15000,
    })
    expect(await page.evaluate(() => window.__sends.length)).toBe(2)
    expect(await page.evaluate(() => window.__signatures)).toBe(1)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export deployment record', exact: true }).click()
    const record = JSON.parse(await readFile(await (await download).path(), 'utf8'))
    expect(record.chainId).toBe(4663)
    expect(record.abiVersion).toBe('hookbrew-v2')
    expect(record.quoteDecimals).toBe(18)
    expect(record.quoteIsNative).toBe(true)
    expect(record.launchFee).toBe('100000000000000')
    expect(record.treasury.toLowerCase()).toBe(account.toLowerCase())
    for (const hash of [record.factoryTx, record.routerTx]) {
      const receipt = await client.getTransactionReceipt({ hash })
      expect(receipt.status).toBe('success')
      expect((await client.getBlock({ blockNumber: receipt.blockNumber })).hash).toBe(
        receipt.blockHash,
      )
    }
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Hookbrew is activated.' })).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    setupApp.close()
    await new Promise((r) => setupServer.close(r))
  }
})

for (const customHook of [false, true])
  test(`${customHook ? 'custom hook build → ' : ''}wallet launch → real indexed chart → ETH buy → token approval → sell inside Hookbrew`, async ({
    page,
  }) => {
    test.setTimeout(180000)
    page.on('pageerror', (e) => errors.push(e.message))
    let holdReceipts = false
    let observedPending = false
    await page.route(/https:\/\/rpc\.mainnet\.chain\.robinhood\.com/, async (route) => {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData(),
      })
      const response = await r.json(),
        request = route.request().postDataJSON()
      if (holdReceipts && request.method === 'eth_getTransactionReceipt') response.result = null
      if (request.method === 'eth_getTransactionByHash' && response.result?.blockNumber === null)
        observedPending = true
      await route.fulfill({ status: r.status, json: response })
    })
    await page.route('**/test-wallet-rpc', async (route) => {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData(),
      })
      await route.fulfill({
        status: r.status,
        contentType: 'application/json',
        body: await r.text(),
      })
    })
    await page.route('**/api/**', async (route) => {
      const u = new URL(route.request().url())
      const r = await fetch(origin + u.pathname + u.search, {
        method: route.request().method(),
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        ...(route.request().method() === 'POST' ? { body: route.request().postData() } : {}),
      })
      await route.fulfill({
        status: r.status,
        contentType: 'application/json',
        body: await r.text(),
      })
    })
    await page.addInitScript(
      ({ creator }) => {
        localStorage.setItem('hooker_vamp_access_v1', '1')
        window.__sends = JSON.parse(sessionStorage.getItem('test-sends') || '[]')
        window.__rejectNext = false
        const provider = {
          on() {},
          removeListener() {},
          async request({ method, params }) {
            if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [creator]
            if (method === 'eth_chainId') return '0x1237'
            if (method === 'eth_sendTransaction') {
              if (window.__rejectNext) {
                window.__rejectNext = false
                throw { code: 4001, message: 'User rejected' }
              }
              window.__sends.push(params[0])
              sessionStorage.setItem('test-sends', JSON.stringify(window.__sends))
            }
            const r = await fetch('/test-wallet-rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
            })
            const body = await r.json()
            if (body.error) throw body.error
            return body.result
          },
        }
        window.ethereum = provider
      },
      { creator },
    )
    await page.goto('/create')
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
    await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(new RegExp(creator, 'i'))
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await page.getByRole('button', { name: /Continue/ }).click()
    if (customHook) {
      await page.getByRole('button', { name: /Build a custom hook/ }).click()
      await page.getByRole('button', { name: 'Install Fee burn', exact: true }).click()
      await page.getByRole('button', { name: 'Install Holder rewards', exact: true }).click()
      await page.getByRole('button', { name: 'Review hook build', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Confirm & build hook', exact: true }),
      ).toBeVisible({ timeout: 60000 })
      await page.evaluate(() => (window.__rejectNext = true))
      await page.getByRole('button', { name: 'Confirm & build hook', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('declined', { timeout: 30000 })
      holdReceipts = true
      await page.getByRole('button', { name: 'Confirm & build hook', exact: true }).click()
      await expect(page.getByRole('link', { name: 'View submitted transaction' })).toBeVisible({
        timeout: 30000,
      })
      await page.reload()
      holdReceipts = false
      await page.getByRole('button', { name: /Continue/ }).click()
      await page.getByRole('button', { name: 'Check confirmation', exact: true }).click()
      await expect(page.getByText('Ready for Stage 3', { exact: true })).toBeVisible({
        timeout: 20000,
      })
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).click()
      await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
      await page.getByRole('button', { name: 'Close dialog' }).click()
      // Editing invalidates the selection. Restoring a built recipe reuses it without another transaction.
      await page.getByRole('button', { name: 'Remove Fee burn', exact: true }).click()
      await page.getByRole('button', { name: /Continue/ }).click()
      await expect(page.getByRole('alert')).toContainText('Build or select')
      await page.getByRole('button', { name: 'Install Fee burn', exact: true }).click()
      await page.getByRole('button', { name: 'Review hook build', exact: true }).click()
      await page.getByRole('button', { name: 'Use existing hook', exact: true }).click()
      await page.screenshot({ path: 'artifacts/hook-builder/confirmed.png', fullPage: true })
    }
    await page.getByRole('button', { name: /Continue/ }).click()
    await page.getByLabel('Token name', { exact: false }).fill('Lifecycle Brew')
    await page.getByLabel('Ticker symbol', { exact: false }).fill('BREW')
    await page
      .getByLabel('Description', { exact: false })
      .fill('Local test token backed by real Uniswap V4 pool events.')
    await page.getByRole('button', { name: /Continue/ }).click()
    await page.getByLabel('Founder buy', { exact: false }).fill('0.005')
    await page.getByRole('button', { name: /^Linear 24h/ }).click()
    await page.getByRole('button', { name: 'Review launch', exact: true }).click()
    await page.getByRole('button', { name: 'Simulate launch & refresh costs' }).click()
    await expect(
      page.getByRole('button', { name: 'Approve founder buy', exact: true }),
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Confirm & launch token/ })).toBeVisible()
    holdReceipts = true
    await page.getByRole('button', { name: /Confirm & launch token/ }).click()
    await expect(page.getByRole('link', { name: 'View submitted transaction' })).toBeVisible()
    await page.reload()
    holdReceipts = false
    await page.getByRole('button', { name: 'Check confirmation', exact: true }).click()
    await expect(page).toHaveURL(/\/token\/0x[\da-f]{40}/i, { timeout: 20000 })
    const address = new URL(page.url()).pathname.split('/').at(-1)
    await expect(page.getByRole('heading', { name: 'Lifecycle Brew', exact: true })).toBeVisible({
      timeout: 30000,
    })
    await expect
      .poll(
        async () =>
          (await apiCall(`/api/tokens/${address}`).catch(() => null))?.token?.tradeCount || 0,
        {
          timeout: 15000,
        },
      )
      .toBe(1)
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click()
    await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText(new RegExp(creator, 'i'))
    await page.getByRole('button', { name: 'Close dialog' }).click()
    // Real full-transaction MAX estimates leave ETH for gas, without buying or approving.
    await expect(page.getByRole('heading', { name: 'Trade', exact: true })).toBeVisible({
      timeout: 20000,
    })
    const originalBalance = await client.getBalance({ address: creator })
    await rpcCall('hardhat_setBalance', [creator, toHex(parseUnits('0.02', 18))])
    await expect(page.getByRole('button', { name: 'MAX', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'MAX', exact: true }).click()
    await expect
      .poll(async () => Number(await page.getByLabel('Amount of ETH to buy with').inputValue()))
      .toBeGreaterThan(0.019)
    const max = parseUnits(await page.getByLabel('Amount of ETH to buy with').inputValue(), 18)
    expect(max).toBeLessThan(parseUnits('0.02', 18))
    await rpcCall('hardhat_setBalance', [creator, toHex(originalBalance)])
    await page.getByLabel('Amount of ETH to buy with').fill('0.0004')
    await expect(page.getByRole('button', { name: 'Approve ETH', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Review buy', exact: true })).toBeEnabled({
      timeout: 15000,
    })
    await page.getByRole('button', { name: 'Review buy', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm buy', exact: true })).toBeVisible()
    // Identical venue data from the next ten-second market poll must preserve review.
    await page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tokens/${address}` && response.status() === 200,
    )
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(page.getByRole('button', { name: 'Confirm buy', exact: true })).toBeVisible()
    // Rejected signatures must leave balances unchanged and allow a deliberate retry.
    await page.evaluate(() => (window.__rejectNext = true))
    await page.getByRole('button', { name: 'Confirm buy', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('declined')
    expect(
      await client.readContract({
        address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [creator],
      }),
    ).toBe(0n)
    if (!customHook) {
      // A same-nonce cancellation must never be accepted as the reviewed purchase.
      await rpcCall('evm_setAutomine', [false])
      await rpcCall('evm_setIntervalMining', [0])
      await page.getByRole('button', { name: 'Confirm buy', exact: true }).click()
      await expect(page.getByRole('link', { name: 'View submitted transaction' })).toBeVisible()
      await expect.poll(() => observedPending).toBe(true)
      const pending = await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('hookbrew:4663:v2:pending-transaction')),
      )
      const original = await client.getTransaction({ hash: pending.hash })
      await rpcCall('eth_sendTransaction', [
        {
          from: creator,
          to: creator,
          value: '0x0',
          data: '0x',
          nonce: toHex(original.nonce),
          gas: '0x5208',
          maxFeePerGas: toHex(original.maxFeePerGas * 2n + 1n),
          maxPriorityFeePerGas: toHex(original.maxPriorityFeePerGas * 2n + 1n),
        },
      ])
      await rpcCall('hardhat_mine', ['0x2'])
      await rpcCall('evm_setAutomine', [true])
      await rpcCall('evm_setIntervalMining', [500])
      await expect(page.getByRole('alert')).toContainText('replaced with a different action', {
        timeout: 20000,
      })
      expect(
        await client.readContract({
          address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [creator],
        }),
      ).toBe(0n)
    }
    await page.getByRole('button', { name: 'Confirm buy', exact: true }).click()
    await expect
      .poll(
        () =>
          client.readContract({
            address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [creator],
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0n)
    await expect(page.getByText('Confirmed on Robinhood Chain.', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: 'artifacts/product-build/terminal-desktop.png', fullPage: true })
    const before = await client.readContract({
      address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [creator],
    })
    await page.getByRole('button', { name: 'Sell', exact: true }).click()
    await expect(page.getByRole('button', { name: '25%', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '25%', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Approve BREW', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Approve BREW', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Review sell', exact: true })).toBeEnabled({
      timeout: 15000,
    })
    await page.getByRole('button', { name: 'Review sell', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm sell', exact: true }).click()
    await expect
      .poll(
        () =>
          client.readContract({
            address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [creator],
          }),
        { timeout: 15000 },
      )
      .toBeLessThan(before)
    await expect(page.getByText('Confirmed on Robinhood Chain.', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    await page.getByRole('tab', { name: 'Creator & vesting' }).click()
    await expect(page.getByRole('heading', { name: 'Creator rewards & vesting' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Harvest pool fees' })).toBeEnabled()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'Recent trades' }).click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: 'artifacts/product-build/terminal-mobile.png', fullPage: true })
    expect(errors).toEqual([])
    const sends = await page.evaluate(() => window.__sends)
    expect(sends).toHaveLength(5)
    expect(sends.every((tx) => tx.from.toLowerCase() === creator.toLowerCase())).toBe(true)
    expect(config.treasury.toLowerCase()).not.toBe('0x2e01dd8df4a4fb06ea62a944a658e9ae01db2ac4') // local fixture treasury only
  })
