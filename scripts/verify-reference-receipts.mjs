import { readFile, writeFile } from 'node:fs/promises'
import { createPublicClient, decodeFunctionData, http } from 'viem'
import { launchAbi } from '../src/lib/launchAbi.js'
import { verifyLaunchReceipt } from '../src/lib/launch.js'

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const { manifest } = await readJson('../docs/evidence/hooker-arc-reference.json')
const history = await readJson('../docs/evidence/reference-launch-events.json')
const codes = await readJson('../docs/evidence/arc-read-only-check.json')
const hooks = await readJson('../docs/evidence/hook-core-source-check.json')
const codeHash = (address) =>
  codes.contracts.find((item) => item.address.toLowerCase() === address.toLowerCase()).codeHash
const config = {
  chainId: 5042,
  abiVersion: 'hooker-arc-v10',
  factory: manifest.contracts.factoryV2,
  policy: manifest.contracts.policyV2,
  treasury: manifest.treasury,
  quote: manifest.constants.usdg,
  sourceReference: 'Historical read-only diagnostic; full source review incomplete.',
  startBlock: String(manifest.deployBlock),
  poolFee: 10000,
  totalSupply: '1000000000',
  factoryCodeHash: codeHash(manifest.contracts.factoryV2),
  policyCodeHash: codeHash(manifest.contracts.policyV2),
  presets: hooks.comparisons.map((item) => ({
    id: item.name,
    name: item.name,
    address: item.address,
    codeHash: item.codeHash,
  })),
}
const client = createPublicClient({
  transport: http('https://rpc.mainnet.arc.io', { timeout: 15000 }),
})
const results = []
for (const sample of history.samples) {
  const preset = config.presets.find(
    (item) => item.address.toLowerCase() === sample.event.args.hook.toLowerCase(),
  )
  if (!preset || sample.event.args.fee !== config.poolFee) continue
  const tx = await client.getTransaction({ hash: sample.transactionHash })
  const { args } = decodeFunctionData({ abi: launchAbi, data: tx.input })
  const prepared = {
    request: { account: tx.from, to: tx.to, data: tx.input, value: tx.value },
    args,
    fields: { name: args[0], symbol: args[1], preset },
    predictedToken: sample.event.args.token,
  }
  try {
    const verified = await verifyLaunchReceipt({
      client,
      config,
      prepared,
      hash: sample.transactionHash,
    })
    results.push({ passed: true, ...verified })
  } catch (error) {
    results.push({
      passed: false,
      transactionHash: sample.transactionHash,
      error: error.shortMessage || error.message,
    })
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  sentTransactions: 0,
  scope:
    'Production receipt decoder and post-launch state checks against existing third-party mainnet launches. Intent was reconstructed from the historical transaction; predictedToken was read from its event. This does NOT test an independent pre-signing prediction or a new Hookbrew launch.',
  results,
}
await writeFile(
  new URL('../docs/evidence/reference-receipt-check.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
console.log(
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
)
if (!results.length || results.some((item) => !item.passed)) process.exitCode = 1
