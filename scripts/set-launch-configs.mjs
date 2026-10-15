// Sets the Meteora DBC configs Quantum launches may use (set_launch_configs, authority only, at
// most 4). Defaults to the trading-tax tiers in shared/network.mjs. Operator tool: signs with the
// Quantum Hooks config authority's keypair file.
//
//   node scripts/set-launch-configs.mjs --authority <keypair.json> [--rpc URL] [--configs A,B,...] [--yes]
import { readFile } from 'node:fs/promises'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import * as q from '../shared/quantum.mjs'
import { launchTiers, network } from '../shared/network.mjs'

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
if (typeof args.authority !== 'string') {
  console.error(
    'Usage: node scripts/set-launch-configs.mjs --authority <keypair.json> [--rpc URL] [--configs A,B,...] [--yes]',
  )
  process.exit(1)
}
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(await readFile(args.authority, 'utf8'))),
)
const connection = new Connection(
  (typeof args.rpc === 'string' && args.rpc) ||
    process.env.QUANTPAD_RPC_URL ||
    network.publicRpcUrl,
  'confirmed',
)
const configs = (
  typeof args.configs === 'string' ? args.configs.split(',') : launchTiers.map((t) => t.config)
).map((s) => new PublicKey(s.trim()))
const config = await q.fetchConfig(connection)
if (!config) {
  console.error('Quantum Hooks is not initialized yet (run scripts/init-config.mjs first).')
  process.exit(1)
}
console.log(`set_launch_configs
  authority   ${authority.publicKey.toBase58()} (config authority ${config.authority})
  version     ${config.version}
  configs     ${configs.map((c) => c.toBase58()).join('\n              ')}`)
if (args.yes !== true) console.log('\nNothing sent. Run again with --yes to send it.')
else {
  const ix = await q.buildSetLaunchConfigsInstruction({
    connection,
    authority: authority.publicKey,
    configs,
    expectedVersion: config.version,
  })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: authority.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ix],
    }).compileToV0Message(),
  )
  tx.sign([authority])
  const signature = await connection.sendTransaction(tx)
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  const after = await q.fetchConfig(connection)
  console.log(
    `\nSent: ${signature}\nAllowed configs now: ${(after.launchConfigs || []).join(', ')}`,
  )
}
