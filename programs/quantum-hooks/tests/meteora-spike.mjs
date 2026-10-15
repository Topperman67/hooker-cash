// Phase 0 spike: drives Meteora's real DBC and DAMM v2 programs (mainnet dumps from
// tests/fixtures) on a local validator through the full Quant Pad lifecycle, and records the
// answers the Quantum Hooks port depends on. No Quantum Hooks code is involved; a plain keypair
// ("well") stands in for the well PDA.
//   node programs/quantum-hooks/tests/fixtures/fetch-fixtures.mjs   (once)
//   node programs/quantum-hooks/tests/meteora-spike.mjs [--keep]
// Writes programs/quantum-hooks/tests/meteora-spike.json.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import BN from 'bn.js'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CpAmmIdl, getTokenProgram } from '@meteora-ag/cp-amm-sdk'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const RPC = 'http://127.0.0.1:8899'
const results = { questions: {}, offsets: {}, sizes: {}, notes: [] }
const answer = (key, value) => {
  results.questions[key] = value
  console.log(`\n▸ ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
const note = (s) => {
  results.notes.push(s)
  console.log(`  · ${s}`)
}

// ---- IDL layout: zero-copy (bytemuck Pod) structs have no implicit padding --------------------

function sizeOf(idl, t) {
  if (typeof t === 'string') {
    return { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 }[t]
  }
  if (t.array) return sizeOf(idl, t.array[0]) * t.array[1]
  if (t.defined) {
    const def = idl.types.find((x) => x.name === (t.defined.name || t.defined))
    if (def.type.kind === 'enum') return 1
    return def.type.fields.reduce((s, f) => s + sizeOf(idl, f.type), 0)
  }
  throw new Error(`unsized ${JSON.stringify(t)}`)
}
function offsets(idl, typeName, base = 8, prefix = '') {
  const def = idl.types.find((x) => x.name === typeName)
  const out = {}
  let at = base
  for (const f of def.type.fields) {
    out[prefix + f.name] = at
    if (f.type.defined && !f.name.startsWith('padding')) {
      const sub = idl.types.find((x) => x.name === (f.type.defined.name || f.type.defined))
      if (sub?.type.kind === 'struct') Object.assign(out, offsets(idl, sub.name, at, `${prefix}${f.name}.`))
    }
    at += sizeOf(idl, f.type)
  }
  out[`${prefix}__end`] = at
  return out
}

// ---- validator --------------------------------------------------------------------------------

function startValidator() {
  const ledger = mkdtempSync(join(tmpdir(), 'qp-meteora-spike-'))
  const args = ['--reset', '--quiet', '--ledger', ledger, '--rpc-port', '8899', '--account-dir', join(fixtures, 'accounts')]
  for (const f of readdirSync(join(fixtures, 'programs'))) {
    if (f.endsWith('.so')) args.push('--bpf-program', f.slice(0, -3), join(fixtures, 'programs', f))
  }
  const child = spawn('solana-test-validator', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', (d) => process.stderr.write(`[validator] ${d}`))
  return { child, ledger }
}

async function waitFor(connection) {
  for (let i = 0; i < 120; i++) {
    try {
      await connection.getSlot()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('validator did not start')
}

// ---- helpers ----------------------------------------------------------------------------------

let connection
async function fund(...keys) {
  for (const k of keys) {
    const sig = await connection.requestAirdrop(k.publicKey, 1000 * LAMPORTS_PER_SOL)
    await connection.confirmTransaction(sig, 'confirmed')
  }
}

async function send(label, txs, signers, { expectFail = false, units = 1_000_000 } = {}) {
  const ixs = [txs].flat().flatMap((t) => t.instructions || [t])
  const tx = new Transaction()
  if (!ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units }))
  }
  tx.add(...ixs)
  tx.feePayer = signers[0].publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
  tx.partialSign(...signers)
  const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: true })
    const info = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    if (info?.meta?.err) throw Object.assign(new Error(JSON.stringify(info.meta.err)), { logs: info.meta.logMessages })
    console.log(`  ✓ ${label} (${size} B, ${info?.meta?.computeUnitsConsumed ?? '?'} CU)`)
    return { ok: true, sig, size, logs: info?.meta?.logMessages || [] }
  } catch (e) {
    let logs = e.logs || e.transactionLogs || []
    if (!logs.length && e.signature) {
      const info = await connection.getTransaction(e.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      logs = info?.meta?.logMessages || []
    }
    const tail = logs.filter((l) => /Error|error|failed|log: [A-Z]/.test(l) && !/Instruction:/.test(l)).slice(-4)
    console.log(`  ${expectFail ? '✓ (expected failure)' : '✗'} ${label}: ${e.message.slice(0, 160)}`)
    tail.forEach((l) => console.log(`      ${l}`))
    if (!expectFail) throw e
    return { ok: false, size, error: e.message, logs }
  }
}

const sol = (n) => new BN(Math.round(n * LAMPORTS_PER_SOL))

// ---- run --------------------------------------------------------------------------------------

async function main() {
  // --external: use a validator that is already running on :8899 (e.g. the Docker one from
  // `scripts/anchor-docker.sh validator <id> <authority>`), which is the only option on Windows.
  const external = process.argv.includes('--external')
  const { child, ledger } = external ? {} : startValidator()
  connection = new Connection(RPC, 'confirmed')
  try {
    await waitFor(connection)
    console.log('validator up')
    await run()
  } finally {
    if (!external && !process.argv.includes('--keep')) {
      child.kill()
      await new Promise((r) => setTimeout(r, 1500))
      try {
        rmSync(ledger, { recursive: true, force: true })
      } catch {}
    }
    writeFileSync(join(here, 'meteora-spike.json'), JSON.stringify(results, null, 2) + '\n')
    console.log(`\nresults → ${join(here, 'meteora-spike.json')}`)
  }
}

async function run() {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const amm = new CpAmm(connection)
  const [partner, launcher, well, trader, keeper] = Array.from({ length: 5 }, () => Keypair.generate())
  await fund(partner, launcher, well, trader, keeper)

  // Account layouts straight from the IDLs.
  // VirtualPool wraps a single PoolState; flatten its field names
  results.offsets.dbcVirtualPool = Object.fromEntries(
    Object.entries(offsets(DynamicBondingCurveIdl, 'VirtualPool')).map(([k, v]) => [k.replace(/^pool_state\./, ''), v]),
  )
  results.offsets.dbcPoolConfig = offsets(DynamicBondingCurveIdl, 'PoolConfig')
  results.offsets.dammPool = offsets(CpAmmIdl, 'Pool')
  results.offsets.dammPosition = offsets(CpAmmIdl, 'Position')
  results.offsets.dammConfig = offsets(CpAmmIdl, 'Config')

  // 1. Quant Pad's config (test values: 5 SOL threshold; a steep anti-sniper scheduler so the
  //    first-swap exemption is easy to see: 50% → 1% over 10 minutes).
  const configKp = Keypair.generate()
  const params = buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 5000, endingFeeBps: 100, numberOfPeriod: 60, totalDuration: 600 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 100,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: { feePercentage: 2, creatorFeePercentage: 100 },
      migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Disabled, poolFeeBps: 100 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 5,
  })
  await send(
    'create config',
    await dbc.partner.createConfig({
      config: configKp.publicKey,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      quoteMint: NATIVE_MINT,
      payer: partner.publicKey,
      ...params,
    }),
    [partner, configKp],
  )

  // 2. T2 instruction order vs DBC's first-swap fee exemption. Each order launches its own coin;
  //    the scheduler starts at 5000 bps, so an exempt dev buy pays ~100 bps and a non-exempt 5000.
  const program = dbc.pool.program
  const poolAuthority = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], program.programId)[0]
  const { createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } = await import('@solana/spl-token')
  const { SystemProgram } = await import('@solana/web3.js')
  const buyIn = sol(0.5)

  async function launch(order) {
    const mint = Keypair.generate()
    const pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKp.publicKey)
    const create = await dbc.creator.createPool({
      // worst case for size: Metaplex's limits (32-byte name, 10-byte symbol, 200-byte URI)
      name: 'Quant Pad Spike Coin Name 32 byt',
      symbol: 'SPIKEQP123',
      uri: 'https://quantpad.example.com/m/'.padEnd(200, 'a'),
      payer: launcher.publicKey,
      poolCreator: launcher.publicKey,
      config: configKp.publicKey,
      baseMint: mint.publicKey,
    })
    // the SDK's transfer and swap builders need the pool to exist already, so build both from
    // the IDL program (this is how the launch transaction will be built anyway)
    const transfer = await program.methods
      .transferPoolCreator()
      .accountsPartial({ virtualPool: pool, config: configKp.publicKey, creator: launcher.publicKey, newCreator: well.publicKey })
      .instruction()
    const launcherBase = getAssociatedTokenAddressSync(mint.publicKey, launcher.publicKey, false, TOKEN_PROGRAM_ID)
    const launcherWsol = getAssociatedTokenAddressSync(NATIVE_MINT, launcher.publicKey, false, TOKEN_PROGRAM_ID)
    const baseVault = PublicKey.findProgramAddressSync([Buffer.from('token_vault'), mint.publicKey.toBuffer(), pool.toBuffer()], program.programId)[0]
    const quoteVault = PublicKey.findProgramAddressSync([Buffer.from('token_vault'), NATIVE_MINT.toBuffer(), pool.toBuffer()], program.programId)[0]
    const swapIx = await program.methods
      .swap2({ amount0: buyIn, amount1: new BN(0), swapMode: SwapMode.ExactIn })
      .accountsPartial({
        poolAuthority,
        config: configKp.publicKey,
        pool,
        inputTokenAccount: launcherWsol,
        outputTokenAccount: launcherBase,
        baseVault,
        quoteVault,
        baseMint: mint.publicKey,
        quoteMint: NATIVE_MINT,
        payer: launcher.publicKey,
        tokenBaseProgram: TOKEN_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
      })
      // DBC only grants the first-swap minimum fee when it can see the create instruction
      .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }])
      .instruction()
    const wrap = [
      createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, launcherWsol, launcher.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: launcher.publicKey, toPubkey: launcherWsol, lamports: buyIn.toNumber() }),
      createSyncNativeInstruction(launcherWsol),
      createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, launcherBase, launcher.publicKey, mint.publicKey),
    ]
    const unwrap = createCloseAccountInstruction(launcherWsol, launcher.publicKey, launcher.publicKey)
    const steps = {
      'wrap→create→buy': [...wrap.slice(0, 3), create, wrap[3], swapIx, unwrap],
      'create→buy': [create, ...wrap, swapIx, unwrap],
      'create→transfer→buy': [create, transfer, ...wrap, swapIx, unwrap],
      'wrap→create→buy→transfer': [...wrap.slice(0, 3), create, wrap[3], swapIx, transfer, unwrap],
    }[order]
    const res = await send(`T2 ${order}`, steps, [launcher, mint])
    const v = await dbc.state.getPool(pool)
    const st = v.poolState ?? v
    const fee = BigInt(st.creatorQuoteFee.toString()) + BigInt(st.protocolQuoteFee.toString()) + BigInt(st.partnerQuoteFee.toString())
    return { mint, pool, size: res.size, feeBps: Number((fee * 10000n) / BigInt(buyIn.toString())), creator: st.creator }
  }

  const orders = {}
  for (const order of ['wrap→create→buy', 'create→buy', 'create→transfer→buy', 'wrap→create→buy→transfer']) {
    const r = await launch(order)
    orders[order] = { devBuyFeeBps: r.feeBps, bytesWithoutLookupTable: r.size, creatorIsWell: r.creator.equals(well.publicKey) }
    if (order === 'wrap→create→buy→transfer') var bound = r
  }
  answer('firstSwapExemptionByOrder', orders)
  results.sizes.t2NoLookupTable = bound.size
  const { mint, pool } = bound
  const poolState = async () => {
    const v = await dbc.state.getPool(pool)
    return v.poolState ?? v
  }
  let state = await poolState()
  answer('creatorAfterT2', state.creator.equals(well.publicKey) ? 'well' : state.creator.toBase58())

  // offsets: raw bytes vs SDK decode
  const raw = (await connection.getAccountInfo(pool)).data
  const vp = results.offsets.dbcVirtualPool
  const checks = {
    config: raw.subarray(vp.config, vp.config + 32).equals(configKp.publicKey.toBuffer()),
    creator: raw.subarray(vp.creator, vp.creator + 32).equals(well.publicKey.toBuffer()),
    baseMint: raw.subarray(vp.base_mint, vp.base_mint + 32).equals(mint.publicKey.toBuffer()),
    quoteReserve: raw.readBigUInt64LE(vp.quote_reserve).toString() === state.quoteReserve.toString(),
    creatorQuoteFee: raw.readBigUInt64LE(vp.creator_quote_fee).toString() === state.creatorQuoteFee.toString(),
    size: raw.length === vp.__end,
  }
  answer('virtualPoolOffsetsMatchIdl', checks)

  // 3. zero-amount creator claim (nothing new accrued since... claim twice in a row)
  const claim = () =>
    dbc.creator.claimCreatorTradingFee2({
      creator: well.publicKey,
      payer: well.publicKey,
      pool,
      maxBaseAmount: new BN('18446744073709551615'),
      maxQuoteAmount: new BN('18446744073709551615'),
      receiver: well.publicKey,
    })
  await send('creator claims trading fee', await claim(), [well])
  const again = await send('creator claims again with nothing accrued', await claim(), [well], { expectFail: true })
  answer('zeroDbcClaimReverts', again.ok ? 'no (succeeds with zero)' : `yes: ${again.error.slice(0, 120)}`)

  // 4. trades fill the curve (PartialFill on the last buy)
  const swap = async (who, amount, mode) =>
    dbc.pool.swap2({ owner: who.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, swapMode: mode, amountIn: amount, minimumAmountOut: new BN(0) })
  await send('trader buys 2 SOL', await swap(trader, sol(2), SwapMode.ExactIn), [trader])
  // PartialFill stops at the threshold however high the anti-sniper fee still is
  await send('trader buys up to 40 SOL (partial fill to the threshold)', await swap(trader, sol(40), SwapMode.PartialFill), [trader])
  state = await poolState()
  answer('curveComplete', { migrationProgress: state.migrationProgress, finishCurveTimestamp: state.finishCurveTimestamp.toString(), quoteReserve: state.quoteReserve.toString() })
  const blocked = await send('transfer creator after completion', await dbc.creator.transferPoolCreator({ pool, creator: well.publicKey, newCreator: launcher.publicKey }), [well], { expectFail: true })
  answer('transferBlockedBetweenCompletionAndMigration', !blocked.ok)

  // 5. creator surplus
  const beforeSurplus = await connection.getBalance(well.publicKey)
  const surplus = await send('creator withdraws surplus', await dbc.creator.creatorWithdrawSurplus({ creator: well.publicKey, pool }), [well], { expectFail: true })
  answer('creatorSurplus', surplus.ok ? `received ${(await connection.getBalance(well.publicKey)) - beforeSurplus} lamports (net of fees)` : `reverted: ${surplus.error.slice(0, 120)}`)

  // 6. migration (keeper pays) into the Customizable DAMM v2 config
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.Customizable]
  const mig = await dbc.migration.migrateToDammV2({ payer: keeper.publicKey, pool, dammConfig })
  await send('migration_damm_v2', mig.transaction, [keeper, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], { units: 1_400_000 })
  state = await poolState()
  answer('afterMigration', { isMigrated: state.isMigrated, migrationProgress: state.migrationProgress })
  const dammPool = deriveDammV2PoolAddress(dammConfig, mint.publicKey, NATIVE_MINT)
  const ps = await amm.fetchPoolState(dammPool)
  answer('dammPool', {
    address: dammPool.toBase58(),
    tokenAIsBase: ps.tokenAMint.equals(mint.publicKey),
    collectFeeMode: ps.collectFeeMode,
    poolStatus: ps.poolStatus,
    creatorField: ps.creator.toBase58() === poolAuthority.toBase58() ? 'DBC pool_authority' : ps.creator.toBase58(),
  })
  const positions = await amm.getUserPositionByPool(dammPool, well.publicKey)
  answer('wellOwnsCreatorPosition', positions.map((p) => ({ position: p.position.toBase58(), permanentLocked: p.positionState.permanentLockedLiquidity.toString(), unlocked: p.positionState.unlockedLiquidity.toString() })))
  const dpRaw = (await connection.getAccountInfo(dammPool)).data
  const dp = results.offsets.dammPool
  answer('dammPoolOffsetsMatchIdl', {
    tokenAMint: dpRaw.subarray(dp.token_a_mint, dp.token_a_mint + 32).equals(ps.tokenAMint.toBuffer()),
    tokenBMint: dpRaw.subarray(dp.token_b_mint, dp.token_b_mint + 32).equals(ps.tokenBMint.toBuffer()),
    collectFeeMode: dpRaw[dp.collect_fee_mode] === ps.collectFeeMode,
    poolStatus: dpRaw[dp.pool_status] === ps.poolStatus,
    size: dpRaw.length === dp.__end,
  })
  const cfgRaw = (await connection.getAccountInfo(dammConfig)).data
  const dc = results.offsets.dammConfig
  answer('dammConfigPoolCreatorAuthorityIsDbc', cfgRaw.subarray(dc.pool_creator_authority, dc.pool_creator_authority + 32).equals(poolAuthority.toBuffer()))

  // 7. creator migration fee
  const beforeMig = await connection.getBalance(well.publicKey)
  const migFee = await send('creator withdraws migration fee', await dbc.creator.creatorWithdrawMigrationFee({ pool, sender: well.publicKey }), [well], { expectFail: true })
  answer('creatorMigrationFee', migFee.ok ? `received ~${(await connection.getBalance(well.publicKey)) - beforeMig} lamports` : `reverted: ${migFee.error.slice(0, 120)}`)

  // 8. DAMM trades, then position fee claims (and a zero claim)
  const tokenAProgram = getTokenProgram(ps.tokenAFlag)
  const tokenBProgram = getTokenProgram(ps.tokenBFlag)
  const dammSwap = (who, amount) =>
    amm.swap2({
      payer: who.publicKey,
      pool: dammPool,
      inputTokenMint: NATIVE_MINT,
      outputTokenMint: mint.publicKey,
      tokenAMint: ps.tokenAMint,
      tokenBMint: ps.tokenBMint,
      tokenAVault: ps.tokenAVault,
      tokenBVault: ps.tokenBVault,
      tokenAProgram,
      tokenBProgram,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn: amount,
      minimumAmountOut: new BN(0),
    })
  await send('trader buys 1 SOL on DAMM v2', await dammSwap(trader, sol(1)), [trader])
  const pos = positions[0]
  const claimPos = async () =>
    amm.claimPositionFee2({
      owner: well.publicKey,
      position: pos.position,
      pool: dammPool,
      positionNftAccount: pos.positionNftAccount,
      tokenAMint: ps.tokenAMint,
      tokenBMint: ps.tokenBMint,
      tokenAVault: ps.tokenAVault,
      tokenBVault: ps.tokenBVault,
      tokenAProgram,
      tokenBProgram,
      receiver: well.publicKey,
    })
  if (pos) {
    await send('creator claims DAMM position fee', await claimPos(), [well])
    const zero = await send('creator claims DAMM position fee again', await claimPos(), [well], { expectFail: true })
    answer('zeroDammClaimReverts', zero.ok ? 'no (succeeds with zero)' : `yes: ${zero.error.slice(0, 120)}`)

    // 9. add liquidity to the permanently locked position, then lock it
    await send('well buys 1 SOL of base on DAMM', await dammSwap(well, sol(1)), [well])
    const fresh = await amm.fetchPoolState(dammPool)
    const baseBal = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint.publicKey, well.publicKey))
    const delta = amm.getLiquidityDelta({
      maxAmountTokenA: new BN(baseBal.value.amount).divn(2),
      maxAmountTokenB: sol(5),
      sqrtPrice: fresh.sqrtPrice,
      sqrtMinPrice: fresh.sqrtMinPrice,
      sqrtMaxPrice: fresh.sqrtMaxPrice,
      collectFeeMode: fresh.collectFeeMode,
    })
    const add = await send(
      'add liquidity to the permanently locked creator position',
      await amm.addLiquidity({
        owner: well.publicKey,
        position: pos.position,
        pool: dammPool,
        positionNftAccount: pos.positionNftAccount,
        liquidityDelta: delta,
        maxAmountTokenA: new BN(baseBal.value.amount),
        maxAmountTokenB: sol(5),
        tokenAAmountThreshold: new BN(baseBal.value.amount),
        tokenBAmountThreshold: sol(5),
        tokenAMint: fresh.tokenAMint,
        tokenBMint: fresh.tokenBMint,
        tokenAVault: fresh.tokenAVault,
        tokenBVault: fresh.tokenBVault,
        tokenAProgram,
        tokenBProgram,
      }),
      [well],
      { expectFail: true },
    )
    answer('addLiquidityToLockedPosition', add.ok)
    if (add.ok) {
      const lock = await send('permanently lock the added liquidity', await amm.permanentLockPosition({ owner: well.publicKey, position: pos.position, positionNftAccount: pos.positionNftAccount, pool: dammPool, unlockedLiquidity: delta }), [well], { expectFail: true })
      const after = await amm.fetchPositionState(pos.position)
      answer('permanentLockAfterAdd', { ok: lock.ok, unlocked: after.unlockedLiquidity.toString(), permanentLocked: after.permanentLockedLiquidity.toString() })
      const pr = (await connection.getAccountInfo(pos.position)).data
      const po = results.offsets.dammPosition
      answer('positionOffsetsMatchIdl', {
        pool: pr.subarray(po.pool, po.pool + 32).equals(dammPool.toBuffer()),
        nftMint: pr.subarray(po.nft_mint, po.nft_mint + 32).equals(after.nftMint.toBuffer()),
        size: pr.length === po.__end,
      })
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
