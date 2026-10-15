// Dumps the mainnet programs and accounts the local end-to-end tests need (read-only RPC).
//   node programs/quantum-hooks/tests/fixtures/fetch-fixtures.mjs [--force]
// RPC: FIXTURE_RPC (default https://api.mainnet-beta.solana.com). Writes programs/*.so and
// accounts/*.json (solana-test-validator --account-dir format) next to this file; both are
// gitignored. Nothing is ever sent to mainnet. Meteora's programs are only ever loaded as these
// dumped binaries: their source is under a non-commercial licence and is never built here.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync as readFileSyncBuffer, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Connection, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS } from '@meteora-ag/dynamic-bonding-curve-sdk'

const here = dirname(fileURLToPath(import.meta.url))
const force = process.argv.includes('--force')
const rpc = process.env.FIXTURE_RPC || 'https://api.mainnet-beta.solana.com'
const connection = new Connection(rpc, 'confirmed')
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const PROGRAMS = {
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  dammV2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  // Mainnet Token-2022 (DAMM v2 position NFTs): newer than the test validator's bundled copy.
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

function programHashes() {
  return readdirSync(join(here, 'programs'))
    .filter((f) => f.endsWith('.so'))
    .map((f) => {
      const elf = readFileSyncBuffer(join(here, 'programs', f))
      let end = elf.length
      while (end > 0 && elf[end - 1] === 0) end--
      return `# program ${f.slice(0, -3)} sha256 ${createHash('sha256').update(elf.subarray(0, end)).digest('hex')}`
    })
}

async function main() {
  mkdirSync(join(here, 'programs'), { recursive: true })
  mkdirSync(join(here, 'accounts'), { recursive: true })
  // drop anything left from other venues so the validator only loads what is listed here
  const keep = new Set(Object.values(PROGRAMS).map((id) => `${id}.so`))
  for (const f of readdirSync(join(here, 'programs'))) if (!keep.has(f)) rmSync(join(here, 'programs', f))
  for (const f of readdirSync(join(here, 'accounts'))) rmSync(join(here, 'accounts', f))
  for (const [name, id] of Object.entries(PROGRAMS)) await dumpProgram(name, id)

  // The DAMM v2 configs DBC migrates into (one per migration_fee_option; [6] = Customizable),
  // which only Meteora's operators can create; both programs' pool authorities (on mainnet they
  // hold the lamports that front rent during migration); and the native mint.
  const authority = (id) => PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], new PublicKey(id))[0]
  const base = [...DAMM_V2_MIGRATION_FEE_ADDRESS, authority(PROGRAMS.dbc), authority(PROGRAMS.dammV2), NATIVE_MINT]
  const baseInfos = await getMany(base)

  let written = 0
  const manifest = []
  base.forEach((key, i) => {
    const info = baseInfos[i]
    if (!info) return
    writeAccount(key, info)
    manifest.push({ pubkey: key.toBase58(), owner: info.owner.toBase58(), size: info.data.length })
    written++
  })
  const slot = await withRetry('getSlot', () => connection.getSlot())
  writeFileSync(
    join(here, 'manifest.txt'),
    [
      `# fetched from ${rpc} at slot ${slot} on ${new Date().toISOString()}`,
      ...programHashes(),
      ...manifest.map((m) => `${m.pubkey} ${m.owner} ${m.size}`),
      '',
    ].join('\n'),
  )
  console.log(`accounts: ${written} written (slot ${slot})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
