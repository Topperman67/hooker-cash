import { readFile, writeFile } from 'node:fs/promises'
import { encodeDeployData, getCreate2Address, keccak256, toHex } from 'viem'
import {
  network,
  treasury,
  protocolVersion,
  modularVersion,
  compilerSettings,
} from '../shared/network.mjs'

const factory = JSON.parse(await readFile('public/protocol/HookbrewFactory.json', 'utf8'))
const args = [network.poolManager, network.quote, treasury, BigInt(network.launchFee)]
const data = encodeDeployData({ abi: factory.abi, bytecode: factory.bytecode, args })
const initCodeHash = keccak256(data)
let prepared
for (let nonce = 0n; nonce < 2_000_000n; nonce++) {
  const salt = toHex(nonce, { size: 32 })
  const address = getCreate2Address({ from: network.create2, salt, bytecodeHash: initCodeHash })
  if ((BigInt(address) & 0x3fffn) === 0x2080n) {
    prepared = { address, salt, initCodeHash, constructorArguments: args.map(String) }
    break
  }
}
if (!prepared) throw Error('Could not find a valid factory hook salt.')
await writeFile(
  'public/protocol/RobinhoodRelease.json',
  JSON.stringify(
    {
      status: 'prepared-not-deployed',
      protocolVersion,
      modularVersion,
      ...network,
      treasury,
      compiler: factory.compiler,
      compilerSettings,
      factoryCandidate: prepared,
      setupSalt:
        'The wallet setup flow mines a fresh valid salt; its confirmed receipt determines the active factory address.',
      router: 'Determined by the deploying wallet and its nonce; exported after activation.',
      customHooks:
        'Recipe-specific CREATE2 salts and addresses are mined from v2 artifacts when building.',
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `Robinhood v2 factory prepared: ${prepared.address} (deployment still requires a wallet signature)`,
)
