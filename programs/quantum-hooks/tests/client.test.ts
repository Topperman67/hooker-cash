// Offline checks of shared/quantum.mjs and of the program's CPI allow-list against the pump.fun
// IDLs vendored in @pump-fun/pump-sdk 4.0.0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import * as q from '../../../shared/quantum.mjs'

const sdkIdl = (file: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../node_modules/@pump-fun/pump-sdk/src/idl/${file}`, import.meta.url),
      'utf8',
    ),
  )
const pumpIdl = sdkIdl('pump.json')
const ammIdl = sdkIdl('pump_amm.json')
const constants = readFileSync(
  new URL('../programs/quantum_hooks/src/constants.rs', import.meta.url),
  'utf8',
)

const disc = (name: string) => [
  ...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8),
]
function rustArray(name: string) {
  const block = constants.slice(constants.indexOf(`pub const ${name}`))
  const start = block.indexOf('= [')
  const body = block.slice(start, block.indexOf('];', start) + 1)
  return [...body.matchAll(/\[([\d,\s]+)\]/g)].map((m) =>
    m[1]
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((x) => !Number.isNaN(x)),
  )
}

test('pump.fun buy allow-list matches the SDK IDL and sha256("global:<name>")', () => {
  const names = [
    'buy',
    'buy_exact_sol_in',
    'buy_v2',
    'buy_exact_quote_in_v2',
    'buy_v3',
    'buy_exact_quote_in_v3',
  ]
  const list = rustArray('PUMP_BUY_DISCRIMINATORS')
  assert.equal(list.length, names.length)
  names.forEach((name, i) => {
    const ix = pumpIdl.instructions.find((x: any) => x.name === name)
    assert.ok(ix, `pump IDL has ${name}`)
    assert.deepEqual(ix.discriminator, disc(name))
    assert.deepEqual(list[i], ix.discriminator, name)
  })
  for (const sell of ['sell', 'sell_v2', 'sell_v3']) {
    const ix = pumpIdl.instructions.find((x: any) => x.name === sell)
    assert.ok(
      !list.some((d) => d.join() === ix.discriminator.join()),
      `${sell} must not be allowed`,
    )
  }
})

test('PumpSwap buy/deposit allow-list matches the SDK IDL', () => {
  const names = ['buy', 'buy_exact_quote_in', 'buy_v2', 'buy_exact_quote_in_v2']
  const list = rustArray('PUMP_AMM_BUY_DISCRIMINATORS')
  names.forEach((name, i) => {
    const ix = ammIdl.instructions.find((x: any) => x.name === name)
    assert.ok(ix, `pump_amm IDL has ${name}`)
    assert.deepEqual(list[i], ix.discriminator, name)
  })
  const deposit = ammIdl.instructions.find((x: any) => x.name === 'deposit')
  const m = constants.match(/PUMP_AMM_DEPOSIT_DISCRIMINATOR: \[u8; 8\] = \[([\d,\s]+)\]/)
  assert.deepEqual(
    m![1].split(',').map((x) => Number(x.trim())),
    deposit.discriminator,
  )
  for (const forbidden of ['sell', 'sell_v2', 'withdraw']) {
    const ix = ammIdl.instructions.find((x: any) => x.name === forbidden)
    assert.ok(
      !list.some((d) => d.join() === ix.discriminator.join()),
      `${forbidden} must not be allowed`,
    )
  }
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
    'initialize_config',
    'lock',
    'post_entanglement',
    'pulse',
    'quantum_burn',
    'register',
    'release',
    'set_paused',
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
  ])
    assert.ok(
      idl.events.some((x: any) => x.name === e),
      e,
    )
})
