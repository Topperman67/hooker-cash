// Read public deployment records; only submit source verification, never transactions.
const hre = require('hardhat')
const { readFile, writeFile, mkdir } = require('node:fs/promises')
const { resolve } = require('node:path')
const { keccak256 } = require('viem')
async function main() {
  const source = process.env.HOOKBREW_VERIFY_SOURCE
  if (!source) throw Error('Pass a deployment record JSON path or HTTPS application URL.')
  const remote = source.startsWith('https://')
  async function json(path) {
    const response = await fetch(new URL(path, source), { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw Error(`Deployment API returned ${response.status}`)
    return response.json()
  }
  const records = remote
    ? [(await json('/api/status')).deployment, ...(await json('/api/hooks')).items].filter(Boolean)
    : [JSON.parse(await readFile(source, 'utf8'))]
  if (!records.length)
    throw Error('No activated Robinhood contracts exist yet. Finish wallet deployment first.')
  if (!process.env.BLOCKSCOUT_API_KEY)
    throw Error(
      'Set BLOCKSCOUT_API_KEY for source publication, or use the exported standard JSON sources in the Blockscout verification UI.',
    )
  const { network, treasury, hasNativeConfiguration } = await import('../../../shared/network.mjs')
  const client = await hre.viem.getPublicClient()
  if ((await client.getChainId()) !== 4663)
    throw Error('Verification RPC must be Robinhood mainnet 4663.')
  const verified = []
  async function verify(name, address, args) {
    try {
      await hre.run('verify:verify', {
        address,
        constructorArguments: args,
        contract: `contracts/${name}.sol:${name}`,
      })
    } catch (error) {
      if (!/already verified/i.test(error.message)) throw error
    }
    verified.push({ name, address, url: `${network.explorerUrl}/address/${address}` })
  }
  for (const d of records) {
    if (
      d.chainId !== 4663 ||
      !['hookbrew-v2', 'hookbrew-modular-v2'].includes(d.abiVersion) ||
      !hasNativeConfiguration(d) ||
      d.treasury.toLowerCase() !== treasury.toLowerCase()
    )
      throw Error('Record does not match this Robinhood venue.')
    for (const role of ['factory', 'router']) {
      const code = await client.getCode({ address: d[role] })
      if (!code || keccak256(code) !== d[`${role}CodeHash`])
        throw Error(`On-chain ${role} differs from the exported record.`)
    }
    const modular = d.abiVersion === 'hookbrew-modular-v2'
    const args = [
      network.poolManager,
      network.quote,
      treasury,
      BigInt(network.launchFee),
      ...(modular ? [d.recipe] : []),
    ]
    if (modular) await verify('HookbrewHookPackage', d.packageAddress, args)
    await verify(modular ? 'HookbrewModularFactory' : 'HookbrewFactory', d.factory, args)
    await verify('HookbrewRouter', d.router, [d.factory])
    await verify('HookbrewVesting', d.vesting, [d.factory])
    if (modular) {
      const factory = await hre.viem.getContractAt('HookbrewModularFactory', d.factory)
      await verify('HookbrewTokenDeployer', await factory.read.tokenDeployer(), [
        network.quote,
        network.poolManager,
        d.vesting,
      ])
    }
  }
  // Verify launched token sources too, including constructor arguments before any burns.
  if (remote) {
    let offset = 0
    do {
      const page = await json(`/api/market?offset=${offset}`)
      for (const item of page.items) {
        const d = records.find((record) => record.factory.toLowerCase() === item.hook.toLowerCase())
        if (!d) throw Error('Token belongs to an unverified venue.')
        const modular = d.abiVersion === 'hookbrew-modular-v2'
        const name = modular ? 'HookbrewRewardToken' : 'HookbrewToken'
        const token = await hre.viem.getContractAt(name, item.address)
        const [tokenName, symbol, creator, uri, factory] = await Promise.all([
          token.read.name(),
          token.read.symbol(),
          token.read.creator(),
          token.read.metadataURI(),
          token.read.factory(),
        ])
        if (factory.toLowerCase() !== d.factory.toLowerCase())
          throw Error('Token factory mismatch.')
        await verify(name, item.address, [
          tokenName,
          symbol,
          creator,
          1_000_000_000n * 10n ** 18n,
          uri,
          ...(modular ? [network.quote, network.poolManager, d.vesting, d.factory] : []),
        ])
      }
      offset = page.next
    } while (offset !== null)
  }
  const directory = resolve('../../artifacts/robinhood')
  await mkdir(directory, { recursive: true })
  await writeFile(
    resolve(directory, 'verified-deployments.json'),
    JSON.stringify(
      { chainId: 4663, verifiedAt: new Date().toISOString(), records, verified },
      null,
      2,
    ) + '\n',
  )
  console.log(
    `Verified ${verified.length} contracts; report saved in artifacts/robinhood/verified-deployments.json`,
  )
}
main().catch((error) => {
  console.error(error.shortMessage || error.message)
  process.exitCode = 1
})
