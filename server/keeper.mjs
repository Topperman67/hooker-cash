// Quantum Hooks keeper: collects creator fees into each coin's well (pulse), runs Quantum Burn and
// Fusion, and posts Entanglement epochs. Every action is also permissionless on-chain except
// posting epoch roots, so a stalled keeper delays hooks but cannot redirect funds.
import { randomBytes } from 'node:crypto'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { network } from '../shared/network.mjs'

const MIN_PULSE = 20_000_000n // 0.02 SOL waiting in pump.fun vaults
const MIN_BURN = 10_000_000n
const MIN_FUSION = 50_000_000n
const MIN_EPOCH = 50_000_000n
const MIN_CLAIM = 50_000n
const EPOCH_EVERY = 24 * 3600
const MAX_LEAVES = 16384

export function parseKeeperSecret(value) {
  if (!value) return null
  const text = String(value).trim()
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text)
  return Keypair.fromSecretKey(bytes)
}

export async function loadQuantumClient() {
  try {
    return await import('../shared/quantum.mjs')
  } catch {
    return null
  }
}

export function createKeeper({ connection, store, indexer, quantum, keeper, log = () => {} }) {
  const enabled = !!(quantum && keeper)

  async function send(instructions, signers = []) {
    const fees = await connection.getRecentPrioritizationFees().catch(() => [])
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b)
    const price = Math.min(
      Math.max(sorted[Math.floor(sorted.length * 0.75)] || 0, 10_000),
      2_000_000,
    )
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: keeper.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
        ...instructions,
      ],
    }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    tx.sign([keeper, ...signers])
    const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
    for (;;) {
      const { value } = await connection.getSignatureStatuses([signature])
      const status = value[0]
      if (status?.err) throw Error(`Keeper transaction failed: ${JSON.stringify(status.err)}`)
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature
      if ((await connection.getBlockHeight('confirmed')) > lastValidBlockHeight)
        throw Error('Keeper transaction expired before confirmation.')
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  async function record(mint, action, detail) {
    const key = `keeper:log:${mint}`
    const rows = (await store.get(key)) || []
    rows.unshift({ action, at: Math.floor(Date.now() / 1000), ...detail })
    await store.set(key, rows.slice(0, 100))
    log(`${action} ${mint} ${detail.signature || ''}`)
  }

  // Holder snapshot for Entanglement: Token-2022 accounts for the mint owned by wallets
  // (on-curve keys). PDAs — the bonding curve, pool, well and lock vault — are excluded.
  async function snapshot(mint) {
    const accounts = await connection.getProgramAccounts(new PublicKey(network.token2022Program), {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
      dataSlice: { offset: 32, length: 40 },
    })
    const balances = new Map()
    for (const { account } of accounts) {
      const owner = new PublicKey(account.data.subarray(0, 32))
      const amount = account.data.readBigUInt64LE(32)
      if (amount === 0n || !PublicKey.isOnCurve(owner.toBytes())) continue
      const key = owner.toBase58()
      balances.set(key, (balances.get(key) || 0n) + amount)
    }
    return [...balances.entries()]
      .map(([wallet, amount]) => ({ wallet, balance: amount }))
      .sort((a, b) => (b.balance > a.balance ? 1 : -1))
      .slice(0, MAX_LEAVES)
  }

  async function entangle(mint, state) {
    const reserve = BigInt(state.entangleReserve)
    if (reserve < MIN_EPOCH) return
    const last = (await store.get(`epoch:last:${mint}`)) || 0
    if (Date.now() / 1000 - last < EPOCH_EVERY) return
    const holders = await snapshot(mint)
    const supply = holders.reduce((s, h) => s + h.balance, 0n)
    if (!supply) return
    const entries = holders
      .map((h) => ({ wallet: h.wallet, amount: (reserve * h.balance) / supply }))
      .filter((e) => e.amount >= MIN_CLAIM)
    if (!entries.length) return
    const tree = quantum.buildEntanglementTree
      ? quantum.buildEntanglementTree(entries)
      : (await import('../shared/merkle.mjs')).buildEntanglementTree(entries)
    const index = state.epochCount
    const ix = await quantum.buildPostEpochInstruction({
      connection,
      keeper: keeper.publicKey,
      mint: new PublicKey(mint),
      index,
      root: tree.root,
      total: tree.total,
      leafCount: entries.length,
    })
    const signature = await send([ix])
    await store.set(`epoch:${mint}:${index}`, {
      index,
      root: Buffer.from(tree.root).toString('hex'),
      total: tree.total.toString(),
      postedAt: Math.floor(Date.now() / 1000),
      signature,
      leaves: entries.map((e, i) => ({ index: i, wallet: e.wallet, amount: e.amount.toString() })),
    })
    const epochs = (await store.get(`epochs:${mint}`)) || []
    await store.set(`epochs:${mint}`, [index, ...epochs.filter((e) => e !== index)])
    await store.set(`epoch:last:${mint}`, Math.floor(Date.now() / 1000))
    await record(mint, 'entangle', {
      signature,
      index,
      total: tree.total.toString(),
      holders: entries.length,
    })
  }

  async function runCoin(mint) {
    const key = new PublicKey(mint)
    const coin = await indexer.coin(mint)
    let state = await quantum.fetchQuantum(connection, key)
    if (!state) return
    const pending = await quantum.pendingCreatorFees?.(connection, key).catch(() => null)
    if (pending === null || pending === undefined || BigInt(pending) >= MIN_PULSE) {
      try {
        const signature = await send(
          await quantum.buildPulseInstructions({ connection, payer: keeper.publicKey, mint: key }),
        )
        await record(mint, 'pulse', { signature })
        state = await quantum.fetchQuantum(connection, key)
      } catch (e) {
        if (!/NothingToPulse/i.test(e.message)) log(`pulse ${mint}: ${e.message}`)
      }
    }
    const config = await quantum.fetchConfig(connection)
    const now = Math.floor(Date.now() / 1000)
    const interval = Number(config?.minActionInterval || 0)
    const burnReserve = BigInt(state.burnReserve)
    if (burnReserve >= MIN_BURN && now >= Number(state.lastBurnAt) + interval) {
      const cap = BigInt(config?.maxBurnLamports || burnReserve)
      const spendLamports = burnReserve < cap ? burnReserve : cap
      try {
        const signature = await send(
          await quantum.buildBurnInstructions({
            connection,
            caller: keeper.publicKey,
            mint: key,
            spendLamports,
            slippagePct: 3,
          }),
        )
        await record(mint, 'burn', { signature, spent: spendLamports.toString() })
      } catch (e) {
        log(`burn ${mint}: ${e.message}`)
      }
    }
    const fusionReserve = BigInt(state.fusionReserve)
    if (
      coin?.complete &&
      fusionReserve >= MIN_FUSION &&
      now >= Number(state.lastFusionAt) + interval
    ) {
      const cap = BigInt(config?.maxBurnLamports || fusionReserve)
      const spendLamports = fusionReserve < cap ? fusionReserve : cap
      try {
        const signature = await send(
          await quantum.buildFusionInstructions({
            connection,
            caller: keeper.publicKey,
            mint: key,
            spendLamports,
            slippagePct: 3,
          }),
        )
        await record(mint, 'fusion', { signature, spent: spendLamports.toString() })
      } catch (e) {
        log(`fusion ${mint}: ${e.message}`)
      }
    }
    try {
      await entangle(mint, await quantum.fetchQuantum(connection, key))
    } catch (e) {
      log(`entangle ${mint}: ${e.message}`)
    }
    for (const index of (await store.get(`epochs:${mint}`)) || []) {
      const epoch = await store.get(`epoch:${mint}:${index}`)
      if (!epoch || epoch.closed || now < epoch.postedAt + 30 * 86400 + 60) continue
      try {
        const signature = await send([
          await quantum.buildCloseEpochInstruction({
            connection,
            caller: keeper.publicKey,
            mint: key,
            index,
          }),
        ])
        await store.set(`epoch:${mint}:${index}`, { ...epoch, closed: true })
        await record(mint, 'close-epoch', { signature, index })
      } catch (e) {
        log(`close-epoch ${mint}: ${e.message}`)
      }
    }
  }

  async function tick({ budget = 6 } = {}) {
    if (!enabled) return { enabled: false }
    const owner = randomBytes(8).toString('hex')
    if (!(await store.set('keeper:lease', owner, { nx: true, ttl: 240000 })))
      return { skipped: true }
    try {
      const coins = (await indexer.list()).filter((c) => c.quantum && !c.external)
      const start = Number((await store.get('keeper:cursor')) || 0) % Math.max(1, coins.length)
      let ran = 0
      for (let n = 0; n < Math.min(budget, coins.length); n++) {
        await runCoin(coins[(start + n) % coins.length].mint).catch((e) =>
          log(`keeper ${e.message}`),
        )
        ran++
      }
      if (coins.length) await store.set('keeper:cursor', (start + ran) % coins.length)
      return { enabled: true, ran }
    } finally {
      await store.release('keeper:lease', owner)
    }
  }

  // Claimable Entanglement leaves for a wallet across open epochs.
  async function claims(mint, wallet) {
    const out = []
    for (const index of (await store.get(`epochs:${mint}`)) || []) {
      const epoch = await store.get(`epoch:${mint}:${index}`)
      if (!epoch || epoch.closed) continue
      const leaf = epoch.leaves.find((l) => l.wallet === wallet)
      if (!leaf) continue
      const { buildEntanglementTree } = await import('../shared/merkle.mjs')
      const tree = buildEntanglementTree(
        epoch.leaves.map((l) => ({ wallet: l.wallet, amount: BigInt(l.amount) })),
      )
      out.push({
        index,
        leafIndex: leaf.index,
        amount: leaf.amount,
        proof: tree.proof(leaf.index).map((p) => Buffer.from(p).toString('hex')),
        expiresAt: epoch.postedAt + 30 * 86400,
      })
    }
    return out
  }

  return {
    enabled,
    keeper: keeper?.publicKey.toBase58() || null,
    tick,
    claims,
    log: (mint) => store.get(`keeper:log:${mint}`).then((r) => r || []),
    epochs: async (mint) =>
      Promise.all(
        ((await store.get(`epochs:${mint}`)) || []).map(async (i) => {
          const e = await store.get(`epoch:${mint}:${i}`)
          return (
            e && {
              index: e.index,
              total: e.total,
              postedAt: e.postedAt,
              holders: e.leaves.length,
              closed: !!e.closed,
              signature: e.signature,
            }
          )
        }),
      ).then((rows) => rows.filter(Boolean)),
  }
}
