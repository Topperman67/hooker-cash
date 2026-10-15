// End-to-end tests against solana-test-validator running mainnet's Meteora DBC and DAMM v2
// programs (dumped by tests/fixtures/fetch-fixtures.mjs, never built from source) plus
// quantum_hooks built with the `short-expiry` feature (epochs expire after 20 s and may be posted
// every 15 s). Started by tests/run-local.mjs.
import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import BN from 'bn.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as q from '../../../shared/quantum.mjs'
import * as m from '../../../shared/meteora.mjs'
import { launchConfigParameters } from '../../../shared/dbc-config.mjs'
import * as ops from '../../../scripts/program-ops.mjs'
import { buildEntanglementTree } from '../../../shared/merkle.mjs'

const rpcUrl = process.env.QH_RPC ?? 'http://127.0.0.1:8899'
const connection = new Connection(rpcUrl, 'confirmed')
const authorityFile =
  process.env.QH_AUTHORITY ?? new URL('./fixtures/.keys/authority.json', import.meta.url)
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(authorityFile, 'utf8'))),
)
const SPL = TOKEN_PROGRAM_ID
const SOL = BigInt(LAMPORTS_PER_SOL)
const RENT0 = 890_880n

// Test wallets (fresh every run; the validator is reset every run).
const keeper = Keypair.generate()
const treasury = Keypair.generate()
const launcher = Keypair.generate()
const partner = Keypair.generate() // creates the test DBC configs
const splitA = Keypair.generate() // funded
const splitB = Keypair.generate() // never funded: small shares must be deferred, not fail the pulse
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const whale = Keypair.generate()
const mintKp = Keypair.generate()
const mint = mintKp.publicKey
// Quant Pad's launch config as the tests create it: the production parameters with a 30 SOL
// threshold, no anti-sniper window and a 2% migration fee (so every harvest leg has something).
const dbcConfigKp = Keypair.generate()
const dbcConfig = dbcConfigKp.publicKey
const TEST_LAUNCH = { migrationQuoteThresholdSol: 30, antiSniper: null, migrationFeePercentage: 2 }
// A second, equally valid DBC config that is never allow-listed.
const strayConfigKp = Keypair.generate()

const CONFIG = {
  protocolBps: 500,
  maxBurnLamports: 2n * SOL,
  minActionInterval: 3,
  keeperGrace: 8,
  // Entanglement claims open 5 s after a post (the 20 s test epochs leave a 15 s claim window).
  claimDelay: 5,
}
// MIN_EPOCH_INTERVAL of the `short-expiry` build.
const TEST_EPOCH_INTERVAL = 15
const HOOKS = {
  creatorBps: 4000,
  burnBps: 2500,
  entangleBps: 2000,
  fusionBps: 1500,
  splits: [
    { wallet: splitA.publicKey.toBase58(), bps: 2500 },
    { wallet: splitB.publicKey.toBase58(), bps: 100 },
  ],
  lock: { bps: 5000, cliffSecs: 12, durationSecs: 70 },
}

// ------------------------------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const big = (v: any) => BigInt(v.toString())
const bal = async (key: PublicKey) => BigInt(await connection.getBalance(key, 'confirmed'))
async function tokenBalance(ata: PublicKey, program = SPL) {
  const info = await connection.getAccountInfo(ata, 'confirmed')
  return info ? unpackAccount(ata, info, program).amount : 0n
}
async function supply(mm = mint, program = SPL) {
  return unpackMint(mm, await connection.getAccountInfo(mm, 'confirmed'), program).supply
}
async function chainNow() {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  return Number(info!.data.readBigInt64LE(32))
}
async function waitForChainTime(ts: number) {
  while ((await chainNow()) < ts) await sleep(500)
}
async function airdrop(key: PublicKey, sol: number) {
  const sig = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL)
  const bh = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
}

type Sent = { sig: string; logs: string[]; events: any[]; size: number; cu: number; fee: bigint }
async function send(
  instructions: any[],
  signers: Keypair[],
  { cu = 400_000, luts = [] as any[] } = {},
): Promise<Sent> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  // Builders that already set a compute budget keep theirs.
  const budgeted = instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    // A random CU limit keeps retried-but-identical transactions from colliding on one blockhash.
    instructions: [
      ...(budgeted
        ? []
        : [ComputeBudgetProgram.setComputeUnitLimit({ units: cu + Math.floor(Math.random() * 5000) })]),
      ...instructions,
    ],
  }).compileToV0Message(luts)
  const tx = new VersionedTransaction(message)
  tx.sign(signers)
  const raw = tx.serialize()
  let sig: string
  try {
    sig = await connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' })
  } catch (e: any) {
    const logs: string[] =
      e.logs ?? (typeof e.getLogs === 'function' ? await e.getLogs(connection).catch(() => []) : [])
    const err: any = new Error(`${e.message}\n${(logs || []).join('\n')}`)
    err.logs = logs
    throw err
  }
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  const info = await connection.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  const logs = info?.meta?.logMessages ?? []
  if (res.value.err)
    throw new Error(`tx failed ${JSON.stringify(res.value.err)}\n${logs.join('\n')}`)
  return {
    sig,
    logs,
    events: q.decodeQuantumEvents(logs),
    size: raw.length,
    cu: info?.meta?.computeUnitsConsumed ?? 0,
    fee: BigInt(info?.meta?.fee ?? 0),
  }
}
// An address lookup table holding every non-signer, non-program key of `instructions` (the launch
// transaction does not fit 1232 bytes without one, exactly as in the browser launch flow).
async function lookupTableFor(instructions: any[], payer: Keypair) {
  const signers = new Set<string>()
  const keys = new Map<string, PublicKey>()
  for (const ix of instructions) {
    for (const k of ix.keys) {
      if (k.isSigner) signers.add(k.pubkey.toBase58())
      else keys.set(k.pubkey.toBase58(), k.pubkey)
    }
  }
  for (const s of signers) keys.delete(s)
  const recentSlot = await connection.getSlot('finalized')
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot,
  })
  await send([create], [payer])
  const list = [...keys.values()]
  for (let i = 0; i < list.length; i += 20)
    await send(
      [
        AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: table,
          addresses: list.slice(i, i + 20),
        }),
      ],
      [payer],
    )
  const slot = await connection.getSlot('confirmed')
  while ((await connection.getSlot('confirmed')) <= slot + 1) await sleep(200)
  return (await connection.getAddressLookupTable(table, { commitment: 'confirmed' })).value!
}

async function expectFail(p: Promise<any>, pattern: RegExp) {
  await assert.rejects(p, (e: any) => {
    assert.match(e.message, pattern)
    return true
  })
}
const event = (sent: Sent, name: string) => {
  const found = sent.events.find((e) => e.name === name)
  assert.ok(found, `expected ${name} event, got ${sent.events.map((e) => e.name).join(', ')}`)
  return found.data
}
const pct = (v: bigint, bps: number) => (v * BigInt(bps)) / 10_000n
const program = () => q.quantumProgram(connection)
const dbcClient = () => new DynamicBondingCurveClient(connection, 'confirmed')

// ---- Meteora helpers --------------------------------------------------------------------------

async function createDbcConfig(kp: Keypair, overrides = TEST_LAUNCH) {
  const tx = await dbcClient().partner.createConfig({
    config: kp.publicKey,
    feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey,
    quoteMint: NATIVE_MINT,
    payer: partner.publicKey,
    ...launchConfigParameters(overrides),
  })
  return send(tx.instructions, [partner, kp])
}
async function dbcPoolState(mm = mint) {
  return m.decodeDbcPool((await connection.getAccountInfo(m.dbcPoolPda(dbcConfig, mm)))?.data)!
}
async function dbcConfigState() {
  return m.decodeDbcConfig((await connection.getAccountInfo(dbcConfig))?.data)!
}
/** A trader buys on the DBC curve (`partial`: fill up to the threshold). */
async function curveBuy(user: Keypair, sol: number, mm = mint, { partial = false } = {}) {
  const ixs = await m.dbcSwapInstructions({
    config: dbcConfig,
    mint: mm,
    user: user.publicKey,
    side: 'buy',
    amountIn: BigInt(Math.round(sol * LAMPORTS_PER_SOL)),
    minOut: 0n,
    mode: partial ? m.SWAP_MODE.PARTIAL_FILL : m.SWAP_MODE.EXACT_IN,
  })
  return send(ixs, [user])
}
async function curveSell(user: Keypair, amount: bigint, mm = mint) {
  const ixs = await m.dbcSwapInstructions({
    config: dbcConfig,
    mint: mm,
    user: user.publicKey,
    side: 'sell',
    amountIn: amount,
  })
  return send(ixs, [user])
}
/** Fills the curve, then migrates it to DAMM v2 the way any keeper would (permissionless). */
async function graduate(mm: PublicKey, buyer: Keypair) {
  await curveBuy(buyer, 50, mm, { partial: true })
  const pool = await dbcPoolState(mm)
  assert.ok(pool.migrationProgress > m.PROGRESS.PRE, 'curve complete')
  const migration = await m.dbcMigrationInstructions({
    connection,
    payer: buyer.publicKey,
    dbcPool: m.dbcPoolPda(dbcConfig, mm),
  })
  return send(migration.instructions, [buyer, ...migration.signers], { cu: 1_400_000 })
}
async function dammState(mm = mint) {
  const config = await dbcConfigState()
  const pool = m.migratedPoolFor(config, mm)
  return { pool, damm: m.decodeDammPool((await connection.getAccountInfo(pool))?.data)! }
}
async function poolBuys(mm: PublicKey, buyers: Keypair[], lamports: bigint) {
  const { pool, damm } = await dammState(mm)
  for (const t of buyers)
    await send(
      await m.dammSwapInstructions({ damm, dammPool: pool, mint: mm, user: t.publicKey, side: 'buy', amountIn: lamports }),
      [t],
    )
}

// ------------------------------------------------------------------------------------------------
describe('quantum_hooks on a local validator with mainnet Meteora DBC and DAMM v2', () => {
  let lockAmount = 0n
  let devBuyTokens = 0n
  let lockStart = 0

  before(async () => {
    for (const k of [authority, keeper, treasury, launcher, partner, splitA, ...traders])
      await airdrop(k.publicKey, 50)
    await airdrop(whale.publicKey, 200)
    await airdrop(whale.publicKey, 200)
    await createDbcConfig(dbcConfigKp)
    await createDbcConfig(strayConfigKp)
  })

  test('initialize_config: only the upgrade authority, once', async () => {
    const asKeeper = await q.buildInitializeConfigInstruction({
      connection,
      authority: keeper.publicKey,
      treasury: treasury.publicKey,
      keeper: keeper.publicKey,
      ...CONFIG,
    })
    await expectFail(send([asKeeper], [keeper]), /NotUpgradeAuthority/)
    const ix = await q.buildInitializeConfigInstruction({
      connection,
      authority: authority.publicKey,
      treasury: treasury.publicKey,
      keeper: keeper.publicKey,
      ...CONFIG,
    })
    const sent = await send([ix], [authority])
    event(sent, 'ConfigUpdated')
    const config = await q.fetchConfig(connection)
    assert.deepEqual(
      { ...config, bump: undefined },
      {
        authority: authority.publicKey.toBase58(),
        treasury: treasury.publicKey.toBase58(),
        keeper: keeper.publicKey.toBase58(),
        protocolBps: 500,
        maxBurnLamports: 2n * SOL,
        minActionInterval: 3,
        keeperGrace: 8,
        paused: false,
        bump: undefined,
        claimDelay: CONFIG.claimDelay,
        version: 0,
        launchConfigs: [],
      },
    )
    const again = await q.buildInitializeConfigInstruction({
      connection,
      authority: authority.publicKey,
      treasury: keeper.publicKey,
      keeper: keeper.publicKey,
      ...CONFIG,
    })
    await expectFail(send([again], [authority]), /already in use|custom program error: 0x0/)
  })

  test('update_config: authority only, protocol_bps capped at 1000', async () => {
    const asKeeper = await q.buildUpdateConfigInstruction({
      connection,
      authority: keeper.publicKey,
      protocolBps: 100,
    })
    await expectFail(send([asKeeper], [keeper]), /NotAuthority/)
    const tooHigh = await q.buildUpdateConfigInstruction({
      connection,
      authority: authority.publicKey,
      protocolBps: 1001,
    })
    await expectFail(send([tooHigh], [authority]), /ProtocolBpsTooHigh/)
    const same = await q.buildUpdateConfigInstruction({
      connection,
      authority: authority.publicKey,
      protocolBps: 500,
    })
    await send([same], [authority])
    assert.equal((await q.fetchConfig(connection)).version, 1)
    // claim_delay is bounded to 7 days.
    const tooLong = await q.buildUpdateConfigInstruction({
      connection,
      authority: authority.publicKey,
      claimDelay: q.MAX_CLAIM_DELAY + 1,
    })
    await expectFail(send([tooLong], [authority]), /InvalidConfig/)
  })

  test('update_config prepared before a set_paused fails (stale expected_version) and cannot unpause', async () => {
    const before = await q.fetchConfig(connection)
    // Drafted while unpaused: a treasury change.
    const drafted = await q.buildUpdateConfigInstruction({
      connection,
      authority: authority.publicKey,
      treasury: keeper.publicKey,
    })
    // Only the authority can pause.
    await expectFail(
      send(
        [
          await q.buildSetPausedInstruction({
            connection,
            authority: keeper.publicKey,
            paused: true,
          }),
        ],
        [keeper],
      ),
      /NotAuthority/,
    )
    const paused = await send(
      [
        await q.buildSetPausedInstruction({
          connection,
          authority: authority.publicKey,
          paused: true,
        }),
      ],
      [authority],
    )
    assert.equal(event(paused, 'ConfigUpdated').version, BigInt(before.version + 1))
    // The drafted update lands after the pause: refused, the pause and the treasury stand.
    await expectFail(send([drafted], [authority]), /ConfigChanged/)
    let config = await q.fetchConfig(connection)
    assert.equal(config.paused, true)
    assert.equal(config.treasury, treasury.publicKey.toBase58())
    assert.equal(config.version, before.version + 1)
    // An update built on the current version works and leaves the pause alone.
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          keeperGrace: CONFIG.keeperGrace,
        }),
      ],
      [authority],
    )
    config = await q.fetchConfig(connection)
    assert.equal(config.paused, true)
    assert.equal(config.version, before.version + 2)
    await assert.rejects(
      q.buildUpdateConfigInstruction({ connection, authority: authority.publicKey, paused: false }),
      /buildSetPausedInstruction/,
    )
    await send(
      [
        await q.buildSetPausedInstruction({
          connection,
          authority: authority.publicKey,
          paused: false,
        }),
      ],
      [authority],
    )
    config = await q.fetchConfig(connection)
    assert.equal(config.paused, false)
    assert.equal(config.version, before.version + 3)
  })

  test('set_launch_configs: authority only, versioned, at most 4 distinct configs', async () => {
    const ix = (signer: PublicKey, configs: PublicKey[], expectedVersion?: number) =>
      q.buildSetLaunchConfigsInstruction({ connection, authority: signer, configs, expectedVersion })
    await expectFail(send([await ix(keeper.publicKey, [dbcConfig])], [keeper]), /NotAuthority/)
    const five = Array.from({ length: 5 }, () => Keypair.generate().publicKey)
    await expectFail(send([await ix(authority.publicKey, five)], [authority]), /InvalidLaunchConfigs/)
    await expectFail(
      send([await ix(authority.publicKey, [dbcConfig, dbcConfig])], [authority]),
      /InvalidLaunchConfigs/,
    )
    const v = (await q.fetchConfig(connection)).version
    await expectFail(send([await ix(authority.publicKey, [dbcConfig], v - 1)], [authority]), /ConfigChanged/)
    const sent = await send([await ix(authority.publicKey, [dbcConfig])], [authority])
    assert.deepEqual(event(sent, 'LaunchConfigsSet').configs, [dbcConfig.toBase58()])
    const config = await q.fetchConfig(connection)
    assert.deepEqual(config.launchConfigs, [dbcConfig.toBase58()])
    assert.equal(config.version, v + 1)
  })

  test('quantum launch: register, then DBC create + creator → well + sync + dev buy in one transaction, then lock', async () => {
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint,
      name: 'Quantum Test',
      symbol: 'QTEST',
      uri: 'https://example.invalid/qtest.json',
      hooks: HOOKS,
      devBuy: { solLamports: 1n * SOL, slippagePct: 1 },
      dbcConfig,
    })
    devBuyTokens = built.devBuyTokens
    lockAmount = built.lockAmount
    assert.ok(devBuyTokens > 0n)
    assert.equal(lockAmount, (devBuyTokens * 5000n) / 10_000n)
    assert.ok(built.dbcPool.equals(m.dbcPoolPda(dbcConfig, mint)))

    const a = await send(built.stages.register, [launcher, mintKp])
    const registered = event(a, 'Registered')
    assert.equal(registered.mint, mint.toBase58())
    assert.equal(registered.wellFunded, RENT0)
    assert.equal(registered.dbcPool, built.dbcPool.toBase58())
    const b = await send(built.stages.launch, [launcher, mintKp], {
      cu: 600_000,
      luts: [await lookupTableFor(built.stages.launch, launcher)],
    })
    const synced = event(b, 'Synced')
    assert.equal(synced.birthBound, true, 'bound before the first trade')
    const c = await send(built.stages.lock, [launcher])
    const locked = event(c, 'Locked')
    assert.equal(locked.amount, lockAmount)
    lockStart = Number(locked.lockStart)
    console.log(
      `    tx sizes: register ${a.size} B, create+bind+buy ${b.size} B (lookup table), lock ${c.size} B; CU ${a.cu}/${b.cu}/${c.cu}`,
    )

    const well = q.wellPda(mint)
    const pool = await dbcPoolState()
    assert.equal(pool.creator, well.toBase58(), 'the DBC pool creator is the well')
    assert.ok(pool.hasSwap, 'the dev buy traded')
    // The dev buy was the first swap in the create's transaction: DBC charged its minimum fee.
    assert.ok(pool.creatorQuoteFee > 0n)
    assert.equal(await bal(well), RENT0)
    const launcherAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, true, SPL)
    assert.equal(await tokenBalance(launcherAta), devBuyTokens - lockAmount, 'exactly the quoted tokens')
    assert.equal(await tokenBalance(q.lockAta(mint)), lockAmount)
    assert.equal(await supply(), 1_000_000_000_000_000n, 'fixed 1 B supply, 6 decimals')

    const quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.launcher, launcher.publicKey.toBase58())
    assert.equal(quantum.dbcConfig, dbcConfig.toBase58())
    assert.equal(quantum.dbcPool, built.dbcPool.toBase58())
    assert.ok(quantum.boundAt > 0)
    assert.equal(quantum.birthBound, true)
    assert.equal(quantum.dammPool, null)
    assert.deepEqual(
      [quantum.creatorBps, quantum.burnBps, quantum.entangleBps, quantum.fusionBps],
      [4000, 2500, 2000, 1500],
    )
    assert.deepEqual(quantum.splits, HOOKS.splits)
    assert.equal(quantum.lockedAmount, lockAmount)
    assert.equal(quantum.lockCliff - quantum.lockStart, 12)
    assert.equal(quantum.lockEnd - quantum.lockStart, 70)
    assert.equal(quantum.lastBurnAt, quantum.createdAt)
    assert.deepEqual(await q.verifyQuantumCoin(connection, mint), {
      registered: true,
      poolExists: true,
      creatorIsWell: true,
      complete: false,
      migrated: false,
      bound: true,
      birthBound: true,
    })
  })

  test('register is rejected for an existing mint, without the mint signature, for a funded mint, a config not on the allow-list, and bad hooks', async () => {
    const registerIx = async (mm: PublicKey, hooks: any = { ...HOOKS, lock: null }, config = dbcConfig) =>
      (
        await q.buildQuantumLaunchInstructions({
          connection,
          launcher: launcher.publicKey,
          mint: mm,
          name: 'X',
          symbol: 'X',
          uri: 'https://example.invalid/x.json',
          hooks,
          dbcConfig: config,
        })
      ).stages.register[0]
    // Same mint again: the Quantum account exists and the mint is no longer empty.
    await expectFail(
      send([await registerIx(mint)], [launcher, mintKp]),
      /already in use|MintNotFresh|0x0/,
    )
    // Fresh mint without its signature.
    const other = Keypair.generate()
    const unsigned = await registerIx(other.publicKey)
    unsigned.keys = unsigned.keys.map((k: any) =>
      k.pubkey.equals(other.publicKey) ? { ...k, isSigner: false } : k,
    )
    await expectFail(send([unsigned], [launcher]), /AccountNotSigner/)
    // A mint address that already holds lamports is not a fresh keypair.
    const funded = Keypair.generate()
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: launcher.publicKey,
          toPubkey: funded.publicKey,
          lamports: 1_000_000,
        }),
      ],
      [launcher],
    )
    await expectFail(send([await registerIx(funded.publicKey)], [launcher, funded]), /MintNotFresh/)
    // A real DBC config Quant Pad never allow-listed, and an account that is not a DBC config.
    const stray = Keypair.generate()
    await expectFail(
      send([await registerIx(stray.publicKey, undefined, strayConfigKp.publicKey)], [launcher, stray]),
      /LaunchConfigNotAllowed/,
    )
    const rawRegister = (mm: PublicKey, params: any, config = dbcConfig) =>
      program()
        .methods.register(params)
        .accountsStrict({
          launcher: launcher.publicKey,
          mint: mm,
          config: q.configPda(),
          quantum: q.quantumPda(mm),
          well: q.wellPda(mm),
          dbcConfig: config,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    const bad = Keypair.generate()
    const plain = { creatorBps: 10000, burnBps: 0, entangleBps: 0, fusionBps: 0, splits: [], lock: null }
    await expectFail(send([await rawRegister(bad.publicKey, plain, launcher.publicKey)], [launcher, bad]), /LaunchConfigNotAllowed/)
    // Validation errors come from the program too (bypass the client-side check).
    await expectFail(
      send(
        [await rawRegister(bad.publicKey, { ...plain, creatorBps: 5000, burnBps: 2000, entangleBps: 2000, fusionBps: 999 })],
        [launcher, bad],
      ),
      /InvalidAllocation/,
    )
    await expectFail(
      send(
        [
          await rawRegister(bad.publicKey, {
            ...plain,
            splits: [
              { wallet: splitA.publicKey, bps: 100 },
              { wallet: splitA.publicKey, bps: 100 },
            ],
            lock: { cliffSecs: new BN(10), durationSecs: new BN(5) },
          }),
        ],
        [launcher, bad],
      ),
      /InvalidSplitWallet|InvalidLockTerms/,
    )
    // Keys the runtime always makes read-only (sysvars, builtin programs) and programs could
    // never be paid by `pulse`: the program and the client refuse them as split wallets.
    for (const reserved of [
      new PublicKey('SysvarRent111111111111111111111111111111111'),
      new PublicKey('Vote111111111111111111111111111111111111111'),
      new PublicKey('ComputeBudget111111111111111111111111111111'),
      q.QUANTUM_PROGRAM_ID,
      m.DBC_PROGRAM_ID,
      m.DAMM_V2_PROGRAM_ID,
    ]) {
      const ix = await rawRegister(bad.publicKey, { ...plain, splits: [{ wallet: reserved, bps: 100 }] })
      await expectFail(send([ix], [launcher, bad]), /InvalidSplitWallet/)
      assert.throws(
        () => q.validateHooks({ creatorBps: 10000, splits: [{ wallet: reserved.toBase58(), bps: 100 }] }),
        /cannot be a split wallet/,
      )
    }
  })

  test('a creator handed to the well after the first trade is bound, but not birth-bound', async () => {
    const late = Keypair.generate()
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint: late.publicKey,
      name: 'Late',
      symbol: 'LATE',
      uri: 'https://example.invalid/late.json',
      hooks: { ...HOOKS, lock: null },
      dbcConfig,
    })
    await send(built.stages.register, [launcher, late])
    // create only (launcher stays creator), then a trade, then the transfer + sync
    const [create, transfer, sync] = built.stages.launch
    await send([create], [launcher, late], { cu: 300_000 })
    // sync refuses to record a binding that has not happened
    await expectFail(send([sync], [launcher]), /NotBound/)
    await curveBuy(traders[1], 0.2, late.publicKey)
    const sent = await send([transfer, sync], [launcher])
    assert.equal(event(sent, 'Synced').birthBound, false)
    const quantum = await q.fetchQuantum(connection, late.publicKey)
    assert.ok(quantum.boundAt > 0)
    assert.equal(quantum.birthBound, false)
  })

  test('release before the cliff fails; only the launcher may release', async () => {
    const ix = await q.buildReleaseInstruction({ connection, launcher: launcher.publicKey, mint })
    await expectFail(send([ix], [launcher]), /NothingToRelease/)
    const stranger = traders[0]
    const theirs = await q.buildReleaseInstruction({
      connection,
      launcher: stranger.publicKey,
      mint,
    })
    await expectFail(
      send([theirs], [stranger]),
      /NotLauncher|ConstraintHasOne|ConstraintTokenOwner|AccountNotInitialized/,
    )
  })

  test('trades from other wallets accrue creator fees for the well', async () => {
    const before = await q.pendingCreatorFees(connection, mint)
    for (const t of traders) await curveBuy(t, 0.8)
    const ata = getAssociatedTokenAddressSync(mint, traders[0].publicKey, true, SPL)
    await curveSell(traders[0], (await tokenBalance(ata)) / 3n)
    const after = await q.pendingCreatorFees(connection, mint)
    console.log(`    pending creator fees ${before} -> ${after} lamports`)
    // 1% fee, 80% of it to the creator side: ~0.0019 SOL per 0.24 SOL traded
    assert.ok(after > before + 10_000_000n, 'at least 0.01 SOL of creator fees accrued')
    assert.ok((await dbcPoolState()).creatorQuoteFee > 0n)
  })

  test('harvest + pulse: claims the DBC creator fee and splits it with protocol cut, Superposition, deferral and rounding', async () => {
    const well = q.wellPda(mint)
    const wrongOrder = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    const pulseIx = wrongOrder[wrongOrder.length - 1]
    const n = pulseIx.keys.length
    ;[pulseIx.keys[n - 1], pulseIx.keys[n - 2]] = [pulseIx.keys[n - 2], pulseIx.keys[n - 1]]
    await expectFail(send(wrongOrder, [keeper]), /SplitAccountsMismatch/)

    const q0 = await q.fetchQuantum(connection, mint)
    const fee0 = (await dbcPoolState()).creatorQuoteFee
    const balances0 = await Promise.all(
      [treasury, splitA, splitB, launcher].map((k) => bal(k.publicKey)),
    )
    const keeper0 = await bal(keeper.publicKey)
    const ixs = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    const sent = await send(ixs, [keeper])
    const harvested = event(sent, 'Harvested')
    assert.equal(harvested.legs, q.HARVEST.TRADING_FEE, 'only the trading-fee leg has work before completion')
    assert.equal(harvested.claimed, fee0, 'the whole DBC creator fee, as SOL')
    assert.equal(harvested.rentRefunded, q.RENT_EXEMPT_TOKEN_ACCOUNT, 'WSOL account rent back to the caller')
    assert.equal(harvested.tokensBurned, 0n)
    // The keeper paid the fee and the well's coin ATA (created once); the WSOL account's rent came back.
    assert.equal(keeper0 - (await bal(keeper.publicKey)), sent.fee + q.RENT_EXEMPT_TOKEN_ACCOUNT)
    assert.equal((await dbcPoolState()).creatorQuoteFee, 0n)
    const pulsed = event(sent, 'Pulsed')
    console.log(`    harvest+pulse tx ${sent.size} B, ${sent.cu} CU, collected ${pulsed.collected}`)
    const available = pulsed.collected
    assert.equal(available, fee0, 'everything harvested is allocated')
    const protocol = pct(available, 500)
    const net = available - protocol
    const burn = pct(net, 2500),
      entangle = pct(net, 2000),
      fusion = pct(net, 1500)
    const slice = net - burn - entangle - fusion
    const a = pct(slice, 2500),
      b = pct(slice, 100)
    const launcherShare = slice - a - b
    assert.equal(pulsed.protocol, protocol)
    assert.equal(pulsed.burnAdded, burn)
    assert.equal(pulsed.entangleAdded, entangle)
    assert.equal(pulsed.fusionAdded, fusion)
    // splitB holds no lamports: a share below the rent minimum is owed to it, never re-split.
    assert.ok(b < RENT0, `expected splitB's share (${b}) below the rent minimum so deferral is exercised`)
    assert.equal(pulsed.splitsPaid, a)
    assert.equal(pulsed.deferred, b)
    assert.equal(pulsed.owedPaid, 0n)
    assert.equal(pulsed.launcherPaid, launcherShare)
    assert.equal(protocol + burn + entangle + fusion + a + b + launcherShare, available, 'rounding is absorbed exactly')

    const balances1 = await Promise.all(
      [treasury, splitA, splitB, launcher].map((k) => bal(k.publicKey)),
    )
    assert.equal(balances1[0] - balances0[0], protocol)
    assert.equal(balances1[1] - balances0[1], a)
    assert.equal(balances1[2] - balances0[2], 0n)
    assert.equal(balances1[3] - balances0[3], launcherShare)

    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.burnReserve - q0.burnReserve, burn)
    assert.equal(q1.entangleReserve - q0.entangleReserve, entangle)
    assert.equal(q1.fusionReserve - q0.fusionReserve, fusion)
    assert.equal(q1.totalProtocol, protocol)
    assert.equal(q1.totalHarvested, fee0)
    assert.deepEqual(q1.splitOwed, [0n, b], "splitB's share is owed to it")
    assert.equal(q1.totalCollected, available, 'an owed share counts as collected once')
    const wellBalance = await q.fetchWellBalance(connection, mint)
    assert.equal(
      wellBalance.lamports,
      RENT0 + q1.burnReserve + q1.entangleReserve + q1.entangleOwed + q1.fusionReserve + pulsed.deferred,
    )
    assert.equal(await bal(well), wellBalance.lamports)

    // Nothing new, and splitB still cannot hold what it is owed → NothingToPulse (a harvest with
    // nothing to claim succeeds, the pulse after it fails).
    const again = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    await expectFail(send(again, [keeper]), /NothingToPulse/)
  })

  test('a deferred split is paid its full owed share once its wallet can hold it, without new fees', async () => {
    const q0 = await q.fetchQuantum(connection, mint)
    const owed = q0.splitOwed[1]
    assert.ok(owed > 0n && owed < RENT0, `splitB owed ${owed}`)
    await airdrop(splitB.publicKey, 1)
    const b0 = await bal(splitB.publicKey)
    const treasury0 = await bal(treasury.publicKey)
    // Anyone may pulse: below the 0.001 SOL floor it allocates nothing new, only pays what is owed.
    const stranger = traders[2]
    const sent = await send(
      await q.buildPulseInstructions({ connection, payer: stranger.publicKey, mint }),
      [stranger],
    )
    const pulsed = event(sent, 'Pulsed')
    assert.equal(pulsed.collected, 0n)
    assert.equal(pulsed.owedPaid, owed)
    assert.equal(pulsed.splitsPaid, owed)
    assert.equal(pulsed.deferred, 0n)
    assert.equal(await bal(splitB.publicKey), b0 + owed, 'splitB received its whole share')
    assert.equal(await bal(treasury.publicKey), treasury0, 'no second protocol cut')
    const q1 = await q.fetchQuantum(connection, mint)
    assert.deepEqual(q1.splitOwed, [0n, 0n])
    assert.equal(q1.totalCreatorPaid, q0.totalCreatorPaid + owed)
    assert.equal(q1.totalCollected, q0.totalCollected)
    await expectFail(
      send(await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint }), [keeper]),
      /NothingToPulse/,
    )
  })

  test('quantum_burn on the DBC curve: venue pinned, caps, keeper gating and grace, public runs stand alone', async () => {
    // more fees, so the burn reserve can pay for several burns
    for (let i = 0; i < 4; i++) await curveBuy(whale, 4)
    await send(await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint }), [keeper])
    let quantum = await q.fetchQuantum(connection, mint)
    assert.ok(quantum.burnReserve > 1_000_000n, `burn reserve ${quantum.burnReserve}`)
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    const spend = quantum.burnReserve / 4n

    // More than the reserve, or than the cap.
    const tooMuch = await q.buildBurnInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: quantum.burnReserve + 1n })
    await expectFail(send(tooMuch, [keeper]), /SpendTooHigh/)
    // The venue accounts must be the coin's own: another coin's pool is refused.
    const [burnIx] = await q.buildBurnInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: spend })
    const other = Keypair.generate()
    const otherBuilt = await q.buildStandardLaunchInstructions({
      connection,
      launcher: traders[2].publicKey,
      mint: other.publicKey,
      name: 'Other',
      symbol: 'OTHR',
      uri: 'https://example.invalid/o.json',
      dbcConfig,
    })
    await send(otherBuilt.instructions, [traders[2], other], { cu: 400_000 })
    const otherPool = m.dbcPoolPda(dbcConfig, other.publicKey)
    const swapped = { ...burnIx, keys: burnIx.keys.map((k: any) => (k.pubkey.equals(m.dbcPoolPda(dbcConfig, mint)) ? { ...k, pubkey: otherPool } : k)) }
    await expectFail(send([swapped], [keeper]), /NotCanonicalPool/)

    // The keeper's burn: tokens bought and burned, spent ≤ spend.
    const supply0 = await supply()
    const sent = await send([burnIx], [keeper])
    const burned = event(sent, 'Burned')
    console.log(`    DBC burn ${sent.size} B, ${sent.cu} CU: spent ${burned.spent}, burned ${burned.tokensBurned}`)
    assert.equal(burned.venue, 0)
    assert.ok(burned.spent > 0n && burned.spent <= spend)
    assert.ok(burned.tokensBurned > 0n)
    assert.equal(await supply(), supply0 - burned.tokensBurned)
    quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.totalBurnSol, burned.spent)
    // Again too soon.
    await expectFail(
      send(await q.buildBurnInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: spend }), [keeper]),
      /TooSoon/,
    )
    // Only the keeper may burn until the grace has passed.
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    assert.ok((await chainNow()) <= quantum.lastBurnAt + CONFIG.keeperGrace, 'still inside the grace')
    const asStranger = await q.buildBurnInstructions({ connection, caller: traders[1].publicKey, mint, spendLamports: spend })
    await expectFail(send(asStranger, [traders[1]]), /KeeperOnly/)
    // After the grace anyone may burn, up to a tenth of the cap, alone in its transaction.
    await waitForChainTime(quantum.lastBurnAt + CONFIG.keeperGrace + 1)
    const pub = await q.buildBurnInstructions({ connection, caller: traders[1].publicKey, mint, spendLamports: spend })
    const sandwich = await m.dbcSwapInstructions({ config: dbcConfig, mint, user: traders[1].publicKey, side: 'buy', amountIn: 1_000_000n })
    await expectFail(send([...sandwich, ...pub], [traders[1]]), /PublicTransactionNotAllowed/)
    const capped = await q.buildBurnInstructions({ connection, caller: traders[1].publicKey, mint, spendLamports: q.publicSpendCap(await q.fetchConfig(connection)) + 1n })
    await expectFail(send(capped, [traders[1]]), /SpendTooHigh/)
    const ok = await send(pub, [traders[1]])
    assert.equal(event(ok, 'Burned').caller, traders[1].publicKey.toBase58())
  })

  test('entanglement: post, claims closed until claim_start, one epoch per interval, claim with proofs, double claim / bad proofs rejected, close after expiry', async () => {
    const q0 = await q.fetchQuantum(connection, mint)
    const reserve = q0.entangleReserve
    assert.ok(reserve > 3000n)
    const entries = traders.map((t, i) => ({
      wallet: t.publicKey.toBase58(),
      amount: ((reserve / 4n) * BigInt(i + 1)) / 2n,
    }))
    const tree = buildEntanglementTree(entries)
    assert.ok(tree.total <= reserve)
    const args = {
      connection,
      mint,
      index: q0.epochCount,
      root: tree.root,
      total: tree.total,
      leafCount: entries.length,
    }
    await expectFail(
      send(
        [await q.buildPostEpochInstruction({ ...args, keeper: traders[0].publicKey })],
        [traders[0]],
      ),
      /KeeperOnly/,
    )
    const tooMuch = await q.buildPostEpochInstruction({
      ...args,
      keeper: keeper.publicKey,
      total: reserve + 1n,
    })
    await expectFail(send([tooMuch], [keeper]), /InsufficientEntangleReserve/)
    const posted = await send(
      [await q.buildPostEpochInstruction({ ...args, keeper: keeper.publicKey })],
      [keeper],
    )
    const ev = event(posted, 'EpochPosted')
    assert.equal(ev.index, 0)
    assert.deepEqual(Uint8Array.from(ev.root), tree.root)
    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.entangleOwed, tree.total)
    assert.equal(q1.entangleReserve, reserve - tree.total)
    const posted0 = await q.fetchEpoch(connection, mint, 0)
    assert.equal(posted0.claimStart, posted0.createdAt + CONFIG.claimDelay)
    assert.equal(ev.claimStart, BigInt(posted0.claimStart))
    assert.equal(posted0.expiresAt, posted0.createdAt + 20, 'short-expiry build')
    assert.equal(q1.lastEpochAt, posted0.createdAt)

    const claim = (
      i: number,
      who = traders[i],
      amount = entries[i].amount,
      proof = tree.proof(i),
    ) =>
      q.buildClaimInstruction({
        connection,
        claimant: who.publicKey,
        mint,
        index: 0,
        leafIndex: i,
        amount,
        proof,
      })
    // Claims stay closed for claim_delay after the post (the authority's cancel window).
    await expectFail(send([await claim(0)], [traders[0]]), /ClaimNotOpen/)
    // One epoch per MIN_EPOCH_INTERVAL: a second root right away is refused.
    const second = await q.buildPostEpochInstruction({
      connection,
      keeper: keeper.publicKey,
      mint,
      index: q0.epochCount + 1,
      root: new Uint8Array(32).fill(7),
      total: 1n,
      leafCount: 1,
    })
    await expectFail(send([second], [keeper]), /EpochTooSoon/)
    await waitForChainTime(posted0.claimStart)
    // Once claims are open the authority can no longer cancel.
    await expectFail(
      send(
        [
          await q.buildCancelEpochInstruction({
            connection,
            authority: authority.publicKey,
            mint,
            index: 0,
          }),
        ],
        [authority],
      ),
      /CancelWindowClosed/,
    )
    // Wrong amount and someone else's proof fail.
    await expectFail(
      send([await claim(0, traders[0], entries[0].amount + 1n)], [traders[0]]),
      /InvalidProof/,
    )
    await expectFail(send([await claim(0, traders[1])], [traders[1]]), /InvalidProof/)
    const before0 = await bal(traders[0].publicKey)
    const c0 = await send([await claim(0)], [traders[0]])
    assert.equal(event(c0, 'Claimed').amount, entries[0].amount)
    const fee = 5000n
    assert.equal(await bal(traders[0].publicKey), before0 + entries[0].amount - fee)
    await expectFail(send([await claim(0)], [traders[0]]), /AlreadyClaimed/)
    await send([await claim(1)], [traders[1]])
    const epoch = await q.fetchEpoch(connection, mint, 0)
    assert.equal(epoch.claimed, entries[0].amount + entries[1].amount)
    assert.ok(q.isLeafClaimed(epoch, 0) && q.isLeafClaimed(epoch, 1) && !q.isLeafClaimed(epoch, 2))

    const closeIx = await q.buildCloseEpochInstruction({
      connection,
      caller: traders[2].publicKey,
      mint,
      index: 0,
    })
    await expectFail(send([closeIx], [traders[2]]), /EpochNotExpired/)
    await waitForChainTime(epoch.expiresAt)
    await expectFail(send([await claim(2)], [traders[2]]), /EpochExpired/)
    const keeperBefore = await bal(keeper.publicKey)
    const closed = await send([closeIx], [traders[2]])
    assert.equal(event(closed, 'EpochClosed').unclaimed, entries[2].amount)
    assert.ok((await bal(keeper.publicKey)) > keeperBefore, 'epoch rent returned to the keeper')
    const q2 = await q.fetchQuantum(connection, mint)
    assert.equal(q2.entangleOwed, 0n)
    assert.equal(q2.entangleReserve, reserve - entries[0].amount - entries[1].amount)
    assert.equal(q2.totalClaimed, entries[0].amount + entries[1].amount)
    assert.equal(await connection.getAccountInfo(q.epochPda(mint, 0)), null)
  })

  test('cancel_epoch: the authority vetoes an epoch before its claims open; the total returns to the reserve', async () => {
    // A long claim delay keeps the cancel window open for the whole test.
    const setClaimDelay = async (claimDelay: number) =>
      send(
        [
          await q.buildUpdateConfigInstruction({
            connection,
            authority: authority.publicKey,
            claimDelay,
          }),
        ],
        [authority],
      )
    await setClaimDelay(3600)
    const q0 = await q.fetchQuantum(connection, mint)
    await waitForChainTime(q0.lastEpochAt + TEST_EPOCH_INTERVAL)
    const index = q0.epochCount
    // What a leaked keeper key could post: everything to itself.
    const total = q0.entangleReserve
    const tree = buildEntanglementTree([{ wallet: keeper.publicKey.toBase58(), amount: total }])
    const keeper0 = await bal(keeper.publicKey)
    const posted = await send(
      [
        await q.buildPostEpochInstruction({
          connection,
          keeper: keeper.publicKey,
          mint,
          index,
          root: tree.root,
          total,
          leafCount: 1,
        }),
      ],
      [keeper],
    )
    const epoch = await q.fetchEpoch(connection, mint, index)
    assert.equal(epoch.claimStart, epoch.createdAt + 3600)
    const epochRent = BigInt((await connection.getAccountInfo(q.epochPda(mint, index)))!.lamports)
    assert.equal(await bal(keeper.publicKey), keeper0 - epochRent - posted.fee)
    let q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.entangleReserve, 0n)
    assert.equal(q1.entangleOwed, q0.entangleOwed + total)
    // The keeper cannot claim it before claim_start, nor cancel it.
    await expectFail(
      send(
        [
          await q.buildClaimInstruction({
            connection,
            claimant: keeper.publicKey,
            mint,
            index,
            leafIndex: 0,
            amount: total,
            proof: tree.proof(0),
          }),
        ],
        [keeper],
      ),
      /ClaimNotOpen/,
    )
    for (const who of [keeper, traders[0]])
      await expectFail(
        send(
          [
            await q.buildCancelEpochInstruction({
              connection,
              authority: who.publicKey,
              mint,
              index,
            }),
          ],
          [who],
        ),
        /NotAuthority/,
      )
    // The authority cancels: the total goes back to the reserve, the rent to config.keeper.
    const keeper1 = await bal(keeper.publicKey)
    const cancelled = await send(
      [
        await q.buildCancelEpochInstruction({
          connection,
          authority: authority.publicKey,
          mint,
          index,
        }),
      ],
      [authority],
    )
    const ev = event(cancelled, 'EpochCancelled')
    assert.equal(ev.index, index)
    assert.equal(ev.returned, total)
    assert.equal(ev.rentTo, keeper.publicKey.toBase58())
    assert.equal(await bal(keeper.publicKey), keeper1 + epochRent)
    assert.equal(await connection.getAccountInfo(q.epochPda(mint, index)), null)
    // Anyone can send lamports to the closed address. It is then a System account, and the client
    // reads the epoch as gone instead of failing to decode it.
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: traders[0].publicKey,
          toPubkey: q.epochPda(mint, index),
          lamports: 1_000_000,
        }),
      ],
      [traders[0]],
    )
    const refunded = await connection.getAccountInfo(q.epochPda(mint, index))
    assert.ok(refunded?.owner.equals(SystemProgram.programId))
    assert.equal(await q.fetchEpoch(connection, mint, index), null)
    await expectFail(
      q.buildCloseEpochInstruction({ connection, caller: traders[0].publicKey, mint, index }),
      /does not exist/,
    )
    q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.entangleReserve, q0.entangleReserve)
    assert.equal(q1.entangleOwed, q0.entangleOwed)
    assert.equal(q1.epochCount, index + 1, 'the index stays used')
    assert.equal(q1.totalClaimed, q0.totalClaimed)
    // Cancelling does not reset the cadence: the next root waits for the interval.
    await expectFail(
      send(
        [
          await q.buildPostEpochInstruction({
            connection,
            keeper: keeper.publicKey,
            mint,
            index: index + 1,
            root: tree.root,
            total: 1n,
            leafCount: 1,
          }),
        ],
        [keeper],
      ),
      /EpochTooSoon/,
    )
    await setClaimDelay(CONFIG.claimDelay)
  })

  test('release: partial after the cliff, everything after the end', async () => {
    await waitForChainTime(lockStart + HOOKS.lock.cliffSecs + 1)
    const ix = () => q.buildReleaseInstruction({ connection, launcher: launcher.publicKey, mint })
    const launcherAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, true, SPL)
    const t0 = await chainNow()
    const sent = await send([await ix()], [launcher])
    const t1 = await chainNow()
    const released = event(sent, 'Released').amount
    const quantum = await q.fetchQuantum(connection, mint)
    assert.ok(released >= q.vestedAmount(quantum, t0) && released <= q.vestedAmount(quantum, t1))
    assert.ok(released > 0n && released < lockAmount)
    await waitForChainTime(lockStart + HOOKS.lock.durationSecs)
    const rest = await send([await ix()], [launcher])
    assert.equal(event(rest, 'Released').releasedTotal, lockAmount)
    assert.equal(await tokenBalance(q.lockAta(mint)), 0n)
    assert.ok((await tokenBalance(launcherAta)) >= lockAmount)
    await expectFail(send([await ix()], [launcher]), /NothingToRelease/)
  })

  test('graduation: the curve fills (burns stop), sync records it, Meteora migrates the coin to DAMM v2 and the well gets the locked LP', async () => {
    await curveBuy(whale, 60, mint, { partial: true })
    let pool = await dbcPoolState()
    assert.ok(pool.migrationProgress > m.PROGRESS.PRE, 'curve complete')
    assert.ok(pool.finishCurveTimestamp > 0)
    // Between completion and migration there is nowhere to buy: the client and the program refuse.
    await assert.rejects(
      q.buildBurnInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: 1_000n }),
      /curve is full/,
    )
    // sync records graduation from DBC's own timestamp
    await send([await q.buildSyncInstruction({ connection, mint, damm: null })], [keeper])
    let quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.graduatedAt, pool.finishCurveTimestamp)
    // The surplus leg runs once the curve is complete.
    const harvest = await send(
      [await q.buildHarvestInstruction({ connection, caller: keeper.publicKey, mint })],
      [keeper],
    )
    assert.equal(event(harvest, 'Harvested').legs & q.HARVEST.SURPLUS, q.HARVEST.SURPLUS)

    // What the keeper sends (server/keeper.mjs migrateGraduates).
    const migration = await q.dbcMigrationInstructions({
      connection,
      payer: keeper.publicKey,
      dbcPool: m.dbcPoolPda(dbcConfig, mint),
    })
    const migrated = await send(migration.instructions, [keeper, ...migration.signers], { cu: 1_400_000 })
    console.log(`    migration ${migrated.size} B, ${migrated.cu} CU`)
    pool = await dbcPoolState()
    assert.equal(pool.migrationProgress, m.PROGRESS.MIGRATED)
    const { pool: dammPool, damm } = await dammState()
    assert.equal(damm.tokenAMint, mint.toBase58())
    assert.equal(damm.tokenBMint, NATIVE_MINT.toBase58())
    assert.equal(damm.collectFeeMode, 1, 'fees in SOL only')
    const well = q.wellPda(mint)
    const found = await q.findWellPosition(connection, well, dammPool)
    assert.ok(found, 'the well owns the creator position NFT')
    const position = m.decodePosition((await connection.getAccountInfo(found!.position))?.data)!
    assert.ok(position.permanentLockedLiquidity > 0n)
    assert.equal(position.unlockedLiquidity, 0n, 'all of it permanently locked')
  })

  test('sync records the DAMM v2 pool only with the coin\'s own migrated pool and the well\'s position', async () => {
    const well = q.wellPda(mint)
    const config = await dbcConfigState()
    const dammConfig = m.DAMM_MIGRATION_CONFIGS[config.migrationFeeOption]
    const { pool: dammPool } = await dammState()
    const found = (await q.findWellPosition(connection, well, dammPool))!
    // Another coin's migrated pool (fill and migrate the coin launched in the burn test).
    const other = await connection.getProgramAccounts(m.DBC_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 72, bytes: dbcConfig.toBase58() } }],
    })
    const otherMint = other
      .map((a) => m.decodeDbcPool(a.account.data)!)
      .find((p) => p.baseMint !== mint.toBase58() && p.migrationProgress === 0 && p.creator !== well.toBase58())!.baseMint
    await graduate(new PublicKey(otherMint), whale)
    const otherPool = m.migratedPoolFor(config, new PublicKey(otherMint))
    const syncWith = (damm: any) => q.buildSyncInstruction({ connection, mint, dbcPool: m.dbcPoolPda(dbcConfig, mint), damm })
    await expectFail(
      send([await syncWith({ config: dammConfig, pool: otherPool, position: found.position, nftAccount: found.nftAccount })], [keeper]),
      /NotCanonicalDammPool/,
    )
    // The right pool with a position that is not the well's: the other coin's creator position.
    const otherCreator = new PublicKey(m.decodeDbcPool((await connection.getAccountInfo(m.dbcPoolPda(dbcConfig, new PublicKey(otherMint))))!.data)!.creator)
    const theirs = (await q.findWellPosition(connection, otherCreator, otherPool))!
    await expectFail(
      send([await syncWith({ config: dammConfig, pool: dammPool, position: theirs.position, nftAccount: theirs.nftAccount })], [keeper]),
      /PositionNotWells/,
    )
    // A DAMM config DBC did not migrate this coin under (another fee tier).
    await expectFail(
      send([await syncWith({ config: m.DAMM_MIGRATION_CONFIGS[0], pool: dammPool, position: found.position, nftAccount: found.nftAccount })], [keeper]),
      /NotCanonicalDammPool/,
    )
    // The real ones.
    const sent = await send([await q.buildSyncInstruction({ connection, mint })], [keeper])
    const synced = event(sent, 'Synced')
    assert.equal(synced.dammPool, dammPool.toBase58())
    assert.equal(synced.collectFeeMode, 1)
    const quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.dammPool, dammPool.toBase58())
    assert.equal(quantum.dammPosition, found.position.toBase58())
    assert.ok(quantum.migratedAt > 0)
  })

  test('post-migration harvest + pulse: creator migration fee and DAMM v2 LP fees, as SOL', async () => {
    await poolBuys(mint, traders, SOL / 2n)
    const pending = await q.pendingCreatorFees(connection, mint)
    const sent = await send(
      await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint }),
      [keeper],
      { cu: 800_000 },
    )
    const harvested = event(sent, 'Harvested')
    assert.equal(harvested.legs & q.HARVEST.MIGRATION_FEE, q.HARVEST.MIGRATION_FEE)
    assert.equal(harvested.legs & q.HARVEST.LP_FEE, q.HARVEST.LP_FEE)
    assert.ok(harvested.claimed > 0n)
    assert.equal(harvested.tokensBurned, 0n, 'quote-only fees: no coin to burn')
    const pulsed = event(sent, 'Pulsed')
    console.log(`    post-migration harvest+pulse ${sent.size} B, ${sent.cu} CU, claimed ${harvested.claimed}, pending was ${pending}`)
    assert.ok(pulsed.collected >= harvested.claimed)
    // the migration fee is paid once
    const again = await send([await q.buildHarvestInstruction({ connection, caller: keeper.publicKey, mint })], [keeper])
    assert.equal(event(again, 'Harvested').legs & q.HARVEST.MIGRATION_FEE, 0)
  })

  test('quantum_burn on the DAMM v2 pool (the DBC pool is refused once migrated)', async () => {
    let quantum = await q.fetchQuantum(connection, mint)
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    const spend = quantum.burnReserve / 4n
    const supply0 = await supply()
    const sent = await send(
      await q.buildBurnInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: spend }),
      [keeper],
    )
    const burned = event(sent, 'Burned')
    console.log(`    DAMM burn ${sent.size} B, ${sent.cu} CU: spent ${burned.spent}, burned ${burned.tokensBurned}`)
    assert.equal(burned.venue, 1)
    assert.ok(burned.spent > 0n && burned.spent <= spend)
    assert.equal(await supply(), supply0 - burned.tokensBurned)
    // A burn aimed at the (migrated) DBC pool is not the coin's venue any more.
    quantum = await q.fetchQuantum(connection, mint)
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    const pool = await dbcPoolState()
    const raw = await program()
      .methods.quantumBurn(new BN(spend.toString()), new BN(0))
      .accountsStrict({
        caller: keeper.publicKey,
        config: q.configPda(),
        quantum: q.quantumPda(mint),
        well: q.wellPda(mint),
        mint,
        wellTokenAta: q.wellTokenAta(mint),
        wellWsolAta: q.wellWsolAta(mint),
        wsolMint: NATIVE_MINT,
        tokenProgram: SPL,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        venueProgram: m.DBC_PROGRAM_ID,
        venuePoolAuthority: m.DBC_POOL_AUTHORITY,
        venueEventAuthority: m.DBC_EVENT_AUTHORITY,
        venuePool: m.dbcPoolPda(dbcConfig, mint),
        venueBaseVault: new PublicKey(pool.baseVault),
        venueQuoteVault: new PublicKey(pool.quoteVault),
        dbcConfig,
      })
      .instruction()
    await expectFail(send([raw], [keeper]), /NotCanonicalPool/)
  })

  test('fusion: the public grace counts from migration; buy + add liquidity to the well\'s position, permanently locked', async () => {
    let quantum = await q.fetchQuantum(connection, mint)
    assert.ok(quantum.fusionReserve > 0n, `fusion reserve ${quantum.fusionReserve}`)
    const spend = quantum.fusionReserve / 2n
    await waitForChainTime(quantum.lastFusionAt + CONFIG.minActionInterval)
    // Long past the last fusion (= launch), but the migration was just now: still keeper only.
    if ((await chainNow()) <= quantum.migratedAt + CONFIG.keeperGrace)
      await expectFail(
        send(await q.buildFusionInstructions({ connection, caller: traders[0].publicKey, mint, spendLamports: spend }), [traders[0]]),
        /KeeperOnly/,
      )
    const position0 = m.decodePosition((await connection.getAccountInfo(new PublicKey(quantum.dammPosition!)))?.data)!
    const ixs = await q.buildFusionInstructions({ connection, caller: keeper.publicKey, mint, spendLamports: spend })
    const sent = await send(ixs, [keeper], { cu: 600_000 })
    const fused = event(sent, 'Fused')
    console.log(`    fusion ${sent.size} B, ${sent.cu} CU: spent ${fused.spent}, liquidity +${fused.liquidityAdded}, burned ${fused.tokensBurned}`)
    assert.ok(fused.spent > 0n && fused.spent <= spend)
    assert.ok(fused.liquidityAdded > 0n)
    const position1 = m.decodePosition((await connection.getAccountInfo(new PublicKey(quantum.dammPosition!)))?.data)!
    assert.equal(position1.permanentLockedLiquidity, position0.permanentLockedLiquidity + fused.liquidityAdded)
    assert.equal(position1.unlockedLiquidity, 0n)
    quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.totalFusedLiquidity, fused.liquidityAdded)
    assert.equal(await tokenBalance(q.wellTokenAta(mint)), 0n, 'nothing left in the well')
  })

  test('standard launch: a plain Meteora coin with the launcher as creator', async () => {
    const plain = Keypair.generate()
    const built = await q.buildStandardLaunchInstructions({
      connection,
      launcher: traders[1].publicKey,
      mint: plain.publicKey,
      name: 'Plain',
      symbol: 'PLAIN',
      uri: 'https://example.invalid/plain.json',
      devBuy: { solLamports: SOL / 10n, slippagePct: 1 },
      dbcConfig,
    })
    await send(built.instructions, [traders[1], plain], { cu: 500_000 })
    const pool = await dbcPoolState(plain.publicKey)
    assert.equal(pool.creator, traders[1].publicKey.toBase58())
    const ata = getAssociatedTokenAddressSync(plain.publicKey, traders[1].publicKey, true, SPL)
    assert.equal(await tokenBalance(ata), built.devBuyTokens)
    assert.equal((await q.verifyQuantumCoin(connection, plain.publicKey)).registered, false)
  })

  test('paused config blocks register and burns', async () => {
    const setPaused = async (paused: boolean) =>
      send(
        [await q.buildSetPausedInstruction({ connection, authority: authority.publicKey, paused })],
        [authority],
      )
    await setPaused(true)
    const m = Keypair.generate()
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint: m.publicKey,
      name: 'P',
      symbol: 'P',
      uri: 'https://example.invalid/p.json',
      hooks: { ...HOOKS, lock: null },
      dbcConfig,
    })
    await expectFail(send(built.stages.register, [launcher, m]), /Paused/)
    // A pause stops only register, quantum_burn and fusion: pulses keep paying out.
    await send(
      [
        SystemProgram.transfer({
          fromPubkey: traders[1].publicKey,
          toPubkey: q.wellPda(mint),
          lamports: 2_000_000,
        }),
      ],
      [traders[1]],
    )
    const pulsed = await send(
      await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint }),
      [keeper],
      { cu: 600_000 },
    )
    assert.ok(event(pulsed, 'Pulsed').collected >= 2_000_000n)
    const quantum = await q.fetchQuantum(connection, mint)
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    await expectFail(
      q
        .buildBurnInstructions({
          connection,
          caller: keeper.publicKey,
          mint,
          spendLamports: quantum.burnReserve / 2n,
        })
        .then((ixs: any) => send(ixs, [keeper], { cu: 600_000 })),
      /Paused/,
    )
    await setPaused(false)
    await send(built.stages.register, [launcher, m])
  })

  test('operator CLI (scripts/program-ops.mjs): dry runs send nothing; pause, versioned update, cancel_epoch', async () => {
    const authPath =
      typeof authorityFile === 'string' ? authorityFile : fileURLToPath(authorityFile)
    const auth = ['--authority', authPath]
    const run = async (...args: string[]) => {
      const lines: string[] = []
      const io = {
        log: (m: any) => lines.push(String(m)),
        error: (m: any) => lines.push(String(m)),
      }
      const code = await ops.main(
        ['--rpc', rpcUrl, '--program-id', q.QUANTUM_PROGRAM_ID.toBase58(), ...args],
        io,
      )
      return { code, out: lines.join('\n') }
    }
    const v0 = (await q.fetchConfig(connection)).version
    let r = await run()
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`v${v0}, not paused`))

    // Dry run: simulated against the chain, nothing signed or sent.
    r = await run('--pause', ...auth)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /dry run/)
    assert.match(r.out, /simulation\s+ok/)
    assert.equal((await q.fetchConfig(connection)).version, v0)
    // For a key that is not the authority it prints the instruction and the simulated error.
    r = await run('--pause', '--authority-pubkey', traders[0].publicKey.toBase58())
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /NotAuthority/)
    assert.match(r.out, /"data": "/)

    // Pause, then an update pinned to the version before the pause is refused before sending.
    r = await run('--pause', ...auth, '--yes')
    assert.equal(r.code, 0, r.out)
    let config = await q.fetchConfig(connection)
    assert.equal(config.paused, true)
    assert.equal(config.version, v0 + 1)
    r = await run('--keeper-grace', '9', '--expected-version', String(v0), ...auth, '--yes')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /ConfigChanged/)
    assert.match(r.out, /Not sent/)
    r = await run('--unpause', ...auth, '--yes')
    assert.equal(r.code, 0, r.out)
    config = await q.fetchConfig(connection)
    assert.equal(config.paused, false)
    assert.equal(config.keeperGrace, CONFIG.keeperGrace)
    assert.equal(config.version, v0 + 2)

    // A versioned update; repeating it is "nothing to change".
    r = await run('--claim-delay', '3600', ...auth, '--yes')
    assert.equal(r.code, 0, r.out)
    config = await q.fetchConfig(connection)
    assert.equal(config.claimDelay, 3600)
    assert.equal(config.version, v0 + 3)
    r = await run('--claim-delay', '3600', ...auth)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /Nothing to change/)

    // Cancel a posted epoch inside its window.
    const q0 = await q.fetchQuantum(connection, mint)
    assert.ok(q0.entangleReserve > 0n, 'pulses refilled the Entanglement reserve')
    await waitForChainTime(q0.lastEpochAt + TEST_EPOCH_INTERVAL)
    const post = async (index: number, total: bigint) => {
      const tree = buildEntanglementTree([{ wallet: keeper.publicKey.toBase58(), amount: total }])
      await send(
        [
          await q.buildPostEpochInstruction({
            connection,
            keeper: keeper.publicKey,
            mint,
            index,
            root: tree.root,
            total,
            leafCount: 1,
          }),
        ],
        [keeper],
      )
      return q.fetchEpoch(connection, mint, index)
    }
    const index = q0.epochCount
    await post(index, q0.entangleReserve)
    r = await run('--epochs', mint.toBase58())
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`#${index} .*CANCELLABLE`))
    const cancel = ['--cancel-epoch', mint.toBase58(), String(index), ...auth]
    r = await run(...cancel)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /simulation\s+ok/)
    assert.ok(await q.fetchEpoch(connection, mint, index), 'a dry run cancels nothing')
    r = await run(...cancel, '--yes')
    assert.equal(r.code, 0, r.out)
    assert.equal(await q.fetchEpoch(connection, mint, index), null)
    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.entangleReserve, q0.entangleReserve)
    assert.equal(q1.entangleOwed, q0.entangleOwed)
    r = await run(...cancel)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /no longer exists/)

    // Once claims are open the CLI refuses (and the program would fail with CancelWindowClosed).
    r = await run('--claim-delay', String(CONFIG.claimDelay), ...auth, '--yes')
    assert.equal(r.code, 0, r.out)
    await waitForChainTime(q1.lastEpochAt + TEST_EPOCH_INTERVAL)
    const open = await post(index + 1, 1n)
    await waitForChainTime(open.claimStart)
    r = await run('--cancel-epoch', mint.toBase58(), String(index + 1), ...auth, '--yes')
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /claims are already open/)
    assert.match(r.out, /CancelWindowClosed/)
    assert.ok(await q.fetchEpoch(connection, mint, index + 1), 'not cancelled')
  })
})
