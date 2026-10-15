// Creates (or extends) Quant Pad's address lookup table so the Meteora launch transaction (DBC
// create, creator hand-off, sync and dev buy) fits in one transaction. Operator tool: signs with a
// local keypair file.
//
//   node scripts/create-lookup-table.mjs --keypair ~/.config/solana/id.json [--rpc URL] [--table ADDRESS] [--config DBC_CONFIG,...]
//
// The DBC configs default to QUANTPAD_DBC_CONFIG. Then set QUANTPAD_LOOKUP_TABLE=<address> on the
// server.
import { readFile } from 'node:fs/promises'
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { staticLaunchAccounts } from '../shared/lookup.mjs'
import { network } from '../shared/network.mjs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, i, all) =>
        value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs,
      [],
    ),
)
if (!args.keypair) {
  console.error(
    'Usage: node scripts/create-lookup-table.mjs --keypair <file> [--rpc URL] [--table ADDRESS] [--config DBC_CONFIG,...]',
  )
  process.exit(1)
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(args.keypair, 'utf8'))),
)
const connection = new Connection(
  args.rpc || process.env.QUANTPAD_RPC_URL || network.publicRpcUrl,
  'confirmed',
)

const quantum = await import('../shared/quantum.mjs')
const extra = [quantum.QUANTUM_PROGRAM_ID, quantum.configPda()]
if (process.env.QUANTPAD_TREASURY) extra.push(new PublicKey(process.env.QUANTPAD_TREASURY))
const launchConfigs = String(args.config || process.env.QUANTPAD_DBC_CONFIG || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new PublicKey(s))
if (!launchConfigs.length)
  console.warn('No DBC launch config given (--config or QUANTPAD_DBC_CONFIG); add it later with --table.')

async function send(instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(),
  )
  tx.sign([payer])
  const signature = await connection.sendTransaction(tx)
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  return signature
}

let table = args.table ? new PublicKey(args.table) : null
if (!table) {
  const slot = await connection.getSlot('finalized')
  const [ix, address] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  })
  console.log('Creating lookup table', address.toBase58(), await send([ix]))
  table = address
}
const existing = new Set(
  ((await connection.getAddressLookupTable(table)).value?.state.addresses || []).map((k) =>
    k.toBase58(),
  ),
)
const wanted = staticLaunchAccounts({ launchConfigs, extra }).filter(
  (k) => !existing.has(k.toBase58()),
)
for (let i = 0; i < wanted.length; i += 20) {
  const chunk = wanted.slice(i, i + 20)
  const ix = AddressLookupTableProgram.extendLookupTable({
    lookupTable: table,
    authority: payer.publicKey,
    payer: payer.publicKey,
    addresses: chunk,
  })
  console.log(`Added ${chunk.length} addresses`, await send([ix]))
}
console.log(
  `\nQUANTPAD_LOOKUP_TABLE=${table.toBase58()}  (${existing.size + wanted.length} addresses)`,
)
