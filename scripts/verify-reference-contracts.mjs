import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { createPublicClient, http, keccak256, parseAbi, formatUnits } from 'viem'

// Read-only. Never asks for an account, signs, or sends a transaction.
const reference = JSON.parse(
  await readFile(new URL('../docs/evidence/hooker-arc-reference.json', import.meta.url), 'utf8'),
)
const rpc = 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ transport: http(rpc, { timeout: 15000, retryCount: 1 }) })
const chainId = await client.getChainId()
if (chainId !== 5042) throw new Error(`Wrong chain: ${chainId}`)
const block = await client.getBlock()
const addressGroups = {
  ...reference.infrastructure.contracts,
  ...reference.manifest.contracts,
  ...reference.manifest.catalog,
  ...reference.manifest.presets,
}
const contracts = []
for (const [name, address] of Object.entries(addressGroups)) {
  await pause(300)
  if (/^0x0{40}$/i.test(address)) {
    contracts.push({ name, address, status: 'not deployed / zero address' })
    continue
  }
  try {
    const code = await client.getCode({ address, blockNumber: block.number })
    contracts.push({
      name,
      address,
      codeBytes: code ? (code.length - 2) / 2 : 0,
      codeHash: code && code !== '0x' ? keccak256(code) : null,
      status: code && code !== '0x' ? 'code present; source not matched' : 'NO CODE',
    })
  } catch (error) {
    contracts.push({
      name,
      address,
      status: 'RPC error',
      error: error.shortMessage || error.message,
    })
  }
}
const factory = reference.manifest.contracts.factoryV2
const getters = []
for (const name of ['policy', 'tokenDeployer', 'launchFee']) {
  await pause(300)
  try {
    const value = await client.readContract({
      address: factory,
      abi: reference.factoryAbi,
      functionName: name,
      blockNumber: block.number,
    })
    const expected =
      name === 'policy'
        ? reference.manifest.contracts.policyV2
        : name === 'tokenDeployer'
          ? reference.manifest.contracts.tokenDeployerV2
          : null
    getters.push({
      name,
      value: String(value),
      expected,
      matches: expected ? value.toLowerCase() === expected.toLowerCase() : null,
      ...(name === 'launchFee' ? { nativeUsdc: formatUnits(value, 18) } : {}),
    })
  } catch (error) {
    getters.push({ name, error: error.shortMessage || error.message })
  }
}
const authority = []
for (const name of [
  'factoryV2',
  'policyV2',
  'hookRegistry',
  'moduleRegistry',
  'hookBuilderV10',
  'engineV3',
]) {
  const address = reference.manifest.contracts[name]
  const result = { name, address }
  for (const getter of ['owner', 'treasury']) {
    await pause(300)
    try {
      result[getter] = await client.readContract({
        address,
        abi: parseAbi([`function ${getter}() view returns (address)`]),
        functionName: getter,
        blockNumber: block.number,
      })
    } catch {
      result[getter] = 'getter unavailable; authority not established by this call'
    }
  }
  authority.push(result)
}
let recentLaunches
try {
  const fromBlock = block.number - 10000n
  const logs = []
  for (let start = fromBlock; start <= block.number; start += 1000n) {
    await pause(750)
    const end = start + 999n < block.number ? start + 999n : block.number
    logs.push(
      ...(await client.getLogs({
        address: factory,
        events: reference.events,
        fromBlock: start,
        toBlock: end,
        strict: true,
      })),
    )
  }
  recentLaunches = {
    fromBlock: String(fromBlock),
    toBlock: String(block.number),
    countInRange: logs.length,
    events: logs.map((log) => ({
      transactionHash: log.transactionHash,
      blockNumber: String(log.blockNumber),
      args: log.args,
    })),
  }
} catch (error) {
  recentLaunches = { error: error.shortMessage || error.message, details: error.details }
}
const report = {
  checkedAt: new Date().toISOString(),
  chainId,
  rpc,
  blockNumber: String(block.number),
  blockHash: block.hash,
  sourceMatched: false,
  hookbrewLaunchVerified: false,
  contracts,
  getters,
  authority,
  recentLaunches,
}
await writeFile(
  new URL('../docs/evidence/arc-read-only-check.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
console.log(
  JSON.stringify(
    {
      block: report.blockNumber,
      contracts: contracts.length,
      codePresent: contracts.filter((c) => c.codeBytes > 0).length,
      getters,
      authority,
      recentLaunchCount: recentLaunches.countInRange ?? recentLaunches.error,
    },
    null,
    2,
  ),
)
