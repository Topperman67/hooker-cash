export const BRAND = {
  name: 'Hookbrew',
  tagline: 'Brew your own tokenomics.',
  chain: 'Arc',
  chainId: 5042,
  quote: 'USDC',
  x: 'https://x.com',
  terms: '/terms',
}

export const ACCESS_RULES = [
  {
    id: 1,
    title: 'No custody, no safety net',
    body: 'Connecting a wallet exposes the account you select, not your private keys. Your wallet controls signatures. Keep your keys secure; this application cannot recover them.',
  },
  {
    id: 2,
    title: 'The screen is data, not advice',
    body: 'Contract reads show their network and block. Missing market data stays unavailable. Names and symbols are supplied by token contracts, and are not endorsements. Nothing here is advice to buy or sell.',
  },
  {
    id: 3,
    title: 'The floor is open to everyone',
    body: 'Token contracts on Arc are permissionless. A listed address or readable token name does not establish legitimacy, liquidity, or safety. Verify the contract and its permissions before signing.',
  },
  {
    id: 4,
    title: "Confirmations don't come back",
    body: 'A signed transaction is permanent. Volatility, exploits, or a plain bad call can take a position to zero in a single block. No refunds, no insurance, no undo. Risk only what you can walk away from.',
  },
]

export const GATE_MODULES = [
  {
    id: 'velvet',
    name: 'Velvet Rope',
    lane: 'gate',
    tag: 'anti-snipe',
    blurb:
      'Per-buy caps on a self-loosening ramp — snipers pay in and loosen their own leash. Sells walk straight in.',
  },
  {
    id: 'bouncer',
    name: 'Bouncer',
    lane: 'gate',
    tag: 'throttle',
    blurb:
      'One admitted buy every N seconds, pool-wide, until the window shuts. Bots lose their zero-delay edge.',
  },
  {
    id: 'tape',
    name: 'Ticker Tape',
    lane: 'gate',
    tag: 'oracle',
    badge: 'required for leverage',
    blurb: "A time-weighted record of the launch's own price — one honest tick a second.",
  },
  {
    id: 'jit',
    name: 'JIT Guard',
    lane: 'gate',
    tag: 'jit',
    blurb: 'Turns away single mints sized to steal the fee pool.',
  },
]

export const VALUE_MODULES = [
  {
    id: 'ashtray',
    name: 'Ashtray',
    lane: 'value',
    tag: 'burn',
    blurb:
      'Intended to send a share of token fees to a burn address. Its effect on reported total supply depends on the token contract.',
  },
  {
    id: 'champagne',
    name: 'Champagne Room',
    lane: 'value',
    tag: 'deepen',
    blurb:
      'Intended to add a share of fees to liquidity. Withdrawal restrictions require deployment verification.',
  },
  {
    id: 'rain',
    name: 'Make It Rain',
    lane: 'value',
    tag: 'reflect',
    blurb: 'Intended to distribute quote-side fees to eligible holders in batches at harvest.',
  },
  {
    id: 'flip',
    name: 'Money Flip',
    lane: 'value',
    tag: 'buyback',
    blurb: 'Flips the cut back through the pool — buys the token, burns the catch.',
  },
  {
    id: 'sugar',
    name: 'Sugar Daddy',
    lane: 'value',
    tag: 'floor',
    blurb:
      'Intended to place liquidity below the current price. It does not guarantee a minimum sale price.',
  },
]

export const ALL_MODULES = [...GATE_MODULES, ...VALUE_MODULES]

export function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(2)}`
  if (n >= 0.0001) return `$${n.toFixed(6)}`
  return `$${n.toExponential(2)}`
}

export function fmtPct(n) {
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

export function moduleById(id) {
  return ALL_MODULES.find((m) => m.id === id)
}
