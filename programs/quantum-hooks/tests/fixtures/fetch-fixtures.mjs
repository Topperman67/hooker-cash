// Dumps the mainnet programs and accounts the local end-to-end tests need (read-only RPC).
//   node programs/quantum-hooks/tests/fixtures/fetch-fixtures.mjs [--force]
// RPC: FIXTURE_RPC (default https://api.mainnet-beta.solana.com). Writes programs/*.so and
// accounts/*.json (solana-test-validator --account-dir format) next to this file; both are
// gitignored. Nothing is ever sent to mainnet.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PUMP_AMM_SDK, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA } from '@pump-fun/pump-swap-sdk'
import {
  PUMP_SDK,
  GLOBAL_PDA,
  PUMP_FEE_CONFIG_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
  QUOTE_CONTROL_PDA,
  FEE_PROGRAM_GLOBAL_PDA,
  getGlobalParamsPda,
  getSolVaultPda,
} from '../../../../shared/vendor/pump-sdk.node.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const force = process.argv.includes('--force')
const rpc = process.env.FIXTURE_RPC || 'https://api.mainnet-beta.solana.com'
const connection = new Connection(rpc, 'confirmed')
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const PROGRAMS = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  mayhem: 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
  // Mainnet Token-2022: newer than the copy bundled with the test validator.
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  metaplex: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function withRetry(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (attempt >= 6) throw new Error(`${label}: ${e.message}`)
      const wait = 1500 * 2 ** attempt
      console.warn(`${label}: ${e.message.slice(0, 120)} — retrying in ${wait} ms`)
      await sleep(wait)
    }
  }
}

async function getMany(keys) {
  const out = []
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100)
    out.push(
      ...(await withRetry('getMultipleAccounts', () => connection.getMultipleAccountsInfo(chunk))),
    )
    await sleep(400)
  }
  return out
}

function writeAccount(pubkey, info) {
  const file = join(here, 'accounts', `${pubkey.toBase58()}.json`)
  const json = {
    pubkey: pubkey.toBase58(),
    account: {
      lamports: info.lamports,
      data: [Buffer.from(info.data).toString('base64'), 'base64'],
      owner: info.owner.toBase58(),
      executable: info.executable,
      rentEpoch: 0,
      space: info.data.length,
    },
  }
  writeFileSync(file, JSON.stringify(json))
}

async function dumpProgram(name, id) {
  const file = join(here, 'programs', `${id}.so`)
  if (existsSync(file) && !force) return console.log(`program ${name}: cached`)
  const program = new PublicKey(id)
  const info = await withRetry(name, () => connection.getAccountInfo(program))
  if (!info) throw new Error(`program ${name} ${id} not found`)
  if (!info.owner.equals(BPF_UPGRADEABLE))
    throw new Error(`program ${name} is not upgradeable-loader owned`)
  const programData = new PublicKey(info.data.subarray(4, 36))
  const dataInfo = await withRetry(`${name} programdata`, () =>
    connection.getAccountInfo(programData),
  )
  const elf = dataInfo.data.subarray(45)
  writeFileSync(file, elf)
  console.log(`program ${name}: ${elf.length} bytes`)
  await sleep(500)
}

async function main() {
  mkdirSync(join(here, 'programs'), { recursive: true })
  mkdirSync(join(here, 'accounts'), { recursive: true })
  for (const [name, id] of Object.entries(PROGRAMS)) await dumpProgram(name, id)

  const base = [
    GLOBAL_PDA,
    PUMP_FEE_CONFIG_PDA,
    PUMP_AMM_FEE_CONFIG_PDA,
    GLOBAL_VOLUME_ACCUMULATOR_PDA,
    AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
    GLOBAL_CONFIG_PDA,
    QUOTE_CONTROL_PDA,
    FEE_PROGRAM_GLOBAL_PDA,
    getGlobalParamsPda(),
    getSolVaultPda(),
    NATIVE_MINT,
  ]
  const baseInfos = await getMany(base)
  const [globalInfo, , , , , ammConfigInfo] = baseInfos
  if (!globalInfo || !ammConfigInfo)
    throw new Error('pump Global / PumpSwap GlobalConfig not found')
  const global = PUMP_SDK.decodeGlobal(globalInfo)
  const ammConfig = PUMP_AMM_SDK.decodeGlobalConfig(ammConfigInfo)

  // Wallets the programs pay or check during create / trade / migrate, plus their WSOL ATAs.
  const wallets = new Map()
  const add = (key) => key && !key.equals(PublicKey.default) && wallets.set(key.toBase58(), key)
  for (const key of [global.feeRecipient, ...(global.feeRecipients || [])]) add(key)
  for (const key of [global.reservedFeeRecipient, ...(global.reservedFeeRecipients || [])]) add(key)
  for (const key of global.buybackFeeRecipients || []) add(key)
  add(global.withdrawAuthority)
  add(global.authority)
  for (const key of ammConfig.protocolFeeRecipients || []) add(key)
  for (const key of ammConfig.buybackFeeRecipients || []) add(key)
  add(ammConfig.admin)
  add(global.whitelistPda)
  add(ammConfig.whitelistPda)
  add(ammConfig.reservedFeeRecipient)
  for (const key of ammConfig.reservedFeeRecipients || []) add(key)
  const walletKeys = [...wallets.values()]
  const atas = walletKeys.map((w) =>
    getAssociatedTokenAddressSync(NATIVE_MINT, w, true, TOKEN_PROGRAM_ID),
  )

  const extra = [...walletKeys, ...atas]
  const extraInfos = await getMany(extra)

  let written = 0
  const manifest = []
  for (const [list, infos] of [
    [base, baseInfos],
    [extra, extraInfos],
  ]) {
    list.forEach((key, i) => {
      const info = infos[i]
      if (!info) return
      writeAccount(key, info)
      manifest.push({
        pubkey: key.toBase58(),
        owner: info.owner.toBase58(),
        size: info.data.length,
      })
      written++
    })
  }
  const slot = await withRetry('getSlot', () => connection.getSlot())
  writeFileSync(
    join(here, 'manifest.txt'),
    `# fetched from ${rpc} at slot ${slot} on ${new Date().toISOString()}\n` +
      manifest.map((m) => `${m.pubkey} ${m.owner} ${m.size}`).join('\n') +
      '\n',
  )
  console.log(`accounts: ${written} written (slot ${slot})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
