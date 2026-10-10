// Deterministic browser fixtures: API responses, a JSON-RPC stub and a Wallet Standard wallet.
export const WALLET_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
export const MINT = 'QuantPadTestMint1111111111111111111111111QP'

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
  progress: 42.5,
  price: 0.0000000412,
  marketCap: 41.2,
  volume24h: 128.4,
  change24h: 18.25,
  trades24h: 311,
  image: null,
  ...over,
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
  } = {},
) {
  await page.route('**/api/status', (route) =>
    route.fulfill({
      json: {
        brand: { name: 'Quant Pad' },
        network: { cluster: 'mainnet-beta', explorerUrl: 'https://solscan.io' },
        rpc: '/api/rpc',
        platform: { treasury: null, feeBps: 0 },
        quantum: { available: false, reason: 'not-deployed' },
        keeper: { enabled: false },
        storage: { mode: 'filesystem', ready: true },
        solUsd: 150,
        lookupTable: null,
      },
    }),
  )
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
  await page.route(`**/api/quantum/${MINT}*`, (route) =>
    route.fulfill({ json: { epochs: [], log: [], items: [] } }),
  )
  // JSON-RPC: balances answer; anything chain-specific fails like an unreachable node.
  await page.route('**/api/rpc', (route) => {
    const body = route.request().postDataJSON()
    const answer = (call) =>
      call.method === 'getBalance'
        ? { jsonrpc: '2.0', id: call.id, result: { context: { slot: 1 }, value: 1_500_000_000 } }
        : { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'stubbed' } }
    return route.fulfill({ json: Array.isArray(body) ? body.map(answer) : answer(body) })
  })
}

export async function enter(page, { wallet = false } = {}) {
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
            signTransaction: async (...inputs) =>
              inputs.map((i) => ({ signedTransaction: i.transaction })),
          },
        },
      }
      const register = ({ register }) => register(wallet)
      window.addEventListener('wallet-standard:app-ready', ({ detail }) => register(detail))
      window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
    }, WALLET_ADDRESS)
}
