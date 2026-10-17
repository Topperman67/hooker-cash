// Deterministic browser fixtures: API responses, a JSON-RPC stub that serves Meteora accounts and
// a Wallet Standard wallet.
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { BorshCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { swapQuoteExactIn } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  DBC_PROGRAM_ID,
  PROGRESS,
  dbcCoder,
  dbcPoolPda,
  dbcQuote,
  decodeDbcConfig,
  decodeDbcPool,
  migratedPoolFor,
} from '../../shared/meteora.mjs'
import { QUANTP, launchTiers, tierFor } from '../../shared/network.mjs'
import { quantumPda } from '../../shared/quantum.mjs'

export const WALLET_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
export const MINT = 'QuantPadTestMint1111111111111111111111111QP'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const QUANTUM_PROGRAM = 'FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK'
export const KEEPER = '2jkXzskqZdtJUG7LBVadijz6uf9yezmkLGWcvddijDQQ'
export const LOOKUP_TABLE = 'BovnvpXNbhHRaCxT3BCfpdSnT5PA5uSLgrUgmbzyj4eS'

// The four mainnet launch configs, one per trading tax (read from mainnet; they never change).
const CONFIGS = JSON.parse(readFileSync(new URL('./dbc-configs.json', import.meta.url), 'utf8'))
// Launches default to the configs without the anti-sniper tax (the ones Quantum Hooks allows).
export const configFor = (feeBps, antiSniper = false) => tierFor(feeBps, antiSniper).config
export const launchConfig = (address) =>
  decodeDbcConfig(Buffer.from(CONFIGS[address].data, 'base64'))
// The test coin trades on the 1% config, like every standard launch.
export const DBC_CONFIG = configFor(100)
export const DBC_POOL = dbcPoolPda(DBC_CONFIG, MINT).toBase58()
// The DAMM v2 pool Meteora migrates the test coin into.
export const DAMM_POOL = migratedPoolFor(launchConfig(DBC_CONFIG), MINT).toBase58()

/** Tokens a launch's dev buy of `lamports` gets on a fresh curve of the `feeBps` launch config. */
export const devBuyTokens = (feeBps, lamports) =>
  dbcQuote({
    pool: null,
    config: launchConfig(configFor(feeBps)),
    side: 'buy',
    amountIn: lamports,
    firstSwap: true,
  }).out

// /api/status as production answers it: Quantum Hooks live, lookup table and launch config set.
export const QUANTUM_LIVE = {
  available: true,
  programId: QUANTUM_PROGRAM,
  deployed: true,
  configured: true,
  paused: false,
  protocolBps: 500,
  keeper: KEEPER,
  claimDelay: 21600,
  reason: null,
}
export const QUANTUM_NOT_LIVE = {
  available: false,
  programId: QUANTUM_PROGRAM,
  deployed: false,
  configured: false,
  paused: false,
  protocolBps: null,
  keeper: null,
  claimDelay: null,
  reason: 'not-deployed',
}
export const QUANTUM_PAUSED = { ...QUANTUM_LIVE, available: false, paused: true, reason: 'paused' }
const status = (over) => ({
  brand: { name: 'Quant Pad' },
  network: { cluster: 'mainnet-beta', explorerUrl: 'https://solscan.io' },
  rpc: '/api/rpc',
  platform: { treasury: null, feeBps: 0 },
  quantum: QUANTUM_LIVE,
  keeper: { enabled: true, address: KEEPER },
  indexer: { degraded: false, reason: null },
  storage: { mode: 'filesystem', ready: true },
  solUsd: 150,
  ipfs: false,
  lookupTable: LOOKUP_TABLE,
  dbcConfig: DBC_CONFIG,
  ...over,
})

export const coin = (over = {}) => ({
  mint: MINT,
  name: 'Entangled Cats',
  symbol: 'ECAT',
  uri: 'https://example.invalid/m/abc',
  creator: 'Fe11WellPda111111111111111111111111111111111',
  launcher: WALLET_ADDRESS,
  quantum: true,
  external: false,
  createdAt: Math.floor(Date.now() / 1000) - 3600,
  complete: false,
  migrated: false,
  progress: 42.5,
  price: 0.0000000412,
  marketCap: 41.2,
  volume24h: 128.4,
  change24h: 18.25,
  trades24h: 311,
  image: null,
  dbcPool: DBC_POOL,
  dbcConfig: DBC_CONFIG,
  pool: null,
  ...over,
})

// SOL bought into the test coin's curve: 42.5% of the config's 85 SOL migration threshold.
export const CURVE_BOUGHT = 36_125_000_000n

/**
 * The test coin's DBC pool on the 1% config, activated long ago (the anti-sniper fee has decayed
 * to the tier's fee). `graduating`: the curve is full and Meteora has not opened the DAMM v2 pool.
 */
export async function dbcPoolAccount({ graduating = false } = {}) {
  const config = launchConfig(DBC_CONFIG).raw
  const name = 'virtualPool'
  const blank = Buffer.alloc(dbcCoder.accounts.size(name))
  blank.set(dbcCoder.accounts.accountDiscriminator(name))
  const raw = dbcCoder.accounts.decode(name, blank)
  const s = raw.poolState
  Object.assign(s, {
    config: new PublicKey(DBC_CONFIG),
    creator: new PublicKey(WALLET_ADDRESS),
    baseMint: new PublicKey(MINT),
    sqrtPrice: config.sqrtStartPrice,
    baseReserve: config.swapBaseAmount,
  })
  if (graduating)
    Object.assign(s, {
      sqrtPrice: config.migrationSqrtPrice,
      quoteReserve: config.migrationQuoteThreshold,
      baseReserve: config.migrationBaseThreshold,
      migrationProgress: PROGRESS.POST,
    })
  else {
    const bought = swapQuoteExactIn(
      raw,
      config,
      false,
      new BN(CURVE_BOUGHT.toString()),
      0,
      false,
      new BN(Math.floor(Date.now() / 1000)),
      false,
    )
    s.sqrtPrice = bought.nextSqrtPrice
    s.quoteReserve = bought.excludedFeeInputAmount
    s.baseReserve = s.baseReserve.sub(bought.outputAmount)
  }
  return dbcCoder.accounts.encode(name, raw)
}

/** The tokens the coin page should quote for a buy of `lamports` on the stubbed curve. */
export async function curveBuyQuote(lamports, slippagePct) {
  const pool = decodeDbcPool(await dbcPoolAccount())
  return dbcQuote({
    pool,
    config: launchConfig(DBC_CONFIG),
    side: 'buy',
    amountIn: lamports,
    slippageBps: slippagePct * 100,
    currentPoint: BigInt(Math.floor(Date.now() / 1000)),
  })
}

// The test coin's Quantum Hooks account: the Balanced preset with one Superposition wallet, after
// some pulses.
const QUANTUM_IDL = JSON.parse(
  readFileSync(new URL('../../shared/idl/quantum_hooks.json', import.meta.url), 'utf8'),
)
export const QUANTUM_PDA = quantumPda(MINT).toBase58()
export const SPLIT_WALLET = 'Hjk4ag4aZ7aKZuGU7zf2ifbS5vTKqcGsTrT8L3cgWNXj'
export const QUANTUM_STATE = {
  creator_bps: 3000,
  burn_bps: 3000,
  entangle_bps: 2000,
  fusion_bps: 2000,
  burn_reserve: 120_000_000n,
  entangle_reserve: 80_000_000n,
  fusion_reserve: 60_000_000n,
  total_collected: 1_250_000_000n,
  total_burned_tokens: 1_000_000_000_000n,
  total_creator_paid: 337_500_000n,
}
function quantumAccount() {
  const coder = new BorshCoder(QUANTUM_IDL)
  const name = 'Quantum'
  const blank = Buffer.alloc(coder.accounts.size(name))
  blank.set(QUANTUM_IDL.accounts.find((a) => a.name === name).discriminator)
  const raw = coder.accounts.decode(name, blank)
  for (const [key, value] of Object.entries(QUANTUM_STATE))
    raw[key] = typeof value === 'bigint' ? new BN(value.toString()) : value
  Object.assign(raw, {
    mint: new PublicKey(MINT),
    launcher: new PublicKey(WALLET_ADDRESS),
    created_at: new BN(Math.floor(Date.now() / 1000) - 3600),
    split_count: 1,
    dbc_config: new PublicKey(DBC_CONFIG),
    dbc_pool: new PublicKey(DBC_POOL),
  })
  raw.splits[0] = { wallet: new PublicKey(SPLIT_WALLET), bps: 2500 }
  return coder.accounts.encode(name, raw)
}

// An SPL mint: 6 decimals, 1B supply, no authorities.
function mintAccount() {
  const data = Buffer.alloc(82)
  data.writeBigUInt64LE(1_000_000_000_000_000n, 36)
  data[44] = 6
  data[45] = 1
  return { owner: TOKEN_PROGRAM, data }
}

/**
 * Chain accounts the RPC stub serves: the launch configs, the test mint, its DBC pool (`pool`:
 * 'curve', 'graduating' or null for none) and its Quantum Hooks account (`quantum`). Anything else
 * fails like an unreachable node.
 */
async function chainAccounts({ pool = 'curve', quantum = true, accounts = {} } = {}) {
  const known = new Map()
  for (const { config } of launchTiers)
    known.set(config, {
      owner: CONFIGS[config].owner,
      lamports: CONFIGS[config].lamports,
      data: Buffer.from(CONFIGS[config].data, 'base64'),
    })
  known.set(MINT, mintAccount())
  if (pool)
    known.set(DBC_POOL, {
      owner: DBC_PROGRAM_ID.toBase58(),
      data: await dbcPoolAccount({ graduating: pool === 'graduating' }),
    })
  if (quantum) known.set(QUANTUM_PDA, { owner: QUANTUM_PROGRAM, data: await quantumAccount() })
  for (const [address, account] of Object.entries(accounts)) known.set(address, account)
  return known
}

const accountJson = ({ owner, data, lamports }) => ({
  data: [data.toString('base64'), 'base64'],
  executable: false,
  lamports: lamports ?? 1_461_600,
  owner,
  rentEpoch: 0,
  space: data.length,
})

export async function stubApi(
  page,
  {
    coins = [
      coin(),
      coin({
        mint: 'Second1111111111111111111111111111111111111',
        name: 'Wave Function',
        symbol: 'PSI',
        quantum: false,
        change24h: -4.2,
      }),
    ],
    status: statusOver = {},
    chain = {},
    mainnet = false,
  } = {},
) {
  // Anything the fixtures do not answer fails, instead of reaching the dev server (which reads
  // mainnet). Registered first, so every route below answers before it.
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, json: { error: 'Not stubbed in the e2e fixtures.' } }),
  )
  await page.route('**/api/status', (route) => route.fulfill({ json: status(statusOver) }))
  await page.route('**/api/market?*', (route) => {
    const url = new URL(route.request().url())
    const filter = url.searchParams.get('filter')
    const items = coins.filter((c) => (filter === 'quantum' ? c.quantum : true))
    return route.fulfill({ json: { items, total: items.length, next: null } })
  })
  await page.route('**/api/stats', (route) =>
    route.fulfill({
      json: { coins: coins.length, quantum: 1, graduated: 0, volume24h: 200, trades24h: 400 },
    }),
  )
  await page.route(`**/api/coins/${MINT}`, (route) =>
    route.fulfill({
      json: { coin: { ...coin(), meta: { description: 'Cats in superposition.' } } },
    }),
  )
  await page.route(`**/api/coins/${MINT}/*`, (route) =>
    route.fulfill({ json: { items: [], total: 0, next: null, interval: 60 } }),
  )
  await page.route(`**/api/quantum/${MINT}**`, (route) =>
    route.fulfill({ json: { epochs: [], log: [], items: [] } }),
  )
  // `mainnet`: JSON-RPC goes through the dev server's proxy to mainnet, except that a transaction
  // is never sent: the send fails like a refused preflight.
  if (mainnet)
    return page.route('**/api/rpc', (route) => {
      const body = route.request().postDataJSON()
      const calls = Array.isArray(body) ? body : [body]
      if (!calls.some((call) => call.method === 'sendTransaction')) return route.continue()
      const refuse = (call) => ({
        jsonrpc: '2.0',
        id: call.id,
        error: { code: -32002, message: 'The e2e fixtures never send transactions.' },
      })
      return route.fulfill({ json: Array.isArray(body) ? body.map(refuse) : refuse(body) })
    })
  // JSON-RPC: balances, the slot and the accounts above answer; anything else fails like an
  // unreachable node.
  const accounts = await chainAccounts(chain)
  await page.route('**/api/rpc', (route) => {
    const body = route.request().postDataJSON()
    const ok = (call, result) => ({ jsonrpc: '2.0', id: call.id, result })
    const answer = (call) => {
      const context = { slot: 300_000_000 }
      if (call.method === 'getBalance') return ok(call, { context, value: 1_500_000_000 })
      if (call.method === 'getSlot') return ok(call, context.slot)
      const keys =
        call.method === 'getAccountInfo'
          ? [call.params[0]]
          : call.method === 'getMultipleAccounts'
            ? call.params[0]
            : null
      if (keys?.every((key) => accounts.has(key))) {
        const values = keys.map((key) => accountJson(accounts.get(key)))
        return ok(call, { context, value: call.method === 'getAccountInfo' ? values[0] : values })
      }
      return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'stubbed' } }
    }
    return route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) })
  })
}

// Indexed trades for the test coin: a full trades table is wider than a phone screen.
export async function stubTrades(page, count = 20) {
  const now = Math.floor(Date.now() / 1000)
  const items = Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    timestamp: now - i * 97,
    side: i % 3 ? 'buy' : 'sell',
    solAmount: String(1_234_567_890 + i * 10_000_000),
    tokenAmount: String(12_345_678_901_234 + i),
    price: 0.0000000412 + i * 1e-11,
    trader: WALLET_ADDRESS,
    signature: `5${'x'.repeat(80)}${i}`,
  }))
  await page.route(`**/api/coins/${MINT}/trades*`, (route) =>
    route.fulfill({ json: { items, total: items.length, next: null } }),
  )
}

export async function enter(page, { wallet = false, address = WALLET_ADDRESS } = {}) {
  await page.addInitScript(() => localStorage.setItem('quantpad:risk-accepted:v1', '1'))
  if (wallet)
    await page.addInitScript((address) => {
      const account = {
        address,
        publicKey: new Uint8Array(32),
        chains: ['solana:mainnet'],
        features: ['solana:signTransaction'],
      }
      const wallet = {
        version: '1.0.0',
        name: 'Test Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
        chains: ['solana:mainnet'],
        accounts: [],
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              wallet.accounts = [account]
              return { accounts: [account] }
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => (wallet.accounts = []),
          },
          'standard:events': { version: '1.0.0', on: () => () => {} },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            // Returns the transactions unsigned, and keeps them (base64) for the test to inspect.
            signTransaction: async (...inputs) => {
              window.__signRequests = window.__signRequests || []
              window.__signRequests.push(
                inputs.map((i) => btoa(String.fromCharCode(...i.transaction))),
              )
              return inputs.map((i) => ({ signedTransaction: i.transaction }))
            },
          },
        },
      }
      const register = ({ register }) => register(wallet)
      window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail))
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
    }, address)
}

// ---- $QUANTP's page -------------------------------------------------------------------------------

// /api/quantp after graduation, as on 2026-10-16: the fee estimates (which the site no longer
// shows as payouts) and `payouts`, what the payout wallet had really paid (round 1), bought back
// (two buys, not burned yet) and held.
export const quantpSnapshot = (over = {}) => ({
  mint: QUANTP.mint,
  symbol: QUANTP.symbol,
  name: QUANTP.name,
  decimals: 6,
  pool: QUANTP.pool,
  config: QUANTP.config,
  priceSol: 1.8e-7,
  priceUsd: 0.000027,
  change24h: 0.12,
  marketCapSol: 180,
  marketCapUsd: 27_000,
  volume24hUsd: 61_000,
  txns24h: { buys: 410, sells: 290 },
  supply: QUANTP.supply,
  burned: '0',
  holders: 64,
  curveProgress: 1,
  migrated: true,
  dammPool: 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw',
  feeBps: 500,
  postGradFeeBps: 500,
  fees: { lifetimeSol: 4.416, creatorLifetimeSol: 3.228, holdersSol: 1.9368, buybackSol: 1.2912 },
  payouts: {
    paidLamports: '549999974',
    wallets: 51,
    boughtLamports: '552559872',
    burnedAmount: '0',
    waitingLamports: '1021862000',
  },
  launchedAt: QUANTP.launchedAt,
  updatedAt: Math.floor(Date.now() / 1000),
  sources: { chain: 'ok', dex: 'ok' },
  ...over,
})

// /api/quantp/ledger as mainnet answers it after round 1: one burst of three transactions to 51
// wallets, 1.58 SOL left in the payout wallet, no burns. `payouts` are bursts, `unburned` what the
// team bought and has not burned yet, `unread` transactions the server could not read yet, and
// `paidWallets` every wallet paid with its totals (left out unless given, as an older server
// answers).
export const quantpLedger = ({
  payouts,
  burns = [],
  unburned = { lamports: '0', amount: '0' },
  payoutLamports = '1580000000',
  unread = 0,
  paidWallets,
} = {}) => {
  const now = Math.floor(Date.now() / 1000)
  const round1 = [
    [
      '5B9NLSK5dRt9Zp3j3b5is9oD6n8a7Wh4wdzczMGc3T7a181PCEZrLW6jJKxYwhPmgMFeH4ewjRcovFM2obXZM3sC',
      '358024234',
      20,
    ],
    [
      '5294RbYBiPA8MJZdV3ToY1U4N6XpLwxMSkjTgh2ySaW6Bawxf1bfrzBUV2WXts73QKgfpVDb9ZFHQAewG1Gf9r3u',
      '176743573',
      20,
    ],
    [
      '5qDPLwq9SdL1ABciwN8ovnjigV8NTk9ktX41DUHyZpsNkYSnjNzfDtWrp4sKWg6fUgQUBaocyvXZFRjo2pKg9JeR',
      '15232167',
      11,
    ],
  ].map(([signature, lamports, recipients], i) => ({
    signature,
    slot: 457_511_697 + i * 20,
    timestamp: now - 7200 + i * 4,
    lamports,
    recipients,
  }))
  const bursts = payouts ?? [
    {
      timestamp: now - 7200,
      lamports: '549999974',
      recipients: 51,
      recipient: null,
      transactions: round1,
    },
  ]
  const sum = (list, field) => list.reduce((s, r) => s + BigInt(r[field] ?? 0), 0n).toString()
  return {
    mint: QUANTP.mint,
    wallets: { payout: QUANTP.payoutWallet, creator: QUANTP.creator },
    payoutLamports,
    payouts: bursts,
    burns,
    ...(paidWallets ? { paidWallets } : {}),
    totals: {
      paidLamports: sum(bursts, 'lamports'),
      payoutTxs: bursts.reduce((s, b) => s + b.transactions.length, 0),
      recipients: bursts.reduce((s, b) => s + b.recipients, 0),
      burnedAmount: sum(burns, 'amount'),
      buybackLamports: sum(burns, 'solSpent'),
      unburned,
    },
    updatedAt: now,
    state: 'ok',
    unread,
  }
}

// /api/quantp/engine for the payout engine running on the payout wallet: the 20%-a-day tier, 31
// wallets eligible, last run 20 minutes ago (as planned from mainnet on 2026-10-16).
export const quantpEngine = (over = {}) => ({
  configured: true,
  wallet: QUANTP.payoutWallet,
  live: true,
  reason: null,
  everySecs: 3600,
  minHoldBps: 15,
  minHold: '1500000000000',
  holdersShareBps: 6000,
  marketCapUsd: 6381,
  dailyBps: 2000,
  balance: '1021862000',
  next: { release: '8349000', holders: '4958000', buyback: '3340000', paying: 28 },
  eligible: 31,
  lastRunAt: Math.floor(Date.now() / 1000) - 1200,
  state: 'ok',
  ...over,
})

/**
 * Answers $QUANTP's routes; `ledger` is the /api/quantp/ledger body, or a status to fail with, and
 * `engine` the /api/quantp/engine body (not configured by default).
 */
export async function stubQuantp(
  page,
  { snapshot = quantpSnapshot(), ledger = quantpLedger(), engine = { configured: false } } = {},
) {
  await page.route('**/api/quantp', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/quantp/engine', (route) => route.fulfill({ json: engine }))
  await page.route('**/api/quantp/trades*', (route) =>
    route.fulfill({ json: { items: [], total: 0, next: null, source: 'indexer' } }),
  )
  await page.route('**/api/quantp/candles*', (route) =>
    route.fulfill({ json: { items: [], interval: 300, source: 'indexer' } }),
  )
  await page.route('**/api/quantp/ledger', (route) =>
    typeof ledger === 'number'
      ? route.fulfill({
          status: ledger,
          json: {
            error: 'Payouts and burns are unavailable right now. Retrying shortly.',
            code: 'LEDGER_UNAVAILABLE',
          },
        })
      : route.fulfill({ json: ledger }),
  )
}
