# Operating Quant Pad

This runbook takes Quant Pad from an empty Vercel project to live Quantum launches. Steps marked
**wallet** need your own signatures. Nothing in the app can perform them for you.

## 1. Web app and API

1. Create a Vercel project from this repository (framework: none; `vercel.json` sets build and routing). `package.json` pins Node 24 (`engines.node`), which Vercel uses for both the build and the function. The lockfile needs npm 11, which ships with Node 24.
2. Add an Upstash Redis database to the project (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the `KV_*` equivalents). Serverless instances share all state through it.
3. Set `QUANTPAD_PUBLIC_URL` to the final HTTPS domain. Token metadata URIs are written on-chain, so pick the domain before the first launch. Alternatively, set `PINATA_JWT` to pin artwork and metadata to IPFS, which keeps URIs independent of the domain.
4. Set `QUANTPAD_RPC_URL` to a provider endpoint. The free public endpoint throttles `getTransaction` hard enough that indexing falls behind.
5. Deploy, then open `/api/status`. Expect `storage.ready: true`, a SOL price, and `quantum.available: false` until step 3.

**Git deployments of `main` are paused.** `vercel.json` sets `git.deploymentEnabled` to `{ "main": false }`, so pushes to `main` do not create Vercel deployments until production is configured. Until then, deploy by hand: run `vercel deploy --prod` from a checkout, or use **Redeploy** in the Vercel dashboard. Every "redeploy" in this runbook means one of those. Once production is configured and verified, re-enable automatic deploys by removing the `git` block from `vercel.json` (or setting `"main": true`) and pushing that change; if that push does not deploy, redeploy it once by hand. Until then, pump.fun SDK updates merged to `main` do not reach production on their own.

## 2. Lookup table (**wallet**, about 0.01 SOL)

A pump.fun create + dev buy is about 1 590 bytes, but Solana allows 1 232. The lookup table holds the
~45 accounts every launch shares:

```bash
node scripts/create-lookup-table.mjs --keypair path/to/operator.json --rpc "$QUANTPAD_RPC_URL"
```

Set the printed `QUANTPAD_LOOKUP_TABLE` and redeploy. Rerun with `--table <address>` after pump.fun upgrades to add new static accounts. `QUANTPAD_LOOKUP_TABLE` is required for any launch with a dev buy, standard or Quantum: `create_v2` and the dev buy always go in one transaction, which only fits with the table, and the launch page refuses a dev buy when no table is configured. Launches without a dev buy still work without it.

## 3. Quantum Hooks program (**wallet**)

1. Build and test: `npm run program:test`. The tests run against pump.fun's real programs dumped from mainnet onto a local validator. They do not need the program keypair.
2. Restore the program keypair. `programs/quantum-hooks/target/deploy/quantum_hooks-keypair.json` is gitignored and determines the program address baked into `declare_id!`, `Anchor.toml` and `shared/idl/quantum_hooks.json`. Keep a backup offline. Before `npm run program:build` or a deploy, restore the backed-up file to that path: `build` and `keys` stop with an error when it is missing or does not match `declare_id!`, and never generate a new id on their own. `QUANTPAD_NEW_PROGRAM_ID=1` deliberately creates a new program id (it rewrites `declare_id!`, `Anchor.toml` and the IDL). Never set it for the production program.
3. Build with `npm run program:build`, then deploy with the Anchor image and your deployer keypair (rent for the program data is roughly 3–5 SOL):
   `anchor deploy --provider.cluster mainnet --provider.wallet <deployer.json>` (see `programs/quantum-hooks/README.md`).

   **Deploy the program and the web app together.** The program, `shared/idl/quantum_hooks.json` and `shared/quantum.mjs` must match: `pulse` now takes a `rent_payer` signer and `fusion` takes `lp_token_program`, so an older web app or keeper fails against the upgraded program, and the other way round. When you upgrade a deployed program, redeploy the web app (which also runs the keeper) from the same commit straight after the program upgrade lands.

4. Initialize the config once with `scripts/init-config.mjs`, signed by the program's upgrade authority (the program accepts no other signer). Without `--yes` it is a dry run: it makes read-only RPC calls, checks the upgrade authority, the authority's balance and whether the config already exists, and prints what it would send. It refuses a mainnet-beta RPC (by URL or genesis hash) unless you also pass `--mainnet`.

   ```bash
   node scripts/init-config.mjs --rpc "$QUANTPAD_RPC_URL" --authority path/to/upgrade-authority.json \
     --treasury <protocol treasury> --keeper <keeper public key> --protocol-bps <0-1000> --mainnet
   # Read the summary, then run the same command with --yes to sign and send.
   ```

   It sets:
   - `treasury` (`--treasury`), which receives the protocol share
   - `keeper` (`--keeper`), the public key of `QUANTPAD_KEEPER_SECRET`. It defaults to the authority's own key, so pass it explicitly.
   - `protocol_bps` (`--protocol-bps`, 0 to 1 000, default 0)
   - `max_burn_lamports` (`--max-burn-sol`, default 1 SOL), `min_action_interval` (`--min-action-interval`, default 3 600 s) and `keeper_grace` (`--keeper-grace`, default 86 400 s)

   `--program-id` overrides the program address from the IDL. Every value except the authority can be changed later with `update_config`. Fund the protocol treasury with at least the rent-exempt minimum for an empty account, 890,880 lamports (send 0.001 SOL). Until it holds that much, pulses defer the protocol share (it stays in the coin's well) instead of paying it out.

5. Consider moving the program's upgrade authority to a multisig.
6. Have the program independently audited before promoting Quantum launches.

`/api/status` now reports `quantum.available: true` and the launch studio enables Quantum launches.

## 4. Keeper

1. Create a fresh keypair for the keeper, fund it with ~0.2 SOL, and set `QUANTPAD_KEEPER_SECRET`.
2. Set `CRON_SECRET`. On Vercel Pro, add a cron for `/api/keeper/tick` every 5 minutes. On Hobby, point any external scheduler (e.g. GitHub Actions) at `GET /api/keeper/tick` with `Authorization: Bearer $CRON_SECRET`. The app also runs a throttled keeper pass during normal traffic.
3. Watch the keeper's SOL balance. Each pulse, burn and epoch costs a network fee plus a priority fee. Post-graduation pulses no longer cost the keeper the 0.00204 SOL (2,039,280 lamports) rent of the well's WSOL account: PumpSwap's fee collection creates that account at the keeper's expense, and `pulse` refunds the rent to its `rent_payer` (the keeper) when it closes the account.

## 5. Platform fee (optional)

Set `QUANTPAD_TREASURY` and `QUANTPAD_FEE_BPS` (default 50 = 0.5%, cap 200). The fee is a separate
transfer shown on the trade ticket and launch summary before signing.

**Fund the treasury first.** Send `QUANTPAD_TREASURY` at least the rent-exempt minimum for an empty
account, 890,880 lamports (send 0.001 SOL), before you enable the fee. Use a plain wallet address (a
system account). Solana rejects a transfer that would leave a new account below that minimum, so until
the treasury holds 890,880 lamports the app leaves out fee transfers smaller than that (also when it
cannot read the treasury's balance). Those trades and launches still go through, but their fees are
lost: at 50 bps that is every trade under about 0.18 SOL, including the 0.01 SOL smoke test below.

## 6. Moderation

Add mints to `QUANTPAD_HIDDEN_MINTS` (comma-separated) to remove them from Quant Pad's lists and coin
pages. They remain on-chain and on pump.fun.

## 7. Limits and tuning

The API limits each visitor by address: an IPv4 address on its own, an IPv6 address by its /64 prefix
(one subscriber's range). Self-hosted servers behind a proxy need `QUANTPAD_TRUST_PROXY` (see below).
Over a limit, the API answers 429.

| Route                                                                                                     | Limit per visitor                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/rpc`                                                                                           | 900 calls per minute, 1 to 25 per request. `getMultipleAccounts` counts each account (at most 100), and every full MiB of response counts as one more call. Responses over 16 MiB are refused.        |
| All other `POST` routes (`/api/media`, `/api/metadata`, `/api/launches`, `/api/coins/track`, `/api/sync`) | 30 per minute together                                                                                                                                                                                |
| `POST /api/launches`                                                                                      | also 10 per minute                                                                                                                                                                                    |
| `POST /api/sync`                                                                                          | also 12 per minute. Each mint syncs at most once per 10 s; a request inside that window gets the stored record and one follow-up sync is queued. A full pass runs at most once per 10 s for everyone. |
| `GET /api/quantum/:mint`                                                                                  | 60 per minute                                                                                                                                                                                         |
| `GET /api/quantum/:mint/claims`                                                                           | 30 per minute                                                                                                                                                                                         |
| `POST /api/media`, `POST /api/metadata`                                                                   | `QUANTPAD_MEDIA_CLIENT_MB` per day (default 16 MB). Each upload is charged at least 128 KB.                                                                                                           |
| `POST /api/metadata` with `PINATA_JWT` set                                                                | `QUANTPAD_PIN_CLIENT_DAILY` new IPFS pins per day (default 24, two per launch). Over it: 429 with `code: MEDIA_QUOTA`.                                                                                |

Settings:

- `QUANTPAD_MEDIA_LIMIT_MB` (default 256): total storage for uploaded artwork and metadata, shared by
  everyone. On Redis it counts the stored size, about 4/3 of the file size (base64). Uploaded artwork
  is kept only once token metadata uses it; artwork that no metadata uses within 24 hours is deleted
  and its space is freed.
- `QUANTPAD_MEDIA_CLIENT_MB` (default 16): each visitor's daily upload budget, as in the table.
- `PINATA_JWT`: when set, nothing is pinned at upload time. `/api/metadata` pins the artwork it
  references and the metadata document (two files on your Pinata plan per launch), and a file that
  was pinned before is reused instead of pinned again. Abandoned uploads never reach Pinata.
- `QUANTPAD_PIN_CLIENT_DAILY` (default 24): new pins each visitor may create per day, as in the table.
- `QUANTPAD_RPC_BATCH` (default 10): `getTransaction` calls per indexer batch request. The indexer
  drops to single requests by itself when a provider refuses batches.
- `QUANTPAD_INDEX_BATCH` (default 40): transactions read per address per indexing pass.
- `QUANTPAD_SYNC_MS`: time budget of one indexing pass, default 15 000 ms on Vercel and 40 000 ms
  elsewhere. The pass's lease lasts this long plus 45 s. On Vercel the request, the index pass and the
  keeper share the function's 60 s: the background pass after a response gets what the request left
  (it is skipped under 10 s), so keep this well under 60 s.
- `QUANTPAD_MAX_LAUNCHES` (default 2 000): the most native Quant Pad launches kept in the coin list.
  Past it, `/api/launches` answers 429 (`launch_cap`) until you raise it.

Storage sizing: each open Entanglement epoch keeps its leaves with their merkle proofs so claims are
cheap to serve, about 11 MB for a full epoch of 16 384 holders (less for smaller coins). Epochs stay
in storage for the 30-day claim window plus 2 days. Size the Redis plan for the number of busy Quantum
coins you expect: for example, 20 coins with full epochs need roughly 220 MB.

The server fetches off-chain token metadata (to show coins' names and artwork) only over https and
only from public addresses: private, loopback and link-local hosts are refused, also after a
redirect. A metadata document may be at most 64 KB.

## Self-hosting with `npm start`

Instead of Vercel, Quant Pad can run as one long-running Node 24 process:

```bash
npm ci
npm run build
npm start   # serves dist/ and the API on HOST:PORT (default 127.0.0.1:5173)
```

- Without Redis, state lives in `QUANTPAD_DATA_DIR` (default `.quantpad-data`). That file store is for
  a single process; use Redis if you run more than one.
- The server speaks plain HTTP. Put it behind a TLS reverse proxy such as Caddy or nginx.
- Behind a proxy, set `QUANTPAD_TRUST_PROXY` to the number of proxies in front of the server (`1` for a
  single Caddy or nginx). Rate limits then key on each visitor's address, taken from the right-hand end
  of `X-Forwarded-For`. Without it, every request comes from the proxy's address and all visitors share
  one rate-limit bucket. Leave it unset when clients connect directly: the header is then ignored,
  because anyone can send it. The proxy must append the client address. Caddy does by default; with
  nginx use `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
- Hashed files under `/assets/` are served with a one-year immutable `Cache-Control`. Everything else
  revalidates by ETag. Text responses are brotli or gzip compressed.
- `npm run preview` serves a build the same way (API and security headers) for a local check.

## Smoke test before announcing

1. Do a standard launch with a 0.01 SOL dev buy. It should appear in the market within seconds and on pump.fun.
2. Buy and sell from a second wallet. Confirm the trades, chart and platform fee transfer.
3. Do a Quantum launch with all four modules and a lock. Trade, then press **Pulse fees now**. Confirm the reserves and creator payout on Solscan.
4. Wait for the keeper to run a burn and an Entanglement epoch, then claim from a holder wallet.
5. Release vested tokens from the launcher wallet after the cliff (use a short cliff for the test coin).
