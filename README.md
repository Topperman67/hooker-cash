# Quant Pad

Launch coins on **pump.fun** (Solana) and route their creator fees through **Quantum Hooks**: buyback
and burn, holder rewards, fee splits, dev-buy vesting and locked liquidity.

- `src/`: React 19 + Vite app (launch studio, market, coin terminal, portfolio, docs).
- `server/`: Node API (indexer, RPC proxy, metadata/media, Quantum Hooks keeper). It runs as Vite middleware in development, as `server/start.mjs` standalone, and as one Vercel function (`api/[[...path]].js`).
- `shared/`: code used by both the browser and the server. This covers network config, the Quantum Hooks client (`quantum.mjs`), the Entanglement merkle tree and the lookup-table contents.
- `programs/quantum-hooks/`: the Anchor program (Rust) plus its end-to-end tests against pump.fun's real programs on a local validator.
- `docs/QUANTUM_HOOKS_SPEC.md`: on-chain specification. `docs/DEPLOY.md` is the operator runbook.

## How it works

1. **Launch.** The launch studio uploads artwork and metadata, finds a mint address ending in `QP`, and builds pump.fun `create_v2` with an optional dev buy in the same transaction.
2. **Quantum launch.** The coin's pump.fun `creator` is set to a per-coin program address (the _well_). Hook rules are registered first, signed by the fresh mint key so nobody else can register them, and are immutable.
3. **Pulse.** Creator fees from the bonding curve and, after graduation, the PumpSwap pool are collected into the well and split. The split covers a creator share (plus Superposition wallets) and three reserves: Quantum Burn, Entanglement and Fusion.
4. **Keeper.** The server keeper pulses fees and runs capped burns and Fusion deposits. It also posts daily Entanglement merkle epochs that holders claim from the coin page. Pulses, burns and Fusion are permissionless after a grace period.
5. **Trading.** Trades go to the bonding curve or the canonical PumpSwap pool through pump.fun's official SDKs. Slippage is enforced on-chain. An optional platform fee is added as a visible transfer.

The browser never talks to an RPC provider directly. It uses `/api/rpc`, a method-allowlisted, rate-limited proxy, so a provider key stays server-side.

## Development

Requires Node 24 (with its bundled npm 11; see `.nvmrc`). Older npm versions reject the lockfile.

```bash
npm ci
npm run dev
```

The app runs at http://localhost:5173 with the API mounted. To check a production build locally, run
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
- `QUANTPAD_PUBLIC_URL`
- the lookup table (`QUANTPAD_LOOKUP_TABLE`), without which launches cannot include a dev buy

Quantum launches also need the program deployed and configured, plus a funded keeper. Per-visitor
rate limits, the upload budget (`QUANTPAD_MEDIA_CLIENT_MB`) and indexer tuning are described in
`docs/DEPLOY.md` (section 7).

## Trust and risk

- pump.fun's admins can reassign a coin's creator, which would stop its hooks.
- pump.fun's programs are upgradeable and change often, so keep the SDKs current.
- The Quantum Hooks program needs an independent audit before it holds meaningful value.
- Memecoins are extremely risky.
