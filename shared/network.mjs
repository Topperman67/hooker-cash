// Solana mainnet + Meteora (coins launch on its Dynamic Bonding Curve and migrate to DAMM v2).
// Shared by the browser bundle and the Node server, so no Node-only imports.
// Lamport and raw token amounts cross JSON boundaries as integer strings.
export const network = Object.freeze({
  cluster: 'mainnet-beta',
  name: 'Solana',
  // Browser traffic goes through the server's /api/rpc proxy so provider keys stay server-side.
  publicRpcUrl: 'https://api.mainnet-beta.solana.com',
  explorerUrl: 'https://solscan.io',
  dbcProgram: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  dammV2Program: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  token2022Program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  wsolMint: 'So11111111111111111111111111111111111111112',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  tokenDecimals: 6,
  // Quant Pad's launch config (shared/dbc-config.mjs): a fixed 1B supply at 6 decimals.
  totalSupply: '1000000000000000',
})

export const brand = Object.freeze({
  name: 'Quant Pad',
  short: 'QUANT',
  tagline: 'Launch on Meteora. Wire it with Quantum Hooks.',
})

// Quant Pad's Meteora launch configs on mainnet, one per trading tax a launcher can pick
// (scripts/create-dbc-config.mjs --fee N --pool-fee N). Each starts at 25% and falls to its tax over
// the first 2 minutes (anti-sniper), and the coin's DAMM v2 pool keeps that tax after graduation.
// The coin's creator receives the tax, less Meteora's protocol share.
export const launchTiers = Object.freeze([
  Object.freeze({ feeBps: 100, config: '8pm3TA69VqTstQGdDkkivEaujoaG64XqRMAMK8hWBFJ9' }),
  Object.freeze({ feeBps: 200, config: 'CZmoBruAVTGKAo2sp8ziLvzpENuwgZk9nybvXsKhcPfn' }),
  Object.freeze({ feeBps: 300, config: 'EaBVGcoSKhXLQvUJj8XYFDSUHsohYMheQS5Dgfac2tCT' }),
  Object.freeze({ feeBps: 500, config: 'J25Zk92d9DBJJ5eWggmQN3yBe8tC6iuxs61FsefFSHNd' }),
])
export const tierForConfig = (config) => launchTiers.find((t) => t.config === config) || null

// v2: the Meteora index (pump.fun records under v1 are left behind, not migrated).
export const storageNamespace = 'quantpad:solana:v2'
export const storageDirectory = 'solana-v2'

// Platform trading fee is optional. It only applies when a treasury is configured server-side.
export const MAX_PLATFORM_FEE_BPS = 200
export const DEFAULT_PLATFORM_FEE_BPS = 50

export const LAMPORTS_PER_SOL = 1_000_000_000n
export const TOKEN_UNIT = 1_000_000n

export const explorer = {
  tx: (signature) => `${network.explorerUrl}/tx/${signature}`,
  account: (address) => `${network.explorerUrl}/account/${address}`,
  token: (mint) => `${network.explorerUrl}/token/${mint}`,
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isAddress = (value) => typeof value === 'string' && BASE58.test(value)
export const isSignature = (value) =>
  typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)

// Price in SOL per whole token from raw quote / token amounts.
export function priceFromReserves(quoteLamports, tokenRaw) {
  const q = Number(quoteLamports),
    t = Number(tokenRaw)
  if (!(q > 0) || !(t > 0)) return null
  return q / 1e9 / (t / 1e6)
}

// Price in SOL per whole token from a Meteora pool's Q64.64 sqrt price (DBC and DAMM v2 alike:
// raw quote per raw base is (sqrtPrice / 2^64)^2).
export function priceFromSqrtPrice(sqrtPrice, tokenDecimals = network.tokenDecimals) {
  const s = Number(BigInt(sqrtPrice ?? 0)) / 2 ** 64
  if (!(s > 0)) return null
  return s * s * 10 ** (tokenDecimals - 9)
}

// Share of the curve filled, 0–100: SOL in the DBC pool against its migration threshold.
export function curveProgress(quoteReserve, migrationThreshold) {
  const q = Number(quoteReserve),
    t = Number(migrationThreshold)
  if (!Number.isFinite(q) || !(t > 0)) return 0
  return Math.max(0, Math.min(100, (q / t) * 100))
}
