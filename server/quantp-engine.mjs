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
// from its wallet (server/quantp.mjs). Each one ends with a memo naming its run's hour, and a run
// first claims its hour on-chain (claimInstructions), so no hour is paid twice, whatever the store
// says.
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import bs58 from 'bs58'
import {
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
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
// The runtime's reserved account keys (Agave's reserved_account_keys): the System Program, the
// builtin and loader programs, the signature-verification precompiles and every sysvar. A token
// account can name any of them as its owner, several are on the ed25519 curve, and no transfer can
// credit them: one in a payout batch would get the whole batch refused.
const RESERVED = new Set([
  '11111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
  'Feature111111111111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'StakeConfig11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'ZkE1Gama1Proof11111111111111111111111111111',
  'ZkTokenProof1111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Secp256r1SigVerify1111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarEpochRewards1111111111111111111111111',
  'SysvarEpochSchedu1e111111111111111111111111',
  'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111',
  'SysvarS1otHistory11111111111111111111111111',
  'SysvarStakeHistory1111111111111111111111111',
])
// The least SOL an empty wallet can be sent (rent exemption for an account of 0 bytes) when the
// chain cannot be asked: the engine reads the real figure from the Rent sysvar, and this older,
// higher one only skips more shares, never fails a transfer.
const RENT_EXEMPT = 890_880n
// SOL transfers per payout transaction: each adds an account and an instruction, about 49 bytes,
// and 18 with the run's memo come to about 1,190 of the 1,232 bytes a transaction may take.
const TRANSFERS_PER_TX = 18
const LAST_RUN = 'quantp:engine:last'
const LOCK = 'quantp:engine:lock'
// Every engine transaction ends with a memo that starts with this and names its run's hour
// (`h=<period>`), so the chain says which hour a transaction belongs to, whenever it landed.
export const ENGINE_MEMO = 'qp-engine:v1'
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
// Compute units. A transaction that runs out fails on-chain, so each asks about twice what it
// uses (scripts/simulate-engine-run.mjs measures them on mainnet): the memo costs about 370 a
// character (a payout batch's 51 took 19,711, and its longest is about 55), the claim's own
// instructions under 1,000, a transfer 150, and the buyback's swap and burn 37,816.
const MEMO_UNITS = 45_000
const CLAIM_UNITS = 5_000 + MEMO_UNITS
const payoutUnits = (recipients) => 2_000 + 300 * recipients + MEMO_UNITS
const BUYBACK_UNITS = 75_000 + MEMO_UNITS
// A claim takes back the rent of earlier hours' claim accounts: it looks this many hours back, and
// takes back at most this many at once.
const RECLAIM_HOURS = 24
const RECLAIM_MAX = 4
// The run check reads at most this many of the wallet's transactions in full.
const CHAIN_READS = 6
// Preflight refusals that say nothing about the transaction, only that the node is behind the one
// that gave the blockhash: the same signed bytes are sent again.
const TRANSIENT = /Blockhash not found|Minimum context slot|Node is behind|unhealthy/i
const PREFLIGHT_RETRIES = 3

const sum = (list, field) => list.reduce((s, x) => s + x[field], 0n)
// An address a wallet can own: on the ed25519 curve, so no program derived it. Being on the curve
// is not enough to be paid: several reserved keys are (RESERVED), and read() also checks that the
// account itself is a plain wallet.
const isWallet = (address) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes())
  } catch {
    return false
  }
}
// Resolves like `promise`, or rejects after `ms`.
function within(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('timed out')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
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
 * belong to program addresses, which are off the ed25519 curve, and the runtime's reserved keys
 * (RESERVED) are left out with the incinerator and `exclude` (the team's wallets).
 */
export function eligibleHolders(accounts, { supply, minHoldBps, exclude = [] }) {
  const byOwner = new Map()
  for (const { owner, amount } of accounts)
    byOwner.set(owner, (byOwner.get(owner) || 0n) + BigInt(amount))
  const skip = new Set([INCINERATOR, ...RESERVED, ...exclude])
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
 * Each run releases the tier's dailyBps/24 of what the wallet holds then, so 24 runs with nothing
 * coming in release about 18%, 40% or 64% of it, not the whole daily share.
 * `holders` are eligibleHolders whose wallets can be paid; `lamportsOf` maps a holder to its SOL
 * now. A share below the minimum transfer, or below `rentExemptLamports` for a wallet holding no
 * SOL (the least a new account can receive), is skipped that run and stays in the wallet
 * (`skipped` lists them); so does a buyback below its minimum, and everything not released.
 */
export function planRun({
  balance,
  marketCapUsd,
  holders,
  lamportsOf = new Map(),
  policy = QUANTP.engine,
  holdersShareBps = QUANTP.holdersShareBps,
  rentExemptLamports = RENT_EXEMPT,
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
  const skipped = []
  for (const h of holders) {
    const lamports = held > 0n ? (holdersPot * h.amount) / held : 0n
    const empty = lamportsOf.get(h.owner) === 0n
    const reason =
      lamports < BigInt(policy.minTransferLamports)
        ? 'below-minimum'
        : empty && lamports < BigInt(rentExemptLamports)
          ? 'no-sol'
          : null
    if (reason) skipped.push({ wallet: h.owner, amount: h.amount, lamports, reason })
    else payouts.push({ wallet: h.owner, amount: h.amount, lamports })
  }
  const buyback = buybackPot >= BigInt(policy.minBuybackLamports) ? buybackPot : 0n
  return {
    available,
    dailyBps,
    release,
    holdersPot,
    buybackPot,
    held,
    eligible: holders.length,
    payouts,
    skipped,
    paying: sum(payouts, 'lamports'),
    buyback,
    buybackSkipped: buybackPot > 0n && !buyback ? 'below minimum' : null,
  }
}

/** A memo instruction (spl-memo, no signers) recording `text` with the transaction. */
export function memoInstruction(text) {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [],
    data: Buffer.from(text, 'utf8'),
  })
}

/** The run hour an engine memo names (a transaction's memo as the RPC lists it), or null. */
export function memoHour(memo) {
  const m = new RegExp(`${ENGINE_MEMO} h=(\\d+)`).exec(memo ?? '')
  return m ? Number(m[1]) : null
}

/**
 * The memos of a run in `hour`: its payout batches carry the holders' pot and the eligible
 * balance it is shared over, its buyback the SOL it spends, and its claim says what it is.
 */
export const engineMemo = {
  payout: (hour, plan) => `${ENGINE_MEMO} h=${hour} pot=${plan.holdersPot} H=${plan.held}`,
  buyback: (hour, lamports) => `${ENGINE_MEMO} h=${hour} bb=${lamports}`,
  claim: (hour) => `${ENGINE_MEMO} h=${hour} claim`,
}

/**
 * The plan's payouts in transactions of at most `size` transfers, from `from`, each ending with
 * `memo` when given.
 */
export function payoutTransactions(from, payouts, { size = TRANSFERS_PER_TX, memo = null } = {}) {
  const out = []
  for (let i = 0; i < payouts.length; i += size) {
    const batch = payouts.slice(i, i + size)
    out.push({
      lamports: sum(batch, 'lamports'),
      recipients: batch.length,
      payouts: batch,
      instructions: payoutInstructions(from, batch, memo),
    })
  }
  return out
}

function payoutInstructions(from, payouts, memo) {
  const fromPubkey = new PublicKey(from)
  return [
    ...payouts.map((p) =>
      SystemProgram.transfer({
        fromPubkey,
        toPubkey: new PublicKey(p.wallet),
        lamports: p.lamports,
      }),
    ),
    ...(memo ? [memoInstruction(memo)] : []),
  ]
}

/**
 * The seed of hour `period`'s claim account: an HMAC of the hour under the engine's secret key, so
 * only the key holder can work out the address, and nobody can fund it first to block that hour.
 */
export function hourSeed(secretKey, period) {
  return createHmac('sha256', Buffer.from(secretKey))
    .update(`qp-engine-hour:${period}`)
    .digest('hex')
    .slice(0, 32)
}

/** The address of `wallet`'s claim account for `seed` (hourSeed): a 0-byte system account. */
export const hourAccount = (wallet, seed) =>
  PublicKey.createWithSeed(new PublicKey(wallet), seed, SystemProgram.programId)

/**
 * The claim of hour `period`, sent as its own transaction before any payout. It creates the hour's
 * account (`account`, from `seed`, holding `lamports` of rent), which the System Program refuses
 * with AccountAlreadyInUse when a run of the same hour got there first: two runs racing for one
 * hour cannot both pay. It also takes back the rent of earlier hours' accounts (`reclaims`:
 * { seed, address, lamports }, at most RECLAIM_MAX), and ends with the memo. Nothing in it is a
 * transfer from the wallet, so the ledger (server/quantp.mjs) never counts it as a payout.
 */
export function claimInstructions({ wallet, period, seed, account, lamports, reclaims = [] }) {
  const owner = new PublicKey(wallet)
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner,
      basePubkey: owner,
      seed,
      newAccountPubkey: new PublicKey(account),
      lamports: Number(lamports),
      space: 0,
      programId: SystemProgram.programId,
    }),
    ...reclaims.slice(0, RECLAIM_MAX).map((r) =>
      SystemProgram.transfer({
        fromPubkey: new PublicKey(r.address),
        basePubkey: owner,
        toPubkey: owner,
        lamports: BigInt(r.lamports),
        seed: r.seed,
        programId: SystemProgram.programId,
      }),
    ),
    memoInstruction(engineMemo.claim(period)),
  ]
}

/**
 * Buy $QUANTP with `lamports` in its DAMM v2 pool (`venue` from fetchMeteoraVenue) and burn, in
 * the same transaction, the least the swap can return plus `held` (what the wallet already holds,
 * such as a buy's extra over its minimum last time). `point` is the pool's clock now. `memo`, when
 * given, comes last.
 */
export async function buybackInstructions({
  venue,
  wallet,
  lamports,
  held = 0n,
  point,
  slippageBps,
  token = QUANTP,
  memo = null,
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
      ...(memo ? [memoInstruction(memo)] : []),
    ],
  }
}

/**
 * An engine transaction, unsigned: its compute budget (`units` at `price` µlamports each) first,
 * then `instructions`, paid by `payer`.
 */
export function engineTransaction({ payer, instructions, units, price, blockhash }) {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(payer),
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
        ...instructions,
      ],
    }).compileToV0Message(),
  )
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

// A preflight refusal: the node answered with an error, so it did not forward the transaction.
const isRefusal = (e) =>
  e instanceof SendTransactionError || typeof e?.transactionMessage === 'string'
// The instruction a refused or failed transaction stopped at, as [index, error], or null: from the
// simulation's error when it names one, else from the node's message.
function instructionError(e) {
  if (Array.isArray(e?.txErr?.InstructionError)) return e.txErr.InstructionError
  const m = /Error processing Instruction (\d+): (.*)$/.exec(e?.rpcMessage ?? e?.message ?? '')
  return m ? [Number(m[1]), m[2]] : null
}
// AccountAlreadyInUse at the claim's account creation (instruction 2, after the compute budget).
function claimedAlready(e) {
  const [index, error] = instructionError(e) ?? []
  return index === 2 && (error?.Custom === 0 || /^custom program error: 0x0$/.test(String(error)))
}
// What a run reports of a failed transaction: the node's own words, where it failed, and the
// signature only when it was sent (null when preflight refused it).
const failure = (e) => ({
  error: e.rpcMessage ?? e.message,
  ...(e.stage ? { stage: e.stage } : {}),
  ...(e.stage === 'preflight'
    ? {
        rpcMessage: e.rpcMessage,
        logs: e.logs,
        simErr: e.simErr,
        unitsConsumed: e.unitsConsumed,
      }
    : {}),
  signature: e.signature || null,
})

/**
 * The engine. `secret` is QUANTP_ENGINE_SECRET (base58 or a JSON byte array), `feed` the $QUANTP
 * feed (server/quantp.mjs createQuantpFeed) for the market cap and supply, `store` the app's store
 * for the hourly record and run lock, and `ledger` the payouts and burns reader (createQuantpLedger)
 * for when the wallet last paid and burned, which the site shows.
 *   tick({ deadline }) runs once in each clock hour (UTC), and says what it did.
 *   status() is what the site shows: the wallet, whether it is live, the tier and what the next
 *   run would release, the eligible holders, and when it last ran.
 *   draft({ secretKey }) builds the transactions a run would send now, never signed
 *   (scripts/simulate-engine-run.mjs).
 */
export function createQuantpEngine({
  connection,
  store,
  feed,
  ledger = null,
  secret,
  paused = false,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
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
  let lastSource = null // how this instance knows it: 'local' (it ran it) or 'chain'
  let lastReport = null // this instance's last run, as status() shows it
  let rent = null // the chain's rent exemption for an empty account, read once

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

  // Each owner's SOL, and whether a transfer can pay it: a missing account (an empty wallet, which
  // the rent rule covers) or a plain wallet, one the System Program owns that holds no data and
  // runs no code. A program, a sysvar or a program's data account would get its batch refused.
  async function walletLamports(owners) {
    const out = new Map()
    for (let i = 0; i < owners.length; i += 100) {
      const keys = owners.slice(i, i + 100)
      const infos = await connection.getMultipleAccountsInfo(
        keys.map((k) => new PublicKey(k)),
        'confirmed',
      )
      keys.forEach((k, j) => {
        const info = infos[j]
        out.set(k, {
          lamports: BigInt(info?.lamports ?? 0),
          payable:
            !info ||
            (new PublicKey(info.owner).equals(SystemProgram.programId) &&
              !info.executable &&
              (info.data?.length ?? 0) === 0),
        })
      })
    }
    return out
  }

  async function rentExempt() {
    if (rent == null)
      rent = await Promise.resolve()
        .then(() => connection.getMinimumBalanceForRentExemption(0, 'confirmed'))
        .then(
          (v) => (Number.isSafeInteger(v) && v > 0 ? BigInt(v) : null),
          () => null,
        )
    return rent ?? RENT_EXEMPT
  }

  async function heldTokens() {
    const account = getAssociatedTokenAddressSync(mint, walletKey, false, TOKEN_2022_PROGRAM_ID)
    try {
      return BigInt((await connection.getTokenAccountBalance(account, 'confirmed')).value.amount)
    } catch {
      return 0n // no account yet
    }
  }

  // Everything a plan needs, read now. `holders` are every eligible holder, those that cannot be
  // paid (`notPayable`) included; the plan shares the holders' pot among the others.
  async function read() {
    const [balance, snapshot, accounts, rentExemptLamports] = await Promise.all([
      connection.getBalance(walletKey, 'confirmed'),
      feed.snapshot(),
      holderAccounts(),
      rentExempt(),
    ])
    const supply = snapshot?.supply
    if (supply == null) throw Error('The $QUANTP supply could not be read.')
    const holders = eligibleHolders(accounts, {
      supply,
      minHoldBps: policy.minHoldBps,
      exclude: [...team.all, wallet],
    })
    const wallets = await walletLamports(holders.map((h) => h.owner))
    const payable = holders.filter((h) => wallets.get(h.owner).payable)
    const lamportsOf = new Map(payable.map((h) => [h.owner, wallets.get(h.owner).lamports]))
    const marketCapUsd = snapshot.marketCapUsd ?? null
    return {
      supply: BigInt(supply),
      marketCapUsd,
      balance: BigInt(balance),
      rentExemptLamports,
      holders,
      notPayable: holders.filter((h) => !wallets.get(h.owner).payable),
      plan: planRun({
        balance,
        marketCapUsd,
        holders: payable,
        lamportsOf,
        policy,
        rentExemptLamports,
      }),
    }
  }

  // The engine wallet's newest payout and burn in the ledger, in seconds (null when none, or when
  // the ledger cannot answer within 1.5 s). For the site only: the ledger is cached per instance,
  // so it never decides whether a run is due.
  async function lastActivity() {
    const l = ledger ? await within(ledger.ledger(), 1_500).catch(() => null) : null
    const newest = (times) => {
      const known = times.filter(Number.isFinite)
      return known.length ? Math.max(...known) : null
    }
    return {
      paidAt: newest(
        (l?.payouts ?? [])
          .filter((p) => p.wallet === wallet)
          .flatMap((p) => p.transactions.map((t) => t.timestamp)),
      ),
      burnAt: newest((l?.burns ?? []).filter((b) => b.wallet === wallet).map((b) => b.timestamp)),
    }
  }

  // The store's record of when the last run started (ms): null when it has none, undefined when
  // it cannot answer.
  const storedRun = () =>
    store.get(LAST_RUN).then(
      (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)),
      () => undefined,
    )

  // One run in each period (everySecs: each UTC clock hour), wherever in it the tick comes. A
  // scheduler that starts anywhere within the hour, as Vercel Cron does on Hobby, still runs it
  // every hour, and a day never has more runs than the 24 a release is sized for.
  const period = (t) => Math.floor(t / (policy.everySecs * 1000))

  // Whether the chain shows a run in `startedAt`'s hour, read fresh: a transaction of the wallet's
  // that the wallet paid the fee for (which only its key can sign), unless its memo names an
  // earlier hour (a run that started before the hour turned and landed after). A stranger's dust
  // never counts, whatever its memo says. Resolves to { at: when that transaction landed (ms), or
  // null; conclusive: false when there was more to read than it read }. Throws when the wallet's
  // history cannot be listed.
  async function chainRunThisPeriod(startedAt) {
    const hour = period(startedAt)
    const inHour = (blockTime) => blockTime == null || period(blockTime * 1000) >= hour
    const list = await connection.getSignaturesForAddress(walletKey, { limit: 25 }, 'confirmed')
    const recent = list.filter((s) => inHour(s.blockTime))
    const tagged = (s) => String(s.memo ?? '').includes(ENGINE_MEMO)
    // the engine's own memos first (anyone can write one, so each is still checked), then newest
    const candidates = [...recent.filter(tagged), ...recent.filter((s) => !tagged(s))]
    // a full page of this hour's transactions may not hold all of them
    let conclusive = !(list.length >= 25 && inHour(list.at(-1).blockTime))
    if (candidates.length > CHAIN_READS) conclusive = false
    for (const s of candidates.slice(0, CHAIN_READS)) {
      // one transaction the node cannot return (in a version it does not read, say) is no answer
      const tx = await Promise.resolve()
        .then(() =>
          connection.getTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
        )
        .catch(() => null)
      if (!tx) {
        conclusive = false
        continue
      }
      const message = tx.transaction?.message
      const payer = (message?.staticAccountKeys ?? message?.accountKeys)?.[0]
      if (!payer || !new PublicKey(payer).equals(walletKey)) continue
      const time = tx.blockTime ?? s.blockTime
      const named = memoHour(s.memo)
      if (!inHour(time) || (named != null && named < hour)) continue
      return { at: time == null ? startedAt : time * 1000, conclusive: true }
    }
    return { at: null, conclusive }
  }

  // The fee per compute unit: the 75th percentile of recent non-zero fees paid by transactions
  // that wrote to `accounts` (the ones this transaction writes), between 10,000 and 500,000.
  async function priorityFee(accounts) {
    const fees = await Promise.resolve()
      .then(() => connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts }))
      .catch(() => [])
    const paid = fees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b)
    const p75 = paid.length ? paid[Math.floor((paid.length - 1) * 0.75)] : 0
    return Math.min(Math.max(p75, 10_000), 500_000)
  }

  // Signs and sends `instructions`, and resolves to the signature once it is confirmed. A refusal
  // that only says the node was behind (no logs, or a blockhash it has not seen yet) is answered by
  // sending the same signed bytes again, never by signing anew: whatever the node did with them,
  // the transaction can land once at most. Errors carry `stage`: 'preflight' when the node refused
  // it (it was not sent: `signature` is null), 'confirm' after it was sent (with its signature, and
  // `unknown` when it may still land).
  async function send(instructions, { units, deadline, accounts = [walletKey] }) {
    const price = await priorityFee(accounts)
    const {
      context,
      value: { blockhash, lastValidBlockHeight },
    } = await connection.getLatestBlockhashAndContext('confirmed')
    const tx = engineTransaction({ payer: walletKey, instructions, units, price, blockhash })
    tx.sign([keypair])
    const signature = bs58.encode(tx.signatures[0])
    const bytes = tx.serialize()
    // preflight simulates it: a transaction that would fail is refused before it is sent
    for (let tries = 0; ; tries++) {
      try {
        await connection.sendRawTransaction(bytes, {
          minContextSlot: context.slot,
          preflightCommitment: 'confirmed',
        })
        break
      } catch (e) {
        if (!isRefusal(e)) break // a network error or timeout: it may be out, so see if it lands
        const transient =
          TRANSIENT.test(e.transactionMessage ?? '') ||
          (Array.isArray(e.transactionLogs) && e.transactionLogs.length === 0)
        if (transient && tries < PREFLIGHT_RETRIES && now() < deadline) {
          await sleep(700)
          continue
        }
        throw await refusal(tx, e)
      }
    }
    return confirm(signature, bytes, lastValidBlockHeight, deadline)
  }

  // The refusal as an error that says why: the node's message and logs, and one simulation of the
  // same transaction for the error itself (web3.js drops it), on its own blockhash, since a
  // replaced one would hide BlockhashNotFound.
  async function refusal(tx, e) {
    const sim = await Promise.resolve()
      .then(() => connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' }))
      .then(
        (r) => r.value,
        () => null,
      )
    const rpcMessage = e.transactionMessage ?? e.message
    const logs = e.transactionLogs?.length ? e.transactionLogs : (sim?.logs ?? [])
    return Object.assign(Error(rpcMessage), {
      stage: 'preflight',
      rpcMessage,
      logs: logs.slice(-10),
      simErr: sim ? JSON.stringify(sim.err) : null,
      unitsConsumed: sim?.unitsConsumed ?? null,
      signature: null,
      txErr: sim?.err ?? null,
    })
  }

  // Waits for `signature` to confirm, sending the same bytes again every 2 s (without preflight)
  // in case a node dropped them. Stops when it lands, fails, the deadline passes or its blockhash
  // expires. An RPC error while it waits is no answer, so it asks again.
  async function confirm(signature, bytes, lastValidBlockHeight, deadline) {
    let sentAt = now()
    for (;;) {
      const [status] = await Promise.resolve()
        .then(() => connection.getSignatureStatuses([signature]))
        .then(
          (r) => r.value,
          () => [null],
        )
      if (status?.err)
        throw Object.assign(
          Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`),
          { stage: 'confirm', signature, txErr: status.err },
        )
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized')
        return signature
      const height = await Promise.resolve()
        .then(() => connection.getBlockHeight('confirmed'))
        .catch(() => null)
      if (now() > deadline || height > lastValidBlockHeight)
        throw Object.assign(Error(`Transaction ${signature} is not confirmed yet.`), {
          stage: 'confirm',
          signature,
          unknown: true,
        })
      if (now() - sentAt >= 2_000) {
        sentAt = now()
        await Promise.resolve()
          .then(() => connection.sendRawTransaction(bytes, { skipPreflight: true }))
          .catch(() => {})
      }
      await sleep(1000)
    }
  }

  // Hour `hour`'s claim (claimInstructions), with the earlier hours' accounts that still hold rent:
  // one read of the last RECLAIM_HOURS hours' addresses (none when it fails: they wait). `bare` is
  // the claim without them.
  async function claimFor(hour, secretKey) {
    const seed = hourSeed(secretKey, hour)
    const earlier = await Promise.all(
      Array.from({ length: RECLAIM_HOURS }, async (_, i) => {
        const s = hourSeed(secretKey, hour - 1 - i)
        return { seed: s, address: await hourAccount(walletKey, s) }
      }),
    )
    const infos = await Promise.resolve()
      .then(() =>
        connection.getMultipleAccountsInfo(
          earlier.map((e) => e.address),
          'confirmed',
        ),
      )
      .catch(() => [])
    const reclaims = earlier
      .flatMap((e, i) => {
        const info = infos?.[i]
        return info?.lamports > 0 &&
          new PublicKey(info.owner).equals(SystemProgram.programId) &&
          (info.data?.length ?? 0) === 0
          ? [{ ...e, lamports: BigInt(info.lamports) }]
          : []
      })
      .slice(0, RECLAIM_MAX)
    const account = await hourAccount(walletKey, seed)
    const lamports = await rentExempt()
    const build = (r) =>
      claimInstructions({ wallet, period: hour, seed, account, lamports, reclaims: r })
    return { seed, account, reclaims, instructions: build(reclaims), bare: build([]) }
  }

  // Claims hour `hour`: resolves to { signature }, or { locked: true } when a run of this hour
  // claimed it first; throws on anything else. A refusal at a reclaim (an earlier account whose
  // balance moved) is tried once more without the reclaims. Signing anew is safe for a claim: its
  // account can be created once at most.
  async function claimHour(hour, deadline) {
    const claim = await claimFor(hour, keypair.secretKey)
    let instructions = claim.instructions
    for (;;) {
      try {
        return { signature: await send(instructions, { units: CLAIM_UNITS, deadline }) }
      } catch (e) {
        if (claimedAlready(e)) return { locked: true }
        const [index] = instructionError(e) ?? []
        if (e.stage === 'preflight' && instructions !== claim.bare && claim.reclaims.length) {
          if (index > 2 && index <= 2 + claim.reclaims.length && now() < deadline) {
            instructions = claim.bare
            continue
          }
        }
        throw e
      }
    }
  }

  // The buyback of `plan` in hour `hour`, built against the pool now, or why there is none.
  async function buybackFor(plan, hour) {
    const venue = await fetchMeteoraVenue(connection, mint, { dbcPool: token.pool })
    if (venue.kind !== 'pool') return { stopped: 'no DAMM v2 pool' }
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
      memo: engineMemo.buyback(hour, plan.buyback),
    })
    // the accounts its priority fee is read for: the pool, its vaults and the wallet
    const accounts = [venue.dammPool, venue.damm.tokenAVault, venue.damm.tokenBVault, wallet]
    return { buy, accounts: accounts.map((a) => new PublicKey(a)) }
  }

  // Sends one payout batch, recording it in `report`. When preflight refuses it at one transfer
  // (InstructionError [i, …]: the two compute-budget instructions come first, the memo last), that
  // recipient is left out and the rest sent once more. Resolves to 'unknown' when it went out and
  // did not confirm in time.
  async function payBatch(batch, memo, deadline, report) {
    let payouts = batch.payouts
    for (let retry = false; ; retry = true) {
      try {
        const signature = await send(payoutInstructions(wallet, payouts, memo), {
          units: payoutUnits(payouts.length),
          deadline,
        })
        report.payouts.push({
          signature,
          lamports: sum(payouts, 'lamports').toString(),
          recipients: payouts.length,
        })
        return 'sent'
      } catch (e) {
        const lost = { recipients: payouts.length, lamports: sum(payouts, 'lamports').toString() }
        if (e.unknown) {
          report.failed.push({ ...lost, ...failure(e), unknown: true })
          return 'unknown'
        }
        const [index, error] = instructionError(e) ?? []
        const at = index - 2
        if (!retry && e.stage === 'preflight' && at >= 0 && at < payouts.length) {
          report.skipped.push({
            wallet: payouts[at].wallet,
            reason: typeof error === 'string' ? error : JSON.stringify(error),
          })
          payouts = payouts.filter((_, i) => i !== at)
          if (payouts.length) continue
          return 'skipped'
        }
        report.failed.push({ ...lost, ...failure(e) })
        return 'failed'
      }
    }
  }

  // Sends the plan, recording each transaction in `report` as it confirms (so a run that fails
  // part way still says what it sent). Each payout batch stands alone: one that fails is recorded
  // and the next one sent. The buyback is tried whatever the payouts did, while there is time.
  // Resolves to why it stopped early, or null.
  async function execute({ plan }, hour, deadline, report) {
    const memo = engineMemo.payout(hour, plan)
    let stopped = null
    for (const batch of payoutTransactions(wallet, plan.payouts, { memo })) {
      if (now() > deadline) {
        stopped = 'time limit'
        break
      }
      // sent and not confirmed in time: the rest wait, since the time they needed is gone
      if ((await payBatch(batch, memo, deadline, report)) === 'unknown') {
        stopped = 'payout not confirmed'
        break
      }
    }
    if (plan.buyback > 0n) {
      if (now() > deadline) return stopped ?? 'time limit before buyback'
      const b = await buybackFor(plan, hour)
      if (b.stopped) return stopped ?? b.stopped
      const signature = await send(b.buy.instructions, {
        units: BUYBACK_UNITS,
        deadline,
        accounts: b.accounts,
      })
      report.buyback = {
        signature,
        lamports: plan.buyback.toString(),
        burned: b.buy.burn.toString(),
      }
    }
    return stopped
  }

  // Keeps what status() shows of this instance's last run, and warns of a run that stopped early.
  function remember(at, result) {
    lastReport = {
      at: Math.floor(at / 1000),
      ok: !result.error && !result.stopped,
      stopped: result.stopped ?? null,
      error: result.error ?? null,
      payouts: (result.payouts ?? []).map((p) => p.signature),
      buyback: result.buyback?.signature ?? null,
      skipped: result.skipped ?? [],
    }
    if (result.stopped) log.warn('[quantp-engine] stopped:', result.stopped)
    return result
  }

  let running = false // this instance's run: with the store down, the store's lock is no guard

  async function tick({ deadline = now() + 25_000 } = {}) {
    if (blocker) return { ran: false, reason: blocker }
    if (running) return { ran: false, reason: 'locked' }
    running = true
    try {
      return await run(deadline)
    } finally {
      running = false
    }
  }

  // Whether this hour still needs its run, cheapest answer first. The store's record and this
  // instance's own runs can only say it ran (either one in this hour is enough); neither can say it
  // is due, since the store may have lost a write. Then the chain, read fresh; and last, the hour's
  // claim on-chain, which only one run can make.
  async function run(deadline) {
    const startedAt = now()
    const hour = period(startedAt)
    const notDue = (at, source) => ({
      ran: false,
      reason: 'not-due',
      source,
      nextAt: (period(at) + 1) * policy.everySecs * 1000,
    })
    const stored = await storedRun()
    const cheap = Math.max(stored ?? 0, lastLocal ?? 0) || null
    if (cheap && period(cheap) >= hour)
      return notDue(cheap, cheap === stored ? 'store' : lastSource)
    let chain
    try {
      chain = await chainRunThisPeriod(startedAt)
    } catch (e) {
      // fail closed: without the chain's word this tick does not run, and the next one asks again
      log.warn('[quantp-engine] the wallet’s history could not be read:', e.message)
      return { ran: false, reason: 'unverified', detail: e.message }
    }
    if (chain.at != null) {
      lastLocal = chain.at
      lastSource = 'chain'
      await store.set(LAST_RUN, chain.at).catch(() => {})
      return notDue(chain.at, 'chain')
    }
    // Inconclusive (more of this hour's transactions than it read): the claim decides.
    const owner = `${startedAt}:${Math.random()}`
    const locked = await store.set(LOCK, owner, { nx: true, ttl: 900_000 }).catch(() => null)
    if (locked === false) return { ran: false, reason: 'locked' }
    try {
      // another instance may have run between the check and the lock
      const again = await storedRun()
      if (again && period(again) >= hour) return notDue(again, 'store')
      return await runHour(startedAt, hour, deadline)
    } finally {
      if (locked) await store.release(LOCK, owner).catch(() => {})
    }
  }

  async function runHour(startedAt, hour, deadline) {
    let state
    try {
      state = await read().catch(async (e) => {
        if (now() >= deadline - 12_000) throw e
        log.warn('[quantp-engine] read failed, trying again:', e.message)
        await sleep(2_500)
        return read()
      })
    } catch (e) {
      log.error('[quantp-engine]', e.message)
      return remember(startedAt, { ran: false, error: e.message })
    }
    // Recorded before anything is sent: a run that dies part way is not repeated that hour.
    lastLocal = startedAt
    lastSource = 'local'
    await store.set(LAST_RUN, startedAt).catch(() => {})
    const plan = state.plan
    const summary = {
      marketCapUsd: state.marketCapUsd,
      dailyBps: plan.dailyBps,
      release: plan.release.toString(),
      eligible: state.holders.length,
      paying: plan.payouts.length,
      plannedBuyback: plan.buyback.toString(),
      ...(plan.buybackSkipped ? { buybackSkipped: plan.buybackSkipped } : {}),
    }
    if (!plan.payouts.length && !plan.buyback)
      return remember(startedAt, {
        ran: true,
        ...summary,
        payouts: [],
        buyback: null,
        note: 'nothing to send',
      })
    let claim
    try {
      claim = await claimHour(hour, deadline)
    } catch (e) {
      // the hour is skipped, never repeated: its claim may yet land
      log.error('[quantp-engine] claim failed:', e.rpcMessage ?? e.message)
      return remember(startedAt, {
        ran: true,
        ...summary,
        payouts: [],
        buyback: null,
        stopped: 'claim failed',
        ...failure(e),
      })
    }
    if (claim.locked) return { ran: false, reason: 'locked', source: 'claim' }
    const report = { claim: claim.signature, payouts: [], buyback: null, skipped: [], failed: [] }
    const outcome = (extra) => {
      const { skipped, failed, ...sent } = report
      return {
        ran: true,
        ...summary,
        ...sent,
        ...(skipped.length ? { skipped } : {}),
        ...(failed.length ? { failed, error: failed[0].error } : {}),
        ...extra,
      }
    }
    try {
      const stopped = await execute(state, hour, deadline, report)
      return remember(startedAt, outcome(stopped ? { stopped } : {}))
    } catch (e) {
      log.error('[quantp-engine]', e.rpcMessage ?? e.message)
      return remember(startedAt, outcome(failure(e)))
    }
  }

  const statusSource = cachedSource(
    async () => {
      const [state, stored, activity] = await Promise.all([read(), storedRun(), lastActivity()])
      const p = state.plan
      // the newest word on when it last ran, and whose
      const [lastRunSource, last] = [
        ['store', stored],
        [lastSource, lastLocal],
        ['ledger', activity.paidAt == null ? null : activity.paidAt * 1000],
        ['ledger', activity.burnAt == null ? null : activity.burnAt * 1000],
      ].reduce((a, b) => (b[1] != null && (a[1] == null || b[1] > a[1]) ? b : a), [null, null])
      const share = new Map([
        ...p.payouts.map((x) => [x.wallet, { lamports: x.lamports.toString(), reason: null }]),
        ...p.skipped.map((x) => [x.wallet, { lamports: null, reason: x.reason }]),
      ])
      const count = (reason) => p.skipped.filter((x) => x.reason === reason).length
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
        rentExemptLamports: state.rentExemptLamports.toString(),
        next: {
          release: p.release.toString(),
          holders: p.paying.toString(),
          buyback: p.buyback.toString(),
          buybackPot: p.buybackPot.toString(),
          paying: p.payouts.length,
          skipped: {
            belowMin: count('below-minimum'),
            noSol: count('no-sol'),
            notPayable: state.notPayable.length,
          },
        },
        eligible: state.holders.length,
        heldEligible: p.held.toString(),
        // every eligible holder, largest first: what the next run sends it, or why nothing
        holders: state.holders.map((h) => ({
          wallet: h.owner,
          amount: h.amount.toString(),
          ...(share.get(h.owner) ?? { lamports: null, reason: 'not-payable' }),
        })),
        lastRunAt: last ? Math.floor(last / 1000) : null,
        lastRunSource,
        nextAt: last ? (period(last) + 1) * policy.everySecs : null,
        lastPaidAt: activity.paidAt,
        lastBurnAt: activity.burnAt,
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
      return { ...r.value, lastRun: lastReport, updatedAt: Math.floor(r.at / 1000), state: r.state }
    },
    // The transactions a run would send now, built as tick() builds them and never signed: the
    // hour's claim (seeded with `secretKey`, any key: the engine's own is not needed to check
    // one), the payout batches and the buyback, each paid by the engine wallet.
    async draft({ secretKey }) {
      const hour = period(now())
      const state = await read()
      const { plan } = state
      const parts = []
      if (plan.payouts.length || plan.buyback) {
        const claim = await claimFor(hour, secretKey)
        parts.push({ label: 'claim', instructions: claim.instructions, units: CLAIM_UNITS, claim })
      }
      const memo = engineMemo.payout(hour, plan)
      for (const batch of payoutTransactions(wallet, plan.payouts, { memo }))
        parts.push({
          label: `payout (${batch.recipients} transfers)`,
          instructions: batch.instructions,
          units: payoutUnits(batch.recipients),
          batch,
        })
      let stopped = null
      if (plan.buyback > 0n) {
        const b = await buybackFor(plan, hour)
        if (b.stopped) stopped = b.stopped
        else
          parts.push({
            label: 'buyback',
            instructions: b.buy.instructions,
            units: BUYBACK_UNITS,
            accounts: b.accounts,
            buy: b.buy,
          })
      }
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const transactions = []
      for (const part of parts) {
        const price = await priorityFee(part.accounts ?? [walletKey])
        transactions.push({
          ...part,
          price,
          transaction: engineTransaction({
            payer: walletKey,
            instructions: part.instructions,
            units: part.units,
            price,
            blockhash,
          }),
        })
      }
      return { hour, state, transactions, stopped }
    },
  }
}
