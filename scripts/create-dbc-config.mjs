// Creates Quant Pad's Meteora Dynamic Bonding Curve launch config (shared/dbc-config.mjs) on the
// chosen cluster. Operator tool: signs with a local keypair file, which pays the rent (~0.01 SOL)
// and, unless --fee-claimer says otherwise, becomes the config's fee claimer (it has no trading
// share: creators get all of the trading fee Meteora does not keep). A DBC config can never be
// changed: check the printed summary, then run again with --yes.
//
//   node scripts/create-dbc-config.mjs --keypair ~/.config/solana/id.json [--rpc URL] [--fee-claimer ADDRESS] [--yes]
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
const params = launchConfigParameters()
const balance = await connection.getBalance(payer.publicKey)

console.log(`Quant Pad Meteora launch config
  RPC                 ${rpc}
  payer               ${payer.publicKey.toBase58()} (${(balance / 1e9).toFixed(4)} SOL)
  fee claimer         ${feeClaimer.toBase58()}
  token               SPL Token, 6 decimals, ${LAUNCH_CONFIG.totalTokenSupply.toLocaleString('en-US')} supply, metadata immutable
  trading fee         ${LAUNCH_CONFIG.baseFeeBps / 100}% after launch (starts ${LAUNCH_CONFIG.antiSniper.startingFeeBps / 100}%, falls over ${LAUNCH_CONFIG.antiSniper.totalDurationSecs} s)
  creator fee share   100% of what Meteora does not keep, paid in SOL
  graduation          DAMM v2 at ${LAUNCH_CONFIG.migrationQuoteThresholdSol} SOL in the curve
  migrated pool fee   ${LAUNCH_CONFIG.migratedPoolFeeBps / 100}%, in SOL; LP permanently locked to the creator`)
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
  const tx = await new DynamicBondingCurveClient(connection, 'confirmed').partner.createConfig({
    config: config.publicKey,
    feeClaimer,
    leftoverReceiver: feeClaimer,
    quoteMint: NATIVE_MINT,
    payer: payer.publicKey,
    ...params,
  })
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
