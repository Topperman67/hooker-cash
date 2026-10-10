import { test, expect } from '@playwright/test'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
} from 'viem'
import { launchAbi, launchHookAbi, launchPolicyAbi } from '../src/lib/launchAbi'

// Isolated browser fixtures. No deployment or provider fixture ships in src/.
const addr = (digit) => `0x${digit.repeat(40)}`
const account = addr('1'),
  factory = addr('2'),
  policy = addr('3'),
  treasury = addr('4'),
  hook = addr('5'),
  token = addr('6')
const hash = `0x${'a'.repeat(64)}`,
  blockHash = `0x${'b'.repeat(64)}`
const code = '0x60006000'
const config = {
  chainId: 5042,
  abiVersion: 'hooker-arc-v10',
  factory,
  policy,
  treasury,
  quote: '0x3600000000000000000000000000000000000000',
  sourceReference: 'browser test fixture',
  startBlock: '1',
  poolFee: 10000,
  totalSupply: '1000000000',
  factoryCodeHash: keccak256(code),
  policyCodeHash: keccak256(code),
  presets: [{ id: 'plain', name: 'Plain test hook', address: hook, codeHash: keccak256(code) }],
}

async function setup(page, { reject = false, badReceipt = false, reverted = false } = {}) {
  const sent = []
  await page.route(/\/src\/config\/launchDeployment(?:\.js)?(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export const launchDeployment = ${JSON.stringify(config)}`,
    }),
  )
  await page.addInitScript(
    ({ account, hash, reject }) => {
      localStorage.setItem('hooker_vamp_access_v1', '1')
      window.__launchRequests = []
      window.ethereum = {
        request: async (request) => {
          window.__launchRequests.push(request)
          if (['eth_requestAccounts', 'eth_accounts'].includes(request.method)) return [account]
          if (request.method === 'eth_chainId') return '0x13b2'
          if (request.method === 'eth_sendTransaction') {
            if (reject) throw { code: 4001, message: 'User rejected request' }
            await window.recordLaunchSend(request.params[0])
            return hash
          }
          throw new Error(`Unexpected test wallet method ${request.method}`)
        },
      }
    },
    { account, hash, reject },
  )
  await page.exposeFunction('recordLaunchSend', (value) => sent.push(value))
  await page.route(/https:\/\/rpc\.(?:drpc\.)?mainnet\.arc\.io/, async (route) => {
    const rpc = route.request().postDataJSON()
    const respond = (item) => {
      let result
      const tx = sent.at(-1)
      const abi = [...launchAbi, ...launchPolicyAbi, ...launchHookAbi, ...erc20Abi]
      if (item.method === 'eth_chainId') result = '0x13b2'
      else if (item.method === 'eth_blockNumber') result = '0x1234'
      else if (item.method === 'eth_getBlockByNumber')
        result = { number: '0x1234', timestamp: '0x6aa00000', hash: blockHash, transactions: [] }
      else if (item.method === 'eth_getCode') result = code
      else if (item.method === 'eth_getBalance') result = '0x8ac7230489e80000'
      else if (item.method === 'eth_gasPrice') result = '0x3e8'
      else if (item.method === 'eth_estimateGas') result = '0x186a0'
      else if (item.method === 'eth_call') {
        const decoded = decodeFunctionData({ abi, data: item.params[0].data })
        const values = {
          launchFee: 1000000000000000000n,
          policy,
          treasury,
          allowedQuoteCurrency: true,
          launch: token,
          name: 'Browser launch',
          symbol: 'BROWSE',
          decimals: 18,
          totalSupply: 1000000000000000000000000000n,
          launchedToken: true,
        }
        result = encodeFunctionResult({
          abi,
          functionName: decoded.functionName,
          result: values[decoded.functionName],
        })
      } else if (item.method === 'eth_getTransactionByHash') {
        result = tx
          ? {
              hash,
              from: account,
              to: factory,
              input: tx.data,
              value: tx.value,
              blockHash,
              blockNumber: '0x1233',
              nonce: '0x0',
              gas: '0x186a0',
              gasPrice: '0x3e8',
              transactionIndex: '0x0',
              type: '0x0',
              v: '0x1b',
              r: `0x${'0'.repeat(63)}1`,
              s: `0x${'0'.repeat(63)}1`,
            }
          : null
      } else if (item.method === 'eth_getTransactionReceipt') {
        if (!tx) result = null
        else {
          const event = launchAbi.find((item) => item.type === 'event' && item.inputs.length === 8)
          const log = {
            address: badReceipt ? hook : factory,
            blockHash,
            blockNumber: '0x1233',
            transactionHash: hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
            topics: encodeEventTopics({
              abi: [event],
              eventName: 'TokenLaunched',
              args: { token, creator: account, hook },
            }),
            data: encodeAbiParameters(
              event.inputs.filter((input) => !input.indexed),
              [blockHash, 10000, 100000n, 1000000000000000000000000000n, 0n],
            ),
          }
          result = {
            transactionHash: hash,
            transactionIndex: '0x0',
            blockHash,
            blockNumber: '0x1233',
            from: account,
            to: factory,
            cumulativeGasUsed: '0x186a0',
            gasUsed: '0x186a0',
            effectiveGasPrice: '0x3e8',
            contractAddress: null,
            logs: reverted ? [] : [log],
            logsBloom: `0x${'0'.repeat(512)}`,
            status: reverted ? '0x0' : '0x1',
            type: '0x0',
          }
        }
      } else
        return {
          jsonrpc: '2.0',
          id: item.id,
          error: { code: -32601, message: `Unexpected test RPC ${item.method}` },
        }
      return { jsonrpc: '2.0', id: item.id, result }
    }
    await route.fulfill({ json: Array.isArray(rpc) ? rpc.map(respond) : respond(rpc) })
  })
  return sent
}

async function review(page) {
  await page.goto('/create')
  await page
    .locator('.launch-form')
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  await page.getByRole('button', { name: 'Browser wallet', exact: true }).click()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByLabel('Token name', { exact: true }).fill('Browser launch')
  await page.getByLabel('Symbol', { exact: true }).fill('BROWSE')
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your launch' })).toBeVisible()
  await expect(page.locator('.launch-review')).toContainText('No token has been deployed yet')
}

test('configured launch simulates, signs once, verifies receipt and resumes after reload without resending', async ({
  page,
}) => {
  const sent = await setup(page)
  await review(page)
  await page.getByRole('button', { name: 'Confirm launch in wallet' }).dblclick()
  await expect(page.getByRole('heading', { name: 'Launch confirmed' })).toBeVisible()
  expect(sent).toHaveLength(1)
  await expect(page.locator('.launch-receipt')).toContainText(token)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.screenshot({ path: 'artifacts/hookbrew-launch-test-confirmed.png', fullPage: true })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Submitted transaction' })).toBeVisible()
  await page.getByRole('button', { name: 'Verify submitted transaction' }).click()
  await expect(page.getByRole('heading', { name: 'Launch confirmed' })).toBeVisible()
  expect(sent).toHaveLength(1)
})

test('wallet rejection never becomes launch success', async ({ page }) => {
  await setup(page, { reject: true })
  await review(page)
  await page.getByRole('button', { name: 'Confirm launch in wallet' }).click()
  await expect(page.getByRole('alert')).toContainText('declined')
  await expect(page.getByRole('heading', { name: 'Launch confirmed' })).toHaveCount(0)
})

test('a reverted receipt permits an explicit new launch without resending automatically', async ({
  page,
}) => {
  const sent = await setup(page, { reverted: true })
  await review(page)
  await page.getByRole('button', { name: 'Confirm launch in wallet' }).click()
  await expect(page.getByRole('alert')).toContainText('reverted on-chain')
  await page.getByRole('button', { name: 'Start a new launch' }).click()
  await expect(page.getByRole('heading', { name: 'Submitted transaction' })).toHaveCount(0)
  await expect(page.getByLabel('Token name', { exact: true })).toHaveValue('')
  expect(sent).toHaveLength(1)
})

test('mobile launch review fits the viewport and rejects oversized Unicode names', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await review(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel('Token name', { exact: true }).fill('💧'.repeat(9))
  await page.getByRole('button', { name: 'Review launch', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('32 UTF-8 bytes')
  expect(
    await page.evaluate(() =>
      window.__launchRequests.some((item) => item.method === 'eth_sendTransaction'),
    ),
  ).toBe(false)
})

test('a mined transaction with an unrelated event remains unverified', async ({ page }) => {
  await setup(page, { badReceipt: true })
  await review(page)
  await page.getByRole('button', { name: 'Confirm launch in wallet' }).click()
  await expect(page.getByRole('alert')).toContainText('matching launch event')
  await expect(page.getByRole('heading', { name: 'Launch confirmed' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Verify submitted transaction' })).toBeVisible()
})
