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

// $QUANTP, Quant Pad's own token. It launched through Midas (not Quant Pad's launch flow) on a
// Meteora DBC transfer-hook pool: a Token-2022 mint whose transfers run Midas's hook program, under
// Midas's own DBC config. Its pool charges a flat 2% per trade in SOL until the curve graduates to
// a DAMM v2 pool that charges 5%; nothing on-chain charges more. The team says the creator's share
// of those fees goes 60% to holders in SOL and 40% to buying back and burning $QUANTP, paid out
// off-chain. Never add `config` to QUANTPAD_DBC_CONFIG: that would
// point new launches at Midas's config.
export const QUANTP = Object.freeze({
  mint: '7cAJWZyyG7VqFJ4HzAxKNG8Xch6mJY4CfwPbfP6cJKiy',
  pool: '85TSwjnucTtvgvtqzWzChNBfmoR4Dv581A3WG7Buzgvf',
  config: 'FKVEdYr8tKgdpCsaLGoMGmgHYMV6kYamJJoCRzvgEDm5',
  hookProgram: '4xh25C2V65F5buKwKzYpSKHdhz7xTfNTJofCgB1WTDrE',
  symbol: 'QUANTP',
  name: 'Quant Pad',
  decimals: 6,
  supply: '1000000000000000',
  launchedAt: 1792115973,
  feeBps: 200, // the curve's flat fee (config FKVEdYr8…); the live value comes from /api/quantp
  postGradFeeBps: 500, // the DAMM v2 pool's fee after graduation
  holdersShareBps: 6000, // of the creator's fee share, by the team's stated policy (off-chain)
  buybackShareBps: 4000,
  dexscreener: 'https://dexscreener.com/solana/85tswjnucttvgvtqzwzchnbfmor4dv581a3wg7buzgvf',
  path: '/quantp',
})

// Quant Pad's Meteora launch configs on mainnet, one per trading tax a launcher can pick, with and
// without the opt-in anti-sniper tax (scripts/create-dbc-config.mjs --fee N --pool-fee N, plus
// --launch-fee 0 for the ones without). With it, the tax starts at 25% and falls to the chosen tax
// over the first 2 minutes; without it, the chosen tax applies from the first trade. The coin's
// DAMM v2 pool keeps the tax after graduation. The coin's creator receives the tax, less Meteora's
// protocol share. Quantum Hooks allows at most 4 configs: the ones without the anti-sniper tax.
export const launchTiers = Object.freeze([
  Object.freeze({
    feeBps: 100,
    antiSniper: true,
    config: '8pm3TA69VqTstQGdDkkivEaujoaG64XqRMAMK8hWBFJ9',
  }),
  Object.freeze({
    feeBps: 200,
    antiSniper: true,
    config: 'CZmoBruAVTGKAo2sp8ziLvzpENuwgZk9nybvXsKhcPfn',
  }),
  Object.freeze({
    feeBps: 300,
    antiSniper: true,
    config: 'EaBVGcoSKhXLQvUJj8XYFDSUHsohYMheQS5Dgfac2tCT',
  }),
  Object.freeze({
    feeBps: 500,
    antiSniper: true,
    config: 'J25Zk92d9DBJJ5eWggmQN3yBe8tC6iuxs61FsefFSHNd',
  }),
  Object.freeze({
    feeBps: 100,
    antiSniper: false,
    config: '3e4MpnHbsDiWqh2kRLj82URFAWoNm4p3cmKeqvsB76KH',
  }),
  Object.freeze({
    feeBps: 200,
    antiSniper: false,
    config: 'G6u6dfAKPqMJEpvPAQ7kpHskDn3RE1KXUWbWjRuKrzQi',
  }),
  Object.freeze({
    feeBps: 300,
    antiSniper: false,
    config: '23w793vBTPB8HNNhjpczhyGvLtSi5LNwjRcYZh4Mmjgs',
  }),
  Object.freeze({
    feeBps: 500,
    antiSniper: false,
    config: 'Cu9rMFJotxnXXHcGehx9BzJFps1MJLGBgcgAvqPQdPNi',
  }),
])
/** The trading taxes a launcher can pick, in bps. */
export const TAX_OPTIONS = Object.freeze([100, 200, 300, 500])
export const tierForConfig = (config) => launchTiers.find((t) => t.config === config) || null
export const tierFor = (feeBps, antiSniper) =>
  launchTiers.find((t) => t.feeBps === Number(feeBps) && t.antiSniper === !!antiSniper) || null

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
