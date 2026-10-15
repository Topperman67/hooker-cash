// Read-only smoke check for a Meteora program upgrade (written for DBC 0.2.2, mainnet 2026-10-16
// 03:00 UTC). It never signs or sends anything: it reads Meteora's program data, decodes a live
// Quantum coin's DBC pool and config with today's decoders, and simulates on mainnet the
// transactions Quant Pad depends on (a curve buy, sync, harvest, harvest + pulse, a keeper burn).
//
//   node scripts/meteora-upgrade-check.mjs --snapshot   save the DBC program and the coin's bytes
//   node scripts/meteora-upgrade-check.mjs              check (and diff against the snapshot)
//
// Options: --mint <base58> (default: the first Quantum coin listed by --app), --rpc <url>
// (default: public mainnet), --app <origin> (default: https://www.quantpad.company).
// Exit code 1 when any check fails. A simulation stopped by one of Quantum Hooks' own gates
// (TooSoon, NothingToPulse, ...) is reported as SKIP: the coin's state, not Meteora, refused it.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  DBC_PROGRAM_ID,
  PROGRESS,
  SWAP_MODE,
  decodeDbcConfig,
  decodeDbcPool,
  dbcSwapInstructions,
} from '../shared/meteora.mjs'
import {
  HARVEST,
  QUANTUM_IDL,
  QUANTUM_PROGRAM_ID,
  buildBurnInstructions,
  buildHarvestInstruction,
  buildPulseInstructions,
  buildSyncInstruction,
  fetchConfig,
  fetchQuantum,
} from '../shared/quantum.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT = path.join(root, '.quantpad-data', 'meteora-upgrade', 'snapshot.json')
// DBC 0.2.1's mainnet deploy slot (2026-09-09); a later ProgramData slot means a redeploy.
const DBC_021_SLOT = 445_503_633n
// An error string only the 0.2.2 build contains.
const DBC_022_MARKER = 'CreateConfig2'
const BUY_LAMPORTS = 10_000_000n
const BURN_LAMPORTS = 1_000_000n
const TRADE_BUDGET = 300_000
const KEEPER_BUDGET = 600_000
// Quantum Hooks errors that only mean "not now" for the coin as it stands (nothing to pulse, too
// soon since the last burn, ...), so they say nothing about the upgrade.
const GATES = new Set([
  'TooSoon',
  'NothingToPulse',
  'SpendTooHigh',
  'KeeperOnly',
  'Paused',
  'ZeroAmount',
])
const ERRORS = new Map(QUANTUM_IDL.errors.map((e) => [e.code, e.name]))

function args(argv) {
  const out = { snapshot: false, mint: null, rpc: null, app: 'https://www.quantpad.company' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--snapshot') out.snapshot = true
    else if (a === '--mint') out.mint = argv[++i]
    else if (a === '--rpc') out.rpc = argv[++i]
    else if (a === '--app') out.app = argv[++i]
    else throw new Error(`Unknown option ${a}`)
  }
  return out
}

const results = []
function report(status, name, detail = '') {
  results.push({ status, name })
  console.log(`${status.padEnd(4)}  ${name}${detail ? `  ${detail}` : ''}`)
}

async function firstQuantumMint(app) {
  const res = await fetch(`${app}/api/market?filter=quantum`)
  if (!res.ok) throw new Error(`${app}/api/market returned ${res.status}`)
  const { items } = await res.json()
  if (!items?.length) throw new Error('No Quantum coin is listed; pass --mint')
  return items[0].mint
}

/** The upgradeable loader's ProgramData for `program`: deploy slot, binary hash, 0.2.2 marker. */
async function programData(connection, program) {
  const info = await connection.getAccountInfo(program)
  if (!info) throw new Error(`${program.toBase58()} not found`)
  const address = new PublicKey(info.data.subarray(4, 36))
  const data = (await connection.getAccountInfo(address))?.data
  if (!data) throw new Error('DBC ProgramData not found')
  // UpgradeableLoaderState::ProgramData: u32 tag, u64 slot, Option<Pubkey> authority, then the ELF.
  const elf = data.subarray(45)
  return {
    address: address.toBase58(),
    slot: data.readBigUInt64LE(4),
    sha256: createHash('sha256').update(elf).digest('hex'),
    has022Marker: elf.includes(Buffer.from(DBC_022_MARKER)),
  }
}

function anchorError(sim) {
  for (const line of sim.logs ?? []) {
    const m = line.match(/Error Code: (\w+)\. Error Number: (\d+)/)
    if (m) return { name: m[1], code: Number(m[2]) }
  }
  const custom = sim.err?.InstructionError?.[1]?.Custom
  if (custom != null) return { name: ERRORS.get(custom) ?? `Custom(${custom})`, code: custom }
  return null
}

/** Simulates `instructions` paid by `payer` (signatures are not checked) and reports the result. */
async function simulate(connection, name, payer, instructions, budget) {
  try {
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: budget }), ...instructions],
    }).compileToV0Message()
    const { value: sim } = await connection.simulateTransaction(new VersionedTransaction(message), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    })
    const units = sim.unitsConsumed ?? 0
    const usage = `${units.toLocaleString('en-US')} / ${budget.toLocaleString('en-US')} CU`
    if (!sim.err) {
      const tight = units > budget * 0.8 ? '  (over 80% of the budget)' : ''
      return report('PASS', name, usage + tight)
    }
    const error = anchorError(sim)
    const quantumFailed = (sim.logs ?? []).some((l) =>
      l.startsWith(`Program ${QUANTUM_PROGRAM_ID.toBase58()} failed`),
    )
    if (error && quantumFailed && GATES.has(error.name))
      return report('SKIP', name, `stopped by Quantum Hooks gate ${error.name}, not by Meteora`)
    report('FAIL', name, `${error?.name ?? JSON.stringify(sim.err)}  ${usage}`)
    for (const line of (sim.logs ?? []).slice(-12)) console.log(`        ${line}`)
  } catch (err) {
    report('FAIL', name, err.message)
  }
}

async function main() {
  const opts = args(process.argv.slice(2))
  const connection = new Connection(opts.rpc ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
  const mint = opts.mint ?? (await firstQuantumMint(opts.app))
  const [program, quantum, config] = await Promise.all([
    programData(connection, DBC_PROGRAM_ID),
    fetchQuantum(connection, mint),
    fetchConfig(connection),
  ])
  if (!quantum) throw new Error(`${mint} is not a Quantum coin`)
  if (!config) throw new Error('Quantum Hooks config not found')
  const [poolInfo, configInfo] = await connection.getMultipleAccountsInfo([
    new PublicKey(quantum.dbcPool),
    new PublicKey(quantum.dbcConfig),
  ])
  console.log(`Coin ${mint}`)
  console.log(`DBC ProgramData slot ${program.slot}, binary sha256 ${program.sha256.slice(0, 16)}…`)

  if (opts.snapshot) {
    await mkdir(path.dirname(SNAPSHOT), { recursive: true })
    const snapshot = {
      takenAt: new Date().toISOString(),
      mint,
      program: { ...program, slot: program.slot.toString() },
      dbcPool: { address: quantum.dbcPool, data: poolInfo.data.toString('base64') },
      dbcConfig: { address: quantum.dbcConfig, data: configInfo.data.toString('base64') },
    }
    await writeFile(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(`Saved ${path.relative(root, SNAPSHOT)}`)
    return
  }

  const snapshot = await readFile(SNAPSHOT, 'utf8')
    .then(JSON.parse)
    .catch(() => null)
  const upgraded = program.slot > DBC_021_SLOT
  report(
    upgraded ? 'INFO' : 'WAIT',
    'DBC program upgrade',
    upgraded
      ? `redeployed at slot ${program.slot}${program.has022Marker ? ' (0.2.2 build)' : ' (no 0.2.2 marker: another build)'}`
      : `still the 0.2.1 build (slot ${program.slot}); rerun after the deploy`,
  )
  if (snapshot && snapshot.mint === mint)
    report(
      'INFO',
      'DBC binary vs snapshot',
      snapshot.program.sha256 === program.sha256 ? 'unchanged' : 'changed since the snapshot',
    )

  // Today's decoders must still read the live accounts.
  const pool = decodeDbcPool(poolInfo?.data)
  const dbcConfig = decodeDbcConfig(configInfo?.data)
  report(
    pool ? 'PASS' : 'FAIL',
    'Decode the DBC pool',
    pool ? `progress ${pool.migrationProgress}` : '',
  )
  report(
    dbcConfig ? 'PASS' : 'FAIL',
    'Decode the DBC config',
    dbcConfig ? `version ${dbcConfig.raw.version ?? '?'}` : '',
  )
  if (snapshot && snapshot.mint === mint) {
    const before = Buffer.from(snapshot.dbcConfig.data, 'base64')
    report(
      before.equals(configInfo.data) ? 'PASS' : 'FAIL',
      'DBC config bytes vs snapshot',
      before.equals(configInfo.data) ? 'identical' : 'differ: existing configs should not change',
    )
    const old = decodeDbcPool(Buffer.from(snapshot.dbcPool.data, 'base64'))
    const keys = ['config', 'creator', 'baseMint', 'baseVault', 'quoteVault']
    const moved = pool && old ? keys.filter((k) => pool[k] !== old[k]) : keys
    report(
      poolInfo.data.length === Buffer.from(snapshot.dbcPool.data, 'base64').length &&
        moved.length === 0
        ? 'PASS'
        : 'FAIL',
      'DBC pool layout vs snapshot',
      moved.length
        ? `changed: ${moved.join(', ')}`
        : `size ${poolInfo.data.length}, fixed fields equal`,
    )
  } else report('INFO', 'No snapshot for this coin', 'run with --snapshot before the upgrade')

  // The transactions Quant Pad sends, simulated with the keeper as payer (it holds SOL).
  const keeper = config.keeper
  if (pool?.migrationProgress === PROGRESS.PRE) {
    const buy = await dbcSwapInstructions({
      config: quantum.dbcConfig,
      mint,
      user: keeper,
      side: 'buy',
      amountIn: BUY_LAMPORTS,
      mode: SWAP_MODE.PARTIAL_FILL,
    })
    await simulate(connection, 'DBC buy, 0.01 SOL partial fill', keeper, buy, TRADE_BUDGET)
  } else report('INFO', 'DBC buy', 'skipped: the curve is not trading')
  await simulate(
    connection,
    'Quantum sync',
    keeper,
    [await buildSyncInstruction({ connection, mint })],
    KEEPER_BUDGET,
  )
  const harvest = await buildHarvestInstruction({
    connection,
    caller: keeper,
    mint,
    legs: HARVEST.ALL,
    quantum,
    pool,
  })
  await simulate(
    connection,
    'Quantum harvest (claims DBC creator fees)',
    keeper,
    [harvest],
    KEEPER_BUDGET,
  )
  await simulate(
    connection,
    'Quantum harvest + pulse',
    keeper,
    await buildPulseInstructions({ connection, payer: keeper, mint }),
    KEEPER_BUDGET,
  )
  if (quantum.burnReserve > 0n) {
    const spend = quantum.burnReserve < BURN_LAMPORTS ? quantum.burnReserve : BURN_LAMPORTS
    await simulate(
      connection,
      `Quantum burn by the keeper, ${spend} lamports`,
      keeper,
      await buildBurnInstructions({ connection, caller: keeper, mint, spendLamports: spend }),
      KEEPER_BUDGET,
    )
  } else report('INFO', 'Quantum burn', 'skipped: the burn reserve is empty')

  const failed = results.filter((r) => r.status === 'FAIL').length
  console.log(failed ? `\n${failed} check(s) failed.` : '\nNo failures.')
  process.exitCode = failed ? 1 : 0
}

main().catch((err) => {
  console.error(err.message)
  process.exitCode = 1
})
