import solc from '../contracts/review/node_modules/solc/index.js'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import {
  createPublicClient,
  http,
  parseUnits,
  encodeFunctionData,
  keccak256,
  stringToHex,
} from 'viem'

// Public-client-only simulation: no private key, wallet client, or broadcasting.
// The probe runtime and native balance exist only inside a single eth_call.
const probeSource = await readFile(
  new URL('../contracts/review/LaunchReadOnlyProbe.sol', import.meta.url),
  'utf8',
)
const input = {
  language: 'Solidity',
  sources: { 'LaunchReadOnlyProbe.sol': { content: probeSource } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter((error) => error.severity === 'error')
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'))
const probe = output.contracts['LaunchReadOnlyProbe.sol'].LaunchReadOnlyProbe
const reference = JSON.parse(
  await readFile(new URL('../docs/evidence/hooker-arc-reference.json', import.meta.url), 'utf8'),
)
const rpc = 'https://rpc.mainnet.arc.io'
const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 30000 }) })
if ((await client.getChainId()) !== 5042) throw new Error('Wrong chain')
const block = await client.getBlockNumber()
const probeAddress = '0x000000000000000000000000000000000000cafe'
const originalProbeCode = await client.getCode({ address: probeAddress, blockNumber: block })
if (originalProbeCode && originalProbeCode !== '0x')
  throw new Error('Probe address already has code')
const factory = reference.manifest.contracts.factoryV2
const quote = reference.manifest.constants.usdg
const fee = await client.readContract({
  address: factory,
  abi: reference.factoryAbi,
  functionName: 'launchFee',
  blockNumber: block,
})
const supply = parseUnits('1000000000', 18)
const initialBuy = parseUnits('1', 6)
const results = []
const cases = [
  ...Object.entries(reference.manifest.presets).map(([name, hook]) => ({
    name,
    hook,
    allocation: supply / 10n,
  })),
  {
    name: 'plain-with-vested-buy',
    hook: reference.manifest.presets.plain,
    allocation: supply / 10n,
    vested: true,
  },
  {
    name: 'zero-cap-rejects-initial-buy',
    hook: reference.manifest.presets.plain,
    allocation: 0n,
    expectRevert: true,
  },
]
for (const { name, hook, allocation, vested = false, expectRevert = false } of cases) {
  await pause(600)
  const launchArgs = [
    'Hookbrew read only',
    'PROBE',
    supply,
    allocation,
    hook,
    10000,
    {
      description: 'Ephemeral eth_call verification; never deployed.',
      imageURI: '',
      website: '',
      twitter: '',
      telegram: '',
    },
    { vanitySalt: keccak256(stringToHex(`hookbrew-probe-${block}-${name}`)), targetMcap: 0n },
    quote,
    initialBuy,
    vested ? [{ wallet: probeAddress, bps: 10000, cliffSecs: 86400, durationSecs: 2592000 }] : [],
  ]
  const launchData = encodeFunctionData({
    abi: reference.factoryAbi,
    functionName: 'launch',
    args: launchArgs,
  })
  try {
    const simulation = await client.simulateContract({
      address: probeAddress,
      abi: probe.abi,
      functionName: 'run',
      args: [
        factory,
        quote,
        hook,
        reference.infrastructure.contracts.poolManager,
        reference.manifest.contracts.vestingV3,
        launchData,
        fee,
        initialBuy,
      ],
      blockNumber: block,
      stateOverride: [
        {
          address: probeAddress,
          code: `0x${probe.evm.deployedBytecode.object}`,
          balance: parseUnits('100', 18),
        },
      ],
    })
    const observed = simulation.result
    const checks = {
      ephemeralTokenHasCode: observed.runtimeBytes > 0n,
      exactMetadata: observed.name === launchArgs[0] && observed.symbol === launchArgs[1],
      exactSupply: observed.totalSupply === supply,
      initialBuyDeliveredTokens: vested
        ? observed.vestingBalance > 0n && observed.purchaserBalance === 0n
        : observed.purchaserBalance > 0n && observed.vestingBalance === 0n,
      purchaseWithinCreatorCap: observed.purchaserBalance + observed.vestingBalance <= allocation,
      poolReceivedTokens: observed.poolManagerBalance > 0n,
      quoteAndNativeBalancesAgree: observed.quoteAfter === observed.nativeAfter / 10n ** 12n,
      exactLaunchAndBuyCost:
        observed.nativeBefore - observed.nativeAfter === fee + initialBuy * 10n ** 12n,
      allowanceConsumed: observed.remainingAllowance === 0n,
      registeredWithHook: observed.registeredWithHook,
    }
    results.push({
      name,
      hook,
      creatorAllocationCap: allocation,
      vested,
      expectRevert,
      expectationMet: !expectRevert && Object.values(checks).every(Boolean),
      checks,
      observed,
      tokenActuallyDeployed: false,
    })
  } catch (error) {
    const revert = error.walk?.((cause) => cause.name === 'ContractFunctionRevertedError')
    results.push({
      name,
      hook,
      creatorAllocationCap: allocation,
      expectRevert,
      expectationMet: expectRevert && revert?.reason === 'creator buy exceeds allocation cap',
      error: error.shortMessage || error.message,
      details: error.details,
      data: error.cause?.data,
    })
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  chainId: 5042,
  block: String(block),
  rpc,
  factory,
  quote,
  launchFee: fee,
  initialBuy,
  compiler: solc.version(),
  probeSourceHash: keccak256(stringToHex(probeSource)),
  stateOverride: {
    address: probeAddress,
    nativeBalance: parseUnits('100', 18),
    purpose:
      'Temporary diagnostic code and funding, discarded after each eth_call; existing protocol contracts and storage are not overridden.',
  },
  sentTransactions: 0,
  limitations:
    'Simulates ERC-20 approval, native launch fee, launch, initial purchase and post-launch balances inside one eth_call. Not a broadcast, subsequent market swap, complete source review, or security certification.',
  results,
}
await writeFile(
  new URL('../docs/evidence/reference-initial-buy-simulation.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
console.log(
  JSON.stringify(
    results.map(({ name, expectationMet, checks, error }) => ({
      name,
      expectationMet,
      checks,
      error,
    })),
    null,
    2,
  ),
)
if (results.some((result) => !result.expectationMet)) process.exitCode = 1
