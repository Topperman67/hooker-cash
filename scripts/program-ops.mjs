// Operator tool for the Quantum Hooks config authority: pause or resume the program
// (`set_paused`), cancel an Entanglement epoch before its claims open (`cancel_epoch`), change
// config values (`update_config`, pinned to the config version it was built on), and list a
// coin's epochs. Signs with a local keypair file, or prints the instruction for a multisig.
//
//   node scripts/program-ops.mjs --rpc <url> [action]
//        [--authority <keypair.json> | --authority-pubkey <base58>]
//        [--program-id <base58>] [--mainnet] [--yes]
//
// Actions (at most one; with none it prints the config):
//   --pause | --unpause            set_paused. A pause stops register, quantum_burn and fusion
//                                  (docs/QUANTUM_HOOKS_SPEC.md lists what keeps working). It takes
//                                  no expected version, so it always lands.
//   --cancel-epoch <mint> <index>  cancel_epoch, only before the epoch's claim_start: its total
//                                  returns to the coin's Entanglement reserve, its rent goes to
//                                  config.keeper.
//   --epochs <mint>                lists the coin's epochs and which can still be cancelled
//                                  (read-only).
//   update_config, any of:
//     --treasury <base58>  --keeper <base58>  --protocol-bps <0-1000>  --max-burn-sol <sol>
//     --min-action-interval <secs>  --keeper-grace <secs>  --claim-delay <0-604800>
//     --new-authority <base58>
//     [--expected-version <n>]     default: the config version read now. The update fails with
//                                  ConfigChanged if any other config change (a pause, another
//                                  update) lands before it.
//
// Without --yes it only prints what would change, checks it against the chain and simulates the
// transaction (read-only RPC calls), then exits: nothing is signed. --yes needs --authority (a
// keypair file). --authority-pubkey builds the same instruction for an authority whose key is not
// on this machine (a multisig) and prints it (program id, accounts, data) for a proposal; it never
// sends. Like init-config.mjs it refuses mainnet-beta RPC URLs, and any RPC whose genesis hash is
// mainnet-beta's, unless --mainnet is also passed.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  MAINNET_GENESIS_HASH,
  MAX_CLAIM_DELAY,
  isMainnetUrl,
  solToLamports,
} from './init-config.mjs'

export const USAGE =
  'Usage: node scripts/program-ops.mjs --rpc <url>\n' +
  '         [--pause | --unpause | --cancel-epoch <mint> <index> | --epochs <mint> |\n' +
  '          update_config fields: --treasury <base58> --keeper <base58> --protocol-bps <0-1000>\n' +
  '          --max-burn-sol <sol> --min-action-interval <secs> --keeper-grace <secs>\n' +
  '          --claim-delay <secs> --new-authority <base58> [--expected-version <n>]]\n' +
  '         [--authority <keypair.json> | --authority-pubkey <base58>]\n' +
  '         [--program-id <base58>] [--mainnet] [--yes]'

// update_config fields: flag -> [option name, parser]. Same bounds as init-config.mjs.
const UPDATE_FLAGS = {
  treasury: ['treasury', (v) => pubkeyArg('treasury', v)],
  keeper: ['keeper', (v) => pubkeyArg('keeper', v)],
  'protocol-bps': ['protocolBps', (v) => intArg('protocol-bps', v, 0, 1000)],
  'max-burn-sol': [
    'maxBurnLamports',
    (v) => {
      const out = solToLamports(v)
      if (out <= 0n) throw usageError('--max-burn-sol must be greater than 0')
      return out
    },
  ],
  'min-action-interval': ['minActionInterval', (v) => intArg('min-action-interval', v, 0, 2 ** 40)],
  'keeper-grace': ['keeperGrace', (v) => intArg('keeper-grace', v, 0, 2 ** 40)],
  'claim-delay': ['claimDelay', (v) => intArg('claim-delay', v, 0, MAX_CLAIM_DELAY)],
  'new-authority': ['newAuthority', (v) => pubkeyArg('new-authority', v)],
}
const VALUE_FLAGS = new Set([
  'rpc',
  'authority',
  'authority-pubkey',
  'program-id',
  'epochs',
  'expected-version',
  ...Object.keys(UPDATE_FLAGS),
])
const BOOLEAN_FLAGS = new Set(['pause', 'unpause', 'yes', 'mainnet', 'help'])
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DEFAULT_KEY = '11111111111111111111111111111111'
const SENDING_ACTIONS = new Set(['pause', 'unpause', 'cancel', 'update'])

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

/** Parses and validates the command line. Throws an error with `usage: true` on bad input. */
export function parseArgs(argv) {
  const raw = {}
  let cancel = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw usageError(`Unexpected argument ${arg}`)
    const name = arg.slice(2)
    if (name in raw || (name === 'cancel-epoch' && cancel))
      throw usageError(`--${name} is given twice`)
    if (BOOLEAN_FLAGS.has(name)) raw[name] = true
    else if (name === 'cancel-epoch') {
      const [mint, index] = [argv[i + 1], argv[i + 2]]
      if ([mint, index].some((v) => v === undefined || v.startsWith('--')))
        throw usageError('--cancel-epoch needs <mint> <index>')
      cancel = {
        mint: pubkeyArg('cancel-epoch', mint),
        index: intArg('cancel-epoch', index, 0, 2 ** 32 - 1),
      }
      i += 2
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw usageError(`--${name} needs a value`)
      raw[name] = value
    } else throw usageError(`Unknown option --${name}`)
  }
  if (raw.help) return { help: true }
  if (!raw.rpc) throw usageError('--rpc is required')
  let rpc
  try {
    rpc = new URL(raw.rpc)
  } catch {
    throw usageError('--rpc must be an http(s) URL')
  }
  if (!['http:', 'https:'].includes(rpc.protocol)) throw usageError('--rpc must be an http(s) URL')

  const changes = {}
  for (const [flag, [key, parse]] of Object.entries(UPDATE_FLAGS))
    if (raw[flag] !== undefined) changes[key] = parse(raw[flag])
  const actions = [
    raw.pause && 'pause',
    raw.unpause && 'unpause',
    cancel && 'cancel',
    raw.epochs !== undefined && 'epochs',
    Object.keys(changes).length > 0 && 'update',
  ].filter(Boolean)
  if (actions.length > 1)
    throw usageError(
      'Choose one action: --pause, --unpause, --cancel-epoch, --epochs or update_config fields',
    )
  const action = actions[0] ?? 'show'
  if (raw['expected-version'] !== undefined && action !== 'update')
    throw usageError('--expected-version goes with update_config fields')
  if (raw.authority !== undefined && raw['authority-pubkey'] !== undefined)
    throw usageError('Pass --authority or --authority-pubkey, not both')
  if (SENDING_ACTIONS.has(action) && !raw.authority && !raw['authority-pubkey'])
    throw usageError(
      '--authority <keypair.json> (or --authority-pubkey <base58> for a dry run) is required',
    )
  if (raw.yes && !SENDING_ACTIONS.has(action))
    throw usageError('--yes needs an action that sends a transaction')
  if (raw.yes && !raw.authority)
    throw usageError('--yes needs --authority <keypair.json>; --authority-pubkey only prints')

  return {
    rpc: raw.rpc,
    action,
    authorityFile: raw.authority ?? null,
    authorityPubkey:
      raw['authority-pubkey'] === undefined
        ? null
        : pubkeyArg('authority-pubkey', raw['authority-pubkey']),
    programId: raw['program-id'] === undefined ? null : pubkeyArg('program-id', raw['program-id']),
    mint: cancel?.mint ?? (raw.epochs === undefined ? null : pubkeyArg('epochs', raw.epochs)),
    index: cancel?.index ?? null,
    changes,
    expectedVersion:
      raw['expected-version'] === undefined
        ? null
        : intArg('expected-version', raw['expected-version'], 0, Number.MAX_SAFE_INTEGER),
    mainnet: !!raw.mainnet,
    yes: !!raw.yes,
  }
}

const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, '')} SOL`

/** `update_config` fields that `changes` would actually change: [field, from, to] rows. */
export function planUpdate(current, changes) {
  const fields = [
    ['treasury', 'treasury', 'treasury'],
    ['keeper', 'keeper', 'keeper'],
    ['protocol_bps', 'protocolBps', 'protocolBps'],
    ['max_burn_lamports', 'maxBurnLamports', 'maxBurnLamports'],
    ['min_action_interval', 'minActionInterval', 'minActionInterval'],
    ['keeper_grace', 'keeperGrace', 'keeperGrace'],
    ['claim_delay', 'claimDelay', 'claimDelay'],
    ['authority', 'authority', 'newAuthority'],
  ]
  const out = []
  for (const [label, from, to] of fields) {
    if (changes[to] === undefined) continue
    if (String(changes[to]) !== String(current[from])) out.push([label, current[from], changes[to]])
  }
  return out
}

/** "in 5 h 3 min" / "12 min ago" for unix seconds `at` seen from `now`. */
export function relative(at, now) {
  const d = Number(at) - Number(now)
  const s = Math.abs(d)
  const text =
    s < 60
      ? `${s} s`
      : s < 3600
        ? `${Math.floor(s / 60)} min`
        : s < 172_800
          ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
          : `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`
  return d >= 0 ? `in ${text}` : `${text} ago`
}

const iso = (secs) => new Date(Number(secs) * 1000).toISOString().replace('.000Z', 'Z')
const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

// Anchor's error log line, e.g. "... Error Code: ConfigChanged. Error Number: 6042. ...".
function programError(logs) {
  for (const line of logs ?? []) {
    const m = /Error Code: (\w+)\. Error Number: (\d+)/.exec(line)
    if (m) return `${m[1]} (${m[2]})`
  }
  return null
}

export async function main(argv, io = console) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    if (!e.usage) throw e
    io.error(`${e.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    io.log(USAGE)
    return 0
  }
  if (isMainnetUrl(opts.rpc) && !opts.mainnet) {
    io.error(
      `Refusing ${opts.rpc}: it looks like mainnet-beta. Pass --mainnet as well to operate the live program.`,
    )
    return 1
  }

  const {
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    SYSVAR_CLOCK_PUBKEY,
    TransactionMessage,
    VersionedTransaction,
  } = await import('@solana/web3.js')
  const quantum = await import('../shared/quantum.mjs')

  let signer = null
  if (opts.authorityFile) {
    try {
      signer = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(await readFile(opts.authorityFile, 'utf8'))),
      )
    } catch (e) {
      io.error(`Cannot read the authority keypair ${opts.authorityFile}: ${e.message}`)
      return 1
    }
  }
  const authority =
    signer?.publicKey ?? (opts.authorityPubkey && new PublicKey(opts.authorityPubkey))
  const programId = new PublicKey(opts.programId ?? quantum.QUANTUM_PROGRAM_ID)
  const connection = new Connection(opts.rpc, 'confirmed')

  const genesis = await connection.getGenesisHash()
  const isMainnet = genesis === MAINNET_GENESIS_HASH
  if (isMainnet && !opts.mainnet) {
    io.error(
      `Refusing ${opts.rpc}: its genesis hash is mainnet-beta's. Pass --mainnet as well to operate the live program.`,
    )
    return 1
  }

  const [config, clockInfo] = await Promise.all([
    quantum.fetchConfig(connection, programId),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
  ])
  const now = Number(clockInfo.data.readBigInt64LE(32))
  io.log(`Quantum Hooks ${opts.action === 'show' ? 'config' : opts.action}${SENDING_ACTIONS.has(opts.action) && !opts.yes ? ' (dry run: nothing is signed or sent)' : ''}
  RPC                  ${opts.rpc} (${isMainnet ? 'mainnet-beta' : `genesis ${genesis}`})
  program              ${programId.toBase58()}
  chain time           ${iso(now)}`)
  if (!config) {
    io.error(`  ! The config ${quantum.configPda(programId).toBase58()} is not initialised.`)
    return 1
  }
  io.log(`  config               v${config.version}, ${config.paused ? 'PAUSED' : 'not paused'}
  authority            ${config.authority}
  keeper               ${config.keeper}
  treasury             ${config.treasury}
  protocol_bps         ${config.protocolBps}
  max_burn_lamports    ${config.maxBurnLamports} (${sol(config.maxBurnLamports)}; public runs ${sol(quantum.publicSpendCap(config))})
  min_action_interval  ${config.minActionInterval} s
  keeper_grace         ${config.keeperGrace} s
  claim_delay          ${config.claimDelay} s`)
  if (opts.action === 'show') return 0
  if (opts.action === 'epochs')
    return listEpochs({ io, quantum, connection, programId, mint: opts.mint, now })

  const problems = []
  const notes = []
  if (authority.toBase58() !== config.authority)
    problems.push(
      `The config authority is ${config.authority}, not ${authority.toBase58()}; the program will reject this signer (NotAuthority).`,
    )
  let ix
  if (opts.action === 'pause' || opts.action === 'unpause') {
    const paused = opts.action === 'pause'
    io.log(`  set_paused           ${paused}`)
    if (config.paused === paused)
      notes.push(
        `The program is already ${paused ? 'paused' : 'running'}; this only bumps the config version.`,
      )
    notes.push(
      paused
        ? 'A pause stops register, quantum_burn and fusion. Pulses, Entanglement posts, claims, closes and cancels, lock and release keep working.'
        : 'Unpausing reopens register, quantum_burn and fusion.',
    )
    notes.push(
      `Every update_config built against v${config.version} will fail with ConfigChanged; rebuild it after this.`,
    )
    ix = await quantum.buildSetPausedInstruction({ connection, authority, paused, programId })
  } else if (opts.action === 'cancel') {
    const [coin, epoch] = await Promise.all([
      quantum.fetchQuantum(connection, opts.mint, programId),
      quantum.fetchEpoch(connection, opts.mint, opts.index, programId),
    ])
    io.log(`  cancel_epoch         coin ${opts.mint}, epoch ${opts.index}`)
    if (!coin) problems.push(`${opts.mint} is not a Quantum coin.`)
    else if (!epoch)
      problems.push(
        opts.index < coin.epochCount
          ? `Epoch ${opts.index} no longer exists (already cancelled or closed).`
          : `Epoch ${opts.index} was never posted (the coin has ${coin.epochCount}).`,
      )
    else {
      io.log(`  epoch total          ${epoch.total} (${sol(epoch.total)}), ${epoch.leafCount} leaves, ${epoch.claimed} claimed
  posted               ${iso(epoch.createdAt)} (${relative(epoch.createdAt, now)})
  claims open          ${iso(epoch.claimStart)} (${relative(epoch.claimStart, now)})
  rent goes to         ${config.keeper} (config.keeper)`)
      if (now >= epoch.claimStart)
        problems.push(
          'Its claims are already open, so it can no longer be cancelled (CancelWindowClosed).',
        )
      else
        notes.push(
          `Returns ${sol(epoch.total - epoch.claimed)} to the coin's Entanglement reserve. The coin's next epoch still waits until ${iso(quantum.nextEpochAt(coin))}.`,
        )
    }
    ix = await quantum.buildCancelEpochInstruction({
      connection,
      authority,
      mint: opts.mint,
      index: opts.index,
      keeper: config.keeper,
      programId,
    })
  } else {
    const rows = planUpdate(config, opts.changes)
    const expectedVersion = opts.expectedVersion ?? config.version
    io.log(`  update_config        expected_version ${expectedVersion}`)
    for (const [label, from, to] of rows)
      io.log(`    ${label.padEnd(19)}${String(from)} -> ${String(to)}`)
    if (!rows.length) problems.push('Nothing to change: every value given equals the current one.')
    if (expectedVersion !== config.version)
      problems.push(
        `The config is at v${config.version}; an update pinned to v${expectedVersion} fails with ConfigChanged.`,
      )
    if (rows.some(([label]) => label === 'keeper'))
      notes.push(
        'The old keeper key stops working for keeper-only actions; give the server the new one (QUANTPAD_KEEPER_SECRET).',
      )
    if (rows.some(([label]) => label === 'authority'))
      notes.push(
        `After this only ${opts.changes.newAuthority} can pause, cancel epochs or update the config.`,
      )
    if (rows.some(([label]) => label === 'claim_delay'))
      notes.push(
        'The new claim delay applies to epochs posted from now on; posted epochs keep their claim_start.',
      )
    ix = await quantum.buildUpdateConfigInstruction({
      connection,
      authority,
      programId,
      expectedVersion,
      ...opts.changes,
    })
  }

  const compile = (recentBlockhash) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: authority,
        recentBlockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix],
      }).compileToV0Message(),
    )
  const latest = await connection.getLatestBlockhash('confirmed')
  const sim = await connection.simulateTransaction(compile(latest.blockhash), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  })
  if (sim.value.err) {
    const named = programError(sim.value.logs)
    problems.push(`Simulation failed: ${named ?? JSON.stringify(sim.value.err)}.`)
  } else io.log(`  simulation           ok (${sim.value.unitsConsumed ?? '?'} compute units)`)
  for (const n of notes) io.log(`  - ${n}`)
  for (const p of problems) io.log(`  ! ${p}`)

  if (!signer) {
    io.log(`\nInstruction for a proposal (signer: ${authority.toBase58()}):`)
    io.log(
      json({
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((k) => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: Buffer.from(ix.data).toString('base64'),
      }),
    )
    return problems.length ? 1 : 0
  }
  if (!opts.yes) {
    io.log(
      problems.length
        ? '\nFix the problems above first.'
        : '\nLooks good. Re-run with --yes to send it.',
    )
    return problems.length ? 1 : 0
  }
  if (problems.length) {
    io.error('\nNot sent.')
    return 1
  }

  const tx = compile(latest.blockhash)
  tx.sign([signer])
  const signature = await connection.sendTransaction(tx)
  const result = await connection.confirmTransaction(
    { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    'confirmed',
  )
  if (result.value.err) {
    io.error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`)
    return 1
  }
  io.log(`\nSent in ${signature}`)
  if (opts.action === 'cancel') {
    const coin = await quantum.fetchQuantum(connection, opts.mint, programId)
    io.log(
      `Epoch ${opts.index} cancelled; entangle_reserve ${coin.entangleReserve}, entangle_owed ${coin.entangleOwed}.`,
    )
  } else io.log(json(await quantum.fetchConfig(connection, programId)))
  return 0
}

async function listEpochs({ io, quantum, connection, programId, mint, now }) {
  const coin = await quantum.fetchQuantum(connection, mint, programId)
  if (!coin) {
    io.error(`  ! ${mint} is not a Quantum coin.`)
    return 1
  }
  io.log(`  coin                 ${mint}
  entangle_reserve     ${coin.entangleReserve} (${sol(coin.entangleReserve)}), owed ${coin.entangleOwed}
  epochs posted        ${coin.epochCount}${coin.lastEpochAt ? `, last ${iso(coin.lastEpochAt)}, next allowed ${iso(quantum.nextEpochAt(coin))}` : ''}`)
  let gone = 0
  for (let start = 0; start < coin.epochCount; start += 100) {
    const indexes = []
    for (let i = start; i < Math.min(coin.epochCount, start + 100); i++) indexes.push(i)
    const infos = await connection.getMultipleAccountsInfo(
      indexes.map((i) => quantum.epochPda(mint, i, programId)),
    )
    infos.forEach((info, k) => {
      if (!quantum.isQuantumAccount(info, 'Epoch', programId)) {
        gone++
        return
      }
      const e = quantum.decodeEpoch(info.data)
      const status =
        now < e.claimStart
          ? `CANCELLABLE: claims open ${relative(e.claimStart, now)}`
          : now < e.expiresAt
            ? `claimable, expires ${relative(e.expiresAt, now)}`
            : 'expired (close_epoch)'
      io.log(
        `  #${indexes[k]}  ${sol(e.total)} (${e.claimed} claimed), ${e.leafCount} leaves, posted ${iso(e.createdAt)}: ${status}`,
      )
    })
  }
  if (gone) io.log(`  ${gone} earlier epoch(s) closed or cancelled`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // process.exit() while web3.js's sockets close can abort Node on Windows; let the loop drain.
  const done = (code) => {
    process.exitCode = code
    setTimeout(() => process.exit(code), 5000).unref()
  }
  main(process.argv.slice(2)).then(done, (e) => {
    console.error(e?.message ?? e)
    done(1)
  })
}
