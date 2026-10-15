// Creates Quant Pad's Meteora Dynamic Bonding Curve launch config (shared/dbc-config.mjs) on the
// chosen cluster. Operator tool: signs with a local keypair file, which pays the rent (~0.01 SOL)
// and, unless --fee-claimer says otherwise, becomes the config's fee claimer (it has no trading
// share: creators get all of the trading fee Meteora does not keep). A DBC config can never be
// changed: check the printed summary, then run again with --yes.
//
//   node scripts/create-dbc-config.mjs --keypair ~/.config/solana/id.json [--rpc URL] [--fee-claimer ADDRESS]
//     [--fee PCT] [--launch-fee PCT] [--launch-fee-secs SECS] [--graduation SOL] [--pool-fee PCT] [--yes]
//
// --fee is the curve's trading fee once the launch window has passed (default 1), --launch-fee the
// anti-sniper fee it starts at and falls from over --launch-fee-secs (default 25 over 120; 0 turns
// it off), --graduation the SOL in the curve when it moves to DAMM v2 (default 85), --pool-fee the
// DAMM v2 pool's fee after that (default 1). Meteora keeps its protocol share of every fee; the
// rest goes to the coin's creator.
//
// Then set QUANTPAD_DBC_CONFIG=<address> on the server.
import { readFile, writeFile } from 'node:fs/promises'
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { LAUNCH_CONFIG, launchConfigParameters } from '../shared/dbc-config.mjs'
import { network } from '../shared/network.mjs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, i, all) =>
        value.startsWith('--')
          ? [...pairs, [value.slice(2), all[i + 1]?.startsWith('--') ? true : (all[i + 1] ?? true)]]
          : pairs,
      [],
    ),
)
if (!args.keypair || args.keypair === true) {
  console.error(
    'Usage: node scripts/create-dbc-config.mjs --keypair <file> [--rpc URL] [--fee-claimer ADDRESS] [--yes]',
  )
  process.exit(1)
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(args.keypair, 'utf8'))),
)
const rpc =
  (typeof args.rpc === 'string' && args.rpc) || process.env.QUANTPAD_RPC_URL || network.publicRpcUrl
const connection = new Connection(rpc, 'confirmed')
const feeClaimer = new PublicKey(
  typeof args['fee-claimer'] === 'string' ? args['fee-claimer'] : payer.publicKey,
)
const pct = (name) => {
  if (args[name] === undefined) return undefined
  const v = Number(args[name])
  if (!Number.isFinite(v) || v < 0) {
    console.error(`--${name} must be a number`)
    process.exit(1)
  }
  return v
}
const overrides = {}
if (pct('fee') !== undefined) overrides.baseFeeBps = Math.round(pct('fee') * 100)
if (pct('graduation') !== undefined) overrides.migrationQuoteThresholdSol = pct('graduation')
if (pct('pool-fee') !== undefined) overrides.migratedPoolFeeBps = Math.round(pct('pool-fee') * 100)
if (pct('launch-fee') === 0) overrides.antiSniper = null
else if (pct('launch-fee') !== undefined || pct('launch-fee-secs') !== undefined)
  overrides.antiSniper = {
    ...LAUNCH_CONFIG.antiSniper,
    ...(pct('launch-fee') !== undefined
      ? { startingFeeBps: Math.round(pct('launch-fee') * 100) }
      : {}),
    ...(pct('launch-fee-secs') !== undefined
      ? { totalDurationSecs: Math.round(pct('launch-fee-secs')) }
      : {}),
  }
const c = { ...LAUNCH_CONFIG, ...overrides }
let params
try {
  params = launchConfigParameters(overrides)
} catch (e) {
  console.error(`Meteora would refuse these settings: ${e.message}`)
  process.exit(1)
}
const balance = await connection.getBalance(payer.publicKey)

console.log(`Quant Pad Meteora launch config
  RPC                 ${rpc}
  payer               ${payer.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)
  fee claimer         ${feeClaimer.toBase58()}
  token               SPL Token, 6 decimals, ${LAUNCH_CONFIG.totalTokenSupply.toLocaleString('en-US')} supply, metadata immutable
  trading fee         ${c.baseFeeBps / 100}%${c.antiSniper ? ` after launch (starts ${c.antiSniper.startingFeeBps / 100}%, falls over ${c.antiSniper.totalDurationSecs} s)` : ' from the first trade'}
  creator fee share   100% of what Meteora does not keep, paid in SOL
  graduation          DAMM v2 at ${c.migrationQuoteThresholdSol} SOL in the curve
  migrated pool fee   ${c.migratedPoolFeeBps / 100}%, in SOL; LP permanently locked to the creator`)
// Meteora's SDK checks every parameter while building the transaction: build it now, so a refusal
// shows before anything is sent.
const client = new DynamicBondingCurveClient(connection, 'confirmed')
const buildTx = (config) =>
  client.partner.createConfig({
    config,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: NATIVE_MINT,
    payer: payer.publicKey,
    ...params,
  })
try {
  await buildTx(Keypair.generate().publicKey)
} catch (e) {
  console.error(`
Meteora would refuse these settings: ${e.message}`)
  process.exit(1)
}
if (args.yes !== true)
  console.log(
    '\nNothing sent. Run again with --yes to create it (it cannot be changed afterwards).',
  )
else await create()

async function create() {
  const config = Keypair.generate()
  // Keep the config keypair: it is not needed again, but it is the record of what was created.
  const saved = `dbc-config-${config.publicKey.toBase58()}.json`
  await writeFile(saved, JSON.stringify(Array.from(config.secretKey)))
  const tx = await buildTx(config.publicKey)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToV0Message()
  const signed = new VersionedTransaction(message)
  signed.sign([payer, config])
  const signature = await connection.sendTransaction(signed)
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  console.log(`\nCreated: ${signature}
Config keypair saved to ${saved}

QUANTPAD_DBC_CONFIG=${config.publicKey.toBase58()}`)
}
