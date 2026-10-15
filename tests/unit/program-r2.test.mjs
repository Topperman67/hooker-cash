// Program group, round 2: claim delay / cancel / cadence (K1), versioned config updates and
// set_paused (K2), public burn / fusion limits, graduation recorded by sync (K3), owed pulse
// payments (K4),
// owner-checked account reads and the authority CLI. Offline checks of shared/quantum.mjs, the
// regenerated IDL, scripts/init-config.mjs and scripts/program-ops.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import BN from 'bn.js'
import { BorshCoder } from '@coral-xyz/anchor'
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import * as q from '../../shared/quantum.mjs'
import {
  CONFIG,
  dammPoolAccount,
  dammPoolFor,
  dammPositionAccount,
  dbcConfigAccount,
  dbcPoolAccount,
  dbcPoolFor,
} from './meteora-chain.mjs'
import { parseArgs } from '../../scripts/init-config.mjs'
import * as ops from '../../scripts/program-ops.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const src = (file) =>
  readFileSync(`${root}programs/quantum-hooks/programs/quantum_hooks/src/${file}`, 'utf8')
const idl = q.QUANTUM_IDL
const coder = new BorshCoder(idl)
const key = () => Keypair.generate().publicKey
const zero = new BN(0)

// ---------------------------------------------------------------------------------------------
// Fixtures: accounts encoded with the real IDL.

async function quantumData(mint, overrides = {}) {
  return coder.accounts.encode('Quantum', {
    mint,
    launcher: key(),
    bump: 255,
    well_bump: 255,
    created_at: new BN(1_700_000_000),
    creator_bps: 10_000,
    burn_bps: 0,
    entangle_bps: 0,
    fusion_bps: 0,
    split_count: 0,
    splits: Array(4).fill({ wallet: PublicKey.default, bps: 0 }),
    burn_reserve: zero,
    entangle_reserve: zero,
    entangle_owed: zero,
    fusion_reserve: zero,
    total_collected: zero,
    total_protocol: zero,
    total_creator_paid: zero,
    total_burn_sol: zero,
    total_burned_tokens: zero,
    total_claimed: zero,
    total_fused_sol: zero,
    epoch_count: 0,
    locked_amount: zero,
    released_amount: zero,
    lock_start: zero,
    lock_cliff: zero,
    lock_end: zero,
    last_burn_at: zero,
    last_fusion_at: zero,
    planned_cliff_secs: zero,
    planned_duration_secs: zero,
    last_epoch_at: zero,
    graduated_at: zero,
    split_owed: Array(4).fill(zero),
    launcher_owed: zero,
    protocol_owed: zero,
    dbc_config: new PublicKey(CONFIG),
    dbc_pool: new PublicKey(dbcPoolFor(mint)),
    damm_pool: PublicKey.default,
    damm_position: PublicKey.default,
    damm_nft_account: PublicKey.default,
    bound_at: zero,
    birth_bound: false,
    migrated_at: zero,
    total_harvested: zero,
    total_fused_liquidity: zero,
    reserved: Array(16).fill(0),
    ...overrides,
  })
}

async function configData(overrides = {}) {
  const k = key()
  return coder.accounts.encode('Config', {
    authority: k,
    treasury: k,
    keeper: k,
    protocol_bps: 100,
    max_burn_lamports: new BN(1_000_000_000),
    min_action_interval: new BN(3600),
    keeper_grace: new BN(86_400),
    paused: false,
    bump: 255,
    claim_delay: new BN(21_600),
    version: new BN(7),
    launch_configs: [new PublicKey(CONFIG), ...Array(3).fill(PublicKey.default)],
    launch_config_count: 1,
    reserved: Array(48).fill(0),
    ...overrides,
  })
}

// Accounts listed without an owner are Quantum Hooks accounts (the client checks the owner).
const withOwner = (info) => info && { owner: q.QUANTUM_PROGRAM_ID, lamports: 1, ...info }
const fakeConnection = (accounts, calls = [], tokenAccounts = []) => ({
  getTokenAccountsByOwner: async (owner, { programId }) => ({
    value: tokenAccounts.filter((t) => t.owner.equals(owner) && t.account.owner.equals(programId)),
  }),
  getMultipleAccountsInfo: async (keys) => {
    calls.push(keys.length)
    return keys.map((k) => withOwner(accounts.get(k.toBase58())) ?? null)
  },
  getAccountInfo: async (k) => {
    calls.push(1)
    return withOwner(accounts.get(k.toBase58())) ?? null
  },
})

const positionOf = (nftMint) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('position'), nftMint.toBuffer()],
    new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'),
  )[0]
const decodeIx = (ix) => coder.instruction.decode(Buffer.from(ix.data))
const keyAt = (ix, name, instruction) => {
  const accounts = idl.instructions.find((i) => i.name === instruction).accounts
  return ix.keys[accounts.findIndex((a) => a.name === name)]
}

// ---------------------------------------------------------------------------------------------
// IDL and constants

test('IDL: cancel_epoch and set_paused exist, update_config is versioned and cannot pause', () => {
  assert.equal(idl.address, 'FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK')
  const ix = (name) => idl.instructions.find((i) => i.name === name)
  assert.deepEqual(
    ix('update_config').args.map((a) => a.name),
    [
      'expected_version',
      'treasury',
      'keeper',
      'protocol_bps',
      'max_burn_lamports',
      'min_action_interval',
      'keeper_grace',
      'claim_delay',
      'new_authority',
    ],
  )
  assert.deepEqual(
    ix('set_paused').args.map((a) => a.name),
    ['paused'],
  )
  assert.ok(ix('initialize_config').args.some((a) => a.name === 'claim_delay'))
  assert.deepEqual(
    ix('cancel_epoch').accounts.map((a) => [a.name, !!a.signer, !!a.writable]),
    [
      ['authority', true, false],
      ['config', false, false],
      ['quantum', false, true],
      ['epoch', false, true],
      ['keeper', false, true],
    ],
  )
  for (const name of ['quantum_burn', 'fusion']) {
    const sysvar = ix(name).accounts.find((a) => a.name === 'instructions_sysvar')
    assert.equal(sysvar?.address, SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), name)
  }
  // Graduation is recorded by sync, whose DAMM v2 accounts are optional until the coin migrates.
  assert.deepEqual(
    ix('sync')
      .accounts.filter((a) => a.optional)
      .map((a) => a.name),
    ['damm_config', 'damm_pool', 'damm_position', 'damm_nft_account'],
  )
  const fields = (name) => idl.types.find((t) => t.name === name).type.fields.map((f) => f.name)
  assert.ok(fields('Epoch').includes('claim_start'))
  assert.ok(fields('EpochPosted').includes('claim_start'))
  assert.deepEqual(fields('EpochCancelled'), ['mint', 'index', 'returned', 'rent_to'])
  for (const f of ['claim_delay', 'version']) assert.ok(fields('Config').includes(f), f)
  for (const f of [
    'last_epoch_at',
    'graduated_at',
    'split_owed',
    'launcher_owed',
    'protocol_owed',
    'migrated_at',
  ])
    assert.ok(fields('Quantum').includes(f), f)
  assert.ok(fields('Pulsed').includes('owed_paid'))
})

test('IDL: the error codes are errors.rs in order (the frontend explains them from the IDL)', () => {
  const rust = [...src('errors.rs').matchAll(/^\s{4}([A-Z]\w+),$/gm)].map((m) => m[1])
  assert.deepEqual(
    idl.errors.map((e) => e.name),
    rust,
  )
  idl.errors.forEach((e, i) => assert.equal(e.code, 6000 + i, e.name))
  const code = (name) => idl.errors.find((e) => e.name === name)?.code
  assert.equal(code('InvalidAllocation'), 6000)
  assert.equal(code('Paused'), 6007)
  assert.equal(code('NothingToPulse'), 6016)
  for (const name of [
    'ConfigChanged',
    'ClaimNotOpen',
    'CancelWindowClosed',
    'EpochTooSoon',
    'PublicTransactionNotAllowed',
    'LaunchConfigNotAllowed',
    'NotBound',
    'VenueUnavailable',
    'NotCanonicalDammPool',
    'NotMigrated',
  ])
    assert.ok(code(name) >= 6000, name)
})

test('constants: the client and init-config use the program values', () => {
  const constants = src('constants.rs')
  const prod = (name) => {
    const m = new RegExp(
      `#\\[cfg\\(not\\(feature = "short-expiry"\\)\\)\\]\\s*pub const ${name}: i64 = ([\\d_ *]+);`,
    ).exec(constants)
    return eval(m[1].replaceAll('_', '')) // e.g. "20 * 3_600"
  }
  assert.equal(prod('MIN_EPOCH_INTERVAL'), q.MIN_EPOCH_INTERVAL)
  assert.equal(q.MIN_EPOCH_INTERVAL, 72_000)
  assert.equal(prod('EPOCH_TTL'), 30 * 86_400)
  const maxDelay = /pub const MAX_CLAIM_DELAY: i64 = ([\d_ *]+);/.exec(constants)[1]
  assert.equal(eval(maxDelay.replaceAll('_', '')), q.MAX_CLAIM_DELAY)
  assert.equal(q.MAX_CLAIM_DELAY, 604_800)
  assert.equal(q.DEFAULT_CLAIM_DELAY, 21_600)
  assert.match(constants, /pub const PUBLIC_SPEND_DIVISOR: u64 = 10;/)
  assert.equal(q.PUBLIC_SPEND_DIVISOR, 10n)
  // The short test build shortens the cadence the same way it shortens expiry.
  assert.match(
    constants,
    /#\[cfg\(feature = "short-expiry"\)\]\s*pub const MIN_EPOCH_INTERVAL: i64 = 15;/,
  )
})

// ---------------------------------------------------------------------------------------------
// Decoders

test('decodeConfig exposes claimDelay and version; publicSpendCap is a tenth of max_burn_lamports', async () => {
  const config = q.decodeConfig(
    await configData({ claim_delay: new BN(3600), version: new BN(42) }),
  )
  assert.equal(config.claimDelay, 3600)
  assert.equal(config.version, 42)
  assert.equal(typeof config.version, 'number')
  assert.equal(q.publicSpendCap(config), 100_000_000n)
  assert.equal(q.publicSpendCap({ maxBurnLamports: 9n }), 0n)
})

test('decodeEpoch exposes claimStart; isEpochClaimable is [claimStart, expiresAt)', async () => {
  const mint = key()
  const data = await coder.accounts.encode('Epoch', {
    mint,
    index: 2,
    root: Array(32).fill(1),
    total: new BN(5),
    claimed: zero,
    leaf_count: 1,
    created_at: new BN(1000),
    claim_start: new BN(1000 + 21_600),
    expires_at: new BN(1000 + 30 * 86_400),
    payer: key(),
    bump: 1,
    bitmap: Buffer.alloc(1),
  })
  const epoch = q.decodeEpoch(data)
  assert.equal(epoch.claimStart, 22_600)
  assert.equal(typeof epoch.claimStart, 'number')
  assert.equal(q.isEpochClaimable(epoch, 22_599), false)
  assert.equal(q.isEpochClaimable(epoch, 22_600), true)
  assert.equal(q.isEpochClaimable(epoch, epoch.expiresAt - 1), true)
  assert.equal(q.isEpochClaimable(epoch, epoch.expiresAt), false)
})

test('decodeQuantum exposes owed amounts, lastEpochAt and graduatedAt; owed lamports are reserved', async () => {
  const mint = key()
  const splits = [
    { wallet: key(), bps: 100 },
    { wallet: key(), bps: 200 },
    { wallet: PublicKey.default, bps: 0 },
    { wallet: PublicKey.default, bps: 0 },
  ]
  const data = await quantumData(mint, {
    split_count: 2,
    splits,
    burn_reserve: new BN(1_000),
    last_epoch_at: new BN(1_700_000_500),
    graduated_at: new BN(1_700_001_000),
    split_owed: [new BN(475_000), new BN(0), zero, zero],
    launcher_owed: new BN(300_000),
    protocol_owed: new BN(25_000),
  })
  const quantum = q.decodeQuantum(data)
  assert.deepEqual(quantum.splitOwed, [475_000n, 0n])
  assert.equal(quantum.launcherOwed, 300_000n)
  assert.equal(quantum.protocolOwed, 25_000n)
  assert.equal(quantum.owedTotal, 800_000n)
  assert.equal(quantum.lastEpochAt, 1_700_000_500)
  assert.equal(quantum.graduatedAt, 1_700_001_000)
  assert.equal(q.nextEpochAt(quantum), 1_700_000_500 + 72_000)

  // The well's free lamports exclude what pulse owes (it is not re-split).
  const accounts = new Map([
    [
      q.wellPda(mint).toBase58(),
      { lamports: Number(q.RENT_EXEMPT_EMPTY) + 801_000 + 5, owner: SystemProgram.programId },
    ],
    [q.quantumPda(mint).toBase58(), { data }],
  ])
  const well = await q.fetchWellBalance(fakeConnection(accounts), mint)
  assert.equal(well.reserved, 801_000n)
  assert.equal(well.unallocated, 5n)
  assert.equal(await q.pendingCreatorFees(fakeConnection(accounts), mint), 5n)
})

// ---------------------------------------------------------------------------------------------
// Config builders

test('buildUpdateConfigInstruction sends the version it read (or the one given) and refuses `paused`', async () => {
  const authority = key()
  const accounts = new Map([[q.configPda().toBase58(), { data: await configData() }]])
  const connection = fakeConnection(accounts)
  const ix = await q.buildUpdateConfigInstruction({
    connection,
    authority,
    claimDelay: 3600,
    protocolBps: 250,
  })
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [authority.toBase58(), true, false],
      [q.configPda().toBase58(), false, true],
    ],
  )
  const decoded = decodeIx(ix)
  assert.equal(decoded.name, 'update_config')
  assert.equal(decoded.data.expected_version.toString(), '7')
  assert.equal(decoded.data.claim_delay.toString(), '3600')
  assert.equal(decoded.data.protocol_bps, 250)
  assert.equal(
    decoded.data.keeper_grace.toString(),
    '86400',
    'unchanged fields come from the chain',
  )
  assert.equal('paused' in decoded.data, false)

  const pinned = decodeIx(
    await q.buildUpdateConfigInstruction({ connection, authority, expectedVersion: 3 }),
  )
  assert.equal(pinned.data.expected_version.toString(), '3')
  await assert.rejects(
    q.buildUpdateConfigInstruction({ connection, authority, paused: false }),
    /buildSetPausedInstruction/,
  )
  await assert.rejects(
    q.buildUpdateConfigInstruction({ connection: fakeConnection(new Map()), authority }),
    /not initialized/,
  )
})

test('buildSetPausedInstruction: authority + config, boolean only, no RPC', async () => {
  const authority = key()
  const offline = {
    getAccountInfo: async () => assert.fail('no RPC call'),
    getMultipleAccountsInfo: async () => assert.fail('no RPC call'),
  }
  for (const paused of [true, false]) {
    const ix = await q.buildSetPausedInstruction({ connection: offline, authority, paused })
    assert.ok(ix.programId.equals(q.QUANTUM_PROGRAM_ID))
    assert.deepEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      [
        [authority.toBase58(), true, false],
        [q.configPda().toBase58(), false, true],
      ],
    )
    const decoded = decodeIx(ix)
    assert.equal(decoded.name, 'set_paused')
    assert.equal(decoded.data.paused, paused)
  }
  await assert.rejects(
    q.buildSetPausedInstruction({ connection: offline, authority, paused: 'yes' }),
    /true or false/,
  )
})

test('buildInitializeConfigInstruction defaults claim_delay to 6 hours', async () => {
  const args = {
    connection: null,
    authority: key(),
    treasury: key(),
    keeper: key(),
    protocolBps: 0,
    maxBurnLamports: 1n,
    minActionInterval: 0,
    keeperGrace: 0,
  }
  const plain = decodeIx(await q.buildInitializeConfigInstruction(args))
  assert.equal(plain.data.claim_delay.toString(), '21600')
  const set = decodeIx(await q.buildInitializeConfigInstruction({ ...args, claimDelay: 60 }))
  assert.equal(set.data.claim_delay.toString(), '60')
})

test('buildCancelEpochInstruction({ connection, authority, mint, index }): rent goes to config.keeper', async () => {
  const mint = key()
  const authority = key()
  const keeper = key()
  const calls = []
  const accounts = new Map([[q.configPda().toBase58(), { data: await configData({ keeper }) }]])
  const ix = await q.buildCancelEpochInstruction({
    connection: fakeConnection(accounts, calls),
    authority,
    mint: mint.toBase58(),
    index: 4,
  })
  assert.ok(calls.length > 0, 'reads the keeper from the config')
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [authority.toBase58(), true, false],
      [q.configPda().toBase58(), false, false],
      [q.quantumPda(mint).toBase58(), false, true],
      [q.epochPda(mint, 4).toBase58(), false, true],
      [keeper.toBase58(), false, true],
    ],
  )
  const decoded = decodeIx(ix)
  assert.equal(decoded.name, 'cancel_epoch')
  assert.equal(decoded.data.index, 4)
  const given = await q.buildCancelEpochInstruction({
    connection: {
      getAccountInfo: async () => assert.fail('no RPC call when the keeper is given'),
      getMultipleAccountsInfo: async () => assert.fail('no RPC call when the keeper is given'),
    },
    authority,
    mint,
    index: 1,
    keeper,
  })
  assert.ok(given.keys[4].pubkey.equals(keeper))
  await assert.rejects(
    q.buildCancelEpochInstruction({
      connection: fakeConnection(new Map()),
      authority,
      mint,
      index: 0,
    }),
    /not initialized/,
  )
})

// ---------------------------------------------------------------------------------------------
// Pulse: the migration is recorded by sync

test("buildPulseInstructions records a migration (DAMM v2 pool and the well's position) before harvesting its LP fee", async () => {
  const mint = key()
  const well = q.wellPda(mint)
  const nftMint = key()
  const nftAccount = key()
  const dammPool = dammPoolFor(mint.toBase58())
  // The well's position NFT: a Token-2022 account holding 1.
  const nft = Buffer.alloc(165)
  nftMint.toBuffer().copy(nft, 0)
  well.toBuffer().copy(nft, 32)
  nft.writeBigUInt64LE(1n, 64)
  nft[108] = 1 // initialized
  const tokenAccounts = [
    {
      pubkey: nftAccount,
      owner: well,
      account: { owner: TOKEN_2022_PROGRAM_ID, lamports: 1, data: nft, executable: false },
    },
  ]
  const chain = async ({ migrated, recorded }) =>
    new Map([
      [
        q.quantumPda(mint).toBase58(),
        {
          data: await quantumData(mint, {
            bound_at: new BN(1_700_000_000),
            ...(recorded
              ? {
                  damm_pool: new PublicKey(dammPool),
                  damm_position: positionOf(nftMint),
                  damm_nft_account: nftAccount,
                }
              : {}),
          }),
        },
      ],
      [q.configPda().toBase58(), { data: await configData() }],
      [CONFIG, await dbcConfigAccount()],
      [dbcPoolFor(mint), await dbcPoolAccount(mint.toBase58(), { creator: well, migrated })],
      ...(migrated
        ? [
            [dammPool, await dammPoolAccount(mint.toBase58(), {})],
            [positionOf(nftMint).toBase58(), await dammPositionAccount(dammPool, nftMint)],
          ]
        : []),
    ])
  const pulse = async (accounts) =>
    q.buildPulseInstructions({
      connection: fakeConnection(accounts, [], tokenAccounts),
      payer: key(),
      mint,
    })
  const names = (ixs) => ixs.map((ix) => decodeIx(ix).name)

  // Still on the curve: harvest (no LP leg) and pulse.
  let ixs = await pulse(await chain({ migrated: false }))
  assert.deepEqual(names(ixs), ['harvest', 'pulse'])
  assert.equal(decodeIx(ixs[0]).data.legs, q.HARVEST.ALL & ~q.HARVEST.LP_FEE)

  // Migrated, not recorded: sync names the pool, the position and its NFT account, and the harvest
  // after it claims the position's LP fee too.
  ixs = await pulse(await chain({ migrated: true }))
  assert.deepEqual(names(ixs), ['sync', 'harvest', 'pulse'])
  const sync = ixs[0]
  assert.equal(keyAt(sync, 'damm_pool', 'sync').pubkey.toBase58(), dammPool)
  assert.ok(keyAt(sync, 'damm_position', 'sync').pubkey.equals(positionOf(nftMint)))
  assert.ok(keyAt(sync, 'damm_nft_account', 'sync').pubkey.equals(nftAccount))
  assert.equal(decodeIx(ixs[1]).data.legs, q.HARVEST.ALL)
  assert.equal(keyAt(ixs[1], 'damm_pool', 'harvest').pubkey.toBase58(), dammPool)

  // A position the well does not hold (yet) records nothing: no sync, no LP leg.
  tokenAccounts[0].owner = key()
  ixs = await pulse(await chain({ migrated: true }))
  assert.deepEqual(names(ixs), ['harvest', 'pulse'])
  tokenAccounts[0].owner = well

  // Once recorded, no sync is sent again.
  ixs = await pulse(await chain({ migrated: true, recorded: true }))
  assert.deepEqual(names(ixs), ['harvest', 'pulse'])
  assert.equal(decodeIx(ixs[0]).data.legs, q.HARVEST.ALL)
})

// ---------------------------------------------------------------------------------------------
// scripts/init-config.mjs

test('init-config: --claim-delay (default 21600, 0..604800)', () => {
  const base = [
    '--rpc',
    'http://127.0.0.1:8899',
    '--authority',
    'a.json',
    '--treasury',
    key().toBase58(),
  ]
  assert.equal(parseArgs(base).claimDelay, 21_600)
  assert.equal(parseArgs([...base, '--claim-delay', '0']).claimDelay, 0)
  assert.equal(parseArgs([...base, '--claim-delay', '604800']).claimDelay, 604_800)
  assert.throws(() => parseArgs([...base, '--claim-delay', '604801']), /between 0 and 604800/)
  assert.throws(() => parseArgs([...base, '--claim-delay', '-1']), /needs a value|whole number/)
  assert.throws(() => parseArgs([...base, '--claim-delay']), /needs a value/)
})

// ---------------------------------------------------------------------------------------------
// Account reads check the owner and the discriminator

async function epochData(mint, index, overrides = {}) {
  return coder.accounts.encode('Epoch', {
    mint,
    index,
    root: Array(32).fill(7),
    total: new BN(5_000),
    claimed: zero,
    leaf_count: 1,
    created_at: new BN(1000),
    claim_start: new BN(1000 + 21_600),
    expires_at: new BN(1000 + 30 * 86_400),
    payer: key(),
    bump: 1,
    bitmap: Buffer.alloc(1),
    ...overrides,
  })
}

test('a cancelled epoch PDA re-funded by a plain transfer reads as gone (fetchEpoch, decodeEpoch)', async () => {
  const mint = key()
  const address = q.epochPda(mint, 3).toBase58()
  const live = await epochData(mint, 3)
  // What the chain returns after someone sends 0.001 SOL to the closed account.
  const refunded = { owner: SystemProgram.programId, lamports: 1_000_000, data: Buffer.alloc(0) }
  assert.equal(await q.fetchEpoch(fakeConnection(new Map([[address, refunded]])), mint, 3), null)
  assert.equal(q.decodeEpoch(refunded.data), null, 'raw decoders (the keeper batch read) too')
  assert.equal(q.decodeEpoch(new Uint8Array(0)), null)
  // Epoch bytes in an account another program owns are not an Epoch.
  const foreign = { owner: SystemProgram.programId, lamports: 1, data: live }
  assert.equal(await q.fetchEpoch(fakeConnection(new Map([[address, foreign]])), mint, 3), null)
  // A program-owned account of another type at that address is not one either.
  const other = { data: await configData() }
  assert.equal(await q.fetchEpoch(fakeConnection(new Map([[address, other]])), mint, 3), null)
  assert.equal(q.decodeEpoch(other.data), null)
  // The live account still decodes, through either path.
  const epoch = await q.fetchEpoch(fakeConnection(new Map([[address, { data: live }]])), mint, 3)
  assert.equal(epoch.index, 3)
  assert.deepEqual(q.decodeEpoch(live), epoch)
  // The owner may come from another web3.js copy (the SDKs' CommonJS build) or as a string.
  for (const owner of [q.QUANTUM_PROGRAM_ID.toBase58(), { _bn: q.QUANTUM_PROGRAM_ID._bn }])
    assert.equal(q.isQuantumAccount({ owner, data: live }, 'Epoch'), true)
  assert.equal(q.isQuantumAccount({ owner: 'not a key', data: live }, 'Epoch'), false)
  assert.equal(q.isQuantumAccount(null, 'Epoch'), false)
  assert.equal(q.isQuantumAccount({ data: live }, 'Epoch'), false, 'no owner, no account')
  // Another program id: the caller's programId decides the owner.
  const custom = key()
  assert.equal(q.isQuantumAccount({ owner: custom, data: live }, 'Epoch', custom), true)
  assert.equal(q.isQuantumAccount({ owner: custom, data: live }, 'Epoch'), false)

  // buildCloseEpochInstruction reads the payer through fetchEpoch: a clear error, not a decode one.
  await assert.rejects(
    q.buildCloseEpochInstruction({
      connection: fakeConnection(new Map([[address, refunded]])),
      caller: key(),
      mint,
      index: 3,
    }),
    /does not exist/,
  )
})

test('fetchConfig and fetchQuantum return null for a System-owned or foreign account at the PDA', async () => {
  const mint = key()
  const funded = { owner: SystemProgram.programId, lamports: 5_000_000, data: Buffer.alloc(0) }
  const quantum = await quantumData(mint, { burn_reserve: new BN(4_000_000) })
  const config = await configData()
  const at = (address, info) => fakeConnection(new Map([[address.toBase58(), info]]))
  assert.equal(await q.fetchConfig(at(q.configPda(), funded)), null)
  assert.equal(await q.fetchConfig(at(q.configPda(), { ...funded, data: config })), null)
  assert.equal((await q.fetchConfig(at(q.configPda(), { data: config }))).version, 7)
  assert.equal(await q.fetchQuantum(at(q.quantumPda(mint), funded), mint), null)
  assert.equal(
    await q.fetchQuantum(at(q.quantumPda(mint), { ...funded, data: quantum }), mint),
    null,
  )
  assert.equal(
    (await q.fetchQuantum(at(q.quantumPda(mint), { data: quantum }), mint)).mint,
    mint.toBase58(),
  )
  assert.equal(q.decodeConfig(quantum), null)
  assert.equal(q.decodeQuantum(config), null)
  assert.equal(q.decodeQuantum(Buffer.alloc(0)), null)

  // The well ledger and the registration check ignore a Quantum PDA that is not a Quantum account.
  const wellLamports = Number(q.RENT_EXEMPT_EMPTY) + 9_000
  const accounts = (quantumInfo) =>
    new Map([
      [q.wellPda(mint).toBase58(), { owner: SystemProgram.programId, lamports: wellLamports }],
      [q.quantumPda(mint).toBase58(), quantumInfo],
    ])
  const spoofed = accounts({ ...funded, data: quantum })
  assert.equal((await q.fetchWellBalance(fakeConnection(spoofed), mint)).reserved, 0n)
  assert.equal(await q.pendingCreatorFees(fakeConnection(spoofed), mint), 9_000n)
  assert.equal(
    (await q.verifyQuantumCoin(fakeConnection(accounts(funded)), mint)).registered,
    false,
  )
  assert.equal(
    (await q.verifyQuantumCoin(fakeConnection(accounts({ data: quantum })), mint)).registered,
    true,
  )
  const pulse = (quantumInfo, configInfo = { data: config }) =>
    q.buildPulseInstructions({
      connection: fakeConnection(
        new Map([
          [q.quantumPda(mint).toBase58(), quantumInfo],
          [q.configPda().toBase58(), configInfo],
        ]),
      ),
      payer: key(),
      mint,
    })
  await assert.rejects(pulse(funded), /is not a Quantum coin/)
  await assert.rejects(pulse({ data: quantum }, funded), /config is not initialized/)
})

// ---------------------------------------------------------------------------------------------
// Keeper contract (round 2): the fields and exports server/keeper.mjs reads

test('keeper contract: claimStart, lastEpochAt, claimDelay, MIN_EPOCH_INTERVAL and EpochCancelled', async () => {
  const mint = key()
  assert.equal(q.MIN_EPOCH_INTERVAL, 72_000)
  const epoch = q.decodeEpoch(await epochData(mint, 0, { claim_start: new BN(1_700_000_123) }))
  assert.equal(epoch.claimStart, 1_700_000_123)
  assert.equal(typeof epoch.claimStart, 'number')
  const quantum = q.decodeQuantum(await quantumData(mint, { last_epoch_at: new BN(1_700_000_456) }))
  assert.equal(quantum.lastEpochAt, 1_700_000_456)
  assert.equal(typeof quantum.lastEpochAt, 'number')
  assert.equal(typeof quantum.lastBurnAt, typeof quantum.lastEpochAt, 'like the other i64 fields')
  const config = q.decodeConfig(await configData({ claim_delay: new BN(900) }))
  assert.equal(Number(config.claimDelay), 900)

  const rentTo = key()
  const { discriminator } = idl.events.find((e) => e.name === 'EpochCancelled')
  const body = coder.types.encode('EpochCancelled', {
    mint,
    index: 4,
    returned: new BN(123_456),
    rent_to: rentTo,
  })
  const id = q.QUANTUM_PROGRAM_ID.toBase58()
  const events = q.decodeQuantumEvents([
    `Program ${id} invoke [1]`,
    `Program data: ${Buffer.concat([Buffer.from(discriminator), body]).toString('base64')}`,
    `Program ${id} success`,
  ])
  assert.deepEqual(events, [
    {
      name: 'EpochCancelled',
      data: { mint: mint.toBase58(), index: 4, returned: 123_456n, rentTo: rentTo.toBase58() },
    },
  ])
})

// ---------------------------------------------------------------------------------------------
// scripts/program-ops.mjs (authority CLI)

test('program-ops: one action per run; sending needs a keypair file; flags are validated', () => {
  const rpc = ['--rpc', 'http://127.0.0.1:8899']
  const auth = ['--authority', 'a.json']
  const mint = key().toBase58()
  assert.equal(ops.parseArgs(rpc).action, 'show')
  assert.equal(ops.parseArgs([...rpc, '--epochs', mint]).mint, mint)
  const pause = ops.parseArgs([...rpc, '--pause', ...auth, '--yes'])
  assert.equal(pause.action, 'pause')
  assert.equal(pause.yes, true)
  assert.equal(pause.authorityFile, 'a.json')
  assert.equal(ops.parseArgs([...rpc, '--unpause', ...auth]).action, 'unpause')
  const cancel = ops.parseArgs([...rpc, '--cancel-epoch', mint, '12', ...auth])
  assert.deepEqual([cancel.action, cancel.mint, cancel.index], ['cancel', mint, 12])
  const update = ops.parseArgs([
    ...rpc,
    ...auth,
    '--claim-delay',
    '3600',
    '--max-burn-sol',
    '0.5',
    '--keeper',
    mint,
    '--expected-version',
    '9',
  ])
  assert.equal(update.action, 'update')
  assert.deepEqual(update.changes, {
    keeper: mint,
    maxBurnLamports: 500_000_000n,
    claimDelay: 3600,
  })
  assert.equal(update.expectedVersion, 9)
  assert.equal(ops.parseArgs([...rpc, '--pause', '--authority-pubkey', mint]).authorityPubkey, mint)

  const bad = (args, pattern) => assert.throws(() => ops.parseArgs(args), pattern)
  bad(['--pause', ...auth], /--rpc is required/)
  bad([...rpc, '--pause', '--unpause', ...auth], /Choose one action/)
  bad([...rpc, '--pause', '--claim-delay', '5', ...auth], /Choose one action/)
  bad([...rpc, '--pause'], /--authority/)
  bad([...rpc, '--pause', '--authority-pubkey', mint, '--yes'], /--yes needs --authority/)
  bad([...rpc, '--pause', ...auth, '--authority-pubkey', mint], /not both/)
  bad([...rpc, '--epochs', mint, '--yes'], /--yes needs an action/)
  bad([...rpc, '--yes'], /--yes needs an action/)
  bad([...rpc, '--expected-version', '3', '--pause', ...auth], /--expected-version goes with/)
  bad([...rpc, '--cancel-epoch', mint, ...auth], /needs <mint> <index>/)
  bad([...rpc, '--cancel-epoch', 'nope', '1', ...auth], /base58/)
  bad([...rpc, '--cancel-epoch', mint, '-1', ...auth], /needs <mint> <index>|whole number/)
  bad([...rpc, '--claim-delay', '604801', ...auth], /between 0 and 604800/)
  bad([...rpc, '--protocol-bps', '1001', ...auth], /between 0 and 1000/)
  bad([...rpc, '--max-burn-sol', '0', ...auth], /greater than 0/)
  bad([...rpc, '--new-authority', '11111111111111111111111111111111', ...auth], /base58/)
  bad([...rpc, '--paused', 'false', ...auth], /Unknown option --paused/)
  bad([...rpc, '--pause', '--pause', ...auth], /given twice/)
  bad(['--rpc', 'ftp://x', '--pause', ...auth], /http\(s\)/)
})

test('program-ops: planUpdate lists only real changes; mainnet is refused before any RPC call', async () => {
  const current = {
    authority: 'A',
    treasury: 'T',
    keeper: 'K',
    protocolBps: 100,
    maxBurnLamports: 1_000_000_000n,
    minActionInterval: 3600,
    keeperGrace: 86_400,
    claimDelay: 21_600,
  }
  assert.deepEqual(
    ops.planUpdate(current, { claimDelay: 21_600, maxBurnLamports: 1_000_000_000n, keeper: 'K2' }),
    [['keeper', 'K', 'K2']],
  )
  assert.deepEqual(ops.planUpdate(current, { newAuthority: 'B', protocolBps: 0 }), [
    ['protocol_bps', 100, 0],
    ['authority', 'A', 'B'],
  ])
  assert.deepEqual(ops.planUpdate(current, { treasury: 'T' }), [])
  assert.equal(ops.relative(100, 40), 'in 1 min')
  assert.equal(ops.relative(0, 7_260), '2 h 1 min ago')

  const out = []
  const io = { log: (m) => out.push(m), error: (m) => out.push(m) }
  const code = await ops.main(
    ['--rpc', 'https://api.mainnet-beta.solana.com', '--pause', '--authority', 'missing.json'],
    io,
  )
  assert.equal(code, 1)
  assert.match(out.join('\n'), /looks like mainnet-beta\. Pass --mainnet/)
  out.length = 0
  assert.equal(await ops.main(['--rpc', 'http://127.0.0.1:8899', '--bogus'], io), 2)
  assert.match(out.join('\n'), /Unknown option --bogus/)
})
