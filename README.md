# Quant Pad

Launch coins on **Meteora** (Solana): a Dynamic Bonding Curve (DBC) pool that graduates to a DAMM v2
pool. Route their creator fees through **Quantum Hooks**: buyback and burn, holder rewards, fee
splits, dev-buy vesting and locked liquidity.

- `src/`: React 19 + Vite app (launch studio, market, coin terminal, portfolio, docs, and the $QUANTP pages).
- `server/`: Node API (indexer, RPC proxy, metadata/media, Quantum Hooks keeper, $QUANTP payout engine). It runs as Vite middleware in development, as `server/start.mjs` standalone, and as one Vercel function (`api/[[...path]].js`).
- `shared/`: code used by both the browser and the server. This covers network config, the Meteora client (`meteora.mjs`), the Quantum Hooks client (`quantum.mjs`), the Entanglement merkle tree and the lookup-table contents.
- `programs/quantum-hooks/`: the Anchor program (Rust) plus its end-to-end tests against Meteora's DBC and DAMM v2 programs, dumped from mainnet onto a local validator.
- `docs/QUANTUM_HOOKS_SPEC.md`: on-chain specification. `docs/DEPLOY.md` is the operator runbook.

## How it works

1. **Launch.** The launch studio uploads artwork and metadata, finds a mint address ending in `QP`, and creates the coin's DBC pool under one of Quant Pad's launch configs (the trading tax the launcher picks), with an optional dev buy in the same transaction.
2. **Quantum launch.** The coin's DBC pool creator is handed to a per-coin program address (the _well_). Hook rules are registered first, signed by the fresh mint key so nobody else can register them, and are immutable.
3. **Harvest and pulse.** The well claims its creator fees as SOL: the DBC creator trading fee, the curve's creator surplus once it fills, and after migration the creator migration fee and the LP fees of the locked DAMM v2 position the well owns. A pulse splits them into a creator share (plus Superposition wallets) and three reserves: Quantum Burn, Entanglement and Fusion.
4. **Keeper.** The server keeper harvests and pulses fees and runs capped burns and Fusion deposits. It also posts daily Entanglement merkle epochs that holders claim from the coin page, and migrates full curves to DAMM v2 (Meteora's migration is permissionless). Pulses, burns and Fusion are permissionless after a grace period.
5. **Trading.** Trades go to the coin's DBC pool or, after migration, its DAMM v2 pool, with instructions built from Meteora's pinned IDLs. Slippage is enforced on-chain. An optional platform fee is added as a visible transfer.

The browser never talks to an RPC provider directly. It uses `/api/rpc`, a method-allowlisted, rate-limited proxy, so a provider key stays server-side.

## $QUANTP payout engine

$QUANTP, Quant Pad's own token, launched outside Quant Pad's launch flow and now trades in its DAMM v2 pool. The team funds a payout wallet at its discretion (nothing on-chain makes it), and `server/quantp-engine.mjs` pays that wallet out from the keeper tick, once each UTC hour. Each run releases a 24th of the market cap tier's daily rate (40% below $100k, 100% up to $1M, 200% above) of what the wallet holds then: about 33%, 64% or 88% of a fixed balance over a day, at most 1 SOL a run. 60% of a release goes in SOL to the wallets holding at least 0.15% of the supply, by balance, and 40% buys $QUANTP in its pool and burns it; a share too small to send stays in the wallet. Each hour is claimed on-chain before anything is paid, so an hour never runs twice. The rules live in `QUANTP.engine` in `shared/network.mjs`, and `GET /api/quantp/engine` shows the engine's state. To stop it, set `QUANTP_ENGINE_PAUSED=1` and redeploy. Setup, guarantees and the incident runbook are in `docs/DEPLOY.md` ("$QUANTP payout engine").

## Development

Requires Node 24 (with its bundled npm 11; see `.nvmrc`). Older npm versions reject the lockfile.

```bash
npm ci
npm run dev
```

The app runs at http://127.0.0.1:5173 with the API mounted. The dev server listens on this machine
only, because it serves files from the repository root. To check a production build locally, run
`npm run build`, then `npm run preview` or `npm start` (see the self-hosting notes in
`docs/DEPLOY.md`). Unit tests:

```bash
npm run test:unit
```

The program is built and tested in Docker (`solanafoundation/anchor:v0.31.1`):

```bash
npm run program:test
```

## Configuration

Copy `.env.example` and see `docs/DEPLOY.md`. Production needs at least:

- a provider RPC (`QUANTPAD_RPC_URL`)
- Redis on serverless hosts
- `QUANTPAD_PUBLIC_URL` (a full `https://` URL) or `PINATA_JWT`. A self-hosted server without
  either refuses artwork uploads and metadata (503 `PUBLIC_URL_UNSET`), because metadata URIs are
  never built from the request's `Host` header.
- the lookup table (`QUANTPAD_LOOKUP_TABLE`), without which launches cannot include a dev buy
- `CRON_SECRET`, which the schedulers send to the keeper tick: the same value in Vercel and as the
  `CRON_SECRET` repository secret on GitHub

Quantum launches also need the program deployed and configured, plus a funded keeper. Per-visitor
rate limits, the upload and pin budgets (`QUANTPAD_MEDIA_CLIENT_MB`, `QUANTPAD_PIN_CLIENT_DAILY`,
`QUANTPAD_PIN_DAILY`), CDN caching and indexer tuning are described in `docs/DEPLOY.md` (section 7).

The $QUANTP payout engine runs only with `QUANTP_ENGINE_SECRET`, the payout wallet's key, set in
Vercel's **Production** environment only (never Preview or Development, and never committed).
`QUANTP_ENGINE_PAUSED=1` stops it. `QUANTP_ALERT_WEBHOOK` (optional) is a webhook URL the keeper
tick posts a one-line alert to when a run fails or stops early, or the keeper finds an epoch it did
not post.

## Trust and risk

- Meteora can upgrade its programs, and its operators can change a migrated pool's fees or pause
  it. No Meteora admin can reassign a coin's creator away from its well.
- The Quantum Hooks program needs an independent audit before it holds meaningful value.
- On Vercel, the keeper's and the payout engine's keys sit in the public serverless function. Keep
  only what each needs soon in its wallet.
- $QUANTP payouts are the team's discretionary policy, not enforced on-chain: they can change,
  pause or stop at any time.
- Memecoins are extremely risky.
