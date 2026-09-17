import solc from '../contracts/review/node_modules/solc/index.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { createPublicClient, http, keccak256, padHex, parseAbi, zeroAddress } from 'viem'

const sourceUrl = 'https://hooker.cash/LaunchpadHookCore.standard.json'
const original = await readFile(
  new URL('../contracts/review/LaunchpadHookCore.standard.json', import.meta.url),
  'utf8',
)
if (!solc.version().startsWith('0.8.26+commit.8a97fa7a'))
  throw new Error('Compiler version differs from the verified profile')
const input = JSON.parse(original)
const sourceSha256 = createHash('sha256').update(original).digest('hex')
const settings = structuredClone(input.settings)
input.settings.outputSelection = {
  '*': { '': ['ast'] },
  'src/launchpad/LaunchpadHookCore.sol': { LaunchpadHookCore: ['abi', 'evm.deployedBytecode'] },
}
console.log('Compiling the published V10 core with', solc.version())
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const failures = (output.errors || []).filter((error) => error.severity === 'error')
if (failures.length) throw new Error(failures.map((error) => error.formattedMessage).join('\n'))
const compiled = output.contracts['src/launchpad/LaunchpadHookCore.sol'].LaunchpadHookCore
const template = compiled.evm.deployedBytecode.object
const refs = compiled.evm.deployedBytecode.immutableReferences
const nodes = new Map()
function visit(node) {
  if (!node || typeof node !== 'object') return
  if (node.nodeType === 'VariableDeclaration')
    nodes.set(String(node.id), { name: node.name, type: node.typeDescriptions.typeString })
  for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
}
for (const source of Object.values(output.sources)) visit(source.ast)
function mask(hex) {
  const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  for (const locations of Object.values(refs))
    for (const location of locations) {
      if (location.start < 0 || location.start + location.length > bytes.length)
        throw new Error('Immutable reference outside runtime')
      bytes.fill(0, location.start, location.start + location.length)
    }
  return bytes.toString('hex')
}
const reference = JSON.parse(
  await readFile(new URL('../docs/evidence/hooker-arc-reference.json', import.meta.url), 'utf8'),
)
const client = createPublicClient({
  transport: http('https://rpc.mainnet.arc.io', { timeout: 15000 }),
})
if ((await client.getChainId()) !== 5042) throw new Error('Wrong chain')
const block = await client.getBlockNumber()
const executorAbi = parseAbi([
  'function factory() view returns (address)',
  'function quotePolicy() view returns (address)',
])
const executorGetters = {}
for (const functionName of ['factory', 'quotePolicy']) {
  await pause(300)
  executorGetters[functionName] = await client.readContract({
    address: reference.manifest.contracts.seedExecutorV2,
    abi: executorAbi,
    functionName,
    blockNumber: block,
  })
}
const executorChecks = {
  factory:
    executorGetters.factory.toLowerCase() === reference.manifest.contracts.factoryV2.toLowerCase(),
  quotePolicy:
    executorGetters.quotePolicy.toLowerCase() ===
    reference.manifest.contracts.policyV2.toLowerCase(),
}
const presetConfigurations = {
  jit: { gates: [reference.manifest.catalog.jit], values: [], params: ['0x'] },
  plain: { gates: [], values: [], params: [] },
  reflect50: {
    gates: [],
    values: [reference.manifest.catalog.reflect],
    params: [padHex('0x1388', { size: 32 })],
  },
  reflect50burn20: {
    gates: [],
    values: [reference.manifest.catalog.reflect, reference.manifest.catalog.burn],
    params: [padHex('0x1388', { size: 32 }), padHex('0x07d0', { size: 32 })],
  },
}
const comparisons = []
for (const [name, address] of Object.entries(reference.manifest.presets)) {
  await pause(300)
  const deployed = await client.getCode({ address, blockNumber: block })
  if (!deployed || deployed === '0x') throw new Error(`No code: ${name}`)
  const bytes = Buffer.from(deployed.slice(2), 'hex')
  const immutableValues = Object.entries(refs).map(([id, locations]) => {
    const values = locations.map(
      ({ start, length }) => `0x${bytes.subarray(start, start + length).toString('hex')}`,
    )
    return {
      id,
      ...nodes.get(id),
      value: values[0],
      allOccurrencesAgree: values.every((value) => value === values[0]),
      locations,
    }
  })
  const getters = {}
  for (const functionName of [
    'factory',
    'treasury',
    'manager',
    'positionManager',
    'feeShare',
    'WETH',
    'USDG',
    'reflectionsDistributor',
    'universalEconomics',
    'wantsHolderTracking',
    'manifest',
  ]) {
    await pause(300)
    try {
      getters[functionName] = await client.readContract({
        address,
        abi: compiled.abi,
        functionName,
        blockNumber: block,
      })
    } catch (error) {
      getters[functionName] = { error: error.shortMessage || error.message }
    }
  }
  // The recovered base explicitly binds its "factory" field to the seed executor.
  // Arc has no WETH. The deployed core uses a dead-address sentinel; preserve the
  // discrepancy with the site's generic manifest instead of silently equating them.
  const config = presetConfigurations[name]
  if (!config) throw new Error(`Unreviewed preset: ${name}`)
  const expected = {
    factory: reference.manifest.contracts.seedExecutorV2,
    treasury: reference.manifest.treasury,
    manager: reference.infrastructure.contracts.poolManager,
    positionManager: reference.infrastructure.contracts.positionManager,
    feeShare: reference.manifest.contracts.engineV3,
    WETH: '0x000000000000000000000000000000000000dead',
    USDG: reference.manifest.constants.usdg,
    reflectionsDistributor: config.values.length
      ? reference.manifest.contracts.distributor
      : zeroAddress,
  }
  const dependencyChecks = Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key,
      typeof getters[key] === 'string' && getters[key].toLowerCase() === value.toLowerCase(),
    ]),
  )
  const immutableExpected = {
    ...expected,
    universalEconomics: true,
    wantsHolderTracking: config.values.length > 0,
  }
  for (let index = 0; index < 4; index++)
    immutableExpected[`g${index}`] = config.gates[index] || zeroAddress
  for (let index = 0; index < 5; index++)
    immutableExpected[`v${index}`] = config.values[index] || zeroAddress
  for (const item of immutableValues) {
    const expectedValue = immutableExpected[item.name]
    if (expectedValue === undefined) throw new Error(`Unreviewed immutable: ${item.name}`)
    item.expectedValue = padHex(
      typeof expectedValue === 'boolean' ? (expectedValue ? '0x01' : '0x00') : expectedValue,
      { size: 32 },
    ).toLowerCase()
    item.matchesExpected = item.value === item.expectedValue
  }
  const expectedManifest = [10, 1, [...config.gates, ...config.values], config.params]
  const manifestMatches =
    JSON.stringify(getters.manifest).toLowerCase() ===
    JSON.stringify(expectedManifest).toLowerCase()
  const genericManifestDifferences = {
    hookFactoryIsSeedExecutor: getters.factory !== reference.manifest.contracts.factoryV2,
    hookWethDiffersFromGenericManifest: getters.WETH !== reference.manifest.constants.weth,
  }
  comparisons.push({
    name,
    address,
    templateBytes: template.length / 2,
    deployedBytes: bytes.length,
    templateMatchExcludingImmutables:
      bytes.length === template.length / 2 && mask(deployed) === mask(template),
    immutableValues,
    getters,
    dependencyChecks,
    manifestMatches,
    genericManifestDifferences,
    codeHash: keccak256(deployed),
  })
}
const report = {
  checkedAt: new Date().toISOString(),
  sourceUrl,
  sourceSha256,
  compiler: solc.version(),
  settings,
  blockNumber: String(block),
  executorGetters,
  executorChecks,
  limitations:
    'Runtime template plus every compiler-identified immutable and public manifest checked against the recorded preset configuration. Getter/dependency checks do not validate all storage, module implementations, factory source, or economic safety. The dead-address WETH sentinel is an observed deployment convention, not a generic manifest match.',
  comparisons,
}
await writeFile(
  new URL('../docs/evidence/hook-core-source-check.json', import.meta.url),
  JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2) +
    '\n',
)
await mkdir(new URL('../artifacts/contract-review/', import.meta.url), { recursive: true })
await writeFile(
  new URL('../artifacts/contract-review/hook-core-abi.json', import.meta.url),
  JSON.stringify(compiled.abi, null, 2),
)
console.log(
  JSON.stringify(
    {
      executorChecks,
      presets: comparisons.map(
        ({
          name,
          templateMatchExcludingImmutables,
          dependencyChecks,
          manifestMatches,
          immutableValues,
        }) => ({
          name,
          templateMatchExcludingImmutables,
          dependencyChecks,
          manifestMatches,
          immutablesMatch: immutableValues.every(
            (item) => item.matchesExpected && item.allOccurrencesAgree,
          ),
        }),
      ),
    },
    null,
    2,
  ),
)
if (
  Object.values(executorChecks).some((value) => !value) ||
  comparisons.some(
    (result) =>
      !result.templateMatchExcludingImmutables ||
      !result.manifestMatches ||
      result.immutableValues.some(
        (value) => !value.allOccurrencesAgree || !value.matchesExpected,
      ) ||
      Object.values(result.dependencyChecks).some((value) => !value),
  )
)
  process.exitCode = 1
