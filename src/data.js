export const BRAND = {
  name: 'Hooker',
  tagline: 'the hook launchpad on Arc',
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
    body: 'Hooker never holds anything. It assembles transactions; your wallet signs them. Lose the keys and the funds are gone — there is no recovery desk, no password reset, and no support ticket that brings them back.',
  },
  {
    id: 2,
    title: 'The screen is data, not advice',
    body: 'Every price, chart and stat is raw chain data rendered as-is — no promise it is right, complete, or timely. Nothing here tells you to buy or sell anything. Whatever you trade, you traded.',
  },
  {
    id: 3,
    title: 'The floor is open to everyone',
    body: 'Launches on Arc are permissionless: honest builders share the stage with rug-pullers and honeypots. We run no vetting, no audits, no endorsements — assume every token is hostile until it proves otherwise.',
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
    blurb: 'One admitted buy every N seconds, pool-wide, until the window shuts. Bots lose their zero-delay edge.',
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
    blurb: 'A slice of the cut goes up in smoke — supply only ever burns down.',
  },
  {
    id: 'champagne',
    name: 'Champagne Room',
    lane: 'value',
    tag: 'deepen',
    blurb: 'The slice re-mints as sealed one-sided LP. Money that goes in never comes out.',
  },
  {
    id: 'rain',
    name: 'Make It Rain',
    lane: 'value',
    tag: 'reflect',
    blurb: 'The quote-side cut, rained on every holder pro-rata at each harvest.',
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
    blurb: 'A permanent resting bid under price — sells land on him, not on thin air.',
  },
]

export const ALL_MODULES = [...GATE_MODULES, ...VALUE_MODULES]

export const FEATURES = [
  {
    title: 'The 70/30 split',
    body: 'Every swap pays the toll. You choose where 70% of it flows — one wallet or a split, set at launch.',
  },
  {
    title: 'Sealed seed liquidity',
    body: 'Launch liquidity locks inside the launch contracts from block one. No removal path — for anyone.',
  },
  {
    title: 'Any token is a quote',
    body: 'Launch against ETH, the dollar, or the desk — stocks, commodities, anything the treasury admits.',
  },
  {
    title: 'Longs & shorts, natively',
    body: 'Taped tokens go on the board — leveraged longs and shorts, margin in USDC. Experimental, deliberately capped.',
  },
  {
    title: 'Arc × Uni V4',
    body: 'Real V4 pools, routable everywhere from block one. USDC gas.',
  },
]

export const DEMO_TOKENS = [
  {
    id: 'hkrs',
    name: 'hookers',
    symbol: 'HKRS',
    mcap: 243800,
    price: 0.0002438,
    change24h: 2310.11,
    vol24h: 160000,
    liq: 49400,
    trades: 1400,
    modules: ['velvet', 'ashtray', 'rain'],
    age: '2h',
    hot: true,
  },
  {
    id: 'floor',
    name: 'Sugar Floor',
    symbol: 'FLOOR',
    mcap: 89200,
    price: 0.0000892,
    change24h: 42.3,
    vol24h: 22100,
    liq: 31200,
    trades: 318,
    modules: ['sugar', 'bouncer'],
    age: '6h',
  },
  {
    id: 'rain',
    name: 'Make It Rain',
    symbol: 'RAIN',
    mcap: 156400,
    price: 0.0001564,
    change24h: -8.4,
    vol24h: 54000,
    liq: 40100,
    trades: 902,
    modules: ['rain', 'jit', 'tape'],
    age: '14h',
  },
  {
    id: 'ash',
    name: 'Ashtray',
    symbol: 'ASH',
    mcap: 67400,
    price: 0.0000674,
    change24h: 118.2,
    vol24h: 18900,
    liq: 22800,
    trades: 441,
    modules: ['ashtray', 'velvet'],
    age: '1d',
  },
  {
    id: 'jitx',
    name: 'Jitless',
    symbol: 'JITX',
    mcap: 41200,
    price: 0.0000412,
    change24h: 6.1,
    vol24h: 9800,
    liq: 17500,
    trades: 190,
    modules: ['jit', 'champagne'],
    age: '2d',
  },
  {
    id: 'tape',
    name: 'Ticker Tape',
    symbol: 'TAPE',
    mcap: 301200,
    price: 0.0003012,
    change24h: 19.7,
    vol24h: 88000,
    liq: 72000,
    trades: 2104,
    modules: ['tape', 'flip', 'velvet'],
    age: '3d',
    hot: true,
  },
  {
    id: 'champ',
    name: 'Champagne',
    symbol: 'CHMP',
    mcap: 52300,
    price: 0.0000523,
    change24h: -2.2,
    vol24h: 7400,
    liq: 19800,
    trades: 122,
    modules: ['champagne'],
    age: '4d',
  },
  {
    id: 'bounce',
    name: 'Bouncer Club',
    symbol: 'BNCR',
    mcap: 27800,
    price: 0.0000278,
    change24h: 55.0,
    vol24h: 12100,
    liq: 14200,
    trades: 276,
    modules: ['bouncer', 'ashtray'],
    age: '5d',
  },
]

export const DEMO_ACTIVITY = [
  { type: 'buy', symbol: 'HKRS', amount: '0.42 USDC', when: '12s' },
  { type: 'launch', symbol: 'FLOOR', amount: 'sealed LP', when: '2m' },
  { type: 'sell', symbol: 'RAIN', amount: '180 USDC', when: '3m' },
  { type: 'buy', symbol: 'TAPE', amount: '1.2k USDC', when: '5m' },
  { type: 'buy', symbol: 'ASH', amount: '64 USDC', when: '8m' },
  { type: 'launch', symbol: 'JITX', amount: 'sealed LP', when: '14m' },
]

export const FEE_TIERS = [
  { fee: 9000, label: '0.90%', tickSpacing: 60 },
  { fee: 2500, label: '0.25%', tickSpacing: 60 },
  { fee: 375, label: '0.0375%', tickSpacing: 10 },
  { fee: 75, label: '0.0075%', tickSpacing: 1 },
]

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
