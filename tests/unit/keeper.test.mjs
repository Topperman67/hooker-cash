import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { createKeeper, parseKeeperSecret } from '../../server/keeper.mjs'
import { createFileStore } from '../../server/storage.mjs'
import { buildEntanglementTree, verifyClaim } from '../../shared/merkle.mjs'
import bs58 from 'bs58'

const MINT = Keypair.generate().publicKey.toBase58()
const keeperKey = Keypair.generate()
const holders = [Keypair.generate().publicKey, Keypair.generate().publicKey]
const pda = PublicKey.findProgramAddressSync([Buffer.from('well')], SystemProgram.programId)[0]
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// On-chain Epoch accounts by PDA (base58), shared by the fake connection and client.
const chainEpochs = new Map()
const epochPda = (mint, index) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('epoch'), new PublicKey(mint).toBuffer(), Buffer.from([index, 0, 0, 0])],
    SystemProgram.programId,
  )[0]

function fakeConnection(sent) {
  const statuses = new Map()
  return {
    getMultipleAccountsInfo: async (keys) =>
      keys.map((k) =>
        chainEpochs.has(k.toBase58()) ? { data: chainEpochs.get(k.toBase58()) } : null,
      ),
    getTransaction: async () => null,
    getAccountInfo: async () => ({ owner: TOKEN_2022 }), // the coin mint
    rpcEndpoint: 'http://fake.invalid',
    getRecentPrioritizationFees: async () => [{ prioritizationFee: 5000 }],
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    }),
    getBlockHeight: async () => 1,
    sendRawTransaction: async () => {
      const signature = bs58.encode(Keypair.generate().secretKey.subarray(0, 64))
      sent.push(signature)
      statuses.set(signature, { confirmationStatus: 'confirmed', err: null })
      return signature
    },
    getSignatureStatuses: async ([s]) => ({ value: [statuses.get(s)] }),
    // Token-2022 holder accounts: owner (32 bytes) + amount (u64 LE) slices.
    getProgramAccounts: async () =>
      [
        [holders[0], 600n],
        [holders[1], 400n],
        [pda, 10_000n], // program-owned (bonding curve / pool / well) — excluded
      ].map(([owner, amount]) => {
        const data = Buffer.alloc(40)
        owner.toBuffer().copy(data, 0)
        data.writeBigUInt64LE(amount, 32)
        return { pubkey: Keypair.generate().publicKey, account: { data } }
      }),
  }
}

function fakeQuantum(state, calls) {
  const ix = (name) => {
    calls.push(name)
    return SystemProgram.transfer({
      fromPubkey: keeperKey.publicKey,
      toPubkey: keeperKey.publicKey,
      lamports: 1,
    })
  }
  return {
    fetchQuantum: async () => state,
    fetchConfig: async () => ({ minActionInterval: 60, maxBurnLamports: 50_000_000n }),
    pendingCreatorFees: async () => state.pending,
    fetchWellBalance: async () => ({ unallocated: 0n }),
    epochPda,
    decodeEpoch: (data) => data,
    mintTokenProgram: (info) => info.owner,
    fetchEpoch: async (_c, mint, index) =>
      chainEpochs.get(epochPda(mint, index).toBase58()) ?? null,
    isLeafClaimed: (epoch, leafIndex) => epoch.claimed.has(leafIndex),
    decodeQuantumEvents: () => [],
    buildPulseInstructions: async () => [ix('pulse')],
    buildBurnInstructions: async ({ spendLamports }) => {
      calls.push(`burn:${spendLamports}`)
      return [ix('burn-ix')]
    },
    buildFusionInstructions: async () => [ix('fusion')],
    // The post lands: the program creates the Epoch account and bumps the count.
    buildPostEpochInstruction: async ({ mint, index, total, leafCount, root }) => {
      calls.push(`epoch:${total}:${leafCount}:${root.length}`)
      const now = Math.floor(Date.now() / 1000)
      chainEpochs.set(epochPda(mint, index).toBase58(), {
        index,
        root: Uint8Array.from(root),
        total,
        leafCount,
        createdAt: now,
        expiresAt: now + 30 * 86400,
        payer: keeperKey.publicKey.toBase58(),
        claimed: new Set(),
      })
      state.epochCount = index + 1
      return ix('epoch-ix')
    },
    buildCloseEpochInstruction: async () => ix('close'),
  }
}

test('keeper pulses, burns within the cap and posts a holder epoch with valid proofs', async () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-keeper-')))
  const sent = [],
    calls = []
  const state = {
    pending: 30_000_000n,
    burnReserve: 80_000_000n,
    entangleReserve: 100_000_000n,
    fusionReserve: 0n,
    epochCount: 0,
    lastBurnAt: 0,
    lastFusionAt: 0,
  }
  const indexer = {
    list: async () => [{ mint: MINT, quantum: true, external: false }],
    coin: async () => ({ mint: MINT, complete: false }),
  }
  const keeper = createKeeper({
    connection: fakeConnection(sent),
    store,
    indexer,
    quantum: fakeQuantum(state, calls),
    keeper: keeperKey,
  })
  assert.equal(keeper.enabled, true)
  assert.deepEqual(await keeper.tick(), { enabled: true, ran: 1 })
  assert.ok(calls.includes('pulse'))
  assert.ok(calls.includes('burn:50000000'), 'burn spend is capped at maxBurnLamports')
  assert.ok(!calls.includes('fusion'), 'fusion waits for graduation')
  assert.ok(
    calls.some((c) => c.startsWith('epoch:100000000:2:32')),
    'program-owned holders are excluded',
  )

  const claims = await keeper.claims(MINT, holders[0].toBase58())
  assert.equal(claims.length, 1)
  assert.equal(claims[0].amount, '60000000')
  const epoch = await store.get(`epoch:${MINT}:0`)
  const proof = claims[0].proof.map((h) => Uint8Array.from(Buffer.from(h, 'hex')))
  assert.ok(
    verifyClaim({
      leafIndex: claims[0].leafIndex,
      wallet: holders[0].toBase58(),
      amount: 60_000_000n,
      proof,
      root: Uint8Array.from(Buffer.from(epoch.root, 'hex')),
    }),
  )
  const log = await keeper.log(MINT)
  assert.deepEqual(
    log.map((r) => r.action),
    ['entangle', 'burn', 'pulse'],
  )

  // A second tick inside the epoch window and burn interval does nothing new.
  calls.length = 0
  state.pending = 0n
  state.lastBurnAt = Math.floor(Date.now() / 1000)
  await store.delete('keeper:lease')
  await keeper.tick()
  assert.deepEqual(calls, [])
})

test('keeper is disabled without a client or key, and parses both secret formats', () => {
  const store = createFileStore(mkdtempSync(join(tmpdir(), 'qp-keeper-')))
  assert.equal(
    createKeeper({ connection: null, store, indexer: null, quantum: null, keeper: keeperKey })
      .enabled,
    false,
  )
  const fromJson = parseKeeperSecret(JSON.stringify([...keeperKey.secretKey]))
  const fromBase58 = parseKeeperSecret(bs58.encode(keeperKey.secretKey))
  assert.equal(fromJson.publicKey.toBase58(), keeperKey.publicKey.toBase58())
  assert.equal(fromBase58.publicKey.toBase58(), keeperKey.publicKey.toBase58())
  assert.equal(parseKeeperSecret(''), null)
})

test('merkle helper round-trips the keeper leaves', () => {
  const entries = holders.map((h, i) => ({ wallet: h.toBase58(), amount: BigInt(i + 1) * 1000n }))
  const tree = buildEntanglementTree(entries)
  assert.equal(tree.total, 3000n)
})
