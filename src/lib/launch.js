// Launch flow: artwork → metadata → mint keypair → pump.fun create_v2 (+ dev buy), optionally
// wired to Quantum Hooks. The mint keypair signs locally and never leaves the browser.
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '#pump-sdk'
import { api } from './api.js'
import { connection, platformFeeInstruction } from './solana.js'
import { loadQuantum } from './quantum.js'

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

// Returns ordered instruction groups. packTransactions() merges them into as few transactions as
// fit: create + dev buy share one transaction when the lookup table is configured; a Quantum
// launch registers its hooks first (before the coin exists, so nothing can be sniped) and locks
// the dev buy last.
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
  const fee = platformFeeInstruction(user, platform, devBuyLamports)
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
    return {
      ...built,
      groups: [register, launch.slice(0, 1), [...launch.slice(1), ...(fee ? [fee] : [])], lock],
    }
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
  const [create, ...buy] = built.instructions
  return { ...built, groups: [[create], [...buy, ...(fee ? [fee] : [])]] }
}
