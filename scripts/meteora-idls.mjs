// Saves the Meteora DBC and DAMM v2 IDLs bundled in the pinned SDKs to shared/idl/, and checks
// them against the IDL each program publishes on-chain and the deployed program's hash
// (read-only RPC). Re-run after any Meteora upgrade; a mismatch means re-pinning.
//   node scripts/meteora-idls.mjs [--rpc <url>]
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { Connection, PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const rpc = arg('--rpc') || process.env.FIXTURE_RPC || 'https://api.mainnet-beta.solana.com'
const connection = new Connection(rpc, 'confirmed')
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

async function onChainIdl(programId) {
  const base = PublicKey.findProgramAddressSync([], programId)[0]
  const address = await PublicKey.createWithSeed(base, 'anchor:idl', programId)
  const info = await connection.getAccountInfo(address)
  if (!info) return null
  // discriminator(8) authority(32) data_len(4) zlib(data)
  const len = info.data.readUInt32LE(40)
  return JSON.parse(inflateSync(info.data.subarray(44, 44 + len)).toString('utf8'))
}

async function programHash(programId) {
  const program = await connection.getAccountInfo(programId)
  const programData = new PublicKey(program.data.subarray(4, 36))
  const data = await connection.getAccountInfo(programData)
  // slot(8) option(1) authority(32) then the ELF, zero-padded
  const elf = data.data.subarray(45)
  let end = elf.length
  while (end > 0 && elf[end - 1] === 0) end--
  return {
    programData: programData.toBase58(),
    slot: Number(data.data.readBigUInt64LE(4)),
    authority: data.data[12] ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null,
    sha256: createHash('sha256').update(elf.subarray(0, end)).digest('hex'),
  }
}

const ixNames = (idl) => idl.instructions.map((i) => i.name).sort()
const evNames = (idl) => (idl.events || []).map((e) => e.name).sort()

const out = {}
for (const [name, idl, file] of [
  ['dbc', DynamicBondingCurveIdl, 'meteora_dbc.json'],
  ['damm_v2', CpAmmIdl, 'meteora_damm_v2.json'],
]) {
  const programId = new PublicKey(idl.address)
  const [chain, hash] = await Promise.all([onChainIdl(programId), programHash(programId)])
  const sdkIx = ixNames(idl)
  const chainIx = chain ? ixNames(chain) : []
  const missing = chain ? chainIx.filter((n) => !sdkIx.includes(n)) : []
  const extra = chain ? sdkIx.filter((n) => !chainIx.includes(n)) : []
  writeFileSync(new URL(`../shared/idl/${file}`, import.meta.url), JSON.stringify(idl, null, 2) + '\n')
  out[name] = {
    program: idl.address,
    sdkIdlVersion: idl.metadata?.version,
    onChainIdlVersion: chain?.metadata?.version ?? 'none published',
    instructionsOnlyOnChain: missing,
    instructionsOnlyInSdk: extra,
    sdkEvents: evNames(idl),
    deployed: hash,
  }
}
console.log(JSON.stringify(out, null, 2))
