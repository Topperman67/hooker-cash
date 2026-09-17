import { test, expect } from '@playwright/test'
import { defaultDraft } from '../src/lib/protocolDraft.js'

const treasury = '0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4'
const deployment = {
  chainId: 5042,
  treasury,
  abiVersion: 'hookbrew-v1',
  factory: `0x${'11'.repeat(20)}`,
  router: `0x${'22'.repeat(20)}`,
  factoryTx: `0x${'33'.repeat(32)}`,
  routerTx: `0x${'44'.repeat(32)}`,
}
async function init(page) {
  await page.addInitScript(
    ({ treasury, deployment, draft }) => {
      localStorage.setItem('hooker_vamp_access_v1', '1')
      if (!localStorage.getItem('hookbrew:launch-draft:v1')) {
        localStorage.setItem('hookbrew:launch-draft:v1', JSON.stringify(draft))
        localStorage.setItem('hookbrew:launch-step:v1', '4')
      }
      localStorage.setItem('hookbrew:deployment-progress:v1', JSON.stringify(deployment))
      window.__walletCalls = []
      window.ethereum = {
        async request({ method }) {
          window.__walletCalls.push(method)
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [treasury]
          if (method === 'eth_chainId') return '0x13b2'
          if (method === 'personal_sign') return '0x1234'
          throw Error(`Unexpected wallet request: ${method}`)
        },
      }
    },
    { treasury, deployment, draft: { ...defaultDraft, name: 'Saved Brew', symbol: 'BREW' } },
  )
  await page.route(/https:\/\/rpc\.(?:drpc\.)?mainnet\.arc\.io/, (route) => {
    const request = route.request().postDataJSON()
    return route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: request.id,
        result: request.method === 'eth_chainId' ? '0x13b2' : '0x0',
      },
    })
  })
}

async function reviewSavedDraft(page) {
  await expect(page.getByRole('heading', { name: 'The pool', exact: true })).toBeVisible()
  for (let step = 0; step < 3; step++)
    await page.getByRole('button', { name: 'Continue', exact: false }).click()
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
}

for (const outcome of ['activate', 'already active', 'conflict']) {
  test(`setup ${outcome} continues the saved review and never deploys twice`, async ({ page }) => {
    await init(page)
    let active = false
    await page.route('**/api/status', (route) =>
      route.fulfill({
        json: {
          deployment: active ? deployment : null,
          treasury,
          storage: { ready: true },
        },
      }),
    )
    await page.route('**/api/deployment/challenge', (route) => {
      if (outcome === 'activate')
        return route.fulfill({ json: { nonce: 'test', message: 'Test authorization' } })
      active = true
      return route.fulfill({
        status: outcome === 'conflict' ? 409 : 200,
        json: {
          deployment,
          alreadyActive: true,
          ...(outcome === 'conflict'
            ? { error: 'A different Hookbrew deployment is already active.' }
            : {}),
        },
      })
    })
    await page.route('**/api/deployment/activate', (route) => {
      active = true
      return route.fulfill({ status: 201, json: { deployment } })
    })
    await page.goto('/create')
    await reviewSavedDraft(page)
    await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
    await page.getByRole('link', { name: /Open deployment setup/ }).click()
    await page.getByRole('button', { name: 'Connect deployer wallet' }).click()
    await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await page.getByRole('button', { name: 'Authorize & activate Hookbrew' }).click()
    await expect(page.getByRole('heading', { name: 'Hookbrew is activated.' })).toBeVisible()
    await page.getByRole('link', { name: 'Continue your token launch' }).click()
    await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Token review' })).toContainText(
      'Saved Brew / $BREW',
    )
    await expect(
      page.getByRole('button', { name: 'Simulate launch & refresh costs' }),
    ).toBeVisible()
    const calls = await page.evaluate(() => window.__walletCalls)
    expect(calls.filter((call) => call === 'personal_sign')).toHaveLength(
      outcome === 'activate' ? 1 : 0,
    )
    expect(calls.some((call) => /sendTransaction|deploy/.test(call))).toBe(false)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  })
}

test('an existing draft from the older build resumes at review after setup', async ({ page }) => {
  await init(page)
  await page.route('**/api/status', (route) => route.fulfill({ json: { deployment, treasury } }))
  await page.goto('/setup')
  await page.evaluate(() => localStorage.removeItem('hookbrew:launch-step:v1'))
  await page.getByRole('link', { name: 'Continue your token launch' }).click()
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Token review' })).toContainText(
    'Saved Brew / $BREW',
  )
})

test('failed status and missing durable storage never send a creator back to deployment', async ({
  page,
}) => {
  await init(page)
  let available = false
  await page.route('**/api/status', (route) =>
    route.fulfill(
      available
        ? {
            json: {
              deployment: null,
              treasury,
              storage: { ready: false, error: 'Persistent storage is not connected.' },
            },
          }
        : { status: 503, json: { error: 'Storage temporarily unavailable.' } },
    ),
  )
  await page.goto('/create')
  await reviewSavedDraft(page)
  await expect(page.getByRole('alert')).toContainText('Storage temporarily unavailable')
  await expect(page.getByRole('link', { name: /Open deployment setup/ })).toHaveCount(0)
  available = true
  await page.getByRole('button', { name: 'Retry status' }).click()
  await expect(page.getByRole('alert')).toContainText('Persistent storage is not connected')
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await page.goto('/setup')
  await expect(page.getByRole('alert')).toContainText('Persistent storage is not connected')
  await expect(
    page.getByRole('button', { name: /Authorize|Prepare.*deployment|Connect deployer/ }),
  ).toHaveCount(0)
})

test('a later null status cannot turn an activated venue back into the deployment wizard', async ({
  page,
}) => {
  await init(page)
  await page.clock.install()
  let active = true
  await page.route('**/api/status', (route) =>
    route.fulfill({ json: { deployment: active ? deployment : null, treasury } }),
  )
  await page.goto('/create')
  await reviewSavedDraft(page)
  await expect(page.getByRole('button', { name: 'Connect wallet to review' })).toBeVisible()
  active = false
  await page.clock.runFor(16000)
  await expect(page.getByRole('alert')).toContainText('temporarily lost its deployment record')
  await expect(page.getByRole('link', { name: /Open deployment setup/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/launch-recovery-status.png', fullPage: true })
})
