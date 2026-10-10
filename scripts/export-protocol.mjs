import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { keccak256 } from 'viem'
import { compilerSettings, protocolVersion, modularVersion } from '../shared/network.mjs'
const names = [
  'HookbrewFactory',
  'HookbrewRouter',
  'HookbrewVesting',
  'HookbrewToken',
  'HookbrewModularFactory',
  'HookbrewHookPackage',
  'HookbrewRewardToken',
  'HookbrewTokenDeployer',
]
await mkdir('src/generated', { recursive: true })
await mkdir('public/protocol', { recursive: true })
await mkdir('artifacts/robinhood/source-verification', { recursive: true })
const abis = {}
for (const name of names) {
  const artifact = JSON.parse(
    await readFile(`contracts/protocol/artifacts/contracts/${name}.sol/${name}.json`, 'utf8'),
  )
  const size = (artifact.deployedBytecode.length - 2) / 2
  const debugPath = `contracts/protocol/artifacts/contracts/${name}.sol/${name}.dbg.json`
  const debug = JSON.parse(await readFile(debugPath, 'utf8'))
  const build = JSON.parse(await readFile(resolve(dirname(debugPath), debug.buildInfo), 'utf8'))
  await writeFile(
    `artifacts/robinhood/source-verification/${name}.input.json`,
    JSON.stringify(build.input, null, 2) + '\n',
  )
  if (size > 24576) throw new Error(`${name} exceeds the contract size limit`)
  if ((artifact.bytecode.length - 2) / 2 > 49152)
    throw new Error(`${name} exceeds the initcode size limit`)
  abis[name] = artifact.abi
  await writeFile(
    `public/protocol/${name}.json`,
    JSON.stringify({
      name,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      creationCodeHash: keccak256(artifact.bytecode),
      runtimeSize: size,
      compiler: '0.8.26+commit.8a97fa7a',
      compilerSettings,
      version: ['HookbrewFactory', 'HookbrewRouter', 'HookbrewVesting', 'HookbrewToken'].includes(
        name,
      )
        ? protocolVersion
        : modularVersion,
    }) + '\n',
  )
  console.log(`${name}: ${size} runtime bytes`)
}
await writeFile('src/generated/protocol.json', JSON.stringify(abis, null, 2) + '\n')
