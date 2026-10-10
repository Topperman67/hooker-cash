# Operating Quant Pad

This runbook takes Quant Pad from an empty Vercel project to live Quantum launches. Steps marked
**wallet** need your own signatures. Nothing in the app can perform them for you.

## 1. Web app and API

1. Create a Vercel project from this repository (framework: none; `vercel.json` sets build and routing).
2. Add an Upstash Redis database to the project (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the `KV_*` equivalents). Serverless instances share all state through it.
3. Set `QUANTPAD_PUBLIC_URL` to the final HTTPS domain. Token metadata URIs are written on-chain, so pick the domain before the first launch. Alternatively, set `PINATA_JWT` to pin artwork and metadata to IPFS, which keeps URIs independent of the domain.
4. Set `QUANTPAD_RPC_URL` to a provider endpoint. The free public endpoint throttles `getTransaction` hard enough that indexing falls behind.
5. Deploy, then open `/api/status`. Expect `storage.ready: true`, a SOL price, and `quantum.available: false` until step 3.

## 2. Lookup table (**wallet**, about 0.01 SOL)

A pump.fun create + dev buy is about 1 590 bytes, but Solana allows 1 232. The lookup table holds the
~45 accounts every launch shares:

```bash
node scripts/create-lookup-table.mjs --keypair path/to/operator.json --rpc "$QUANTPAD_RPC_URL"
```

Set the printed `QUANTPAD_LOOKUP_TABLE` and redeploy. Rerun with `--table <address>` after pump.fun upgrades to add new static accounts. Without the table, a launch with a dev buy is split into two transactions, which leaves a short window for snipers between create and buy.

## 3. Quantum Hooks program (**wallet**)

1. Build and test: `npm run program:test`. The tests run against pump.fun's real programs dumped from mainnet onto a local validator.
2. Back up `programs/quantum-hooks/target/deploy/quantum_hooks-keypair.json`. It determines the program address baked into `shared/idl/quantum_hooks.json`.
3. Deploy with the Anchor image and your deployer keypair (rent for the program data is roughly 3–5 SOL):
   `anchor deploy --provider.cluster mainnet --provider.wallet <deployer.json>` (see `programs/quantum-hooks/README.md`).
4. Initialize the config once with `buildInitializeConfigInstruction` from `shared/quantum.mjs` (script in `programs/quantum-hooks/scripts`). This sets:
   - `treasury`, which receives the protocol share
   - `keeper`, the public key of `QUANTPAD_KEEPER_SECRET`
   - `protocol_bps`, at most 1 000
   - `max_burn_lamports`, `min_action_interval` and `keeper_grace`
5. Consider moving the program's upgrade authority to a multisig.
6. Have the program independently audited before promoting Quantum launches.

`/api/status` now reports `quantum.available: true` and the launch studio enables Quantum launches.

## 4. Keeper

1. Create a fresh keypair for the keeper, fund it with ~0.2 SOL, and set `QUANTPAD_KEEPER_SECRET`.
2. Set `CRON_SECRET`. On Vercel Pro, add a cron for `/api/keeper/tick` every 5 minutes. On Hobby, point any external scheduler (e.g. GitHub Actions) at `GET /api/keeper/tick` with `Authorization: Bearer $CRON_SECRET`. The app also runs a throttled keeper pass during normal traffic.
3. Watch the keeper's SOL balance. Each pulse, burn and epoch costs a network fee plus a priority fee.

## 5. Platform fee (optional)

Set `QUANTPAD_TREASURY` and `QUANTPAD_FEE_BPS` (default 50 = 0.5%, cap 200). The fee is a separate
transfer shown on the trade ticket and launch summary before signing.

## 6. Moderation

Add mints to `QUANTPAD_HIDDEN_MINTS` (comma-separated) to remove them from Quant Pad's lists and coin
pages. They remain on-chain and on pump.fun.

## Smoke test before announcing

1. Do a standard launch with a 0.01 SOL dev buy. It should appear in the market within seconds and on pump.fun.
2. Buy and sell from a second wallet. Confirm the trades, chart and platform fee transfer.
3. Do a Quantum launch with all four modules and a lock. Trade, then press **Pulse fees now**. Confirm the reserves and creator payout on Solscan.
4. Wait for the keeper to run a burn and an Entanglement epoch, then claim from a holder wallet.
5. Release vested tokens from the launcher wallet after the cliff (use a short cliff for the test coin).
