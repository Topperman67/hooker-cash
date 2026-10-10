// Initialises the Quantum Hooks config account (`initialize_config`) once, right after the program
// is deployed. The program only accepts its upgrade authority as the signer, so nobody can
// front-run the deploy. Operator tool: signs with a local keypair file.
//
//   node scripts/init-config.mjs --rpc <url> --authority <keypair.json> --treasury <base58>
//        [--protocol-bps <0-1000>]       protocol share of every pulse, in bps (default 0)
//        [--keeper <base58>]             keeper public key, i.e. QUANTPAD_KEEPER_SECRET's
//                                        (default: the authority's public key)
//        [--max-burn-sol <sol>]          per-action cap for Quantum Burn and Fusion (default 1)
//        [--min-action-interval <secs>]  minimum time between two burns / fusions (default 3600)
//        [--keeper-grace <secs>]         time before anyone, not just the keeper, may run them
//                                        (default 86400)
//        [--program-id <base58>]         default: "address" in shared/idl/quantum_hooks.json
//        [--mainnet]                     allow a mainnet-beta RPC
//        [--yes]                         sign and send
//
// Without --yes it only prints a dry-run summary (read-only RPC calls) and exits. It refuses
// mainnet-beta RPC URLs, and any RPC whose genesis hash is mainnet-beta's, unless --mainnet is also
// passed. Every value except the authority can be changed later with update_config.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const USAGE =
  'Usage: node scripts/init-config.mjs --rpc <url> --authority <keypair.json> --treasury <base58>\n' +
  '         [--protocol-bps <0-1000>] [--keeper <base58>] [--max-burn-sol <sol>]\n' +
  '         [--min-action-interval <secs>] [--keeper-grace <secs>] [--program-id <base58>]\n' +
  '         [--mainnet] [--yes]'

const VALUE_FLAGS = new Set([
  'rpc',
  'authority',
  'treasury',
  'protocol-bps',
  'keeper',
  'max-burn-sol',
  'min-action-interval',
  'keeper-grace',
  'program-id',
])
const BOOLEAN_FLAGS = new Set(['yes', 'mainnet', 'help'])
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DEFAULT_KEY = '11111111111111111111111111111111'

const usageError = (message) => Object.assign(new Error(message), { usage: true })

function pubkeyArg(name, value) {
  if (!BASE58.test(value) || value === DEFAULT_KEY)
    throw usageError(`--${name} must be a base58 public key`)
  return value
}

function intArg(name, value, min, max) {
  if (!/^\d+$/.test(value)) throw usageError(`--${name} must be a whole number`)
  const out = Number(value)
  if (!Number.isSafeInteger(out) || out < min || out > max)
    throw usageError(`--${name} must be between ${min} and ${max}`)
  return out
}

/** SOL as a decimal string (at most 9 decimals) to lamports. */
export function solToLamports(value) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(value))
  if (!m) throw usageError('--max-burn-sol must be a positive SOL amount (at most 9 decimals)')
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0'))
}

/** Mainnet-beta RPC endpoints name the cluster in their URL (api.mainnet-beta.solana.com, …). */
export function isMainnetUrl(url) {
  return /mainnet/i.test(String(url))
}

/** Parses and validates the command line. Throws an error with `usage: true` on bad input. */
export function parseArgs(argv) {
  const raw = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw usageError(`Unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (BOOLEAN_FLAGS.has(name)) raw[name] = true
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw usageError(`--${name} needs a value`)
      raw[name] = value
    } else throw usageError(`Unknown option --${name}`)
  }
  if (raw.help) return { help: true }
  for (const name of ['rpc', 'authority', 'treasury'])
    if (!raw[name]) throw usageError(`--${name} is required`)
  let rpc
  try {
    rpc = new URL(raw.rpc)
  } catch {
    throw usageError('--rpc must be an http(s) URL')
  }
  if (!['http:', 'https:'].includes(rpc.protocol)) throw usageError('--rpc must be an http(s) URL')
  const maxBurnLamports = solToLamports(raw['max-burn-sol'] ?? '1')
  if (maxBurnLamports <= 0n) throw usageError('--max-burn-sol must be greater than 0')
  return {
    rpc: raw.rpc,
    authorityFile: raw.authority,
    treasury: pubkeyArg('treasury', raw.treasury),
    keeper: raw.keeper === undefined ? null : pubkeyArg('keeper', raw.keeper),
    protocolBps: intArg('protocol-bps', raw['protocol-bps'] ?? '0', 0, 1000),
    maxBurnLamports,
    minActionInterval: intArg(
      'min-action-interval',
      raw['min-action-interval'] ?? '3600',
      0,
      2 ** 40,
    ),
    keeperGrace: intArg('keeper-grace', raw['keeper-grace'] ?? '86400', 0, 2 ** 40),
    programId: raw['program-id'] === undefined ? null : pubkeyArg('program-id', raw['program-id']),
    mainnet: !!raw.mainnet,
    yes: !!raw.yes,
  }
}

const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, '')} SOL`

// UpgradeableLoaderState::ProgramData: u32 tag (3), u64 slot, Option<Pubkey> authority.
function upgradeAuthorityOf(programDataInfo, PublicKey) {
  const data = programDataInfo?.data
  if (!data || data.length < 45 || data.readUInt32LE(0) !== 3) return undefined
  return data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    if (!e.usage) throw e
    console.error(`${e.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  if (isMainnetUrl(opts.rpc) && !opts.mainnet) {
    console.error(
      `Refusing ${opts.rpc}: it looks like mainnet-beta. Pass --mainnet as well to initialise the live program.`,
    )
    return 1
  }

  const {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
  } = await import('@solana/web3.js')
  const quantum = await import('../shared/quantum.mjs')

  let authority
  try {
    authority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await readFile(opts.authorityFile, 'utf8'))),
    )
  } catch (e) {
    console.error(`Cannot read the authority keypair ${opts.authorityFile}: ${e.message}`)
    return 1
  }
  const programId = new PublicKey(opts.programId ?? quantum.QUANTUM_PROGRAM_ID)
  const keeper = opts.keeper ?? authority.publicKey.toBase58()
  const connection = new Connection(opts.rpc, 'confirmed')

  const genesis = await connection.getGenesisHash()
  const isMainnet = genesis === MAINNET_GENESIS_HASH
  if (isMainnet && !opts.mainnet) {
    console.error(
      `Refusing ${opts.rpc}: its genesis hash is mainnet-beta's. Pass --mainnet as well to initialise the live program.`,
    )
    return 1
  }

  const configPda = quantum.configPda(programId)
  const [programInfo, programDataInfo, configInfo, balance] = await Promise.all([
    connection.getAccountInfo(programId),
    connection.getAccountInfo(quantum.programDataPda(programId)),
    connection.getAccountInfo(configPda),
    connection.getBalance(authority.publicKey),
  ])
  const upgradeAuthority = upgradeAuthorityOf(programDataInfo, PublicKey)
  // 8-byte discriminator + Config::INIT_SPACE (see programs/.../state.rs).
  const configRent = BigInt(await connection.getMinimumBalanceForRentExemption(8 + 188))

  const problems = []
  if (!programInfo?.executable)
    problems.push(`Program ${programId.toBase58()} is not deployed on this cluster.`)
  else if (upgradeAuthority === undefined)
    problems.push('Cannot read the program data account (not an upgradeable program?).')
  else if (upgradeAuthority !== authority.publicKey.toBase58())
    problems.push(
      `The program's upgrade authority is ${upgradeAuthority ?? 'none (immutable)'}, not ${authority.publicKey.toBase58()}; the program will reject this signer.`,
    )
  if (configInfo)
    problems.push(
      `The config ${configPda.toBase58()} is already initialised; use update_config to change it.`,
    )
  if (BigInt(balance) < configRent + 100_000n)
    problems.push(
      `The authority holds ${sol(balance)}; it needs about ${sol(configRent + 100_000n)} (config rent + fees).`,
    )

  console.log(`Quantum Hooks initialize_config${opts.yes ? '' : ' (dry run: nothing is signed or sent)'}
  RPC                  ${opts.rpc} (${isMainnet ? 'mainnet-beta' : `genesis ${genesis}`})
  program              ${programId.toBase58()}
  config account       ${configPda.toBase58()}
  authority (signer)   ${authority.publicKey.toBase58()} (${sol(balance)})
  upgrade authority    ${upgradeAuthority ?? (upgradeAuthority === null ? 'none' : 'unknown')}
  treasury             ${opts.treasury}
  keeper               ${keeper}${opts.keeper ? '' : ' (default: the authority; pass --keeper <pubkey of QUANTPAD_KEEPER_SECRET>)'}
  protocol_bps         ${opts.protocolBps} (${(opts.protocolBps / 100).toFixed(2)}% of every pulse)
  max_burn_lamports    ${opts.maxBurnLamports} (${sol(opts.maxBurnLamports)} per burn / fusion)
  min_action_interval  ${opts.minActionInterval} s
  keeper_grace         ${opts.keeperGrace} s`)
  for (const p of problems) console.log(`  ! ${p}`)

  if (!opts.yes) {
    console.log(
      problems.length
        ? '\nFix the problems above first.'
        : '\nLooks good. Re-run with --yes to send it.',
    )
    return problems.length ? 1 : 0
  }
  if (problems.length) {
    console.error('\nNot sent.')
    return 1
  }

  const ix = await quantum.buildInitializeConfigInstruction({
    connection,
    authority: authority.publicKey,
    treasury: opts.treasury,
    keeper,
    protocolBps: opts.protocolBps,
    maxBurnLamports: opts.maxBurnLamports,
    minActionInterval: opts.minActionInterval,
    keeperGrace: opts.keeperGrace,
    programId,
  })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: authority.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix],
    }).compileToV0Message(),
  )
  tx.sign([authority])
  const signature = await connection.sendTransaction(tx)
  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (result.value.err) {
    console.error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`)
    return 1
  }
  const config = await quantum.fetchConfig(connection, programId)
  console.log(`\nInitialised in ${signature}`)
  console.log(JSON.stringify(config, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // process.exit() while web3.js's sockets close can abort Node on Windows; let the loop drain
  // (the RPC websocket closes itself shortly after the last subscription).
  const done = (code) => {
    process.exitCode = code
    setTimeout(() => process.exit(code), 5000).unref()
  }
  main(process.argv.slice(2)).then(done, (e) => {
    console.error(e?.message ?? e)
    done(1)
  })
}
