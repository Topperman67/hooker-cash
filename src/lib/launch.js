// Launch flow: artwork → metadata → mint keypair → pump.fun create_v2 (+ dev buy), optionally
// wired to Quantum Hooks. The mint keypair signs locally and never leaves the browser.
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token'
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, getBuyTokenAmountFromSolAmount } from '#pump-sdk'
import { api } from './api.js'
import { connection, platformFeeInstruction } from './solana.js'
import { loadQuantum } from './quantum.js'
import {
  launchGroups,
  planGroups,
  plannedStages,
  quantumConfigError,
  reconcileJob,
} from './launchPlan.js'

export const MINT_SUFFIX = 'QP'

export async function uploadArtwork(file) {
  if (!file) throw Error('Choose token artwork.')
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw Error('Use a PNG, JPEG, WebP or GIF image.')
  if (file.size > 1_500_000) throw Error('Choose an image under 1.5 MB.')
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(Error('Could not read that image.'))
    reader.readAsDataURL(file)
  })
  return (await api('/api/media', { data })).url
}

export async function publishMetadata(draft, image) {
  const { uri } = await api('/api/metadata', {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    description: draft.description.trim(),
    image,
    website: draft.website.trim(),
    twitter: draft.twitter.trim(),
    telegram: draft.telegram.trim(),
  })
  return uri
}

// Vanity mint ending in "QP" (about 3 400 tries on average). Yields to keep the page responsive
// and falls back to an ordinary address if it takes too long.
export async function grindMint({ suffix = MINT_SUFFIX, budgetMs = 6000, onProgress } = {}) {
  const started = performance.now()
  let tries = 0
  while (performance.now() - started < budgetMs) {
    for (let i = 0; i < 250; i++) {
      const keypair = Keypair.generate()
      tries++
      if (keypair.publicKey.toBase58().endsWith(suffix)) return { keypair, tries, vanity: true }
    }
    onProgress?.(tries)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { keypair: Keypair.generate(), tries, vanity: false }
}

let globals = null
async function launchGlobals() {
  if (globals && Date.now() - globals.at < 60000) return globals
  const sdk = new OnlinePumpSdk(connection)
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()])
  return (globals = { at: Date.now(), global, feeConfig })
}

// Tokens a fresh curve gives for a SOL budget (fees included).
export async function devBuyQuote(lamports) {
  if (!lamports || lamports <= 0n) return 0n
  const { global, feeConfig } = await launchGlobals()
  return BigInt(
    getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: new BN(lamports.toString()),
      quoteMint: PublicKey.default,
    }).toString(),
  )
}

/**
 * Instruction groups for a fresh launch, with the stages each group completes:
 * [register] (Quantum only), [create_v2, ATA, buy_v2, fee?], [lock] (Quantum with a lock).
 * create_v2 and the dev buy are one indivisible group in both modes, so nobody can trade between
 * them: if that group cannot fit in one transaction, packTransactions fails instead of splitting.
 * The packer merges register into it, and the lock after it, only when everything fits.
 */
export async function launchInstructions({
  launcher,
  mint,
  name,
  symbol,
  uri,
  quantum,
  hooks,
  devBuyLamports,
  slippagePct,
  platform,
}) {
  const user = new PublicKey(launcher)
  const devBuy = devBuyLamports > 0n ? { solLamports: devBuyLamports, slippagePct } : null
  const fee = await platformFeeInstruction(user, platform, devBuyLamports)
  if (quantum) {
    const client = await loadQuantum()
    const built = await client.buildQuantumLaunchInstructions({
      connection,
      launcher: user,
      mint,
      name,
      symbol,
      uri,
      hooks,
      devBuy,
    })
    const { register, launch, lock } = built.stages
    return { ...built, ...launchGroups({ register, launch, fee, lock, devBuy: !!devBuy }) }
  }
  let built
  if (devBuy) {
    const { global } = await launchGlobals()
    const tokens = await devBuyQuote(devBuyLamports)
    const instructions = await PUMP_SDK.createV2AndBuyV2Instructions({
      global,
      mint,
      name,
      symbol,
      uri,
      creator: user,
      user,
      amount: new BN(tokens.toString()),
      quoteAmount: new BN(devBuyLamports.toString()),
      mayhemMode: false,
      slippage: slippagePct,
    })
    built = { instructions, devBuyTokens: tokens, lockAmount: 0n }
  } else {
    const ix = await PUMP_SDK.createV2Instruction({
      mint,
      name,
      symbol,
      uri,
      creator: user,
      user,
      mayhemMode: false,
    })
    built = { instructions: [ix], devBuyTokens: 0n, lockAmount: 0n }
  }
  return { ...built, ...launchGroups({ launch: built.instructions, fee, devBuy: !!devBuy }) }
}

/** Explains why a launch's indivisible create + dev buy group did not fit in one transaction. */
export function launchTooLargeError(error, { devBuy }) {
  if (error?.code !== 'too_large') return error
  const message = !error.lookupTable
    ? devBuy
      ? 'The dev buy must land in the same transaction as the create so nobody can buy first, and that needs the Quant Pad lookup table, which is not configured. Set the dev buy to 0, or ask the operator to configure QUANTPAD_LOOKUP_TABLE.'
      : 'This launch needs the Quant Pad lookup table. Ask the operator to configure QUANTPAD_LOOKUP_TABLE.'
    : devBuy
      ? 'The create and the dev buy do not fit in one Solana transaction. Shorten the name, ticker or links, or set the dev buy to 0. Quant Pad never splits them, so nobody can buy first.'
      : 'This launch is too large for one Solana transaction. Shorten the name, ticker or links.'
  return Object.assign(Error(message), { code: 'too_large', friendly: true })
}

/**
 * Reads the Quantum Hooks config right before a `register` is signed and stops when launches are
 * paused (the app's status can be up to a minute old). If the read itself fails the launch goes
 * on: the transaction is simulated before sending, so a paused program still fails before any fee.
 */
export async function assertQuantumOpen() {
  const client = await loadQuantum()
  let config
  try {
    config = await client.fetchConfig(connection)
  } catch {
    return
  }
  const error = quantumConfigError(config)
  if (error) throw error
}

/** On-chain state of a launch: which stages already landed and the launcher's token balance. */
export async function launchProgress({ mint, snapshot }) {
  const mintKey = new PublicKey(mint)
  const launcher = new PublicKey(snapshot.launcher)
  const client = snapshot.quantum ? await loadQuantum() : null
  const ata = getAssociatedTokenAddressSync(mintKey, launcher, true, TOKEN_2022_PROGRAM_ID)
  const keys = [bondingCurvePda(mintKey), ata, ...(client ? [client.quantumPda(mintKey)] : [])]
  const [curve, token, quantum] = await connection.getMultipleAccountsInfo(keys, 'confirmed')
  const tokens = token ? unpackAccount(ata, token, TOKEN_2022_PROGRAM_ID).amount : 0n
  const state = quantum ? client.decodeQuantum(quantum.data) : null
  return {
    registered: !!state,
    created: !!curve,
    tokens,
    locked: !!state && state.lockedAmount > 0n,
  }
}

/**
 * Before a resume: settles the transaction whose outcome was unknown and fills in stages that the
 * chain shows already landed, so nothing is sent twice and nothing landed is skipped.
 */
export async function reconcileLaunch(job) {
  let pendingLanded = null
  if (job.pending) {
    const { value } = await connection.getSignatureStatuses([job.pending.signature], {
      searchTransactionHistory: true,
    })
    const status = value?.[0]
    if (status?.err) pendingLanded = false
    else if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      pendingLanded = true
  }
  return reconcileJob(job, await launchProgress(job), pendingLanded)
}

/**
 * The instruction groups still to send for `job`, rebuilt from its frozen snapshot:
 * - create_v2 not landed yet: the full launch (minus a register that already landed), quoted
 *   against a fresh curve, which is exact because the coin does not exist yet;
 * - coin created without its dev buy: a dev buy quoted from the live bonding curve;
 * - only the lock left: the lock amount comes from the tokens the launcher actually received.
 */
export async function remainingLaunchGroups(job) {
  const snapshot = job.snapshot
  const mint = new PublicKey(job.mint)
  const planned = plannedStages(snapshot)
  if (!job.done.launch) {
    const built = await launchInstructions({ ...snapshot, mint })
    job.expectedTokens = built.devBuyTokens
    const keep = built.stages.map((stages) => !stages.every((stage) => job.done[stage]))
    return {
      groups: built.groups.filter((_, i) => keep[i]),
      stages: built.stages.filter((_, i) => keep[i]),
    }
  }
  if (planned.includes('buy') && !job.done.buy) {
    const trade = await import('./trade.js')
    const { instructions } = await trade.buyInstructions({
      mint: job.mint,
      user: snapshot.launcher,
      lamports: snapshot.devBuyLamports,
      slippagePct: snapshot.slippagePct,
      platform: snapshot.platform,
    })
    // The lock is built on the next pass, from what this buy actually delivered.
    return planGroups([{ stages: ['buy'], instructions }])
  }
  if (planned.includes('lock') && !job.done.lock) {
    const { tokens } = await launchProgress(job)
    const expected = job.expectedTokens
    const received = expected != null && expected > 0n && expected < tokens ? expected : tokens
    const { bps, cliffSecs, durationSecs } = snapshot.hooks.lock
    const amount = (received * BigInt(bps)) / 10_000n
    if (amount <= 0n)
      throw Object.assign(
        Error('Your dev-buy tokens are no longer in this wallet, so they cannot be locked.'),
        { friendly: true },
      )
    const client = await loadQuantum()
    const lock = await client.buildLockInstruction({
      connection,
      launcher: snapshot.launcher,
      mint,
      amount,
      cliffSecs,
      durationSecs,
    })
    return planGroups([{ stages: ['lock'], instructions: [lock] }])
  }
  return { groups: [], stages: [] }
}
