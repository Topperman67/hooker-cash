# Hookbrew

A native ETH launch venue on **Robinhood Chain mainnet (4663)**, built on Uniswap V4. Hookbrew retains its five-stage studio, liquid-glass design, vesting, trading terminal, and seven immutable hook modules.

- Launch fee: **0.0001 ETH**, plus network gas.
- Opening market cap: **0.5–5 ETH**, default **1 ETH**. Tick rounding can make the initialized price slightly higher than the requested target.
- One-billion initial token supply, 1–5% pool fees, founder purchases capped at 10% of supply, and permanent seed liquidity.
- Harvested fees split 70% to creators and 30% to treasury before creator-funded module allocations.
- Native ETH trading, creator payouts, holder rewards, charts, volume, and market caps. No ETH/USD conversion or oracle.
- Treasury: `0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4`.

Open `/setup` to deploy with a funded wallet and authorize activation with the treasury wallet. Publishing the application does not deploy contracts or make the venue live. See the [Robinhood operating instructions](docs/ROBINHOOD_MIGRATION.md) for verification and the required signed smoke test.

## Run locally

Requires Node 22.12+ or Node 24 and npm.

```sh
npm ci
npm ci --ignore-scripts --prefix contracts/protocol
npm run contracts:build
npm run dev
```

Vite serves the frontend and same-origin API. For the complete production application, run `npm run build` followed by `npm start`. `npm run preview` serves only the frontend. The app never stores a private key.

The server defaults to loopback and port 5173. Configure `HOST`, `PORT`, `HOOKBREW_PUBLIC_URL`, and a persistent `HOOKBREW_DATA_DIR` as needed. `HOOKBREW_RPC_URL` overrides the server RPC; the browser uses the official public Robinhood RPC. See [.env.example](.env.example).

## Production storage

The linked Vercel project is `hooker-cash`; the configured stable metadata origin is `https://hookbrew.tech`. Keep this HTTPS origin stable: metadata URLs written on-chain cannot change.

Vercel requires shared Redis storage for activation, authorizations, media, recipes, and index checkpoints. Connect Upstash Redis and configure server-only `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (legacy `KV_REST_API_URL` / `KV_REST_API_TOKEN` also work). Never prefix secrets with `VITE_`. `/api/status` must report `storage.mode: "redis"` and `storage.ready: true` before setup.

The effective Redis namespace is `hookbrew:4663:v2`, optionally preceded by `HOOKBREW_STORAGE_PREFIX:`. Filesystem data uses a `4663-v2` subdirectory. Browser drafts, setup receipts, pending transactions, and custom-hook selections start fresh under the new namespace. Arc records remain separate and are never interpreted as ETH. Use separate preview storage, back up production Redis, and disable eviction. Metadata has a configurable 256 MB default ceiling; uploads require Redis support for 2.2 MB requests.

## Contracts and execution

`shared/network.mjs` defines the network, infrastructure, currency, monetary configuration, and namespace used by the application and server. Contracts pin the same ETH fee and valuation boundaries. Artifacts are `hookbrew-v2` / `hookbrew-modular-v2`, compiled with Solidity 0.8.26, Cancun, viaIR, optimizer 200. CREATE2 salts are mined from the current creation bytecode and constructor arguments.

Launch value is exactly `launchFee + initialBuy`; buy value is exactly `amountIn`. Neither needs an ERC20 approval. Sells carry zero ETH and approve the exact token amount. The app simulates complete transactions and reserves buffered gas from the same ETH balance. MAX re-estimates the resulting calldata and value.

The indexer waits for two **L2 confirmations**, validates canonical receipts, and recovers from reorganizations. This interaction policy is not Ethereum finality. Treasury activation is bound to the exact compiled factory/router transactions and supports treasury message authorization, including ERC-1271 verification.

## Verification

```sh
npx playwright install chromium
npm run contracts:test
npm run test:unit
npm run test:e2e
npm run contracts:test:fork
npm run format:check
npm run build
```

Local contract tests use real Uniswap V4 contracts and cover standard/custom launches, founder vesting, buys/sells, claims, all modules, rejected ETH payouts, reentrancy, and reserve isolation. The browser lifecycle suite runs real local chain transactions on port 8547. Other browser tests exercise wallet rejection, replacements, recovery, gas budgets, chain switching, production CSP, and mobile layouts.

The fork command checks Robinhood's actual PoolManager, Quoter, StateView, and CREATE2 deployer, then executes test transactions exclusively inside a local Hardhat fork. `HOOKBREW_FORK_RPC_URL` and optional `HOOKBREW_FORK_BLOCK` customize the read-only fork source. No mainnet signing key is needed.

The Redis integration test requires `HOOKBREW_REDIS_TEST_CONTAINER` or `HOOKBREW_REDIS_TEST_ENV_FILE` pointing to an ignored file containing test Redis REST credentials. It creates a random test namespace and cleans it up. CI supplies a real Redis service and checks artifact reproducibility, dependencies, formatting, and browser flows. A successful suite is not an independent contract audit.

After wallet deployment and activation, set `BLOCKSCOUT_API_KEY` in your local shell, then publish source verification and export the record:

```sh
npm run contracts:verify -- https://hookbrew.tech
```

This submits source to Robinhood Blockscout and writes `artifacts/robinhood/verified-deployments.json`. It makes no blockchain transactions. An exported deployment JSON path can be used instead of the site URL.

## Project map

- `contracts/protocol`: current native ETH Solidity, compiler configuration, local and fork tests.
- `public/protocol`, `src/generated`: reproducible deployment artifacts and application ABIs.
- `shared`: chain, currency, fee, valuation, compiler metadata, and namespace configuration.
- `server`: API, metadata, activation, custom-hook registry, and confirmed event indexing.
- `src`: wallet setup, launch studio, markets, charts, creator controls, and trading.
- [Hook builder](docs/HOOK_BUILDER.md): module behavior and accounting.
- `contracts/review`, historical documents and reference scripts: Arc research evidence; never an active deployment adapter.

## Attribution

[QuickLiquid](https://github.com/amarnath3003/quickLiquid) supplies refraction with accessibility/browser fallbacks. Outfit and DM Sans are bundled locally. Charts use [TradingView Lightweight Charts](https://www.tradingview.com/), with attribution in the terminal. See [DESIGN.md](DESIGN.md), [asset sources](public/brand/SOURCES.md), and dependency licenses. Hookbrew is based on the original [Hooker interface](https://hooker.cash/), without implied affiliation.
