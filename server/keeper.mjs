// Quantum Hooks keeper: harvests each coin's Meteora creator fees into its well and allocates them
// (pulse), runs Quantum Burn and Fusion, posts Entanglement epochs, and migrates Quant Pad coins
// whose bonding curve filled to DAMM v2 (Meteora's migration is permissionless, and a full curve
// cannot trade until someone runs it). Every action is also permissionless on-chain except
// posting epoch roots, so a stalled keeper delays hooks but cannot redirect funds. An epoch's
// claims open only at its claimStart (the config's claim delay after the post); until then the
// authority may cancel it, which returns its SOL to the coin's reserve and closes its account.
// Each tick logs (and returns as `alerts`) any recent on-chain epoch this keeper did not post,
// while it can still be cancelled, and a keeper wallet running low.
import { createHash, randomBytes } from 'node:crypto'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { network } from '../shared/network.mjs'
import { LAUNCH_CONFIG } from '../shared/dbc-config.mjs'

const MIN_PULSE = 20_000_000n // 0.02 SOL of creator fees waiting outside the well
// Burns wait out the launch config's anti-sniper fee window: early swaps pay up to 25%.
const BURN_AFTER = Number(LAUNCH_CONFIG.antiSniper?.totalDurationSecs || 0)
const MIGRATIONS_PER_TICK = 2
const DAMM_ENABLED = 0 // DAMM v2 pool_status: 0 enabled, 1 disabled by Meteora's operators
const MIN_BURN = 10_000_000n
const MIN_FUSION = 50_000_000n
const MIN_EPOCH = 50_000_000n
const MIN_CLAIM = 50_000n
const EPOCH_EVERY = 24 * 3600
const EPOCH_TTL = 30 * 86400 // the program's claim window; on-chain expires_at is authoritative
const MAX_LEAVES = 16384
// Epochs are stored as a small summary plus leaves split into wallet-hashed buckets, each leaf
// with its merkle proof, so a claims lookup reads one bucket per open epoch and builds no tree.
// A leaf with a 14-sibling proof is about 670 bytes, so a bucket of 128 is about 86 KB: far
// under store value limits, and a holder in 30 full epochs reads about 2.6 MB per request.
// Leaves expire on their own after the claim window.
const LEAVES_PER_BUCKET = 128
const LEAVES_TTL_MS = (EPOCH_TTL + 2 * 86400) * 1000
const WRITE_BATCH = 8 // bucket writes and deletes in flight at once
const SPL_ACCOUNT_SIZE = 165 // SPL Token accounts have a fixed size; Token-2022 ones vary
const EPOCH_HISTORY = 64 // indexes kept in `epochs:<mint>`
const EPOCH_PAGE = 30 // summaries epochs() returns
const OPEN_EPOCHS = 40 // newest epochs claims() considers (one a day, open for 30 days)
const CLOSE_DELAY = 60 // seconds past expires_at before the keeper closes an epoch
// The chain's clock can trail this server's: a claim is offered this long after claimStart, and a
// post waits this long past the program's minimum interval.
const CLOCK_SLACK = 30
// A posted epoch whose account vanishes is checked for a cancel until this long past its
// claimStart (cancel_epoch is refused from claimStart on), at most CANCEL_CHECKS lookups a tick,
// each reading at most CANCEL_TXS successful transactions on the epoch's address.
const CANCEL_LOOKBACK = 86400
const CANCEL_CHECKS = 3
const CANCEL_TXS = 5
const CANCEL_MIN_AGE = 300 // seconds before a landed pending post with no account is checked
// The program's defaults, for a client that does not export them.
const MIN_EPOCH_INTERVAL = 20 * 3600
const DEFAULT_CLAIM_DELAY = 6 * 3600
const WATCH_MAX = 12 // newest on-chain epochs checked each tick for posts this keeper did not make
// A keeper balance under this much per Quantum coin (about a mid-sized epoch's rent plus a day of
// transaction fees; a 16,384-holder epoch alone is 0.0163 SOL) is logged as running low.
const LOW_BALANCE_PER_COIN = 10_000_000n
const SCAN_CHUNK = 25
// A pending post is dropped only this many blocks past its blockhash expiry, so a lagging RPC
// node cannot make the keeper reuse an index whose post actually landed.
const DROP_MARGIN = 150
const POLL_FAILURES = 10
const GRACE_POLLS = 20

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const nowSecs = () => Math.floor(Date.now() / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settled = (s) => !!s && ['confirmed', 'finalized'].includes(s.confirmationStatus)
const failed = (err) => Error(`Keeper transaction failed: ${JSON.stringify(err)}`)
const unconfirmed = (signature, why) =>
  Object.assign(Error(`Keeper transaction ${signature} is not confirmed yet (${why}).`), {
    code: 'KEEPER_UNCONFIRMED',
    signature,
  })
const bucketOf = (wallet, buckets) =>
  buckets > 1 ? createHash('sha256').update(wallet).digest().readUInt32BE(0) % buckets : 0
// Runs task(0 .. count-1) with at most WRITE_BATCH in flight.
async function batched(count, task) {
  for (let n = 0; n < count; n += WRITE_BATCH)
    await Promise.all(
      Array.from({ length: Math.min(WRITE_BATCH, count - n) }, (_, j) => task(n + j)),
    )
}
// Proofs are stored as their 32-byte siblings concatenated in base64; the API serves hex strings.
const packProof = (proof) => Buffer.concat(proof).toString('base64')
function unpackProof(packed) {
  const raw = Buffer.from(packed, 'base64')
  const out = []
  for (let i = 0; i < raw.length; i += 32) out.push(raw.subarray(i, i + 32).toString('hex'))
  return out
}

function address(value, what) {
  try {
    if (typeof value === 'string') return new PublicKey(value)
  } catch {}
  throw Object.assign(Error(`Invalid ${what} address.`), { status: 400 })
}

export function parseKeeperSecret(value) {
  if (!value) return null
  const text = String(value).trim()
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text)
  return Keypair.fromSecretKey(bytes)
}

/** Why the Quantum Hooks client last failed to load (an error code), or null. */
export let quantumClientError = null

export async function loadQuantumClient({
  load = () => import('../shared/quantum.mjs'),
  report = console.error,
} = {}) {
  try {
    const client = await load()
    quantumClientError = null
    return client
  } catch (error) {
    // A dependency missing from a deployment otherwise looks like "program not ready".
    quantumClientError = error?.code || error?.name || 'load-failed'
    report('Quantum Hooks client failed to load:', error?.code || '', error?.message || error)
    return null
  }
}

export function createKeeper({
  connection,
  store,
  indexer,
  quantum,
  keeper,
  log = () => {},
  pollMs = 1500,
  // Serverless functions are killed at 60 s: stop starting work well before that.
  timeLimitMs = process.env.VERCEL ? 40_000 : 180_000,
}) {
  const enabled = !!(quantum && keeper)
  // The program refuses a post within MIN_EPOCH_INTERVAL of the coin's last one (last_epoch_at).
  const minInterval = Number(quantum?.MIN_EPOCH_INTERVAL) || MIN_EPOCH_INTERVAL
  const epochGap = Math.max(EPOCH_EVERY, Number(quantum?.MIN_EPOCH_INTERVAL || 0) + CLOCK_SLACK)
  // Only accounts the Quantum Hooks program owns are read as epochs (when the client exports
  // its id): once an epoch is cancelled or closed, anyone can send lamports to its address,
  // which leaves a system-owned account with no data there.
  const programId = quantum?.QUANTUM_PROGRAM_ID ? String(quantum.QUANTUM_PROGRAM_ID) : null
  const keys = {
    list: (mint) => `epochs:${mint}`,
    epoch: (mint, index) => `epoch:${mint}:${index}`,
    leaves: (mint, rec, bucket) =>
      `epoch:leaves:${mint}:${rec.index}:${rec.root.slice(0, 16)}:${bucket}`,
    last: (mint) => `epoch:last:${mint}`,
    floor: (mint) => `epoch:floor:${mint}`,
  }

  // `beforeSend` runs once the transaction is signed and before it is broadcast. Polling stops at
  // `deadline` with a KEEPER_UNCONFIRMED error rather than outliving the tick.
  async function send(
    instructions,
    signers = [],
    { deadline = Infinity, beforeSend, units = 600_000 } = {},
  ) {
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
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
        ...instructions,
      ],
    }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    tx.sign([keeper, ...signers])
    await beforeSend?.({ signature: bs58.encode(tx.signatures[0]), lastValidBlockHeight })
    const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
    return confirm(signature, lastValidBlockHeight, deadline)
  }

  async function confirm(signature, lastValidBlockHeight, deadline) {
    let failures = 0
    let grace = 0
    for (;;) {
      let status, height, final
      try {
        ;[status] = (await connection.getSignatureStatuses([signature])).value
        if (!status?.err && !settled(status)) {
          height = await connection.getBlockHeight('confirmed')
          // The last read can lag behind the cluster: look in history before calling it expired.
          if (height > lastValidBlockHeight)
            [final] = (
              await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
            ).value
        }
        failures = 0
      } catch (e) {
        // RPC errors are retried: the transaction is already out and may still land.
        if (++failures >= POLL_FAILURES) throw unconfirmed(signature, e.message)
        if (Date.now() >= deadline) throw unconfirmed(signature, 'time limit')
        await sleep(pollMs)
        continue
      }
      if (status?.err) throw failed(status.err)
      if (settled(status)) return signature
      if (height > lastValidBlockHeight) {
        if (final?.err) throw failed(final.err)
        if (settled(final)) return signature
        if (!final) throw Error('Keeper transaction expired before confirmation.')
        // Processed before its blockhash expired: it can still confirm.
        if (++grace > GRACE_POLLS) throw unconfirmed(signature, 'still processed')
      }
      if (Date.now() >= deadline) throw unconfirmed(signature, 'time limit')
      await sleep(pollMs)
    }
  }

  async function record(mint, action, detail) {
    const key = `keeper:log:${mint}`
    const rows = (await store.get(key)) || []
    rows.unshift({ action, at: Math.floor(Date.now() / 1000), ...detail })
    await store.set(key, rows.slice(0, 100))
    log(`${action} ${mint} ${detail.signature || ''}`)
  }

  // What a burn or Fusion actually spent, from its event; the budget is only an upper bound.
  async function outcome(signature, name, budget) {
    const detail = { signature, budget: budget.toString() }
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      const event = quantum.decodeQuantumEvents(tx?.meta?.logMessages).find((e) => e.name === name)
      for (const field of ['spent', 'tokensBurned', 'liquidityAdded'])
        if (event?.data[field] !== undefined) detail[field] = event.data[field].toString()
    } catch (e) {
      log(`${name} ${signature}: ${e.message}`)
    }
    return detail
  }

  // Creator fees waiting outside the well. Free well lamports (anyone can send SOL to the well)
  // do not count: alone they must not make the keeper pulse, which also pulls in the pool leg.
  async function feesWaiting(key) {
    const [pending, well] = await Promise.all([
      quantum.pendingCreatorFees(connection, key),
      quantum.fetchWellBalance(connection, key),
    ])
    return BigInt(pending) - BigInt(well?.unallocated ?? 0n)
  }

  // Holder snapshot for Entanglement: token accounts for the mint owned by wallets (on-curve
  // keys), under the mint's own token program (SPL Token for Quant Pad's DBC coins). PDAs — the
  // Meteora vaults and pool authorities, the well and the lock vault — are excluded.
  async function snapshot(mint) {
    const program = quantum.mintTokenProgram(
      await connection.getAccountInfo(new PublicKey(mint), 'confirmed'),
    )
    const legacy = program.toBase58() === network.tokenProgram
    const accounts = await connection.getProgramAccounts(program, {
      commitment: 'confirmed',
      filters: [
        ...(legacy ? [{ dataSize: SPL_ACCOUNT_SIZE }] : []),
        { memcmp: { offset: 0, bytes: mint } },
      ],
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

  async function buildTree(entries) {
    return quantum.buildEntanglementTree
      ? quantum.buildEntanglementTree(entries)
      : (await import('../shared/merkle.mjs')).buildEntanglementTree(entries)
  }

  // ---- epoch storage ------------------------------------------------------------------------

  // Each bucket maps wallet -> [leafIndex, amount, packed proof]. The proofs come from the tree
  // built at post time, so serving a claim never rebuilds a tree.
  async function saveLeaves(mint, rec, entries, tree) {
    const buckets = Array.from({ length: rec.buckets }, () => ({}))
    entries.forEach((e, i) => {
      buckets[bucketOf(e.wallet, rec.buckets)][e.wallet] = [
        i,
        e.amount.toString(),
        packProof(tree.proof(i)),
      ]
    })
    await batched(buckets.length, (n) =>
      store.set(keys.leaves(mint, rec, n), buckets[n], { ttl: LEAVES_TTL_MS }),
    )
  }

  async function deleteLeaves(mint, rec) {
    await batched(rec.buckets || 0, (n) => store.delete(keys.leaves(mint, rec, n)))
  }

  async function findLeaf(mint, rec, wallet) {
    const bucket = await store.get(keys.leaves(mint, rec, bucketOf(wallet, rec.buckets)))
    if (!bucket || !Object.hasOwn(bucket, wallet)) return null
    const [leafIndex, amount, proof] = bucket[wallet]
    return { leafIndex, amount, proof }
  }

  async function saveEpoch(mint, rec) {
    await store.set(keys.epoch(mint, rec.index), rec)
    const list = (await store.get(keys.list(mint))) || []
    const next = [rec.index, ...list.filter((i) => i !== rec.index)]
    await store.set(keys.list(mint), next.slice(0, EPOCH_HISTORY))
    for (const index of next.slice(EPOCH_HISTORY)) await store.delete(keys.epoch(mint, index))
  }

  async function dropEpoch(mint, rec) {
    await store.delete(keys.epoch(mint, rec.index))
    const list = (await store.get(keys.list(mint))) || []
    await store.set(
      keys.list(mint),
      list.filter((i) => i !== rec.index),
    )
    await deleteLeaves(mint, rec)
  }

  // `claimDelay` (the config's) estimates claimStart when the Epoch account could not be read; the
  // estimate is never early, since postedAt is then read after the post confirmed.
  async function markPosted(mint, rec, onchain, claimDelay) {
    const postedAt = onchain?.createdAt ?? nowSecs()
    const expiresAt = onchain?.expiresAt ?? postedAt + EPOCH_TTL
    const claimStart =
      onchain?.claimStart ?? (claimDelay == null ? undefined : postedAt + Number(claimDelay))
    await saveEpoch(mint, {
      ...rec,
      status: 'posted',
      postedAt,
      expiresAt,
      ...(claimStart == null ? {} : { claimStart: Number(claimStart) }),
    })
    if (postedAt > Number((await store.get(keys.last(mint))) || 0))
      await store.set(keys.last(mint), postedAt)
    await record(mint, 'entangle', {
      signature: rec.signature,
      index: rec.index,
      total: rec.total,
      holders: rec.holders,
    })
  }

  // A pending record is left to reconcile(): its post may not have landed under this index.
  async function markClosed(mint, index, extra = {}) {
    const rec = await store.get(keys.epoch(mint, index))
    if (!rec || rec.closed || rec.status === 'pending') return
    await store.set(keys.epoch(mint, index), { ...rec, ...extra, closed: true })
    await deleteLeaves(mint, rec)
  }

  // The transaction that cancelled epoch `index`, or null. A missing account alone proves
  // nothing (a lagging RPC node shows none either), so this needs a successful transaction on
  // the epoch's address that emitted EpochCancelled for it. Apart from the post and the cancel,
  // the only transactions that succeed there send it lamports. cancel_epoch is refused from
  // claimStart on, so transactions after it (when known) are skipped: lamports sent to the
  // closed address later cannot push the cancel out of the few that are read.
  async function cancelledBy(key, index, claimStart) {
    const mint = key.toBase58()
    const history = await connection.getSignaturesForAddress(
      quantum.epochPda(key, index),
      { limit: 100 }, // failed transactions (refused early claims) are listed too
      'confirmed',
    )
    const latest = Number(claimStart) + CLOCK_SLACK // NaN when unknown: nothing is skipped
    const candidates = history.filter((s) => !s.err && !(Number(s.blockTime) > latest))
    for (const { signature } of candidates.slice(0, CANCEL_TXS)) {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      if (!tx || tx.meta?.err) continue
      const cancel = quantum
        .decodeQuantumEvents(tx.meta?.logMessages)
        .find(
          (e) =>
            e.name === 'EpochCancelled' &&
            Number(e.data?.index) === index &&
            (e.data?.mint == null || String(e.data.mint) === mint),
        )
      if (cancel) return signature
    }
    return null
  }

  // A cancelled epoch pays nothing: its leaves go, and the summary says why. A pending record
  // is dropped, since its post either never landed or was the epoch cancelled.
  async function settleCancelled(mint, rec, signature) {
    if (rec.status === 'pending') await dropEpoch(mint, rec)
    else await markClosed(mint, rec.index, { cancelled: true })
    await record(mint, 'cancel-epoch', { signature, index: rec.index })
  }

  // An account at an epoch address that is not the program's, or does not decode as an Epoch,
  // is no epoch: lamports sent to a cancelled or closed epoch's address leave a system-owned
  // account with no data there. It reads as missing, so it can neither stall the keeper nor
  // break a claims lookup.
  function asEpoch(info) {
    if (!info) return null
    if (programId && info.owner && String(info.owner) !== programId) return null
    try {
      return quantum.decodeEpoch(info.data) ?? null
    } catch {
      return null
    }
  }

  // On-chain Epoch accounts for `indexes`, null where closed, cancelled or never posted. Every
  // epoch read goes through here (RPC failures still throw).
  async function readEpochs(key, indexes) {
    const out = []
    for (let i = 0; i < indexes.length; i += 100) {
      const infos = await connection.getMultipleAccountsInfo(
        indexes.slice(i, i + 100).map((index) => quantum.epochPda(key, index)),
      )
      out.push(...infos.map(asEpoch))
    }
    return out
  }

  const epochAt = async (key, index) => (await readEpochs(key, [index]))[0]

  // ---- Entanglement -------------------------------------------------------------------------

  // An epoch is stored as `pending`, leaves included, before its post is sent. Settle it from the
  // chain: posted with our root, dropped once its blockhash has expired, or still in flight.
  // Returns false while a post may still land, so nothing is posted over it.
  async function reconcile(mint, key, state) {
    for (const index of ((await store.get(keys.list(mint))) || []).slice(0, 3)) {
      const rec = await store.get(keys.epoch(mint, index))
      if (rec?.status !== 'pending') continue
      if (index >= state.epochCount) {
        const expired = rec.lastValidBlockHeight
          ? (await connection.getBlockHeight('confirmed')) > rec.lastValidBlockHeight + DROP_MARGIN
          : nowSecs() - rec.createdAt > 300
        if (!expired) return false
        // It may have landed just before expiry: read the count again after the height.
        state = (await quantum.fetchQuantum(connection, key)) || state
        if (index >= state.epochCount) {
          await dropEpoch(mint, rec) // never landed; the next post reuses the index
          continue
        }
      }
      const onchain = await epochAt(key, index)
      if (onchain && hex(onchain.root) === rec.root) await markPosted(mint, rec, onchain)
      else if (onchain) {
        // Another post took this index, so ours never landed; watchRecent flags that epoch.
        log(`entangle ${mint} ${index}: another root holds this index; pending post dropped`)
        await dropEpoch(mint, rec)
      } else if (nowSecs() - rec.createdAt > EPOCH_TTL) await dropEpoch(mint, rec)
      else if (nowSecs() - rec.createdAt > CANCEL_MIN_AGE) {
        // Landed (the count moved past it) yet gone: cancelled, or this RPC node lags.
        try {
          const signature = await cancelledBy(key, index)
          if (signature) await settleCancelled(mint, rec, signature)
        } catch (e) {
          log(`cancel-epoch ${mint} ${index}: ${e.message}`)
        }
      }
      // Otherwise the account is not visible on this RPC node yet: settle it next tick.
    }
    return true
  }

  // Nothing is spent on a post the program would refuse: only config.keeper may post, and not
  // within the minimum interval of the coin's last post.
  async function entangle(mint, key, state, deadline, config) {
    if (BigInt(state.entangleReserve) < MIN_EPOCH) return
    if (!config || (config.keeper && config.keeper !== keeper.publicKey.toBase58())) return
    const now = nowSecs()
    // The chain's last_epoch_at also counts posts this store never recorded, such as one that
    // was cancelled before it was reconciled.
    const last = Math.max(
      Number((await store.get(keys.last(mint))) || 0),
      Number(state.lastEpochAt || 0),
    )
    if (now - last < epochGap) return
    const index = state.epochCount
    const existing = await store.get(keys.epoch(mint, index))
    if (existing) {
      // A fresh record at the next index means this chain read is behind the store: retry next
      // tick. An old one is left over from a chain that was reset.
      if (now - (existing.postedAt ?? existing.createdAt ?? 0) < 600) return
      await dropEpoch(mint, existing)
    }
    // The newest on-chain epoch sets the pace too, in case the store lost track of it.
    if (index > 0) {
      const latest = await epochAt(key, index - 1)
      if (latest && now - latest.createdAt < epochGap) {
        await store.set(keys.last(mint), latest.createdAt)
        return
      }
    }
    const reserve = BigInt(state.entangleReserve)
    const holders = await snapshot(mint)
    const supply = holders.reduce((s, h) => s + h.balance, 0n)
    if (!supply) return
    const entries = holders
      .map((h) => ({ wallet: h.wallet, amount: (reserve * h.balance) / supply }))
      .filter((e) => e.amount >= MIN_CLAIM)
    if (!entries.length) return
    const tree = await buildTree(entries)
    const rec = {
      index,
      root: hex(tree.root),
      total: tree.total.toString(),
      holders: entries.length,
      buckets: Math.ceil(entries.length / LEAVES_PER_BUCKET),
      status: 'pending',
      createdAt: now,
    }
    const ix = await quantum.buildPostEpochInstruction({
      connection,
      keeper: keeper.publicKey,
      mint: key,
      index,
      root: tree.root,
      total: tree.total,
      leafCount: entries.length,
    })
    // The leaves are a snapshot that cannot be rebuilt later: store them before sending.
    await saveLeaves(mint, rec, entries, tree)
    const signature = await send([ix], [], {
      deadline,
      beforeSend: ({ signature, lastValidBlockHeight }) =>
        saveEpoch(mint, { ...rec, signature, lastValidBlockHeight }),
    })
    const onchain = await epochAt(key, index).catch(() => null)
    await markPosted(
      mint,
      { ...rec, signature },
      onchain && hex(onchain.root) === rec.root ? onchain : null,
      config.claimDelay,
    )
  }

  // Whether a stored epoch record is past its expiry (and close delay). Pending records and
  // missing ones prove nothing.
  function knownExpired(rec) {
    if (!rec || rec.status === 'pending') return false
    const ends = Number(rec.expiresAt ?? (rec.postedAt ?? rec.createdAt) + EPOCH_TTL)
    return Number.isFinite(ends) && nowSecs() >= ends + CLOSE_DELAY
  }

  // The newest epochs, every tick, with their accounts read in one call:
  //
  // Settle epochs the authority cancelled. cancel_epoch works only before claimStart, so only
  // the newest records can be affected: they are read newest first, stopping at the first whose
  // claimStart is long past (or unknown), and a missing account is settled only on proof of the
  // cancel.
  //
  // Flag on-chain epochs this keeper did not post while they can still be cancelled. An epoch
  // with no record here, or whose root differs from its record, was posted by someone else
  // holding the keeper key (or this store lost its record), and its claimStart is the
  // authority's deadline for cancel_epoch. Posts are at least the program's minimum interval
  // apart, so only the newest claimDelay / interval + 2 can still be before their claimStart (a
  // claim delay lowered in the last week can leave an older one unchecked).
  async function watchRecent(mint, key, count, config, deadline, alerts) {
    const now = nowSecs()
    const records = new Map()
    const recent = []
    for (const index of ((await store.get(keys.list(mint))) || []).slice(0, OPEN_EPOCHS)) {
      const rec = await store.get(keys.epoch(mint, index))
      records.set(index, rec)
      if (rec?.status === 'pending') continue // reconcile() settles these
      if (!(Number(rec?.claimStart) + CANCEL_LOOKBACK > now)) break
      if (!rec.closed) recent.push(rec)
    }
    const delay = Math.max(0, Number(config?.claimDelay ?? DEFAULT_CLAIM_DELAY) || 0)
    const watch = Math.max(0, Math.min(count, WATCH_MAX, Math.floor(delay / minInterval) + 2))
    const newest = Array.from({ length: watch }, (_, n) => count - 1 - n)
    for (const index of newest)
      if (!records.has(index)) records.set(index, await store.get(keys.epoch(mint, index)))
    const indexes = [...new Set([...recent.map((r) => r.index), ...newest])]
    if (!indexes.length) return
    const read = await readEpochs(key, indexes)
    const chain = new Map(indexes.map((index, k) => [index, read[k]]))

    for (const index of newest) {
      const epoch = chain.get(index)
      // Accounts from before the claim delay have no claimStart and can no longer be cancelled.
      if (!epoch || !(now < Number(epoch.claimStart))) continue
      if (records.get(index)?.root === hex(epoch.root)) continue
      const claimStart = Number(epoch.claimStart)
      log(
        `epoch ${mint}#${index} was not posted by this keeper; cancel it with cancel_epoch ` +
          `before ${new Date(claimStart * 1000).toISOString()} (claimStart ${claimStart}, ` +
          `total ${epoch.total} lamports, payer ${epoch.payer})`,
      )
      alerts?.push({
        kind: 'foreign-epoch',
        mint,
        index,
        claimStart,
        total: String(epoch.total),
        payer: epoch.payer == null ? null : String(epoch.payer),
      })
    }

    let checks = 0
    for (const rec of recent) {
      if (chain.get(rec.index)) continue
      if (checks++ >= CANCEL_CHECKS || Date.now() >= deadline) break
      const signature = await cancelledBy(key, rec.index, rec.claimStart)
      if (signature) await settleCancelled(mint, rec, signature)
    }
  }

  // Close expired epochs found on-chain, not only those in the store: an epoch whose record was
  // lost still holds owed SOL. The claim window is fixed, so epochs expire in index order: the
  // scan stops at the first open one, and `epoch:floor:<mint>` skips the closed prefix next time.
  // A missing account means closed only once the epoch must have expired (close_epoch fails
  // before that) or was proven cancelled; until then it may be a lagging RPC node, so it is left
  // alone and the floor stays. An expired epoch proves every earlier one expired too.
  async function closeExpired(mint, key, count, deadline, { config, alerts } = {}) {
    try {
      await watchRecent(mint, key, count, config, deadline, alerts)
    } catch (e) {
      log(`cancel-epoch ${mint}: ${e.message}`)
    }
    const start = Number((await store.get(keys.floor(mint))) || 0)
    let floor = start
    let advancing = true
    const unsure = [] // missing accounts not yet known to be past expiry
    scan: for (let from = start; from < count; from += SCAN_CHUNK) {
      const indexes = []
      for (let i = from; i < Math.min(count, from + SCAN_CHUNK); i++) indexes.push(i)
      const chain = await readEpochs(key, indexes)
      for (const [k, index] of indexes.entries()) {
        const epoch = chain[k]
        if (!epoch) {
          const rec = await store.get(keys.epoch(mint, index))
          if (rec?.cancelled) {
            // Gone for good, though it says nothing about when earlier epochs expire.
            if (advancing && !unsure.length) floor = index + 1
            continue
          }
          if (!knownExpired(rec)) {
            unsure.push(index)
            continue
          }
        } else if (nowSecs() < epoch.expiresAt + CLOSE_DELAY) break scan
        // This epoch has expired, so the missing ones before it were closed.
        for (const earlier of unsure.splice(0)) await markClosed(mint, earlier)
        if (advancing) floor = index
        if (epoch) {
          if (Date.now() >= deadline) break scan
          try {
            const signature = await send(
              [
                await quantum.buildCloseEpochInstruction({
                  connection,
                  caller: keeper.publicKey,
                  mint: key,
                  index,
                  payer: epoch.payer,
                }),
              ],
              [],
              { deadline },
            )
            await record(mint, 'close-epoch', { signature, index })
          } catch (e) {
            log(`close-epoch ${mint} ${index}: ${e.message}`)
            advancing = false
            continue
          }
        }
        // Closed now, or already closed by anyone (close_epoch is permissionless).
        await markClosed(mint, index)
        if (advancing) floor = index + 1
      }
    }
    if (floor > start) await store.set(keys.floor(mint), floor)
  }

  // ---- tick ---------------------------------------------------------------------------------

  async function runCoin(mint, deadline, alerts) {
    const key = new PublicKey(mint)
    let state = await quantum.fetchQuantum(connection, key)
    if (!state) return
    const coin = await indexer.coin(mint)
    const late = () => Date.now() >= deadline
    let mayPost = false
    try {
      mayPost = await reconcile(mint, key, state)
    } catch (e) {
      log(`entangle ${mint}: ${e.message}`)
    }
    try {
      if (!late() && (await feesWaiting(key)) >= MIN_PULSE) {
        const signature = await send(
          await quantum.buildPulseInstructions({ connection, payer: keeper.publicKey, mint: key }),
          [],
          { deadline },
        )
        await record(mint, 'pulse', { signature })
        state = (await quantum.fetchQuantum(connection, key)) || state
      }
    } catch (e) {
      if (!/NothingToPulse/i.test(e.message)) log(`pulse ${mint}: ${e.message}`)
    }
    // Where the coin trades: burns need an open venue (not a full curve awaiting migration, not a
    // DAMM pool Meteora's operators disabled), and Fusion the DAMM v2 pool recorded by sync.
    const venue = quantum.fetchVenue
      ? await quantum.fetchVenue(connection, key).catch(() => null)
      : null
    if (!late() && venue?.kind === 'pool' && !state.dammPool) {
      try {
        const sync = await quantum.buildSyncInstruction({ connection, mint: key })
        const signature = await send([sync], [], { deadline })
        await record(mint, 'sync', { signature })
        state = (await quantum.fetchQuantum(connection, key)) || state
      } catch (e) {
        log(`sync ${mint}: ${e.message}`)
      }
    }
    const open =
      venue?.kind === 'curve' || (venue?.kind === 'pool' && venue.damm?.poolStatus === DAMM_ENABLED)
    const config = await quantum.fetchConfig(connection)
    const now = Math.floor(Date.now() / 1000)
    const interval = Number(config?.minActionInterval || 0)
    const burnReserve = BigInt(state.burnReserve)
    if (
      !late() &&
      open &&
      burnReserve >= MIN_BURN &&
      now >= Number(state.lastBurnAt) + interval &&
      (venue.kind === 'pool' || now >= Number(state.createdAt || 0) + BURN_AFTER)
    ) {
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
          [],
          { deadline },
        )
        await record(mint, 'burn', await outcome(signature, 'Burned', spendLamports))
      } catch (e) {
        log(`burn ${mint}: ${e.message}`)
      }
    }
    const fusionReserve = BigInt(state.fusionReserve)
    if (
      !late() &&
      open &&
      venue.kind === 'pool' &&
      state.dammPool &&
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
          [],
          { deadline },
        )
        await record(mint, 'fusion', await outcome(signature, 'Fused', spendLamports))
      } catch (e) {
        log(`fusion ${mint}: ${e.message}`)
      }
    }
    if (late()) return
    state = (await quantum.fetchQuantum(connection, key)) || state
    if (mayPost) {
      try {
        await entangle(mint, key, state, deadline, config)
      } catch (e) {
        log(`entangle ${mint}: ${e.message}`)
      }
    }
    try {
      await closeExpired(mint, key, state.epochCount, deadline, { config, alerts })
    } catch (e) {
      log(`close-epoch ${mint}: ${e.message}`)
    }
  }

  // Verified Quantum coins, plus coins whose creator is their well while the flag is unknown;
  // `external` does not matter. runCoin confirms each with fetchQuantum before acting.
  function isCandidate(c) {
    if (c.quantum === true) return true
    if (c.quantum === false || !c.creator) return false
    try {
      return quantum.wellPda(new PublicKey(c.mint)).toBase58() === c.creator
    } catch {
      return false
    }
  }

  // Quant Pad launches whose curve filled but that Meteora has not migrated yet: nothing can trade
  // them until migration_damm_v2 runs, so the keeper runs it (it is permissionless; losing a race
  // to another migrator only costs a failed transaction). Quantum coins then record the DAMM pool
  // on their next tick.
  async function migrateGraduates(items, deadline) {
    const waiting = items.filter((c) => !c.external && c.complete && !c.migrated && c.dbcPool)
    for (const coin of waiting.slice(0, MIGRATIONS_PER_TICK)) {
      if (Date.now() >= deadline) return
      try {
        const venue = await quantum.fetchVenue(connection, new PublicKey(coin.mint))
        if (venue.kind !== 'migrating') continue
        const { instructions, signers } = await quantum.dbcMigrationInstructions({
          connection,
          payer: keeper.publicKey,
          dbcPool: coin.dbcPool,
        })
        const signature = await send(instructions, signers, { deadline, units: 1_400_000 })
        await record(coin.mint, 'migrate', { signature })
        await indexer.syncCoin?.(coin.mint)?.catch(() => {})
      } catch (e) {
        log(`migrate ${coin.mint}: ${e.message}`)
      }
    }
  }

  // A keeper that runs dry stops every hook, so a balance under roughly a day of epoch rent and
  // fees for the coins it serves is logged each tick. A failed balance read is ignored.
  async function checkBalance(coinCount, alerts) {
    if (!coinCount || typeof connection.getBalance !== 'function') return
    let lamports
    try {
      lamports = BigInt(await connection.getBalance(keeper.publicKey, 'confirmed'))
    } catch {
      return
    }
    const wanted = LOW_BALANCE_PER_COIN * BigInt(coinCount)
    if (lamports >= wanted) return
    const sol = (v) => (Number(v) / 1e9).toFixed(4)
    log(
      `keeper wallet ${keeper.publicKey.toBase58()} holds ${sol(lamports)} SOL, under about a ` +
        `day of epoch rent and fees for ${coinCount} coins (${sol(wanted)} SOL); top it up`,
    )
    alerts.push({ kind: 'low-balance', lamports: String(lamports), wanted: String(wanted) })
  }

  async function tick({ budget = 6, timeLimitMs: limit = timeLimitMs } = {}) {
    if (!enabled) return { enabled: false }
    const deadline = Date.now() + limit
    const owner = randomBytes(8).toString('hex')
    if (!(await store.set('keeper:lease', owner, { nx: true, ttl: 240000 })))
      return { skipped: true }
    try {
      const listed = await indexer.list()
      if (quantum.dbcMigrationInstructions) await migrateGraduates(listed, deadline)
      const coins = listed.filter(isCandidate)
      // Things the operator must act on: epochs this keeper did not post (cancel them before
      // their claimStart) and a keeper wallet running low. Each is also logged.
      const alerts = []
      await checkBalance(coins.length, alerts)
      const start = Number((await store.get('keeper:cursor')) || 0) % Math.max(1, coins.length)
      let ran = 0
      for (let n = 0; n < Math.min(budget, coins.length); n++) {
        if (Date.now() >= deadline) break
        // Advance first: a coin that keeps outliving the function's time limit is passed over
        // next tick instead of starving every coin after it.
        await store.set('keeper:cursor', (start + n + 1) % coins.length)
        await runCoin(coins[(start + n) % coins.length].mint, deadline, alerts).catch((e) =>
          log(`keeper ${e.message}`),
        )
        ran++
      }
      return { enabled: true, ran, ...(alerts.length ? { alerts } : {}) }
    } finally {
      await store.release('keeper:lease', owner)
    }
  }

  // ---- read API -----------------------------------------------------------------------------

  // Claimable Entanglement leaves for a wallet: open epochs only (on-chain account present,
  // root matches, claims open, not expired) and leaves not yet claimed on-chain. One summary and
  // one bucket read per open epoch plus one account read; proofs were stored at post time. An
  // epoch whose claimStart is still ahead is not offered: the program refuses the claim, and the
  // authority may yet cancel the epoch. epochs() says when its claims open.
  async function claims(mint, wallet) {
    const key = address(mint, 'coin')
    const owner = address(wallet, 'wallet').toBase58()
    if (!quantum) return []
    const now = nowSecs()
    const indexes = ((await store.get(keys.list(mint))) || []).slice(0, OPEN_EPOCHS)
    const records = await Promise.all(indexes.map((i) => store.get(keys.epoch(mint, i))))
    const open = records.filter(
      (r) =>
        r?.buckets &&
        !r.closed &&
        (r.expiresAt === undefined || r.expiresAt > now) &&
        !(Number(r.claimStart) > now),
    )
    const found = (
      await Promise.all(open.map(async (rec) => ({ rec, leaf: await findLeaf(mint, rec, owner) })))
    ).filter((f) => f.leaf)
    if (!found.length) return []
    const chain = await readEpochs(
      key,
      found.map((f) => f.rec.index),
    )
    const out = []
    for (const [k, { rec, leaf }] of found.entries()) {
      const epoch = chain[k]
      if (!epoch || hex(epoch.root) !== rec.root || epoch.expiresAt <= now) continue
      // An account without claimStart predates the claim delay: its claims opened at once.
      if (epoch.claimStart != null && now < Number(epoch.claimStart) + CLOCK_SLACK) continue
      if (leaf.leafIndex >= epoch.leafCount || quantum.isLeafClaimed(epoch, leaf.leafIndex))
        continue
      // A single-leaf tree has an empty proof (''); leaves stored without one are not served.
      if (typeof leaf.proof !== 'string') continue
      out.push({
        index: rec.index,
        leafIndex: leaf.leafIndex,
        amount: leaf.amount,
        proof: unpackProof(leaf.proof),
        claimStart: Number(epoch.claimStart ?? epoch.createdAt),
        expiresAt: epoch.expiresAt,
      })
    }
    return out
  }

  // Recent epoch summaries (never the leaves). claimStart (unix seconds) is when the epoch's
  // claims open, null for records from before the claim delay; a cancelled epoch is also closed.
  async function epochs(mint) {
    address(mint, 'coin')
    const indexes = ((await store.get(keys.list(mint))) || []).slice(0, EPOCH_PAGE)
    const rows = await Promise.all(indexes.map((i) => store.get(keys.epoch(mint, i))))
    return rows
      .filter((e) => e && e.status !== 'pending')
      .map((e) => ({
        index: e.index,
        total: e.total,
        postedAt: e.postedAt,
        claimStart: e.claimStart ?? null,
        expiresAt: e.expiresAt ?? null,
        holders: e.holders ?? e.leaves?.length ?? 0,
        closed: !!e.closed,
        cancelled: !!e.cancelled,
        signature: e.signature,
      }))
  }

  return {
    enabled,
    keeper: keeper?.publicKey.toBase58() || null,
    tick,
    claims,
    log: (mint) => store.get(`keeper:log:${mint}`).then((r) => r || []),
    epochs,
  }
}
