// End-to-end tests against solana-test-validator running mainnet's pump.fun, PumpSwap, pump fees,
// mayhem and Token-2022 programs (dumped by tests/fixtures/fetch-fixtures.mjs) plus quantum_hooks
// built with the `short-expiry` feature. Started by tests/run-local.mjs.
import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token'
import BN from 'bn.js'
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  canonicalPumpPoolPda,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  lpMintPda,
} from '@pump-fun/pump-swap-sdk'
import * as q from '../../../shared/quantum.mjs'
import { buildEntanglementTree } from '../../../shared/merkle.mjs'
import {
  OnlinePumpSdk,
  PUMP_SDK,
  bondingCurvePda,
  creatorVaultPda,
  getBuyTokenAmountFromSolAmount,
  getFeeRecipient,
} from '../../../shared/vendor/pump-sdk.node.mjs'

const connection = new Connection(process.env.QH_RPC ?? 'http://127.0.0.1:8899', 'confirmed')
const authorityFile =
  process.env.QH_AUTHORITY ?? new URL('./fixtures/.keys/authority.json', import.meta.url)
const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(authorityFile, 'utf8'))),
)
const T22 = TOKEN_2022_PROGRAM_ID
const SOL = BigInt(LAMPORTS_PER_SOL)
const RENT0 = 890_880n

// Test wallets (fresh every run; the validator is reset every run).
const keeper = Keypair.generate()
const treasury = Keypair.generate()
const launcher = Keypair.generate()
const splitA = Keypair.generate() // funded
const splitB = Keypair.generate() // never funded: small shares must be deferred, not fail the pulse
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const whale = Keypair.generate()
const mintKp = Keypair.generate()
const mint = mintKp.publicKey

const CONFIG = {
  protocolBps: 500,
  maxBurnLamports: 2n * SOL,
  minActionInterval: 3,
  keeperGrace: 8,
}
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
async function tokenBalance(ata: PublicKey, program = T22) {
  const info = await connection.getAccountInfo(ata, 'confirmed')
  return info ? unpackAccount(ata, info, program).amount : 0n
}
async function supply(m = mint, program = T22) {
  return unpackMint(m, await connection.getAccountInfo(m, 'confirmed'), program).supply
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
  const message = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    // A random CU limit keeps retried-but-identical transactions from colliding on one blockhash.
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cu + Math.floor(Math.random() * 5000) }),
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
// An address lookup table holding every non-signer key of `instructions` (create_v2 + dev buy
// does not fit 1232 bytes without one, exactly as in the browser launch flow).
async function lookupTableFor(instructions: any[], payer: Keypair) {
  const signers = new Set<string>()
  const keys = new Map<string, PublicKey>()
  for (const ix of instructions) {
    keys.set(ix.programId.toBase58(), ix.programId)
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
// quantum_burn: 13 named accounts (optional ones as program-id placeholders), then the CPI accounts;
// data = discriminator (8) + spend (8) + Vec length (4) + CPI data.
const BURN_FIXED_ACCOUNTS = 13
const BURN_DATA_PREFIX = 20
const program = () => q.quantumProgram(connection)

// Raw quantum_burn around an arbitrary CPI (for negative tests the client would never build).
async function rawBurn(cpi: any, spend: bigint, caller: PublicKey, target = cpi.programId) {
  const well = q.wellPda(mint)
  return program()
    .methods.quantumBurn(new BN(spend.toString()), Buffer.from(cpi.data))
    .accountsStrict({
      caller,
      config: q.configPda(),
      quantum: q.quantumPda(mint),
      well,
      mint,
      wellTokenAta: q.wellTokenAta(mint),
      wellWsolAta: null,
      wsolMint: null,
      tokenProgram: T22,
      quoteTokenProgram: null,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      targetProgram: target,
    })
    .remainingAccounts(
      cpi.keys.map((k: any) => ({ pubkey: k.pubkey, isWritable: k.isWritable, isSigner: false })),
    )
    .instruction()
}

async function curveBuy(user: Keypair, sol: number, m = mint, tokenProgram = T22) {
  const online = new OnlinePumpSdk(connection)
  const [global, feeConfig, state] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
    online.fetchBuyState(m, user.publicKey, tokenProgram),
  ])
  const quoteAmount = new BN(Math.round(sol * LAMPORTS_PER_SOL))
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: new BN((await supply(m, tokenProgram)).toString()),
    bondingCurve: state.bondingCurve,
    amount: quoteAmount,
    quoteMint: state.bondingCurve.quoteMint,
  })
  const ixs = await PUMP_SDK.buyV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint: m,
    user: user.publicKey,
    amount,
    quoteAmount,
    slippage: 5,
    tokenProgram,
  })
  return send(ixs, [user])
}

// Buys the rest of a curve and migrates it to PumpSwap (the canonical pool).
async function graduate(m: PublicKey, buyer: Keypair, tokenProgram = T22) {
  const online = new OnlinePumpSdk(connection)
  const global = await online.fetchGlobal()
  const state = await online.fetchBuyState(m, buyer.publicKey, tokenProgram)
  const ixs = await PUMP_SDK.buyV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint: m,
    user: buyer.publicKey,
    amount: state.bondingCurve.realTokenReserves,
    quoteAmount: new BN((150n * SOL).toString()),
    slippage: 0,
    tokenProgram,
  })
  await send(ixs, [buyer])
  const curve = PUMP_SDK.decodeBondingCurve((await connection.getAccountInfo(bondingCurvePda(m)))!)
  assert.ok(curve.complete, 'curve complete')
  const migrate = await PUMP_SDK.migrateV2Instruction({
    withdrawAuthority: global.withdrawAuthority,
    mint: m,
    user: buyer.publicKey,
    quoteMint: curve.quoteMint,
    baseTokenProgram: tokenProgram,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  })
  return send([migrate], [buyer], { cu: 1_000_000 })
}

async function poolBuys(m: PublicKey, buyers: Keypair[], lamports: bigint) {
  const pool = canonicalPumpPoolPda(m)
  const amm = new OnlinePumpAmmSdk(connection)
  for (const t of buyers) {
    const st = await amm.swapSolanaState(pool, t.publicKey)
    await send(await PUMP_AMM_SDK.buyQuoteInput(st, new BN(lamports.toString()), 5), [t])
  }
}

async function curveSell(user: Keypair, amount: bigint) {
  const online = new OnlinePumpSdk(connection)
  const [global, state] = await Promise.all([
    online.fetchGlobal(),
    online.fetchSellState(mint, user.publicKey, T22),
  ])
  const ixs = await PUMP_SDK.sellV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    mint,
    user: user.publicKey,
    amount: new BN(amount.toString()),
    quoteAmount: new BN(0),
    slippage: 0,
    tokenProgram: T22,
  })
  return send(ixs, [user])
}

// ------------------------------------------------------------------------------------------------
describe('quantum_hooks on a local validator with mainnet pump.fun', () => {
  let lockAmount = 0n
  let devBuyTokens = 0n
  let lockStart = 0

  before(async () => {
    for (const k of [authority, keeper, treasury, launcher, splitA, ...traders])
      await airdrop(k.publicKey, 50)
    await airdrop(whale.publicKey, 200)
    await airdrop(whale.publicKey, 200)
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
  })

  test('quantum launch: register, create_v2 (creator = well) + dev buy, lock — three transactions', async () => {
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint,
      name: 'Quantum Test',
      symbol: 'QTEST',
      uri: 'https://example.invalid/qtest.json',
      hooks: HOOKS,
      devBuy: { solLamports: 2n * SOL, slippagePct: 5 },
    })
    devBuyTokens = built.devBuyTokens
    lockAmount = built.lockAmount
    assert.ok(devBuyTokens > 0n)
    assert.equal(lockAmount, (devBuyTokens * 5000n) / 10_000n)
    assert.equal(
      built.instructions.length,
      built.stages.register.length + built.stages.launch.length + built.stages.lock.length,
    )

    const a = await send(built.stages.register, [launcher, mintKp])
    const registered = event(a, 'Registered')
    assert.equal(registered.mint, mint.toBase58())
    assert.equal(registered.wellFunded, RENT0)
    const b = await send(built.stages.launch, [launcher, mintKp], {
      cu: 500_000,
      luts: [await lookupTableFor(built.stages.launch, launcher)],
    })
    const c = await send(built.stages.lock, [launcher])
    const locked = event(c, 'Locked')
    assert.equal(locked.amount, lockAmount)
    lockStart = Number(locked.lockStart)
    console.log(
      `    tx sizes: register ${a.size} B, create+buy ${b.size} B, lock ${c.size} B; CU ${a.cu}/${b.cu}/${c.cu}`,
    )

    const curve = PUMP_SDK.decodeBondingCurve(
      (await connection.getAccountInfo(bondingCurvePda(mint)))!,
    )
    const well = q.wellPda(mint)
    assert.ok(curve.creator.equals(well), 'pump.fun creator is the well')
    assert.equal(await bal(well), RENT0)
    const launcherAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, true, T22)
    assert.equal(await tokenBalance(launcherAta), devBuyTokens - lockAmount)
    assert.equal(await tokenBalance(q.lockAta(mint)), lockAmount)

    const quantum = await q.fetchQuantum(connection, mint)
    assert.equal(quantum.launcher, launcher.publicKey.toBase58())
    assert.deepEqual(
      [quantum.creatorBps, quantum.burnBps, quantum.entangleBps, quantum.fusionBps],
      [4000, 2500, 2000, 1500],
    )
    assert.deepEqual(quantum.splits, HOOKS.splits)
    assert.equal(quantum.lockedAmount, lockAmount)
    assert.equal(quantum.lockCliff - quantum.lockStart, 12)
    assert.equal(quantum.lockEnd - quantum.lockStart, 70)
    assert.equal(quantum.lastBurnAt, quantum.createdAt)
    const verified = await q.verifyQuantumCoin(connection, mint)
    assert.deepEqual(verified, {
      registered: true,
      curveExists: true,
      creatorIsWell: true,
      complete: false,
    })
  })

  test('register is rejected for an existing mint, without the mint signature, for a funded mint, and for bad hooks', async () => {
    const registerIx = async (m: PublicKey, hooks: any = { ...HOOKS, lock: null }) =>
      (
        await q.buildQuantumLaunchInstructions({
          connection,
          launcher: launcher.publicKey,
          mint: m,
          name: 'X',
          symbol: 'X',
          uri: 'https://example.invalid/x.json',
          hooks,
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
    // Validation errors come from the program too (bypass the client-side check).
    const bad = Keypair.generate()
    const raw = await program()
      .methods.register({
        creatorBps: 5000,
        burnBps: 2000,
        entangleBps: 2000,
        fusionBps: 999,
        splits: [],
        lock: null,
      })
      .accountsStrict({
        launcher: launcher.publicKey,
        mint: bad.publicKey,
        config: q.configPda(),
        quantum: q.quantumPda(bad.publicKey),
        well: q.wellPda(bad.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await expectFail(send([raw], [launcher, bad]), /InvalidAllocation/)
    const dupe = await program()
      .methods.register({
        creatorBps: 10000,
        burnBps: 0,
        entangleBps: 0,
        fusionBps: 0,
        splits: [
          { wallet: splitA.publicKey, bps: 100 },
          { wallet: splitA.publicKey, bps: 100 },
        ],
        lock: { cliffSecs: new BN(10), durationSecs: new BN(5) },
      })
      .accountsStrict({
        launcher: launcher.publicKey,
        mint: bad.publicKey,
        config: q.configPda(),
        quantum: q.quantumPda(bad.publicKey),
        well: q.wellPda(bad.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await expectFail(send([dupe], [launcher, bad]), /InvalidSplitWallet|InvalidLockTerms/)
    // Keys the runtime always makes read-only (sysvars, builtin programs) and programs could
    // never be paid by `pulse`: the program and the client refuse them as split wallets.
    for (const reserved of [
      new PublicKey('SysvarRent111111111111111111111111111111111'),
      new PublicKey('Vote111111111111111111111111111111111111111'),
      new PublicKey('ComputeBudget111111111111111111111111111111'),
      q.QUANTUM_PROGRAM_ID,
    ]) {
      const ix = await program()
        .methods.register({
          creatorBps: 10000,
          burnBps: 0,
          entangleBps: 0,
          fusionBps: 0,
          splits: [{ wallet: reserved, bps: 100 }],
          lock: null,
        })
        .accountsStrict({
          launcher: launcher.publicKey,
          mint: bad.publicKey,
          config: q.configPda(),
          quantum: q.quantumPda(bad.publicKey),
          well: q.wellPda(bad.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .instruction()
      await expectFail(send([ix], [launcher, bad]), /InvalidSplitWallet/)
      assert.throws(
        () =>
          q.validateHooks({
            creatorBps: 10000,
            splits: [{ wallet: reserved.toBase58(), bps: 100 }],
          }),
        /cannot be a split wallet/,
      )
    }
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
    const well = q.wellPda(mint)
    const before = await q.pendingCreatorFees(connection, mint)
    for (const t of traders) await curveBuy(t, 6)
    const ata = getAssociatedTokenAddressSync(mint, traders[0].publicKey, true, T22)
    await curveSell(traders[0], (await tokenBalance(ata)) / 3n)
    const after = await q.pendingCreatorFees(connection, mint)
    console.log(`    pending creator fees ${before} -> ${after} lamports`)
    assert.ok(after > before + 10_000_000n, 'at least 0.01 SOL of creator fees accrued')
    const vault = await connection.getAccountInfo(creatorVaultPda(well))
    const curve = PUMP_SDK.decodeBondingCurve(
      (await connection.getAccountInfo(bondingCurvePda(mint)))!,
    )
    assert.ok((vault ? BigInt(vault.lamports) : 0n) > RENT0 || big(curve.creatorFee) > 0n)
  })

  test('pulse: sweep + collect + pulse splits with protocol cut, Superposition, deferral and rounding', async () => {
    const well = q.wellPda(mint)
    const wrongOrder = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    const pulseIx = wrongOrder[wrongOrder.length - 1]
    const n = pulseIx.keys.length
    ;[pulseIx.keys[n - 1], pulseIx.keys[n - 2]] = [pulseIx.keys[n - 2], pulseIx.keys[n - 1]]
    await expectFail(send(wrongOrder, [keeper]), /SplitAccountsMismatch/)

    const q0 = await q.fetchQuantum(connection, mint)
    const balances0 = await Promise.all(
      [treasury, splitA, splitB, launcher].map((k) => bal(k.publicKey)),
    )
    const ixs = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    const sent = await send(ixs, [keeper])
    const pulsed = event(sent, 'Pulsed')
    console.log(`    pulse tx ${sent.size} B, ${sent.cu} CU, collected ${pulsed.collected}`)
    const available = pulsed.collected
    const protocol = pct(available, 500)
    const net = available - protocol
    const burn = pct(net, 2500),
      entangle = pct(net, 2000),
      fusion = pct(net, 1500)
    const slice = net - burn - entangle - fusion
    const a = pct(slice, 2500),
      b = pct(slice, 100)
    const launcherShare = slice - a - b
    assert.equal(pulsed.rentRefunded, 0n, 'no WSOL account on the curve')
    assert.equal(pulsed.protocol, protocol)
    assert.equal(pulsed.burnAdded, burn)
    assert.equal(pulsed.entangleAdded, entangle)
    assert.equal(pulsed.fusionAdded, fusion)
    // splitB holds no lamports: a share below the rent minimum is deferred, never lost.
    const bDeferred = b < RENT0
    assert.ok(
      bDeferred,
      `expected splitB's share (${b}) below the rent minimum so deferral is exercised`,
    )
    assert.equal(pulsed.splitsPaid, a + (bDeferred ? 0n : b))
    assert.equal(pulsed.deferred, bDeferred ? b : 0n)
    assert.equal(pulsed.launcherPaid, launcherShare)
    assert.equal(
      protocol + burn + entangle + fusion + a + b + launcherShare,
      available,
      'rounding is absorbed exactly',
    )

    const balances1 = await Promise.all(
      [treasury, splitA, splitB, launcher].map((k) => bal(k.publicKey)),
    )
    assert.equal(balances1[0] - balances0[0], protocol)
    assert.equal(balances1[1] - balances0[1], a)
    assert.equal(balances1[2] - balances0[2], bDeferred ? 0n : b)
    assert.equal(balances1[3] - balances0[3], launcherShare)

    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.burnReserve - q0.burnReserve, burn)
    assert.equal(q1.entangleReserve - q0.entangleReserve, entangle)
    assert.equal(q1.fusionReserve - q0.fusionReserve, fusion)
    assert.equal(q1.totalProtocol, protocol)
    const wellBalance = await q.fetchWellBalance(connection, mint)
    assert.equal(
      wellBalance.lamports,
      RENT0 +
        q1.burnReserve +
        q1.entangleReserve +
        q1.entangleOwed +
        q1.fusionReserve +
        pulsed.deferred,
    )
    assert.equal(await bal(well), wellBalance.lamports)

    // Nothing left (deferred dust < 0.001 SOL) → NothingToPulse.
    const again = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    await expectFail(send(again, [keeper]), /NothingToPulse/)
  })

  test('quantum_burn on the curve: caps, discriminator allow-list, target check, keeper gating and grace', async () => {
    const well = q.wellPda(mint)
    const q0 = await q.fetchQuantum(connection, mint)
    assert.ok(q0.burnReserve > 1_000_000n, `burn reserve ${q0.burnReserve}`)
    // Spend above the reserve.
    await expectFail(
      q
        .buildBurnInstructions({
          connection,
          caller: keeper.publicKey,
          mint,
          spendLamports: q0.burnReserve + 1n,
        })
        .then((ixs: any) => send(ixs, [keeper])),
      /SpendTooHigh/,
    )
    // A sell is not on the allow-list.
    const online = new OnlinePumpSdk(connection)
    const global = await online.fetchGlobal()
    const sell = await PUMP_SDK.getSellInstructionRaw({
      user: well,
      mint,
      creator: well,
      amount: new BN(1000),
      solAmount: new BN(0),
      feeRecipient: getFeeRecipient(global, false),
      tokenProgram: T22,
    })
    await expectFail(
      send([await rawBurn(sell, 1_000_000n, keeper.publicKey)], [keeper]),
      /DisallowedInstruction/,
    )
    // Only pump.fun / PumpSwap may be invoked.
    const buildOk = await q.buildBurnInstructions({
      connection,
      caller: keeper.publicKey,
      mint,
      spendLamports: q0.burnReserve / 3n,
    })
    const burnIx = buildOk[buildOk.length - 1]
    const asToken = await rawBurn(
      {
        data: burnIx.data.subarray(BURN_DATA_PREFIX),
        keys: burnIx.keys.slice(BURN_FIXED_ACCOUNTS),
        programId: TOKEN_PROGRAM_ID,
      },
      1_000_000n,
      keeper.publicKey,
    )
    await expectFail(send([asToken], [keeper]), /InvalidTargetProgram|DisallowedInstruction/)

    // The per-action cap (config.max_burn_lamports) applies too.
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          maxBurnLamports: 1_000_000n,
        }),
      ],
      [authority],
    )
    await expectFail(
      q
        .buildBurnInstructions({
          connection,
          caller: keeper.publicKey,
          mint,
          spendLamports: 1_000_001n,
        })
        .then((ixs: any) => send(ixs, [keeper])),
      /SpendTooHigh/,
    )
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          maxBurnLamports: CONFIG.maxBurnLamports,
        }),
      ],
      [authority],
    )
    // A buy whose cost exceeds the authorised spend is caught after the CPI (Overspent).
    {
      const curveNow = PUMP_SDK.decodeBondingCurve(
        (await connection.getAccountInfo(bondingCurvePda(mint)))!,
      )
      const feeConfig = await online.fetchFeeConfig()
      const tokens = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: new BN((await supply()).toString()),
        bondingCurve: curveNow,
        amount: new BN(3_000_000),
        quoteMint: curveNow.quoteMint,
      })
      const pricey = await PUMP_SDK.getBuyInstructionRaw({
        user: well,
        mint,
        creator: well,
        amount: tokens,
        solAmount: new BN(4_000_000),
        feeRecipient: getFeeRecipient(global, false),
        tokenProgram: T22,
      })
      const pre = buildOk.slice(0, -1) // the well's volume accumulator init, if any
      await expectFail(
        send([...pre, await rawBurn(pricey, 1_000_000n, keeper.publicKey)], [keeper]),
        /Overspent/,
      )
    }

    // Keeper burn.
    const supply0 = await supply()
    const sent = await send(buildOk, [keeper])
    const burned = event(sent, 'Burned')
    console.log(
      `    curve burn tx ${sent.size} B, ${sent.cu} CU, spent ${burned.spent}, burned ${burned.tokensBurned}`,
    )
    assert.equal(burned.venue, 0)
    assert.ok(burned.spent > 0n && burned.spent <= q0.burnReserve / 3n)
    assert.ok(burned.tokensBurned > 0n)
    assert.equal(await supply(), supply0 - burned.tokensBurned)
    assert.equal(await tokenBalance(q.wellTokenAta(mint)), 0n)
    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.burnReserve, q0.burnReserve - burned.spent)
    assert.equal(q1.totalBurnedTokens, burned.tokensBurned)

    // Right after: a stranger is gated by the keeper grace, the keeper by the interval.
    const stranger = traders[1]
    const asStranger = await q.buildBurnInstructions({
      connection,
      caller: stranger.publicKey,
      mint,
      spendLamports: q1.burnReserve / 3n,
    })
    await expectFail(send(asStranger, [stranger]), /KeeperOnly/)
    const asKeeper = await q.buildBurnInstructions({
      connection,
      caller: keeper.publicKey,
      mint,
      spendLamports: q1.burnReserve / 3n,
    })
    await expectFail(send(asKeeper, [keeper]), /TooSoon/)
    // After the grace anyone may run it.
    await waitForChainTime(q1.lastBurnAt + CONFIG.keeperGrace + 1)
    const late = await q.buildBurnInstructions({
      connection,
      caller: stranger.publicKey,
      mint,
      spendLamports: q1.burnReserve / 3n,
    })
    const lateSent = await send(late, [stranger])
    assert.ok(event(lateSent, 'Burned').tokensBurned > 0n)
  })

  test('entanglement: post, claim with proofs, double claim / bad proofs rejected, close after expiry', async () => {
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

  test('release: partial after the cliff, everything after the end', async () => {
    await waitForChainTime(lockStart + HOOKS.lock.cliffSecs + 1)
    const ix = () => q.buildReleaseInstruction({ connection, launcher: launcher.publicKey, mint })
    const launcherAta = getAssociatedTokenAddressSync(mint, launcher.publicKey, true, T22)
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

  test('graduation: buy out the curve and migrate to PumpSwap', async () => {
    const online = new OnlinePumpSdk(connection)
    const global = await online.fetchGlobal()
    const state = await online.fetchBuyState(mint, whale.publicKey, T22)
    const remaining = state.bondingCurve.realTokenReserves
    const ixs = await PUMP_SDK.buyV2Instructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      associatedUserAccountInfo: state.associatedUserAccountInfo,
      mint,
      user: whale.publicKey,
      amount: remaining,
      quoteAmount: new BN((150n * SOL).toString()),
      slippage: 0,
      tokenProgram: T22,
    })
    await send(ixs, [whale])
    const curve = PUMP_SDK.decodeBondingCurve(
      (await connection.getAccountInfo(bondingCurvePda(mint)))!,
    )
    assert.ok(curve.complete, 'curve complete')
    const migrate = await PUMP_SDK.migrateV2Instruction({
      withdrawAuthority: global.withdrawAuthority,
      mint,
      user: whale.publicKey,
      quoteMint: curve.quoteMint,
      baseTokenProgram: T22,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    })
    const sent = await send([migrate], [whale], { cu: 1_000_000 })
    console.log(`    migrate ${sent.size} B, ${sent.cu} CU`)
    const pool = canonicalPumpPoolPda(mint)
    const poolInfo = await connection.getAccountInfo(pool)
    assert.ok(poolInfo, 'canonical pool exists')
    const decoded = PUMP_AMM_SDK.decodePool(poolInfo)
    assert.ok(decoded.coinCreator.equals(q.wellPda(mint)), 'pool coin creator is the well')
  })

  test('post-graduation pulse: PumpSwap sweep + collect (WSOL) unwrapped by pulse, ATA rent refunded', async () => {
    await poolBuys(mint, traders, 3n * SOL)
    const pending = await q.pendingCreatorFees(connection, mint)
    assert.ok(pending > 1_000_000n)
    assert.equal(await connection.getAccountInfo(q.wellWsolAta(mint)), null, 'no WSOL ATA yet')
    const vaultAta = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthorityPda(q.wellPda(mint)),
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
    )
    const vaultExisted = !!(await connection.getAccountInfo(vaultAta))
    const keeper0 = await bal(keeper.publicKey)
    const ixs = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    const sent = await send(ixs, [keeper], { cu: 600_000 })
    const pulsed = event(sent, 'Pulsed')
    console.log(
      `    pool pulse tx ${sent.size} B, ${sent.cu} CU, unwrapped ${pulsed.unwrapped}, collected ${pulsed.collected}, rent refunded ${pulsed.rentRefunded}`,
    )
    assert.ok(pulsed.unwrapped > 0n, 'WSOL creator fees were unwrapped into the well')
    assert.equal(await connection.getAccountInfo(q.wellWsolAta(mint)), null, 'WSOL ATA closed')
    // The collect leg created the WSOL ATA at the keeper's expense; pulse refunds that rent and
    // splits only the fees (before the fix `collected` was `pending` + 2 039 280).
    assert.equal(pulsed.rentRefunded, q.RENT_EXEMPT_TOKEN_ACCOUNT)
    assert.equal(pulsed.collected, pending, 'exactly the pending creator fees are split')
    const vaultRent = vaultExisted ? 0n : q.RENT_EXEMPT_TOKEN_ACCOUNT
    assert.equal(
      await bal(keeper.publicKey),
      keeper0 - sent.fee - vaultRent,
      'the keeper pays only the network fee',
    )
  })

  test('post-graduation pulse with fees below 0.001 SOL fails with NothingToPulse (ATA rent is not fees)', async () => {
    // A small trade leaves a few thousand lamports of creator fees in the PumpSwap coin-creator
    // vault, so the client includes the collect leg, which creates the WSOL ATA (≈ 0.002 SOL of
    // rent) again. Before the fix that rent lifted the pulse over the 0.001 SOL floor.
    const before = await q.pendingCreatorFees(connection, mint)
    await poolBuys(mint, [traders[0]], SOL / 20n)
    const pending = await q.pendingCreatorFees(connection, mint)
    assert.ok(pending > before, 'creator fees accrued')
    assert.ok(pending < q.MIN_PULSE_LAMPORTS, `pending ${pending}`)
    const ixs = await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint })
    assert.ok(
      ixs.some((ix: any) => ix.programId.equals(q.PUMP_AMM_PROGRAM_ID)),
      'the pool collect leg is included',
    )
    await expectFail(send(ixs, [keeper], { cu: 600_000 }), /NothingToPulse/)
  })

  test('quantum_burn through the canonical PumpSwap pool (non-canonical pool rejected)', async () => {
    const q0 = await q.fetchQuantum(connection, mint)
    await waitForChainTime(q0.lastBurnAt + CONFIG.minActionInterval)
    const spend = q0.burnReserve / 2n
    const ixs = await q.buildBurnInstructions({
      connection,
      caller: keeper.publicKey,
      mint,
      spendLamports: spend,
    })
    const burnIx = ixs[ixs.length - 1]
    const fake = {
      ...burnIx,
      keys: burnIx.keys.map((k: any, i: number) =>
        i === BURN_FIXED_ACCOUNTS ? { ...k, pubkey: Keypair.generate().publicKey } : k,
      ),
    }
    await expectFail(send([...ixs.slice(0, -1), fake], [keeper]), /NotCanonicalPool/)
    const supply0 = await supply()
    const sent = await send(ixs, [keeper], { cu: 600_000 })
    const burned = event(sent, 'Burned')
    console.log(
      `    pool burn tx ${sent.size} B, ${sent.cu} CU, spent ${burned.spent}, burned ${burned.tokensBurned}`,
    )
    assert.equal(burned.venue, 1)
    assert.ok(burned.spent > 0n && burned.spent <= spend)
    assert.equal(await supply(), supply0 - burned.tokensBurned)
    assert.equal(await connection.getAccountInfo(q.wellWsolAta(mint)), null)
    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.burnReserve, q0.burnReserve - burned.spent)
  })

  test('fusion: buy + deposit on the canonical pool, LP stays in the well', async () => {
    const q0 = await q.fetchQuantum(connection, mint)
    assert.ok(q0.fusionReserve > 1_000_000n, `fusion reserve ${q0.fusionReserve}`)
    const ixs = await q.buildFusionInstructions({
      connection,
      caller: keeper.publicKey,
      mint,
      spendLamports: q0.fusionReserve,
    })
    // Only the keeper may fuse before the grace period (it started at launch, long ago, so tighten it).
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          keeperGrace: 3600,
        }),
      ],
      [authority],
    )
    const stranger = await q.buildFusionInstructions({
      connection,
      caller: traders[2].publicKey,
      mint,
      spendLamports: q0.fusionReserve,
    })
    await expectFail(send(stranger, [traders[2]], { cu: 800_000 }), /KeeperOnly/)
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
    const sent = await send(ixs, [keeper], { cu: 800_000 })
    const fused = event(sent, 'Fused')
    console.log(
      `    fusion tx ${sent.size} B, ${sent.cu} CU, spent ${fused.spent}, lp ${fused.lpReceived}, burned ${fused.tokensBurned}`,
    )
    assert.ok(fused.lpReceived > 0n && fused.spent > 0n && fused.spent <= q0.fusionReserve)
    const lpAta = getAssociatedTokenAddressSync(
      lpMintPda(canonicalPumpPoolPda(mint)),
      q.wellPda(mint),
      true,
      T22,
    )
    assert.equal(await tokenBalance(lpAta), fused.lpReceived)
    const q1 = await q.fetchQuantum(connection, mint)
    assert.equal(q1.fusionReserve, q0.fusionReserve - fused.spent)
    assert.equal(q1.totalFusedSol, fused.spent)
    assert.equal(await connection.getAccountInfo(q.wellWsolAta(mint)), null)
  })

  test('standard launch: plain pump.fun coin with creator = launcher', async () => {
    const m = Keypair.generate()
    const built = await q.buildStandardLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint: m.publicKey,
      name: 'Plain',
      symbol: 'PLAIN',
      uri: 'https://example.invalid/plain.json',
      devBuy: { solLamports: SOL / 2n, slippagePct: 5 },
    })
    await send(built.instructions, [launcher, m], {
      cu: 500_000,
      luts: [await lookupTableFor(built.instructions, launcher)],
    })
    const curve = PUMP_SDK.decodeBondingCurve(
      (await connection.getAccountInfo(bondingCurvePda(m.publicKey)))!,
    )
    assert.ok(curve.creator.equals(launcher.publicKey))
    assert.equal(
      await tokenBalance(getAssociatedTokenAddressSync(m.publicKey, launcher.publicKey, true, T22)),
      built.devBuyTokens,
    )
  })

  test('legacy SPL Token coin (pump.fun `create`, creator = well): curve pulse and burn, graduation, pool pulse and burn, fusion', async () => {
    const SPL = TOKEN_PROGRAM_ID
    const legacyKp = Keypair.generate()
    const m = legacyKp.publicKey
    const well = q.wellPda(m)
    const meta = { name: 'Legacy', symbol: 'LEGACY', uri: 'https://example.invalid/legacy.json' }
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint: m,
      ...meta,
      hooks: { ...HOOKS, splits: [{ wallet: splitA.publicKey.toBase58(), bps: 2500 }], lock: null },
    })
    await send(built.stages.register, [launcher, legacyKp])
    // A third-party script can still use pump.fun's legacy `create` (SPL Token mint).
    const create = await PUMP_SDK.createInstruction({
      mint: m,
      ...meta,
      creator: well,
      user: launcher.publicKey,
    })
    await send([create], [launcher, legacyKp])
    const mintInfo = await connection.getAccountInfo(m)
    assert.ok(mintInfo!.owner.equals(SPL), 'legacy create makes an SPL Token mint')
    assert.ok(q.mintTokenProgram(mintInfo).equals(SPL))

    for (const t of traders) await curveBuy(t, 4, m, SPL)
    event(
      await send(await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint: m }), [
        keeper,
      ]),
      'Pulsed',
    )
    let quantum = await q.fetchQuantum(connection, m)
    assert.ok(quantum.burnReserve > 0n && quantum.fusionReserve > 0n)

    // Curve burn with the coin's own token program (it used to require Token-2022).
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    const supply0 = await supply(m, SPL)
    const curveBurn = event(
      await send(
        await q.buildBurnInstructions({
          connection,
          caller: keeper.publicKey,
          mint: m,
          spendLamports: quantum.burnReserve / 2n,
        }),
        [keeper],
      ),
      'Burned',
    )
    assert.equal(curveBurn.venue, 0)
    assert.ok(curveBurn.tokensBurned > 0n)
    assert.equal(await supply(m, SPL), supply0 - curveBurn.tokensBurned)
    assert.equal(await tokenBalance(q.wellTokenAta(m, undefined, SPL), SPL), 0n)

    // Graduation, then collect what the buy-out paid the well on the curve.
    const buyer = Keypair.generate()
    await airdrop(buyer.publicKey, 200)
    await graduate(m, buyer, SPL)
    if ((await q.pendingCreatorFees(connection, m)) >= q.MIN_PULSE_LAMPORTS)
      await send(
        await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint: m }),
        [keeper],
        {
          cu: 600_000,
        },
      )

    // Pool pulse: WSOL unwrapped, ATA rent back to the keeper.
    await poolBuys(m, traders, 2n * SOL)
    const pending = await q.pendingCreatorFees(connection, m)
    const poolPulse = event(
      await send(
        await q.buildPulseInstructions({ connection, payer: keeper.publicKey, mint: m }),
        [keeper],
        {
          cu: 600_000,
        },
      ),
      'Pulsed',
    )
    assert.ok(poolPulse.unwrapped > 0n)
    assert.equal(poolPulse.rentRefunded, q.RENT_EXEMPT_TOKEN_ACCOUNT)
    assert.equal(poolPulse.collected, pending)

    // Pool burn.
    quantum = await q.fetchQuantum(connection, m)
    await waitForChainTime(quantum.lastBurnAt + CONFIG.minActionInterval)
    const supply1 = await supply(m, SPL)
    const poolBurn = event(
      await send(
        await q.buildBurnInstructions({
          connection,
          caller: keeper.publicKey,
          mint: m,
          spendLamports: quantum.burnReserve / 2n,
        }),
        [keeper],
        { cu: 600_000 },
      ),
      'Burned',
    )
    assert.equal(poolBurn.venue, 1)
    assert.equal(await supply(m, SPL), supply1 - poolBurn.tokensBurned)

    // Fusion: base on SPL Token, LP on Token-2022.
    quantum = await q.fetchQuantum(connection, m)
    const fused = event(
      await send(
        await q.buildFusionInstructions({
          connection,
          caller: keeper.publicKey,
          mint: m,
          spendLamports: quantum.fusionReserve,
        }),
        [keeper],
        { cu: 800_000 },
      ),
      'Fused',
    )
    console.log(
      `    legacy coin: curve burn ${curveBurn.tokensBurned}, pool burn ${poolBurn.tokensBurned}, fusion lp ${fused.lpReceived}`,
    )
    assert.ok(fused.lpReceived > 0n && fused.spent > 0n)
    const lpAta = getAssociatedTokenAddressSync(lpMintPda(canonicalPumpPoolPda(m)), well, true, T22)
    assert.equal(await tokenBalance(lpAta), fused.lpReceived)
    assert.equal(
      (await q.fetchQuantum(connection, m)).fusionReserve,
      quantum.fusionReserve - fused.spent,
    )
  })

  test('paused config blocks register and burns', async () => {
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          paused: true,
        }),
      ],
      [authority],
    )
    const m = Keypair.generate()
    const built = await q.buildQuantumLaunchInstructions({
      connection,
      launcher: launcher.publicKey,
      mint: m.publicKey,
      name: 'P',
      symbol: 'P',
      uri: 'https://example.invalid/p.json',
      hooks: { ...HOOKS, lock: null },
    })
    await expectFail(send(built.stages.register, [launcher, m]), /Paused/)
    await send(
      [
        await q.buildUpdateConfigInstruction({
          connection,
          authority: authority.publicKey,
          paused: false,
        }),
      ],
      [authority],
    )
    await send(built.stages.register, [launcher, m])
  })
})
