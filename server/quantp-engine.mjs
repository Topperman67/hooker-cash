// $QUANTP's payout engine. Every hour (GET /api/keeper/tick, server/application.mjs) it releases
// a slice of the engine wallet's SOL: the market cap tier's share per day (QUANTP.engine.tiers),
// spread over the day's runs, so the SOL trickles out and faster as the market cap grows. Of each
// slice, the team's stated split goes to holders (QUANTP.holdersShareBps, 60%): every wallet
// holding at least QUANTP.engine.minHoldBps of the supply at that moment, in proportion to its
// balance. The rest buys $QUANTP in its DAMM v2 pool and burns it in the same transaction.
//
// The engine signs with QUANTP_ENGINE_SECRET, a hot wallet used for nothing else, and sends only
// when that key's address is the one pinned in QUANTP.engine.wallet. Without both it only plans.
// Every transaction it sends is public on-chain, and the site's Payouts and Burns lists read them
// from its wallet (server/quantp.mjs).
import { Buffer } from 'node:buffer'
import bs58 from 'bs58'
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { dammQuote, dammSwapInstructions, fetchMeteoraVenue } from '../shared/meteora.mjs'
import { QUANTP, network } from '../shared/network.mjs'
import { parseKeeperSecret } from './keeper.mjs'
import { cachedSource, teamWallets } from './quantp.mjs'

const DAY = 86_400
const INCINERATOR = '1nc1nerator11111111111111111111111111111111'
// A transfer this small to an empty wallet fails: Solana keeps accounts above rent exemption.
const RENT_EXEMPT = 890_880n
// SOL transfers per payout transaction: each adds an account and an instruction, about 49 bytes,
// and 20 came to 1,200 of the 1,232 bytes a transaction may take. 18 leave room.
const TRANSFERS_PER_TX = 18
const LAST_RUN = 'quantp:engine:last'
const LOCK = 'quantp:engine:lock'

const sum = (list, field) => list.reduce((s, x) => s + x[field], 0n)
const isWallet = (address) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes())
  } catch {
    return false
  }
}

/** The tier's share of the wallet released per day, in bps, at `marketCapUsd` (lowest if unknown). */
export function dailyBpsAt(marketCapUsd, tiers = QUANTP.engine.tiers) {
  if (!(Number(marketCapUsd) >= 0)) return tiers[0].dailyBps
  return (
    tiers.find((t) => t.belowUsd == null || Number(marketCapUsd) < t.belowUsd) ?? tiers.at(-1)
  ).dailyBps
}

/**
 * The wallets that hold at least `minHoldBps` of `supply` (raw units), from token accounts
 * ({ owner, amount }), summed per owner and largest first. Only wallets count: the pools' vaults
 * belong to program addresses, which are off the ed25519 curve. `exclude` (the team's wallets) and
 * the incinerator are left out.
 */
export function eligibleHolders(accounts, { supply, minHoldBps, exclude = [] }) {
  const byOwner = new Map()
  for (const { owner, amount } of accounts)
    byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(amount))
  const skip = new Set([INCINERATOR, ...exclude])
  const floor = BigInt(supply) * BigInt(minHoldBps)
  return [...byOwner]
    .filter(([owner, amount]) => amount * 10_000n >= floor && !skip.has(owner) && isWallet(owner))
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) =>
      b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.owner < b.owner ? -1 : 1,
    )
}

/**
 * One run: what the engine releases from `balance` (its wallet's lamports) and where it goes.
 * `holders` are eligibleHolders; `lamportsOf` maps a holder to its SOL now, so a share too small
 * for an empty wallet's rent exemption waits. A share below the minimum transfer, or a buyback
 * below its minimum, stays in the wallet for a later run, as does everything not released.
 */
export function planRun({
  balance,
  marketCapUsd,
  holders,
  lamportsOf = new Map(),
  policy = QUANTP.engine,
  holdersShareBps = QUANTP.holdersShareBps,
}) {
  const reserve = BigInt(policy.reserveLamports)
  const available = BigInt(balance) > reserve ? BigInt(balance) - reserve : 0n
  const dailyBps = dailyBpsAt(marketCapUsd, policy.tiers)
  let release = (available * BigInt(dailyBps) * BigInt(policy.everySecs)) / (10_000n * BigInt(DAY))
  if (release > BigInt(policy.maxRunLamports)) release = BigInt(policy.maxRunLamports)
  const holdersPot = (release * BigInt(holdersShareBps)) / 10_000n
  const buybackPot = release - holdersPot
  const held = sum(holders, 'amount')
  const payouts = []
  for (const h of holders) {
    const lamports = held > 0n ? (holdersPot * h.amount) / held : 0n
    const empty = lamportsOf.get(h.owner) === 0n
    if (lamports < BigInt(policy.minTransferLamports) || (empty && lamports < RENT_EXEMPT)) continue
    payouts.push({ wallet: h.owner, amount: h.amount, lamports })
  }
  return {
    available,
    dailyBps,
    release,
    holdersPot,
    buybackPot,
    eligible: holders.length,
    payouts,
    paying: sum(payouts, 'lamports'),
    buyback: buybackPot >= BigInt(policy.minBuybackLamports) ? buybackPot : 0n,
  }
}

/** The plan's payouts in transactions of at most `size` transfers, from `from`. */
export function payoutTransactions(from, payouts, size = TRANSFERS_PER_TX) {
  const fromPubkey = new PublicKey(from)
  const out = []
  for (let i = 0; i < payouts.length; i += size) {
    const batch = payouts.slice(i, i + size)
    out.push({
      lamports: sum(batch, 'lamports'),
      recipients: batch.length,
      instructions: batch.map((p) =>
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: new PublicKey(p.wallet),
          lamports: p.lamports,
        }),
      ),
    })
  }
  return out
}

/**
 * Buy $QUANTP with `lamports` in its DAMM v2 pool (`venue` from fetchMeteoraVenue) and burn, in
 * the same transaction, the least the swap can return plus `held` (what the wallet already holds,
 * such as a buy's extra over its minimum last time). `point` is the pool's clock now.
 */
export async function buybackInstructions({
  venue,
  wallet,
  lamports,
  held = 0n,
  point,
  slippageBps,
  token = QUANTP,
}) {
  const q = dammQuote({
    damm: venue.damm,
    side: 'buy',
    amountIn: lamports,
    slippageBps,
    currentPoint: point,
    decimals: token.decimals,
  })
  if (q.minOut <= 0n) throw Error('The buyback is too small to buy any $QUANTP.')
  const mint = new PublicKey(token.mint)
  const owner = new PublicKey(wallet)
  const swap = await dammSwapInstructions({
    damm: venue.damm,
    dammPool: venue.dammPool,
    mint,
    user: owner,
    side: 'buy',
    amountIn: lamports,
    minOut: q.minOut,
    tokenAProgram: TOKEN_2022_PROGRAM_ID,
  })
  const burn = q.minOut + BigInt(held)
  const account = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)
  return {
    expected: q.out,
    minOut: q.minOut,
    burn,
    instructions: [
      ...swap,
      createBurnCheckedInstruction(
        account,
        mint,
        owner,
        burn,
        token.decimals,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
  }
}

/** Why the engine will not send, or null when it is live. */
export function engineBlocker({ keypair, pinned, paused, badKey = false }) {
  if (!pinned) return 'unpinned' // QUANTP.engine.wallet is not set yet
  if (badKey) return 'bad-key' // QUANTP_ENGINE_SECRET is not a readable secret key
  if (!keypair) return 'no-key' // QUANTP_ENGINE_SECRET is not set on this server
  if (keypair.publicKey.toBase58() !== pinned) return 'key-mismatch'
  if (paused) return 'paused' // QUANTP_ENGINE_PAUSED=1
  return null
}

/**
 * The engine. `secret` is QUANTP_ENGINE_SECRET (base58 or a JSON byte array), `feed` the $QUANTP
 * feed (server/quantp.mjs createQuantpFeed) for the market cap and supply, `store` the app's store
 * for the hourly record and run lock (a store that fails falls back to the wallet's own history).
 *   tick({ deadline }) runs when an hour has passed since the last run, and says what it did.
 *   status() is what the site shows: the wallet, whether it is live, the tier and what the next
 *   run would release, the eligible holders, and when it last ran.
 */
export function createQuantpEngine({
  connection,
  store,
  feed,
  secret,
  paused = false,
  now = Date.now,
  token = QUANTP,
  policy = token.engine,
  log = console,
}) {
  let keypair = null
  let badKey = false
  try {
    keypair = secret ? parseKeeperSecret(secret) : null
  } catch {
    badKey = true // never logged: the value is a secret
  }
  const pinned = policy?.wallet || null
  const blocker = engineBlocker({ keypair, pinned, paused, badKey })
  const wallet = pinned
  const walletKey = wallet ? new PublicKey(wallet) : null
  const mint = new PublicKey(token.mint)
  const team = teamWallets(token)
  let lastLocal = null // this instance's last run, when the store cannot say

  // The holders scan: every token account of the mint as owner and amount (40 bytes each).
  async function holderAccounts() {
    const accounts = await connection.getProgramAccounts(new PublicKey(network.token2022Program), {
      commitment: 'confirmed',
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: token.mint } }],
    })
    return accounts.flatMap(({ account }) => {
      const data = Buffer.from(account.data)
      if (data.length < 40) return []
      const amount = data.readBigUInt64LE(32)
      return amount > 0n ? [{ owner: new PublicKey(data.subarray(0, 32)).toBase58(), amount }] : []
    })
  }

  async function walletLamports(owners) {
    const out = new Map()
    for (let i = 0; i < owners.length; i += 100) {
      const keys = owners.slice(i, i + 100)
      const infos = await connection.getMultipleAccountsInfo(
        keys.map((k) => new PublicKey(k)),
        'confirmed',
      )
      keys.forEach((k, j) => out.set(k, BigInt(infos[j]?.lamports ?? 0)))
    }
    return out
  }

  async function heldTokens() {
    const account = getAssociatedTokenAddressSync(mint, walletKey, false, TOKEN_2022_PROGRAM_ID)
    try {
      return BigInt((await connection.getTokenAccountBalance(account, 'confirmed')).value.amount)
    } catch {
      return 0n // no account yet
    }
  }

  // Everything a plan needs, read now.
  async function read() {
    const [balance, snapshot, accounts] = await Promise.all([
      connection.getBalance(walletKey, 'confirmed'),
      feed.snapshot(),
      holderAccounts(),
    ])
    const supply = snapshot?.supply
    if (supply == null) throw Error('The $QUANTP supply could not be read.')
    const holders = eligibleHolders(accounts, {
      supply,
      minHoldBps: policy.minHoldBps,
      exclude: [...team.all, wallet],
    })
    const lamportsOf = await walletLamports(holders.map((h) => h.owner))
    const marketCapUsd = snapshot.marketCapUsd ?? null
    return {
      supply: BigInt(supply),
      marketCapUsd,
      balance: BigInt(balance),
      plan: planRun({ balance, marketCapUsd, holders, lamportsOf, policy }),
    }
  }

  // When the last run started: the store's record (shared by every instance), else this
  // instance's, else the wallet's newest transaction (any, so a deposit also counts: it can only
  // delay a run, never repeat one).
  async function lastRunAt() {
    const stored = await store.get(LAST_RUN).then(
      (v) => (v == null ? null : Number(v)),
      () => undefined,
    )
    if (stored !== undefined) return stored ?? lastLocal
    const [newest] = await connection
      .getSignaturesForAddress(walletKey, { limit: 1 }, 'confirmed')
      .catch(() => [])
    const chain = newest?.blockTime ? newest.blockTime * 1000 : null
    return Math.max(lastLocal ?? 0, chain ?? 0) || null
  }

  async function send(instructions, { units, deadline }) {
    const fees = await connection.getRecentPrioritizationFees().catch(() => [])
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b)
    const price = Math.min(Math.max(sorted[Math.floor(sorted.length * 0.75)] || 0, 10_000), 500_000)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
          ...instructions,
        ],
      }).compileToV0Message(),
    )
    tx.sign([keypair])
    const signature = bs58.encode(tx.signatures[0])
    // preflight simulates it: a transaction that would fail is refused before it is sent
    await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
    for (;;) {
      const [status] = (await connection.getSignatureStatuses([signature])).value
      if (status?.err) throw Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`)
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
        return signature
      if (now() > deadline || (await connection.getBlockHeight('confirmed')) > lastValidBlockHeight)
        throw Object.assign(Error(`Transaction ${signature} is not confirmed yet.`), {
          signature,
          unknown: true,
        })
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  // Sends the plan, recording each transaction in `report` as it confirms (so a run that fails
  // part way still says what it sent). Resolves to why it stopped early, or null.
  async function execute({ plan }, deadline, report) {
    for (const batch of payoutTransactions(wallet, plan.payouts)) {
      if (now() > deadline) return 'time limit'
      const signature = await send(batch.instructions, {
        units: 2_000 + 300 * batch.recipients,
        deadline,
      })
      report.payouts.push({
        signature,
        lamports: batch.lamports.toString(),
        recipients: batch.recipients,
      })
    }
    if (plan.buyback > 0n && now() <= deadline) {
      const venue = await fetchMeteoraVenue(connection, mint, { dbcPool: token.pool })
      if (venue.kind !== 'pool') return 'no DAMM v2 pool'
      const point =
        Number(venue.damm.raw.activationType) === 1
          ? BigInt(Math.floor(now() / 1000))
          : BigInt(await connection.getSlot('confirmed'))
      const buy = await buybackInstructions({
        venue,
        wallet,
        lamports: plan.buyback,
        held: await heldTokens(),
        point,
        slippageBps: policy.slippageBps,
        token,
      })
      const signature = await send(buy.instructions, { units: 250_000, deadline })
      report.buyback = {
        signature,
        lamports: plan.buyback.toString(),
        burned: buy.burn.toString(),
      }
    }
    return null
  }

  async function tick({ deadline = now() + 25_000 } = {}) {
    if (blocker) return { ran: false, reason: blocker }
    const startedAt = now()
    const last = await lastRunAt()
    if (last && startedAt - last < (policy.everySecs - 300) * 1000)
      return { ran: false, reason: 'not-due', nextAt: last + policy.everySecs * 1000 }
    const owner = `${startedAt}:${Math.random()}`
    const locked = await store.set(LOCK, owner, { nx: true, ttl: 900_000 }).catch(() => null)
    if (locked === false) return { ran: false, reason: 'locked' }
    try {
      const state = await read()
      // Recorded before anything is sent: a run that dies part way is not repeated for an hour.
      lastLocal = startedAt
      await store.set(LAST_RUN, startedAt).catch(() => {})
      const summary = {
        marketCapUsd: state.marketCapUsd,
        dailyBps: state.plan.dailyBps,
        release: state.plan.release.toString(),
        eligible: state.plan.eligible,
        paying: state.plan.payouts.length,
      }
      if (!state.plan.payouts.length && !state.plan.buyback)
        return { ran: true, ...summary, payouts: [], buyback: null, note: 'nothing to send' }
      const report = { payouts: [], buyback: null }
      try {
        const stopped = await execute(state, deadline, report)
        return { ran: true, ...summary, ...report, ...(stopped ? { stopped } : {}) }
      } catch (e) {
        log.error('[quantp-engine]', e.message)
        return {
          ran: true,
          ...summary,
          ...report,
          error: e.message,
          signature: e.signature ?? null,
        }
      }
    } finally {
      if (locked) await store.release(LOCK, owner).catch(() => {})
    }
  }

  const statusSource = cachedSource(
    async () => {
      const [state, last] = await Promise.all([read(), lastRunAt()])
      const p = state.plan
      return {
        configured: true,
        wallet,
        live: !blocker,
        reason: blocker,
        everySecs: policy.everySecs,
        minHoldBps: policy.minHoldBps,
        minHold: ((state.supply * BigInt(policy.minHoldBps)) / 10_000n).toString(),
        tiers: policy.tiers,
        holdersShareBps: token.holdersShareBps,
        marketCapUsd: state.marketCapUsd,
        dailyBps: p.dailyBps,
        balance: state.balance.toString(),
        next: {
          release: p.release.toString(),
          holders: p.paying.toString(),
          buyback: p.buyback.toString(),
          paying: p.payouts.length,
        },
        eligible: p.eligible,
        lastRunAt: last ? Math.floor(last / 1000) : null,
      }
    },
    { ttl: 300_000, retry: 60_000, wait: 8_000, now },
  )

  return {
    tick,
    async status() {
      if (!wallet) return { configured: false }
      const r = await statusSource()
      if (r.state === 'down')
        throw Object.assign(Error('The payout engine’s state is unavailable right now.'), {
          status: 503,
          expose: true,
          code: 'ENGINE_UNAVAILABLE',
        })
      return { ...r.value, updatedAt: Math.floor(r.at / 1000), state: r.state }
    },
  }
}
