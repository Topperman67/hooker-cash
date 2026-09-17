import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { createPublicClient, http, parseAbi, parseUnits, keccak256, stringToHex } from 'viem'

// This script has no wallet client and never broadcasts. The temporary account
// balance applies to eth_call only. A returned address is NOT a deployed token.
const reference = JSON.parse(
  await readFile(new URL('../docs/evidence/hooker-arc-reference.json', import.meta.url), 'utf8'),
)
const rpc = 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 30000 }) })
const chainId = await client.getChainId()
if (chainId !== reference.manifest.chainId) throw new Error('Wrong chain')
const block = await client.getBlockNumber()
const factory = reference.manifest.contracts.factoryV2
const quote = reference.manifest.constants.usdg
const account = '0x000000000000000000000000000000000000beef'
const launchFee = await client.readContract({
  address: factory,
  abi: reference.factoryAbi,
  functionName: 'launchFee',
  blockNumber: block,
})
const policy = await client.readContract({
  address: factory,
  abi: reference.factoryAbi,
  functionName: 'policy',
  blockNumber: block,
})
const policyAbi = parseAbi([
  'function allowedQuoteCurrency(address) view returns (bool)',
  'function creatorAllocationCapBps() view returns (uint24)',
  'function defaultUsdMcap() view returns (uint256)',
])
const allowedQuote = await client.readContract({
  address: policy,
  abi: policyAbi,
  functionName: 'allowedQuoteCurrency',
  args: [quote],
  blockNumber: block,
})
if (!allowedQuote) throw new Error('USDC quote is not admitted')
const hooks = reference.manifest.presets
const results = []
const cases = [
  ...Object.entries(hooks).map(([name, hook]) => ({ name, hook, expectRevert: false })),
  { name: 'insufficient-launch-fee', hook: hooks.plain, expectRevert: true, value: launchFee - 1n },
  {
    name: 'oversized-token-name',
    hook: hooks.plain,
    expectRevert: true,
    nameOverride: 'A'.repeat(33),
  },
  {
    name: 'oversized-token-symbol',
    hook: hooks.plain,
    expectRevert: true,
    symbolOverride: 'A'.repeat(13),
  },
  {
    name: 'zero-hook-address',
    hook: '0x0000000000000000000000000000000000000000',
    expectRevert: true,
  },
  { name: 'non-contract-quote', hook: hooks.plain, expectRevert: true, quoteOverride: account },
  {
    name: 'creator-allocation-over-cap',
    hook: hooks.plain,
    expectRevert: true,
    allocation: parseUnits('110000000', 18),
  },
]
for (const {
  name,
  hook,
  expectRevert,
  value = launchFee,
  nameOverride,
  symbolOverride,
  quoteOverride,
  allocation = 0n,
} of cases) {
  await pause(500)
  const args = [
    nameOverride ?? 'Hookbrew verification only',
    symbolOverride ?? 'VERIFY',
    parseUnits('1000000000', 18),
    allocation,
    hook,
    10000,
    {
      description: 'Read-only eth_call verification. This token is not deployed.',
      imageURI: '',
      website: '',
      twitter: '',
      telegram: '',
    },
    { vanitySalt: keccak256(stringToHex(`hookbrew-read-only-${block}-${name}`)), targetMcap: 0n },
    quoteOverride ?? quote,
    0n,
    [],
  ]
  try {
    const simulation = await client.simulateContract({
      address: factory,
      abi: reference.factoryAbi,
      functionName: 'launch',
      args,
      account,
      value,
      blockNumber: block,
      stateOverride: [{ address: account, balance: parseUnits('10', 18) }],
    })
    results.push({
      name,
      hook,
      expectRevert,
      expectationMet: !expectRevert,
      result: 'eth_call succeeded',
      predictedToken: simulation.result,
      tokenActuallyDeployed: false,
    })
  } catch (error) {
    const revert = error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')
    results.push({
      name,
      hook,
      expectRevert,
      expectationMet: expectRevert && revert?.name === 'ContractFunctionRevertedError',
      result: 'eth_call failed',
      failureType: revert?.name || error.name,
      error: error.shortMessage || error.message,
      details: error.details,
      cause: error.cause?.shortMessage,
      data: error.cause?.data,
    })
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  chainId,
  block: String(block),
  rpc,
  factory,
  quote,
  policy,
  allowedQuote,
  launchFee: String(launchFee),
  simulationAccount: account,
  temporaryNativeBalance: '10000000000000000000',
  sentTransactions: 0,
  scope:
    'Read-only launch simulation. Successful baseline cases use zero creator allocation cap and no initial buy; negative cases exercise invalid inputs. Does not establish source verification, a real deployment, post-launch trading or fee claims.',
  results,
}
await writeFile(
  new URL('../docs/evidence/reference-launch-simulation.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
console.log(JSON.stringify(report, null, 2))
if (results.some((result) => !result.expectationMet)) process.exitCode = 1
