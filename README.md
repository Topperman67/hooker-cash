# Hookbrew

An Arc / Uniswap V4 launch venue with its own contracts, a five-stage launch studio, event indexer, and in-site trading terminal. The midnight liquid-glass interface uses QuickLiquid and the original Hookbrew logo assets.

Open `/setup` to check the active venue or finish activation of existing deployment receipts. The configured protocol treasury is `0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4`.

## Implemented

- Launch flow: **Pool → Hook → Token → Payouts → Review**, with purple glass styling, mobile layouts, per-step validation, review edit links, and saved-draft migration.
- Token identity, uploaded artwork, description and social links; local draft persistence.
- Fixed one-billion supply; USDC quote pool; 1–5% pool fee; opening valuation target of 2,000–10,000 USDC.
- Optional founder buy, capped at 10% of supply; up to ten recipients with exact percentage splits. Vesting presets run from a one-hour cliff to a year, with custom hour/day schedules and per-wallet overrides. A solo creator's vesting is assigned to their connected launch wallet.
- Optional time-limited buy caps and global buy spacing; sells remain open.
- Permanent factory seed position. Harvested seed fees split 70% to creators and 30% to the protocol treasury.
- Creator fee claims and vested token releases. Founder recipients retain their original allocation to qualify for creator fees, counting unreleased vesting.
- Indexed market search, fee filters, sorting, volume rankings, and seed-pool listings.
- Token pages with actual OHLC/volume charts, interval selection, recent trades, identity links and creator controls.
- Real V4 quotes and own-router exact-input buy/sell execution, exact approvals, minimum output, deadline, transaction simulation, wallet/account checks and receipt validation.
- Wallet-signed deployment, mined hook address, compiled-bytecode verification, treasury-signed activation, persisted configuration, event indexing and reorganization recovery.

There are no production fixture tokens, fabricated charts, simulated wallets, or pretend successful transactions. Browser and chain test fixtures live in the test suites. Contract and integration tests are not an independent security audit.

## Run locally

Requires Node 22.12+ (or Node 24) and npm.

```sh
npm ci
npm ci --ignore-scripts --prefix contracts/protocol
npm run contracts:build
npm run dev
```

Vite serves both the frontend and `/api` middleware. The first-visit acknowledgement is stored locally. No private key is read or stored by the app.

For a production build with the API and media server:

```sh
npm run build
npm start
```

Set `HOST=0.0.0.0` when required by your host, `PORT` (default 5173), `HOOKBREW_PUBLIC_URL=https://your-domain`, and `HOOKBREW_DATA_DIR` to a persistent directory. Optionally set `HOOKBREW_RPC_URL` to your Arc RPC. The default bind address is loopback. Put public deployments behind HTTPS; configure your reverse proxy to preserve the original Host header.

`npm run preview` is a frontend-only Vite preview; use `npm start` for the complete application. Static-only hosting does not run this indexer/API.

### Vercel hosting

Vercel function memory and `/tmp` are disposable and are not shared between instances. The Vercel adapter requires shared Redis storage for deployment state, short-lived authorizations, token artwork/metadata, and index checkpoints. It refuses activation and uploads when storage is missing, before any wallet transaction is requested.

1. In the **hooker-cash** Vercel project's **Storage** tab, connect an **Upstash Redis** database to **Production**. The integration should supply `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the older `KV_REST_API_URL` and `KV_REST_API_TOKEN` names also work). These are server-only secrets; never use a `VITE_` prefix or commit them.
2. Set `HOOKBREW_PUBLIC_URL=https://hooker-cash.vercel.app` and redeploy the latest `main` commit. The adapter can also use Vercel's production URL when no explicit URL is supplied.
3. Confirm `/api/status` reports `storage.mode: "redis"` and `storage.ready: true`.
4. Return to `/setup` in the browser used to deploy. Its saved factory/router transaction hashes are preserved. Finish the gas-free treasury activation using those receipts, then choose **Continue your token launch**. Do not redeploy contracts already shown as confirmed.

Use a persistent database with eviction disabled; activation and metadata must not expire. `HOOKBREW_STORAGE_PREFIX` defaults to `hookbrew:v1`. Do not share production storage with previews; use a separate database/prefix if enabling writes in previews. Media is content-addressed and capped by `HOOKBREW_MEDIA_LIMIT_MB`; choose a Redis plan that supports the app's maximum 2.2 MB upload request size. The index is rebuildable from chain events and uses expiring leases plus conditional writes to prevent stale instances from overwriting newer checkpoints. Vercel `waitUntil` keeps each bounded index pass alive after the HTTP response.

If an older deployment used `/tmp`, its temporary activation record may already be gone. The public receipts saved by the setup page are enough to re-verify the existing contracts and authorize the venue again. Previously lost artwork/metadata needs to be restored from backups; on-chain metadata URLs cannot be changed.

## Activate your venue

1. Run the public HTTPS application with durable storage and a stable public URL. Metadata URLs written on-chain are immutable.
2. Open `/setup`, connect a funded Arc deployer wallet, and prepare the factory deployment. Review the treasury and gas estimate, then sign.
3. Prepare and sign the router deployment. The factory constructor creates the vesting vault.
4. Connect the configured treasury wallet and sign the deployment-specific activation message. This authorization costs no gas. Server verification also supports ERC-1271 signatures.
5. The server verifies both transactions against this exact compiled build and starts indexing your factory. Open `/create` to launch.

The setup page stores public transaction hashes and can export a deployment record. For filesystem hosting, back up `.hookbrew-data` (or the configured directory), especially `deployment.json` and `media/`, and run one server process per directory. For Vercel, back up the connected Redis database. Index files can be rebuilt from chain events. Activation is idempotent for the same transaction hashes; different receipts cannot overwrite the active venue. The launch studio saves both the draft and current step, and rechecks server availability before every launch or approval.

Native USDC pays launch fees and gas. ERC20 USDC at `0x3600000000000000000000000000000000000000` is the pool’s trading asset. A live launch requires a public HTTPS metadata origin. The flat launch fee is 1 native USDC, paid directly to the configured treasury.

Both USDC interfaces share one underlying balance. The app reserves the combined purchase, fee and gas cost; buy MAX keeps a gas reserve. Public media storage defaults to a 256 MB ceiling, configurable with `HOOKBREW_MEDIA_LIMIT_MB`.

## Verify

```sh
npx playwright install chromium
npm run contracts:test
npm run test:unit
npm run test:e2e
npm run format:check
npm run build
```

The contract suite uses real local Uniswap V4 PoolManager/Quoter contracts. It covers buys/sells in both currency orderings, slippage, vesting, guards, recipient validation, creator eligibility and treasury isolation. Its HTTP integration test covers signature/bytecode-bound activation, real event indexing, persistence and reorganization recovery.

The browser lifecycle suite starts its own local Hardhat chain on port 8547, deploys real contracts and drives the actual launch/approve/buy/sell interface. It uses isolated test accounts and redirects RPC calls to that local node. Other browser tests cover wallet rejection, receipt verification, reload recovery, draft validation, mobile layout and unavailable services.

## Architecture and scope

- `contracts/protocol`: independent Hookbrew v1 Solidity source and tests.
- `public/protocol`: compiled deployment bytecode and ABIs, exported from that source.
- `server`: same-origin API, content-addressed media/metadata, deployment activation, confirmed event index.
- `src/lib/protocol*`: transaction and validation adapters; `src/components/LaunchStudio.jsx` and `src/pages/TokenTerminal.jsx`: product workflows.
- `src/config/launchDeployment.js`: separate, unset historical Hooker V10 adapter. It is not the Hookbrew v1 configuration.

The original eight-module builder, reflections/buybacks, external LP position management, leveraged markets, and transaction-capable MCP service remain backlog work. See [the build notes](docs/HOOKBREW_V1.md), [reference audit](docs/FEATURE_PARITY_AUDIT.md) and [parity backlog](docs/FEATURE_BACKLOG.md). Historical original-contract research stays in `contracts/review`; those contracts and fee destinations are not adopted.

## Attribution

[QuickLiquid](https://github.com/amarnath3003/quickLiquid) supplies refraction with accessibility/browser fallbacks. Outfit and DM Sans are bundled locally. Charts use [TradingView Lightweight Charts](https://www.tradingview.com/), with attribution in the terminal. See [DESIGN.md](DESIGN.md), [asset sources](public/brand/SOURCES.md) and dependency licenses. Hookbrew is based on the original [Hooker interface](https://hooker.cash/), without implied affiliation.
