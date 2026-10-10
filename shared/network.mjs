// Solana mainnet + pump.fun. Shared by the browser bundle and the Node server, so no Node-only imports.
// Lamport and raw token amounts cross JSON boundaries as integer strings.
export const network = Object.freeze({
  cluster: 'mainnet-beta',
  name: 'Solana',
  // Browser traffic goes through the server's /api/rpc proxy so provider keys stay server-side.
  publicRpcUrl: 'https://api.mainnet-beta.solana.com',
  explorerUrl: 'https://solscan.io',
  pumpProgram: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpAmmProgram: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpFeesProgram: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  token2022Program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  wsolMint: 'So11111111111111111111111111111111111111112',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  tokenDecimals: 6,
  // pump.fun's live Global account: 1B supply, 793.1M sold on the curve before graduation.
  totalSupply: '1000000000000000',
  initialRealTokenReserves: '793100000000000',
})

export const brand = Object.freeze({
  name: 'Quant Pad',
  short: 'QUANT',
  tagline: 'Launch on pump.fun. Wire it with Quantum Hooks.',
})

export const storageNamespace = 'quantpad:solana:v1'
export const storageDirectory = 'solana-v1'

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
export const pumpFunUrl = (mint) => `https://pump.fun/coin/${mint}`

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isAddress = (value) => typeof value === 'string' && BASE58.test(value)
export const isSignature = (value) =>
  typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)

// Price in SOL per whole token from raw curve/pool reserves.
export function priceFromReserves(quoteLamports, tokenRaw) {
  const q = Number(quoteLamports),
    t = Number(tokenRaw)
  if (!(q > 0) || !(t > 0)) return null
  return q / 1e9 / (t / 1e6)
}

// Share of the curve sold, 0–100. pump.fun graduates when real token reserves reach zero.
export function curveProgress(realTokenReserves) {
  const remaining = Number(realTokenReserves),
    initial = Number(network.initialRealTokenReserves)
  if (!Number.isFinite(remaining)) return 0
  return Math.max(0, Math.min(100, 100 - (remaining / initial) * 100))
}
