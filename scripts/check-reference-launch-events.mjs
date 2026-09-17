import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { createPublicClient, decodeEventLog, decodeFunctionData, http } from 'viem'
import { launchAbi } from '../src/lib/launchAbi.js'

const { manifest } = JSON.parse(
  await readFile(new URL('../docs/evidence/hooker-arc-reference.json', import.meta.url), 'utf8'),
)
const client = createPublicClient({
  transport: http('https://rpc.mainnet.arc.io', { timeout: 15000, retryCount: 0 }),
})
if ((await client.getChainId()) !== 5042) throw new Error('Wrong chain')
const latest = await client.getBlockNumber()
const samples = [],
  windows = [],
  topics = new Set()
let step = 10000n
for (
  let start = BigInt(manifest.deployBlock);
  start <= latest && windows.length < 400 && samples.length === 0;
) {
  const end = start + step - 1n < latest ? start + step - 1n : latest
  await pause(300)
  try {
    const logs = await client.getLogs({
      address: manifest.contracts.factoryV2,
      fromBlock: start,
      toBlock: end,
    })
    windows.push({ fromBlock: String(start), toBlock: String(end), logCount: logs.length })
    for (const log of logs) {
      topics.add(log.topics[0])
      try {
        const decoded = decodeEventLog({
          abi: launchAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        })
        if (decoded.eventName === 'TokenLaunched')
          samples.push({
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            address: log.address,
            topics: log.topics,
            data: log.data,
            event: decoded,
          })
      } catch {}
      if (samples.length >= 3) break
    }
    start = end + 1n
    if (windows.length % 20 === 0) console.log(`Scanned ${windows.length} windows through ${end}`)
  } catch (error) {
    if (step > 1000n) {
      step = 1000n
      continue
    }
    windows.push({
      fromBlock: String(start),
      toBlock: String(end),
      error: error.shortMessage || error.message,
    })
    break
  }
}
for (const sample of samples) {
  const transaction = await client.getTransaction({ hash: sample.transactionHash })
  sample.transactionTo = transaction.to
  sample.transactionFrom = transaction.from
  try {
    sample.transactionCall = decodeFunctionData({ abi: launchAbi, data: transaction.input })
  } catch {}
}
const report = {
  checkedAt: new Date().toISOString(),
  chainId: 5042,
  factory: manifest.contracts.factoryV2,
  latestBlock: String(latest),
  scope:
    'Bounded historical public log scan starting at the published deployment block, stopping after sample matching launches or an error. Not a complete market index.',
  windows,
  topics: [...topics],
  samples,
}
await writeFile(
  new URL('../docs/evidence/reference-launch-events.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
console.log(
  JSON.stringify(
    {
      windows: windows.length,
      lastWindow: windows.at(-1),
      topics: [...topics],
      samples: samples.map((sample) => ({
        hash: sample.transactionHash,
        block: String(sample.blockNumber),
        token: sample.event.args.token,
      })),
    },
    null,
    2,
  ),
)
