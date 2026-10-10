// Program group: Quantum Hooks client (shared/quantum.mjs), regenerated IDL, scripts/init-config.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import BN from 'bn.js'
import { BorshCoder } from '@coral-xyz/anchor'
import {
  AddressLookupTableProgram,
  BPF_LOADER_DEPRECATED_PROGRAM_ID,
  BPF_LOADER_PROGRAM_ID,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_EPOCH_SCHEDULE_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_REWARDS_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SYSVAR_SLOT_HISTORY_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  Secp256k1Program,
  StakeProgram,
  SystemProgram,
  VoteProgram,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import * as q from '../../shared/quantum.mjs'
import { isMainnetUrl, parseArgs, solToLamports } from '../../scripts/init-config.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const rustConstants = readFileSync(
  `${root}programs/quantum-hooks/programs/quantum_hooks/src/constants.rs`,
  'utf8',
)
const ok = () => Keypair.generate().publicKey.toBase58()
const HOOKS = { creatorBps: 10_000, burnBps: 0, entangleBps: 0, fusionBps: 0, lock: null }

test('reserved split keys: same list in Rust and JS, covering the runtime sysvars and builtins', () => {
  const block = rustConstants.slice(rustConstants.indexOf('pub const RESERVED_ACCOUNT_KEYS'))
  const rust = [
    ...block.slice(0, block.indexOf('];')).matchAll(/pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/g),
  ].map((m) => m[1])
  assert.equal(rust.length, 31)
  assert.deepEqual([...q.RESERVED_ACCOUNT_KEYS].sort(), [...rust].sort())
  for (const key of rust) assert.equal(new PublicKey(key).toBase58(), key)
  for (const key of [
    SystemProgram.programId,
    AddressLookupTableProgram.programId,
    BPF_LOADER_PROGRAM_ID,
    BPF_LOADER_DEPRECATED_PROGRAM_ID,
    ComputeBudgetProgram.programId,
    Ed25519Program.programId,
    Secp256k1Program.programId,
    StakeProgram.programId,
    VoteProgram.programId,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_EPOCH_SCHEDULE_PUBKEY,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    SYSVAR_REWARDS_PUBKEY,
    SYSVAR_SLOT_HASHES_PUBKEY,
    SYSVAR_SLOT_HISTORY_PUBKEY,
    SYSVAR_STAKE_HISTORY_PUBKEY,
  ])
    assert.ok(q.isReservedAccountKey(key), `${key.toBase58()} missing`)
  assert.equal(q.isReservedAccountKey(ok()), false)
})

test('validateHooks refuses split wallets register would reject (reserved keys, programs, well, Quantum account)', () => {
  const mint = Keypair.generate().publicKey
  for (const wallet of [
    SYSVAR_RENT_PUBKEY.toBase58(),
    'Vote111111111111111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
    PublicKey.default.toBase58(),
    q.QUANTUM_PROGRAM_ID.toBase58(),
    q.PUMP_PROGRAM_ID.toBase58(),
    q.PUMP_AMM_PROGRAM_ID.toBase58(),
  ])
    assert.throws(
      () => q.validateHooks({ ...HOOKS, splits: [{ wallet, bps: 100 }] }),
      /cannot be a split wallet/,
      wallet,
    )
  for (const wallet of [q.wellPda(mint), q.quantumPda(mint)]) {
    const hooks = { ...HOOKS, splits: [{ wallet: wallet.toBase58(), bps: 100 }] }
    assert.doesNotThrow(() => q.validateHooks(hooks))
    assert.throws(() => q.validateHooks(hooks, { mint }), /cannot be a split wallet/)
  }
  const a = ok()
  assert.doesNotThrow(() =>
    q.validateHooks({ ...HOOKS, splits: [{ wallet: a, bps: 100 }] }, { mint }),
  )
  assert.throws(
    () =>
      q.validateHooks({
        ...HOOKS,
        splits: [
          { wallet: a, bps: 1 },
          { wallet: a, bps: 1 },
        ],
      }),
    /unique/,
  )
})

test('regenerated IDL: same program id, pulse rent_payer, unpinned coin token program, LP on Token-2022', () => {
  const idl = q.QUANTUM_IDL
  assert.equal(idl.address, 'FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK')
  const lib = readFileSync(
    `${root}programs/quantum-hooks/programs/quantum_hooks/src/lib.rs`,
    'utf8',
  )
  assert.match(lib, new RegExp(`declare_id!\\("${idl.address}"\\)`))
  const accounts = (name) => idl.instructions.find((i) => i.name === name).accounts
  const pulse = accounts('pulse')
  assert.deepEqual(pulse[0], {
    name: 'rent_payer',
    docs: pulse[0].docs,
    writable: true,
    signer: true,
  })
  const burnToken = accounts('quantum_burn').find((a) => a.name === 'token_program')
  assert.equal(burnToken.address, undefined, 'burn accepts SPL Token and Token-2022 mints')
  const fusion = accounts('fusion')
  assert.equal(fusion.find((a) => a.name === 'token_program').address, undefined)
  assert.equal(
    fusion.find((a) => a.name === 'lp_token_program').address,
    TOKEN_2022_PROGRAM_ID.toBase58(),
  )
  const pulsed = idl.types.find((t) => t.name === 'Pulsed').type.fields.map((f) => f.name)
  assert.ok(pulsed.includes('rent_refunded'))
})

// ---------------------------------------------------------------------------------------------
// Offline pulse building against a fake connection.
const coder = new BorshCoder(q.QUANTUM_IDL)
const zeroBn = new BN(0)
async function quantumAccount(mint, launcher, splits, overrides = {}) {
  const padded = [
    ...splits,
    ...Array(4 - splits.length).fill({ wallet: PublicKey.default, bps: 0 }),
  ]
  return coder.accounts.encode('Quantum', {
    mint,
    launcher,
    bump: 255,
    well_bump: 255,
    created_at: zeroBn,
    creator_bps: 10_000,
    burn_bps: 0,
    entangle_bps: 0,
    fusion_bps: 0,
    split_count: splits.length,
    splits: padded,
    burn_reserve: zeroBn,
    entangle_reserve: zeroBn,
    entangle_owed: zeroBn,
    fusion_reserve: zeroBn,
    total_collected: zeroBn,
    total_protocol: zeroBn,
    total_creator_paid: zeroBn,
    total_burn_sol: zeroBn,
    total_burned_tokens: zeroBn,
    total_claimed: zeroBn,
    total_fused_sol: zeroBn,
    epoch_count: 0,
    locked_amount: zeroBn,
    released_amount: zeroBn,
    lock_start: zeroBn,
    lock_cliff: zeroBn,
    lock_end: zeroBn,
    last_burn_at: zeroBn,
    last_fusion_at: zeroBn,
    planned_cliff_secs: zeroBn,
    planned_duration_secs: zeroBn,
    last_epoch_at: zeroBn,
    graduated_at: zeroBn,
    split_owed: Array(4).fill(zeroBn),
    launcher_owed: zeroBn,
    protocol_owed: zeroBn,
    reserved: Array(16).fill(0),
    ...overrides,
  })
}
async function configAccount(treasury) {
  return coder.accounts.encode('Config', {
    authority: treasury,
    treasury,
    keeper: treasury,
    protocol_bps: 100,
    max_burn_lamports: new BN(1),
    min_action_interval: zeroBn,
    keeper_grace: zeroBn,
    paused: false,
    bump: 255,
    claim_delay: new BN(21_600),
    version: zeroBn,
    reserved: Array(48).fill(0),
  })
}
// Accounts listed without an owner are Quantum Hooks accounts (the client checks the owner).
const withOwner = (info) => info && { owner: q.QUANTUM_PROGRAM_ID, lamports: 1, ...info }
const fakeConnection = (accounts) => ({
  getMultipleAccountsInfo: async (keys) =>
    keys.map((k) => withOwner(accounts.get(k.toBase58())) ?? null),
  getAccountInfo: async (k) => withOwner(accounts.get(k.toBase58())) ?? null,
})

test('buildPulseInstructions passes the payer as the writable rent_payer signer', async () => {
  const mint = Keypair.generate().publicKey
  const payer = Keypair.generate().publicKey
  const launcher = Keypair.generate().publicKey
  const treasury = Keypair.generate().publicKey
  const split = Keypair.generate().publicKey
  const accounts = new Map([
    [
      q.quantumPda(mint).toBase58(),
      { data: await quantumAccount(mint, launcher, [{ wallet: split, bps: 100 }]) },
    ],
    [q.configPda().toBase58(), { data: await configAccount(treasury) }],
  ])
  const ixs = await q.buildPulseInstructions({ connection: fakeConnection(accounts), payer, mint })
  assert.equal(ixs.length, 1)
  const [pulse] = ixs
  assert.ok(pulse.programId.equals(q.QUANTUM_PROGRAM_ID))
  assert.ok(pulse.keys[0].pubkey.equals(payer))
  assert.equal(pulse.keys[0].isSigner, true)
  assert.equal(pulse.keys[0].isWritable, true)
  const last = pulse.keys[pulse.keys.length - 1]
  assert.ok(last.pubkey.equals(split) && last.isWritable)

  // A WSOL ATA left over in the well is unwrapped (and its rent refunded to the payer).
  accounts.set(q.wellWsolAta(mint).toBase58(), {
    owner: TOKEN_PROGRAM_ID,
    lamports: Number(q.RENT_EXEMPT_TOKEN_ACCOUNT) + 5,
    data: Buffer.alloc(165),
  })
  const [withAta] = await q.buildPulseInstructions({
    connection: fakeConnection(accounts),
    payer,
    mint,
  })
  assert.ok(withAta.keys.some((k) => k.pubkey.equals(q.wellWsolAta(mint)) && k.isWritable))
})

test('buildPulseInstructions marks a reserved split read-only (legacy coins; the program defers it)', async () => {
  const mint = Keypair.generate().publicKey
  const accounts = new Map([
    [
      q.quantumPda(mint).toBase58(),
      {
        data: await quantumAccount(mint, Keypair.generate().publicKey, [
          { wallet: SYSVAR_RENT_PUBKEY, bps: 100 },
        ]),
      },
    ],
    [q.configPda().toBase58(), { data: await configAccount(Keypair.generate().publicKey) }],
  ])
  const [pulse] = await q.buildPulseInstructions({
    connection: fakeConnection(accounts),
    payer: Keypair.generate().publicKey,
    mint,
  })
  const last = pulse.keys[pulse.keys.length - 1]
  assert.ok(last.pubkey.equals(SYSVAR_RENT_PUBKEY))
  assert.equal(last.isWritable, false)
})

test('pending creator fees count the WSOL ATA without its rent (pulse refunds the rent)', async () => {
  const mint = Keypair.generate().publicKey
  assert.equal(q.RENT_EXEMPT_TOKEN_ACCOUNT, 2_039_280n)
  const wsol = (lamports, owner = TOKEN_PROGRAM_ID) => ({
    owner,
    lamports,
    data: Buffer.alloc(165),
  })
  assert.equal(q.wsolFeeLamports(null), 0n)
  assert.equal(q.wsolFeeLamports(wsol(2_133_154)), 93_874n)
  assert.equal(q.wsolFeeLamports(wsol(2_039_280)), 0n)
  assert.equal(q.wsolFeeLamports(wsol(2_133_154, SystemProgram.programId)), 0n)
  const accounts = new Map([[q.wellWsolAta(mint).toBase58(), wsol(2_133_154)]])
  assert.equal(await q.pendingCreatorFees(fakeConnection(accounts), mint), 93_874n)
})

test('mintTokenProgram follows the mint owner (legacy pump.fun create makes SPL Token mints)', () => {
  assert.ok(q.mintTokenProgram({ owner: TOKEN_2022_PROGRAM_ID }).equals(TOKEN_2022_PROGRAM_ID))
  assert.ok(q.mintTokenProgram({ owner: TOKEN_PROGRAM_ID }).equals(TOKEN_PROGRAM_ID))
  assert.throws(() => q.mintTokenProgram({ owner: SystemProgram.programId }), /not an SPL Token/)
  assert.throws(() => q.mintTokenProgram(null), /not found/)
  const mint = Keypair.generate().publicKey
  const ata = (program) =>
    getAssociatedTokenAddressSync(mint, q.wellPda(mint), true, program).toBase58()
  assert.equal(q.wellTokenAta(mint).toBase58(), ata(TOKEN_2022_PROGRAM_ID))
  assert.equal(q.wellTokenAta(mint, undefined, TOKEN_PROGRAM_ID).toBase58(), ata(TOKEN_PROGRAM_ID))
})

// ---------------------------------------------------------------------------------------------
// Exports server/keeper.mjs relies on (keeper handoff): names, signatures and result shapes.
// The keeper's own tests use fakes of these, so these tests pin the real module to the same shape.

const epochAccount = (mint, index, payer, { leafCount = 10, claimed = [] } = {}) => {
  const bitmap = Buffer.alloc(Math.ceil(leafCount / 8))
  for (const leaf of claimed) bitmap[leaf >> 3] |= 1 << (leaf & 7)
  return coder.accounts.encode('Epoch', {
    mint,
    index,
    root: Array.from({ length: 32 }, (_, i) => i + 1),
    total: new BN(5_000_000),
    claimed: new BN(1_000),
    leaf_count: leafCount,
    created_at: new BN(1_700_000_000),
    claim_start: new BN(1_700_021_600),
    expires_at: new BN(1_700_604_800),
    payer,
    bump: 254,
    bitmap,
  })
}

// "Program data:" logs as the runtime prints them for an Anchor event emitted by `programId`.
function eventLogs(programId, events) {
  const id = programId.toBase58()
  const lines = [`Program ${id} invoke [1]`]
  for (const [name, data] of events) {
    const { discriminator } = q.QUANTUM_IDL.events.find((e) => e.name === name)
    const body = coder.types.encode(name, data)
    lines.push(
      `Program data: ${Buffer.concat([Buffer.from(discriminator), body]).toString('base64')}`,
    )
  }
  lines.push(`Program ${id} consumed 12345 of 200000 compute units`, `Program ${id} success`)
  return lines
}

test('keeper contract: exports the keeper calls exist and are functions', () => {
  for (const name of [
    'epochPda',
    'wellPda',
    'decodeEpoch',
    'fetchEpoch',
    'isLeafClaimed',
    'fetchWellBalance',
    'pendingCreatorFees',
    'decodeQuantumEvents',
    'buildCloseEpochInstruction',
    'buildPostEpochInstruction',
    'buildPulseInstructions',
    'buildBurnInstructions',
    'buildFusionInstructions',
    'fetchQuantum',
    'fetchConfig',
  ])
    assert.equal(typeof q[name], 'function', name)
})

test('keeper contract: epochPda(mint, index) and wellPda(mint) default to the Quant Pad program', () => {
  const mint = Keypair.generate().publicKey
  const seeds = (...s) => PublicKey.findProgramAddressSync(s, q.QUANTUM_PROGRAM_ID)[0]
  const le = (n) => Buffer.from(Uint32Array.of(n).buffer)
  for (const index of [0, 1, 300, 70_000])
    assert.ok(
      q.epochPda(mint, index).equals(seeds(Buffer.from('epoch'), mint.toBuffer(), le(index))),
    )
  // The keeper passes base58 strings as well as PublicKeys.
  assert.ok(q.epochPda(mint.toBase58(), 2).equals(q.epochPda(mint, 2)))
  assert.ok(q.wellPda(mint.toBase58()).equals(seeds(Buffer.from('well'), mint.toBuffer())))
})

test('keeper contract: decodeEpoch, fetchEpoch and isLeafClaimed', async () => {
  const mint = Keypair.generate().publicKey
  const payer = Keypair.generate().publicKey
  const data = await epochAccount(mint, 3, payer, { leafCount: 20, claimed: [0, 9, 19] })
  const epoch = q.decodeEpoch(data)
  assert.ok(epoch.root instanceof Uint8Array)
  assert.equal(epoch.root.length, 32)
  assert.equal(Buffer.from(epoch.root).toString('hex').slice(0, 6), '010203')
  assert.equal(epoch.expiresAt, 1_700_604_800)
  assert.equal(epoch.createdAt, 1_700_000_000)
  assert.equal(epoch.leafCount, 20)
  assert.equal(epoch.payer, payer.toBase58())
  assert.ok(epoch.bitmap instanceof Uint8Array)
  assert.equal(epoch.bitmap.length, 3)
  assert.equal(typeof epoch.expiresAt, 'number')
  assert.equal(typeof epoch.leafCount, 'number')
  assert.equal(typeof epoch.payer, 'string')
  for (let leaf = 0; leaf < 20; leaf++)
    assert.equal(q.isLeafClaimed(epoch, leaf), [0, 9, 19].includes(leaf), `leaf ${leaf}`)

  const accounts = new Map([[q.epochPda(mint, 3).toBase58(), { data }]])
  assert.deepEqual(await q.fetchEpoch(fakeConnection(accounts), mint, 3), epoch)
  assert.equal(await q.fetchEpoch(fakeConnection(accounts), mint, 4), null)
})

test('keeper contract: fetchWellBalance().unallocated is the same free-well term pendingCreatorFees adds', async () => {
  const mint = Keypair.generate().publicKey
  const reserves = {
    burn_reserve: new BN(3_000_000),
    entangle_reserve: new BN(2_000_000),
    entangle_owed: new BN(1_500_000),
    fusion_reserve: new BN(500_000),
  }
  const reserved = 7_000_000n
  const quantum = await quantumAccount(mint, Keypair.generate().publicKey, [], reserves)
  const wellWith = (lamports) =>
    new Map([
      [
        q.wellPda(mint).toBase58(),
        { lamports, owner: SystemProgram.programId, data: Buffer.alloc(0) },
      ],
      [q.quantumPda(mint).toBase58(), { data: quantum }],
    ])

  for (const free of [0n, 1n, 25_000_000n]) {
    const accounts = wellWith(Number(q.RENT_EXEMPT_EMPTY + reserved + free))
    const well = await q.fetchWellBalance(fakeConnection(accounts), mint)
    assert.equal(well.unallocated, free)
    assert.equal(well.reserved, reserved)
    assert.equal(typeof well.unallocated, 'bigint')
    // Nothing else pending: pendingCreatorFees is exactly the well's free lamports.
    assert.equal(await q.pendingCreatorFees(fakeConnection(accounts), mint), free)
    // With fees in the WSOL ATA, pending − unallocated (the keeper's feesWaiting) is those fees.
    accounts.set(q.wellWsolAta(mint).toBase58(), {
      owner: TOKEN_PROGRAM_ID,
      lamports: Number(q.RENT_EXEMPT_TOKEN_ACCOUNT) + 40_000,
      data: Buffer.alloc(165),
    })
    const pending = await q.pendingCreatorFees(fakeConnection(accounts), mint)
    assert.equal(
      pending - (await q.fetchWellBalance(fakeConnection(accounts), mint)).unallocated,
      40_000n,
    )
  }
  // A well below its reserves (or missing) reports nothing free, never a negative amount.
  const short = wellWith(Number(q.RENT_EXEMPT_EMPTY + reserved - 1n))
  assert.equal((await q.fetchWellBalance(fakeConnection(short), mint)).unallocated, 0n)
  assert.equal(await q.pendingCreatorFees(fakeConnection(short), mint), 0n)
  assert.equal((await q.fetchWellBalance(fakeConnection(new Map()), mint)).unallocated, 0n)
})

test('keeper contract: decodeQuantumEvents(logs) returns Burned/Fused with bigint spent, tokensBurned, lpReceived', () => {
  const mint = Keypair.generate().publicKey
  const caller = Keypair.generate().publicKey
  const logs = eventLogs(q.QUANTUM_PROGRAM_ID, [
    ['Burned', { mint, caller, venue: 1, spent: new BN(970_000), tokens_burned: new BN(7_000) }],
    [
      'Fused',
      { mint, caller, spent: new BN(1_234_567), lp_received: new BN(55), tokens_burned: new BN(3) },
    ],
  ])
  const events = q.decodeQuantumEvents(logs)
  assert.deepEqual(
    events.map((e) => e.name),
    ['Burned', 'Fused'],
  )
  const burned = events.find((e) => e.name === 'Burned').data
  assert.equal(burned.spent, 970_000n)
  assert.equal(burned.tokensBurned, 7_000n)
  assert.equal(burned.venue, 1)
  assert.equal(burned.mint, mint.toBase58())
  const fused = events.find((e) => e.name === 'Fused').data
  assert.equal(fused.spent, 1_234_567n)
  assert.equal(fused.lpReceived, 55n)
  assert.equal(fused.tokensBurned, 3n)
  for (const v of [burned.spent, burned.tokensBurned, fused.spent, fused.lpReceived])
    assert.equal(typeof v, 'bigint')
  // The keeper passes tx?.meta?.logMessages, which may be missing.
  assert.deepEqual(q.decodeQuantumEvents(undefined), [])
  assert.deepEqual(q.decodeQuantumEvents([]), [])
  // Another program's identical-looking logs are ignored.
  assert.deepEqual(
    q.decodeQuantumEvents(
      eventLogs(Keypair.generate().publicKey, [
        ['Burned', { mint, caller, venue: 0, spent: new BN(1), tokens_burned: new BN(1) }],
      ]),
    ),
    [],
  )
})

test('keeper contract: buildCloseEpochInstruction({ connection, caller, mint, index, payer })', async () => {
  const mint = Keypair.generate().publicKey
  const payer = Keypair.generate().publicKey
  const offline = {
    getAccountInfo: async () => assert.fail('no RPC call when the payer is given'),
    getMultipleAccountsInfo: async () => assert.fail('no RPC call when the payer is given'),
  }
  const ix = await q.buildCloseEpochInstruction({
    connection: offline,
    caller: Keypair.generate().publicKey,
    mint: mint.toBase58(),
    index: 7,
    payer: payer.toBase58(), // decodeEpoch returns the payer as base58
  })
  assert.ok(ix.programId.equals(q.QUANTUM_PROGRAM_ID))
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]),
    [
      [q.quantumPda(mint).toBase58(), true, false],
      [q.epochPda(mint, 7).toBase58(), true, false],
      [payer.toBase58(), true, false],
    ],
  )
  const { discriminator } = q.QUANTUM_IDL.instructions.find((i) => i.name === 'close_epoch')
  assert.deepEqual(ix.data, Buffer.concat([Buffer.from(discriminator), Buffer.from([7, 0, 0, 0])]))

  // Without a payer it reads the rent payer from the Epoch account.
  const accounts = new Map([
    [q.epochPda(mint, 7).toBase58(), { data: await epochAccount(mint, 7, payer) }],
  ])
  const read = await q.buildCloseEpochInstruction({
    connection: fakeConnection(accounts),
    caller: payer,
    mint,
    index: 7,
  })
  assert.ok(read.keys[2].pubkey.equals(payer))
  await assert.rejects(
    q.buildCloseEpochInstruction({
      connection: fakeConnection(accounts),
      caller: payer,
      mint,
      index: 8,
    }),
    /does not exist/,
  )
})

// ---------------------------------------------------------------------------------------------
// scripts/init-config.mjs
const TREASURY = Keypair.generate().publicKey.toBase58()
const base = ['--rpc', 'http://127.0.0.1:8899', '--authority', 'a.json', '--treasury', TREASURY]

test('init-config: argument parsing, defaults and validation', () => {
  const opts = parseArgs(base)
  assert.deepEqual(opts, {
    rpc: 'http://127.0.0.1:8899',
    authorityFile: 'a.json',
    treasury: TREASURY,
    keeper: null,
    protocolBps: 0,
    maxBurnLamports: 1_000_000_000n,
    minActionInterval: 3600,
    keeperGrace: 86_400,
    claimDelay: 21_600,
    programId: null,
    mainnet: false,
    yes: false,
  })
  const keeper = ok()
  const full = parseArgs([
    ...base,
    '--protocol-bps',
    '1000',
    '--keeper',
    keeper,
    '--max-burn-sol',
    '0.25',
    '--min-action-interval',
    '60',
    '--keeper-grace',
    '0',
    '--yes',
    '--mainnet',
  ])
  assert.equal(full.protocolBps, 1000)
  assert.equal(full.keeper, keeper)
  assert.equal(full.maxBurnLamports, 250_000_000n)
  assert.equal(full.minActionInterval, 60)
  assert.equal(full.keeperGrace, 0)
  assert.equal(full.yes, true)
  assert.equal(full.mainnet, true)
  for (const [args, pattern] of [
    [['--authority', 'a.json', '--treasury', TREASURY], /--rpc is required/],
    [['--rpc', 'http://x', '--treasury', TREASURY], /--authority is required/],
    [['--rpc', 'http://x', '--authority', 'a.json'], /--treasury is required/],
    [[...base, '--protocol-bps', '1001'], /between 0 and 1000/],
    [[...base, '--protocol-bps', '-1'], /needs a value|whole number/],
    [[...base, '--protocol-bps', '1.5'], /whole number/],
    [['--rpc', 'http://x', '--authority', 'a.json', '--treasury', 'nope'], /base58/],
    [[...base, '--keeper', PublicKey.default.toBase58()], /base58/],
    [[...base, '--max-burn-sol', '0'], /greater than 0/],
    [[...base, '--max-burn-sol', '1.0000000001'], /9 decimals/],
    [[...base, '--frobnicate'], /Unknown option/],
    [[...base, '--keeper'], /needs a value/],
    [['--rpc', 'ws://x', '--authority', 'a.json', '--treasury', TREASURY], /http/],
  ])
    assert.throws(() => parseArgs(args), pattern, args.join(' '))
  assert.equal(solToLamports('2'), 2_000_000_000n)
  assert.equal(solToLamports('0.000000001'), 1n)
})

test('init-config: mainnet-beta RPC URLs are refused without --mainnet, before any network call', () => {
  for (const url of [
    'https://api.mainnet-beta.solana.com',
    'https://mainnet.helius-rpc.com/?api-key=x',
    'https://solana-mainnet.g.alchemy.com/v2/x',
  ])
    assert.ok(isMainnetUrl(url), url)
  for (const url of ['http://127.0.0.1:8899', 'https://api.devnet.solana.com'])
    assert.equal(isMainnetUrl(url), false, url)
  const script = `${root}scripts/init-config.mjs`
  const refused = spawnSync(
    process.execPath,
    [
      script,
      '--rpc',
      'https://api.mainnet-beta.solana.com',
      '--authority',
      'missing.json',
      '--treasury',
      TREASURY,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /Refusing .*mainnet-beta.*--mainnet/)
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /--rpc is required[\s\S]*Usage: node scripts\/init-config\.mjs/)
})
