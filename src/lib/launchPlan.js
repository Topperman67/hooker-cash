// Launch bookkeeping that does not touch the chain: how instruction groups are formed, which stage
// each packed transaction carries, the launch job (frozen inputs plus confirmed signatures,
// persisted per mint) and registration with retries. Pure apart from the injected storage/post.

/**
 * Stages of a launch, in send order:
 * - register: Quantum Hooks `register` (before the coin exists, so it cannot be front-run);
 * - launch:   create_v2 + the launcher's token account + buy_v2 (+ platform fee), one indivisible
 *             group: the dev buy lands in the same transaction as the create or not at all;
 * - buy:      a dev buy rebuilt from the live curve, only if the coin exists without one;
 * - lock:     Time Dilation lock of part of the dev buy.
 * A group may carry several stages (`launch` with a dev buy also completes `buy`).
 */
export const STAGES = ['register', 'launch', 'buy', 'lock']

/** Ordered, non-empty instruction groups and the stages each one completes. */
export function planGroups(parts) {
  const groups = []
  const stages = []
  for (const { stages: names, instructions } of parts)
    if (instructions?.length) {
      groups.push(instructions)
      stages.push(names)
    }
  return { groups, stages }
}

/** Groups for a fresh launch: [register], [create_v2, ATA, buy_v2, fee?], [lock]. */
export function launchGroups({
  register = [],
  launch = [],
  fee = null,
  lock = [],
  devBuy = false,
}) {
  return planGroups([
    { stages: ['register'], instructions: register },
    {
      stages: devBuy ? ['launch', 'buy'] : ['launch'],
      instructions: fee ? [...launch, fee] : launch,
    },
    { stages: ['lock'], instructions: lock },
  ])
}

/** Stages carried by each packed transaction (`groupIndexes` from packTransactions). */
export const stagesPerTransaction = (groupIndexes, groupStages) =>
  groupIndexes.map((indexes) => indexes.flatMap((i) => groupStages[i] || []))

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Everything a launch is built from, captured once at the first submit and frozen. Resuming
 * rebuilds from this, never from the (still editable) form.
 */
export function launchSnapshot({
  launcher,
  name,
  symbol,
  uri,
  quantum,
  hooks,
  devBuyLamports,
  slippagePct,
  platform,
  lookupTable,
  dbcConfig,
}) {
  return deepFreeze({
    launcher,
    name,
    symbol,
    uri,
    quantum: !!quantum,
    hooks: quantum && hooks ? structuredClone(hooks) : null,
    devBuyLamports: BigInt(devBuyLamports || 0n),
    slippagePct: Number(slippagePct),
    platform: { treasury: platform?.treasury || null, feeBps: Number(platform?.feeBps || 0) },
    lookupTable: lookupTable || null,
    dbcConfig: dbcConfig || null,
  })
}

/** The stages this launch needs, from its snapshot. */
export function plannedStages(snapshot) {
  const out = []
  if (snapshot.quantum) out.push('register')
  out.push('launch')
  if (snapshot.devBuyLamports > 0n) out.push('buy')
  if (snapshot.quantum && snapshot.hooks?.lock && snapshot.devBuyLamports > 0n) out.push('lock')
  return out
}

/** Whether the next attempt still has to send Quantum Hooks `register` (refused while paused). */
export const needsRegister = (job) =>
  plannedStages(job.snapshot).includes('register') && !job.done.register

/**
 * Why a Quantum launch must not be signed with this Quantum Hooks config (`fetchConfig`), or null.
 * `register` fails while the program is paused, so the wallet is never asked to sign then. The
 * error is retryable: the same job can be finished once launches reopen.
 */
export function quantumConfigError(config) {
  const message = !config
    ? 'Quantum Hooks is not set up on this network, so nothing was sent.'
    : config.paused
      ? 'Quantum launches are paused right now, so nothing was sent. Try again later.'
      : null
  return message
    ? Object.assign(Error(message), {
        friendly: true,
        retryable: true,
        code: config ? 'quantum_paused' : 'quantum_unavailable',
      })
    : null
}

export function newJob({ mint, keypair = null, snapshot, now = Date.now() }) {
  return {
    mint,
    keypair,
    snapshot,
    done: {},
    signatures: [],
    pending: null,
    registered: false,
    expectedTokens: null,
    createdAt: now,
  }
}

/** Marks the stages of confirmed transactions done and keeps their signatures across attempts. */
export function recordConfirmed(job, txStages, signatures) {
  signatures.forEach((signature, i) => {
    if (!signature) return
    if (!job.signatures.includes(signature)) job.signatures.push(signature)
    for (const stage of txStages[i] || []) job.done[stage] ||= signature
    if (job.pending?.signature === signature) job.pending = null
  })
  return job
}

/** Records the transaction whose outcome is unknown, so a resume can look it up first. */
export function recordPending(job, txStages, error) {
  const index = error?.failedIndex
  if (error?.unknown && error.failedSignature && index != null)
    job.pending = { signature: error.failedSignature, stages: txStages[index] || [] }
  return job
}

/**
 * Folds what the chain shows (`launchProgress`) into the job before a resume. `pendingLanded` is
 * the history lookup of the transaction whose outcome was unknown (true landed, false failed,
 * null still unknown). Only this launch's mint keypair can create the coin, and it always does so
 * in the indivisible create + dev buy group, so a created coin also has its dev buy.
 */
export function reconcileJob(job, progress, pendingLanded = null) {
  if (job.pending) {
    if (pendingLanded === true) recordConfirmed(job, [job.pending.stages], [job.pending.signature])
    else if (pendingLanded === false) job.pending = null
  }
  const planned = plannedStages(job.snapshot)
  if (progress.registered && planned.includes('register')) job.done.register ||= 'chain'
  if (progress.created) {
    job.done.launch ||= 'chain'
    if (planned.includes('buy')) job.done.buy ||= job.done.launch
  }
  if (progress.locked && planned.includes('lock')) job.done.lock ||= 'chain'
  // Every stage is visible on-chain, so once both checks ran the chain is the record.
  job.pending = null
  return job
}

/** The signature of the confirmed transaction that contains create_v2, if known. */
export const createSignature = (job) =>
  job.done.launch && job.done.launch !== 'chain' ? job.done.launch : null

export const remainingStages = (job) => plannedStages(job.snapshot).filter((s) => !job.done[s])

/** A launch is finished when every planned stage is done. */
export const launchComplete = (job) => remainingStages(job).length === 0

/** Whether a failed attempt left something to finish (a landed stage or an unconfirmed send). */
export const hasProgress = (job) => !!job && (Object.keys(job.done).length > 0 || !!job.pending)

// ---------------------------------------------------------------------------------------------
// Persistence: one entry per mint, without the mint keypair.
// ---------------------------------------------------------------------------------------------

export const JOB_PREFIX = 'quantpad:launch-job:'
const JOB_TTL = 14 * 86_400_000

export function serializeJob(job) {
  const { keypair, snapshot, expectedTokens, ...rest } = job
  return JSON.stringify({
    ...rest,
    expectedTokens: expectedTokens == null ? null : String(expectedTokens),
    snapshot: { ...snapshot, devBuyLamports: String(snapshot.devBuyLamports) },
  })
}

export function deserializeJob(text) {
  const raw = JSON.parse(text)
  return {
    ...raw,
    keypair: null,
    done: raw.done || {},
    signatures: raw.signatures || [],
    expectedTokens: raw.expectedTokens == null ? null : BigInt(raw.expectedTokens),
    snapshot: deepFreeze({ ...raw.snapshot, devBuyLamports: BigInt(raw.snapshot.devBuyLamports) }),
  }
}

export function saveJob(storage, job) {
  try {
    storage?.setItem(JOB_PREFIX + job.mint, serializeJob(job))
  } catch {}
}

export function loadJob(storage, mint) {
  try {
    const text = storage?.getItem(JOB_PREFIX + mint)
    return text ? deserializeJob(text) : null
  } catch {
    return null
  }
}

export function removeJob(storage, mint) {
  try {
    storage?.removeItem(JOB_PREFIX + mint)
  } catch {}
}

/** Drops finished or stale jobs. */
export function pruneJobs(storage, now = Date.now()) {
  try {
    for (let i = (storage?.length || 0) - 1; i >= 0; i--) {
      const key = storage.key(i)
      if (!key?.startsWith(JOB_PREFIX)) continue
      const job = loadJob(storage, key.slice(JOB_PREFIX.length))
      if (!job || now - job.createdAt > JOB_TTL || (job.registered && launchComplete(job)))
        storage.removeItem(key)
    }
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// Registration (POST /api/launches)
// ---------------------------------------------------------------------------------------------

// Six attempts over about a minute.
export const REGISTER_DELAYS = [2000, 4000, 8000, 15000, 30000]

/**
 * What to do after /api/launches failed: `retry` on 409 (not indexed yet), 429 (rate limit), 5xx
 * and network errors (no status); `external` only on 400 `not_quantpad`; `capped` on 429
 * `launch_cap` (the server takes no more native launches, so retrying cannot help); `fail`
 * otherwise.
 */
export function registrationOutcome(error) {
  const status = Number(error?.status)
  if (status === 400 && error?.code === 'not_quantpad') return 'external'
  if (status === 429 && error?.code === 'launch_cap') return 'capped'
  if (!status || status === 409 || status === 429 || status >= 500) return 'retry'
  return 'fail'
}

/** Records a finished registration in storage; drops the job when nothing is left to do. */
export function markRegistered(storage, mint) {
  const job = loadJob(storage, mint)
  if (!job) return
  job.registered = true
  if (launchComplete(job)) removeJob(storage, mint)
  else saveJob(storage, job)
}

const registrations = new Map()
/**
 * Registers `job` once per page load, sharing an in-flight attempt between callers (the launch
 * page's error path and the coin page). Marks the stored job registered when the server settled
 * it (registered, or provably external); a failed or capped attempt leaves it for a later visit.
 */
export function registerOnce(job, { post, storage, ...options }) {
  if (job.registered) return Promise.resolve({ status: 'registered' })
  if (!registrations.has(job.mint))
    registrations.set(
      job.mint,
      registerLaunch({ signature: createSignature(job), mint: job.mint, post, ...options })
        .then((result) => {
          if (result.status === 'registered' || result.status === 'external') {
            job.registered = true
            markRegistered(storage, job.mint)
          }
          return result
        })
        .finally(() => registrations.delete(job.mint)),
    )
  return registrations.get(job.mint)
}

/**
 * Registers a launch as a Quant Pad coin with the create transaction's signature (or by mint alone
 * when the signature is unknown; the mint is always sent), retrying with backoff. Tracks it as an
 * external coin when the server says it is provably not a Quant Pad launch, or when the server's
 * native-launch cap is reached (so the coin page can still open it; a later visit retries).
 * Resolves to `{ status: 'registered' | 'external' | 'capped' | 'failed', error? }`.
 */
export async function registerLaunch({
  signature,
  mint,
  post,
  delays = REGISTER_DELAYS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onAttempt,
}) {
  const body = signature ? { signature, mint } : { mint }
  for (let attempt = 0; ; attempt++) {
    onAttempt?.(attempt)
    try {
      await post('/api/launches', body)
      return { status: 'registered' }
    } catch (error) {
      const outcome = registrationOutcome(error)
      if (outcome === 'external' || outcome === 'capped') {
        await post('/api/coins/track', { mint }).catch(() => {})
        return { status: outcome, error }
      }
      if (outcome === 'fail' || attempt >= delays.length) return { status: 'failed', error }
      await sleep(delays[attempt])
    }
  }
}
