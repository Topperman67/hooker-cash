import { readFile, writeFile } from 'node:fs/promises'
import { createPublicClient, decodeEventLog, http, parseUnits, toHex } from 'viem'
import { prepareLaunch } from '../src/lib/launch.js'

// Exercises the production transaction builder against original Arc state.
// This is an isolated read-only diagnostic, not production deployment config.
const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const { manifest } = await readJson('../docs/evidence/hooker-arc-reference.json')
const codeReport = await readJson('../docs/evidence/arc-read-only-check.json')
const hookReport = await readJson('../docs/evidence/hook-core-source-check.json')
const codeHash = (address) =>
  codeReport.contracts.find((item) => item.address.toLowerCase() === address.toLowerCase()).codeHash
const config = {
  chainId: 5042,
  abiVersion: 'hooker-arc-v10',
  factory: manifest.contracts.factoryV2,
  policy: manifest.contracts.policyV2,
  treasury: manifest.treasury,
  quote: manifest.constants.usdg,
  sourceReference: 'Original deployment diagnostic only; full source review remains incomplete.',
  startBlock: String(manifest.deployBlock),
  poolFee: 10000,
  totalSupply: '1000000000',
  factoryCodeHash: codeHash(manifest.contracts.factoryV2),
  policyCodeHash: codeHash(manifest.contracts.policyV2),
  presets: hookReport.comparisons.map((item) => ({
    id: item.name,
    name: item.name,
    address: item.address,
    codeHash: item.codeHash,
  })),
}
const rpc = createPublicClient({
  transport: http('https://rpc.mainnet.arc.io', { timeout: 30000 }),
})
const account = '0x000000000000000000000000000000000000beef'
const temporaryBalance = parseUnits('10', 18)
const stateOverride = [{ address: account, balance: temporaryBalance }]
const client = {
  ...rpc,
  getBalance: async () => temporaryBalance,
  simulateContract: (request) => rpc.simulateContract({ ...request, stateOverride }),
  estimateGas: (request) => rpc.estimateGas({ ...request, stateOverride }),
}
const { launchAbi } = await import('../src/lib/launchAbi.js')
const reviewedFee = await rpc.readContract({
  address: config.factory,
  abi: launchAbi,
  functionName: 'launchFee',
})
const prepared = await prepareLaunch({
  client,
  config,
  account,
  reviewedFee,
  draft: {
    name: 'Hookbrew adapter check',
    symbol: 'CHECK',
    description: 'Read-only verification; not deployed.',
    presetId: 'plain',
  },
})
const report = {
  checkedAt: new Date().toISOString(),
  chainId: 5042,
  checkedBlock: String(prepared.live.blockNumber),
  factory: config.factory,
  sentTransactions: 0,
  actualTokenDeployed: false,
  predictedToken: prepared.predictedToken,
  launchFee: String(prepared.request.value),
  estimatedGas: String(prepared.estimatedGas),
  gasPrice: String(prepared.gasPrice),
  account,
  temporaryBalance: String(temporaryBalance),
  scope:
    'Production prepareLaunch path, live dependency/code/fee checks, calldata, RPC simulation and gas estimate. Diagnostic balance substituted locally and in simulation/estimation state overrides only; no wallet provider used. This does not validate receipts or complete current source review.',
}
try {
  // Standard Geth callTracer withLog: https://geth.ethereum.org/docs/developers/evm-tracing/built-in-tracers
  const trace = await rpc.request({
    method: 'debug_traceCall',
    params: [
      {
        from: account,
        to: prepared.request.to,
        data: prepared.request.data,
        value: toHex(prepared.request.value),
      },
      'latest',
      {
        tracer: 'callTracer',
        tracerConfig: { withLog: true },
        stateOverrides: { [account]: { balance: toHex(temporaryBalance) } },
      },
    ],
  })
  const logs = []
  function collect(call) {
    if (call.to?.toLowerCase() === config.factory.toLowerCase()) logs.push(...(call.logs || []))
    for (const child of call.calls || []) collect(child)
  }
  collect(trace)
  const decoded = logs
    .flatMap((log) => {
      try {
        return [
          decodeEventLog({ abi: launchAbi, data: log.data, topics: log.topics, strict: true }),
        ]
      } catch {
        return []
      }
    })
    .filter((event) => event.eventName === 'TokenLaunched')
  report.trace = {
    error: trace.error || null,
    factoryLogTopics: logs.map((log) => log.topics[0]),
    decodedLaunchEvents: decoded,
  }
} catch (error) {
  report.trace = { unavailable: true, reason: error.shortMessage || error.message }
}
const stringify = (value) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
await writeFile(
  new URL('../docs/evidence/launch-adapter-check.json', import.meta.url),
  stringify(report) + '\n',
)
console.log(stringify(report))
