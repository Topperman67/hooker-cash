// Offline checks of shared/quantum.mjs, shared/meteora.mjs and of the program's Meteora
// interface (src/meteora.rs) against the pinned IDLs in shared/idl.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import * as q from '../../../shared/quantum.mjs'
import * as m from '../../../shared/meteora.mjs'

const idlFile = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../shared/idl/${file}`, import.meta.url), 'utf8'))
const dbcIdl = idlFile('meteora_dbc.json')
const dammIdl = idlFile('meteora_damm_v2.json')
const meteoraRs = readFileSync(
  new URL('../programs/quantum_hooks/src/meteora.rs', import.meta.url),
  'utf8',
)
const rustConst = (name: string) => {
  const found = meteoraRs.match(new RegExp(String.raw`pub const ${name}: \[u8; 8\] = \[([\d,\s]+)\]`))
  assert.ok(found, `${name} in meteora.rs`)
  return found![1].split(',').map((x) => Number(x.trim()))
}
const rustKey = (name: string) => {
  const found = meteoraRs.match(new RegExp(String.raw`pub const ${name}: Pubkey = pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)`))
  assert.ok(found, `${name} in meteora.rs`)
  return found![1]
}

test('the program calls exactly the Meteora instructions in the pinned IDLs', () => {
  const ix = (idl: any, name: string) => idl.instructions.find((x: any) => x.name === name).discriminator
  assert.deepEqual(rustConst('IX_SWAP2'), ix(dbcIdl, 'swap2'))
  assert.deepEqual(rustConst('IX_SWAP2'), ix(dammIdl, 'swap2'))
  assert.deepEqual(rustConst('IX_CLAIM_CREATOR_TRADING_FEE'), ix(dbcIdl, 'claim_creator_trading_fee'))
  assert.deepEqual(rustConst('IX_CREATOR_WITHDRAW_SURPLUS'), ix(dbcIdl, 'creator_withdraw_surplus'))
  assert.deepEqual(rustConst('IX_WITHDRAW_MIGRATION_FEE'), ix(dbcIdl, 'withdraw_migration_fee'))
  assert.deepEqual(rustConst('IX_CLAIM_POSITION_FEE'), ix(dammIdl, 'claim_position_fee'))
  assert.deepEqual(rustConst('IX_ADD_LIQUIDITY'), ix(dammIdl, 'add_liquidity'))
  assert.deepEqual(rustConst('IX_PERMANENT_LOCK_POSITION'), ix(dammIdl, 'permanent_lock_position'))
  const acct = (idl: any, name: string) => idl.accounts.find((x: any) => x.name === name).discriminator
  assert.deepEqual(rustConst('DBC_VIRTUAL_POOL_DISC'), acct(dbcIdl, 'VirtualPool'))
  assert.deepEqual(rustConst('DBC_POOL_CONFIG_DISC'), acct(dbcIdl, 'PoolConfig'))
  assert.deepEqual(rustConst('DAMM_POOL_DISC'), acct(dammIdl, 'Pool'))
  assert.deepEqual(rustConst('DAMM_POSITION_DISC'), acct(dammIdl, 'Position'))
  assert.deepEqual(rustConst('DAMM_CONFIG_DISC'), acct(dammIdl, 'Config'))
  // Never a sell, a withdrawal or anything that moves the creator role.
  for (const name of ['remove_liquidity', 'remove_all_liquidity', 'transfer_pool_creator'])
    for (const idl of [dbcIdl, dammIdl]) {
      const found = idl.instructions.find((x: any) => x.name === name)
      if (found) assert.ok(!meteoraRs.includes(`[${found.discriminator.join(', ')}]`), `${name} is not called`)
    }
})

test('program ids, authorities and pool PDAs agree between the program and the client', () => {
  assert.equal(rustKey('DBC_PROGRAM_ID'), dbcIdl.address)
  assert.equal(rustKey('DAMM_V2_PROGRAM_ID'), dammIdl.address)
  assert.equal(rustKey('DBC_POOL_AUTHORITY'), m.DBC_POOL_AUTHORITY.toBase58())
  assert.equal(rustKey('DAMM_POOL_AUTHORITY'), m.DAMM_POOL_AUTHORITY.toBase58())
  assert.equal(rustKey('DBC_EVENT_AUTHORITY'), m.DBC_EVENT_AUTHORITY.toBase58())
  assert.equal(rustKey('DAMM_EVENT_AUTHORITY'), m.DAMM_EVENT_AUTHORITY.toBase58())
  const config = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey
  const [hi, lo] = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) > 0 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint]
  assert.ok(
    m.dbcPoolPda(config, mint).equals(
      PublicKey.findProgramAddressSync([Buffer.from('pool'), config.toBuffer(), hi.toBuffer(), lo.toBuffer()], m.DBC_PROGRAM_ID)[0],
    ),
  )
})

test('PDAs are derived from the documented seeds', () => {
  const mint = Keypair.generate().publicKey
  const id = q.QUANTUM_PROGRAM_ID
  const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, id)[0]
  assert.ok(q.configPda().equals(find([Buffer.from('qp-config')])))
  assert.ok(q.quantumPda(mint).equals(find([Buffer.from('quantum'), mint.toBuffer()])))
  assert.ok(q.wellPda(mint).equals(find([Buffer.from('well'), mint.toBuffer()])))
  const idx = Buffer.alloc(4)
  idx.writeUInt32LE(3)
  assert.ok(q.epochPda(mint, 3).equals(find([Buffer.from('epoch'), mint.toBuffer(), idx])))
  assert.ok(q.lockAta(mint) instanceof PublicKey)
  assert.notEqual(q.wellTokenAta(mint).toBase58(), q.wellWsolAta(mint).toBase58())
})

test('vestedAmount: zero before the cliff, linear, capped at the end', () => {
  const quantum = {
    lockedAmount: 1_000_000n,
    releasedAmount: 0n,
    lockStart: 1000,
    lockCliff: 1100,
    lockEnd: 2000,
  }
  assert.equal(q.vestedAmount(quantum, 999), 0n)
  assert.equal(q.vestedAmount(quantum, 1099), 0n)
  assert.equal(q.vestedAmount(quantum, 1100), 100_000n)
  assert.equal(q.vestedAmount(quantum, 1500), 500_000n)
  assert.equal(q.vestedAmount(quantum, 2000), 1_000_000n)
  assert.equal(q.vestedAmount(quantum, 9999), 1_000_000n)
  assert.equal(q.releasableAmount({ ...quantum, releasedAmount: 400_000n }, 1500), 100_000n)
  assert.equal(q.vestedAmount({ ...quantum, lockedAmount: 0n }, 5000), 0n)
})

test('validateHooks enforces the on-chain rules', () => {
  const w = () => Keypair.generate().publicKey.toBase58()
  const ok = {
    creatorBps: 5000,
    burnBps: 2000,
    entangleBps: 2000,
    fusionBps: 1000,
    splits: [],
    lock: null,
  }
  assert.doesNotThrow(() => q.validateHooks(ok))
  assert.throws(() => q.validateHooks({ ...ok, creatorBps: 4999 }), /sum to 10000/)
  const a = w()
  assert.throws(
    () =>
      q.validateHooks({
        ...ok,
        splits: [
          { wallet: a, bps: 10 },
          { wallet: a, bps: 10 },
        ],
      }),
    /unique/,
  )
  assert.throws(
    () =>
      q.validateHooks({
        ...ok,
        splits: Array.from({ length: 5 }, () => ({ wallet: w(), bps: 1 })),
      }),
    /At most 4/,
  )
  assert.throws(
    () =>
      q.validateHooks({
        ...ok,
        splits: [
          { wallet: w(), bps: 6000 },
          { wallet: w(), bps: 5000 },
        ],
      }),
    /at most 10000/,
  )
  assert.throws(
    () => q.validateHooks({ ...ok, lock: { bps: 5000, cliffSecs: 10, durationSecs: 5 } }),
    /cliff/,
  )
  assert.throws(
    () =>
      q.validateHooks({ ...ok, lock: { bps: 5000, cliffSecs: 0, durationSecs: 5 * 365 * 86400 } }),
    /4 years/,
  )
})

test('IDL exposes every instruction, account and event of the spec', () => {
  const idl = q.QUANTUM_IDL as any
  const ix = idl.instructions.map((i: any) => i.name).sort()
  assert.deepEqual(ix, [
    'cancel_epoch',
    'claim_entanglement',
    'close_epoch',
    'fusion',
    'harvest',
    'initialize_config',
    'lock',
    'post_entanglement',
    'pulse',
    'quantum_burn',
    'register',
    'release',
    'set_launch_configs',
    'set_paused',
    'sync',
    'update_config',
  ])
  assert.deepEqual(idl.accounts.map((a: any) => a.name).sort(), ['Config', 'Epoch', 'Quantum'])
  for (const e of [
    'ConfigUpdated',
    'Registered',
    'Locked',
    'Released',
    'Pulsed',
    'Burned',
    'EpochPosted',
    'Claimed',
    'EpochClosed',
    'EpochCancelled',
    'Fused',
    'Synced',
    'Harvested',
    'LaunchConfigsSet',
  ])
    assert.ok(
      idl.events.some((x: any) => x.name === e),
      e,
    )
})
