// Launches built by the launch page against live mainnet state and simulated by the real Meteora
// and Quantum Hooks programs. Opt-in (it reads mainnet through the public RPC):
//   QUANTPAD_E2E_MAINNET=1 npx playwright test tests/e2e/mainnet.spec.js
// Nothing is ever sent: the wallet returns the transactions unsigned, the RPC stub refuses the
// send, and the test simulates them with signature checks off.
import { test, expect } from '@playwright/test'
import { Connection, VersionedTransaction } from '@solana/web3.js'
import { dbcPoolPda } from '../../shared/meteora.mjs'
import { configFor, enter, stubApi } from './fixtures.js'

test.skip(!process.env.QUANTPAD_E2E_MAINNET, 'Set QUANTPAD_E2E_MAINNET=1 to run against mainnet.')
test.describe.configure({ timeout: 480_000 })

const connection = new Connection(
  process.env.QUANTPAD_E2E_RPC || 'https://api.mainnet-beta.solana.com',
  'confirmed',
)

// A funded, system-owned mainnet wallet to simulate as the launcher (it never signs anything).
const LAUNCHER = process.env.QUANTPAD_E2E_LAUNCHER || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'

// A 1×1 PNG.
const ART = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==',
  'base64',
)

async function simulate(base64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'))
  for (let attempt = 0; ; attempt++)
    try {
      const { value } = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      })
      return value
    } catch (e) {
      if (attempt >= 5 || !/429|Too Many/i.test(e.message)) throw e
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
    }
}

for (const launch of [
  { name: 'standard', mode: 'Standard Meteora', tax: null, feeBps: 100 },
  ...[100, 200, 300, 500].map((feeBps) => ({
    name: `Quantum ${feeBps / 100}%`,
    mode: 'Quantum launch',
    tax: `${feeBps / 100}% tax`,
    feeBps,
  })),
])
  test(`a ${launch.name} launch with a dev buy simulates on mainnet`, async ({ page }) => {
    await stubApi(page, { mainnet: true })
    await page.route('**/api/media', (route) =>
      route.fulfill({ json: { url: 'https://quant-pad.vercel.app/media/0123456789abcdef.png' } }),
    )
    await page.route('**/api/metadata', (route) =>
      route.fulfill({
        json: { uri: 'https://quant-pad.vercel.app/m/0123456789abcdef0123456789abcdef' },
      }),
    )
    await enter(page, { wallet: true, address: LAUNCHER })
    await page.goto('/launch')
    await page.getByRole('banner').getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('button', { name: 'Test Wallet' }).click()
    await expect(page.getByRole('button', { name: 'Wallet details' })).toBeVisible()

    await page.getByLabel('Name').fill('Entangled Cats')
    await page.getByLabel('Ticker').fill('ECAT')
    await page.locator('input[type=file]').setInputFiles({
      name: 'cat.png',
      mimeType: 'image/png',
      buffer: ART,
    })
    await expect(page.getByRole('button', { name: 'Replace artwork' })).toBeVisible()
    await page
      .getByRole('group', { name: 'Launch type' })
      .getByRole('button', { name: launch.mode })
      .click()
    if (launch.tax)
      await page
        .getByRole('group', { name: 'Trading tax' })
        .getByRole('button', { name: launch.tax })
        .click()
    // The dev buy is quoted from the launch config read from mainnet (the public RPC can be slow).
    await expect(page.locator('.field:has(#dev-buy) .hint')).toContainText('About', {
      timeout: 30_000,
    })
    // The wallet is asked once; the send is refused and the page says so. A launch that fails
    // before the wallet is asked shows its reason in the same notice: one the public RPC rate
    // limited is tried again after a pause.
    const notice = page.locator('.launch-summary [role=alert]')
    for (let attempt = 1; ; attempt++) {
      await page.getByRole('button', { name: 'Launch $ECAT' }).click()
      await expect(notice).toBeHidden()
      await expect(notice).toBeVisible({ timeout: 150_000 })
      if (attempt === 4 || !/429|too many requests/i.test(await notice.textContent())) break
      await page.waitForTimeout(10_000 * attempt)
    }
    await expect(notice).toContainText('never send transactions')
    const requests = await page.evaluate(() => window.__signRequests || [])
    expect(requests).toHaveLength(1)
    const [transactions] = requests
    expect(transactions.length).toBeGreaterThan(0)

    // The first transaction holds the DBC create and the dev buy (and Quantum's register when it
    // fits); later ones depend on it, so only it can be simulated against today's state.
    const tx = VersionedTransaction.deserialize(Buffer.from(transactions[0], 'base64'))
    const [payer, mint] = tx.message.staticAccountKeys
    expect(payer.toBase58()).toBe(LAUNCHER)
    // The coin's pool is made under the launch config of the tax chosen.
    const pool = dbcPoolPda(configFor(launch.feeBps), mint).toBase58()
    expect(tx.message.staticAccountKeys.map((k) => k.toBase58())).toContain(pool)
    const result = await simulate(transactions[0])
    expect(result.err, (result.logs || []).join('\n')).toBeNull()
    const logs = result.logs.join('\n')
    expect(logs).toContain('Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN success')
    expect(logs).toMatch(/Instruction: InitializeVirtualPoolWithSplToken/)
    expect(logs).toMatch(/Instruction: Swap/)
    expect(logs.includes('FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK')).toBe(!!launch.tax)
    test.info().annotations.push({
      type: 'simulated',
      description: `${transactions.length} transaction(s); the first used ${result.unitsConsumed} CU`,
    })
  })
