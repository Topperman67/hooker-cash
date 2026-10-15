# Operating Quant Pad

This runbook takes Quant Pad from an empty Vercel project to live Quantum launches. Steps marked
**wallet** need your own signatures. Nothing in the app can perform them for you.

## 1. Web app and API

1. Create a Vercel project from this repository (framework: none; `vercel.json` sets build and routing). `package.json` pins Node 24 (`engines.node`), which Vercel uses for both the build and the function. The lockfile needs npm 11, which ships with Node 24.
2. Add an Upstash Redis database to the project (`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the `KV_*` equivalents). Serverless instances share all state through it.
3. Set `QUANTPAD_PUBLIC_URL` to the final HTTPS domain, as a full URL (`https://quantpad.example.com`). Token metadata URIs are written on-chain, so pick the domain before the first launch. Alternatively, set `PINATA_JWT` to pin artwork and metadata to IPFS, which keeps URIs independent of the domain. Without either, a Vercel deployment issues links under the project's production domain. Metadata URIs are never built from a request's `Host` header; a self-hosted server without either setting refuses uploads (see [Self-hosting](#self-hosting-with-npm-start)). The build reads it too (or `VITE_PUBLIC_URL`, which takes precedence) to write absolute `og:image` and `og:url` tags, which link previews need. Without either, a Vercel build uses the project's production domain, and other builds keep a relative `og:image` (and print a warning). Redeploy after changing it.
4. Set `QUANTPAD_RPC_URL` to a provider endpoint. The free public endpoint throttles `getTransaction` hard enough that indexing falls behind.
5. Deploy, then open `/api/status`. Expect `storage.ready: true`, a SOL price, and `quantum.available: false` until step 3.

**Pushes to `main` deploy to production.** Vercel builds every push to `main` from GitHub. To hold deploys while production is being reconfigured, add `"git": { "deploymentEnabled": { "main": false } }` to `vercel.json` and push that change; deploy by hand meanwhile with `vercel deploy --prod` from a clean checkout, or **Redeploy** in the Vercel dashboard. Every "redeploy" in this runbook means one of those.

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
   - `claim_delay` (`--claim-delay`, default 21 600 s = 6 h, at most 604 800 s = 7 days): how long every Entanglement epoch waits before holders can claim, which is your window to cancel a wrong epoch (see [Program operations](#program-operations-authority))

   `--program-id` overrides the program address from the IDL. Every value can be changed later with `update_config` (see [Program operations](#program-operations-authority)). Fund the protocol treasury with at least the rent-exempt minimum for an empty account, 890,880 lamports (send 0.001 SOL). A pulse cannot pay a protocol share that would leave the treasury below that minimum. Such a share is owed to the treasury and held in the coin's well, never split among the other recipients, and the first pulse after the treasury can receive it (for example once it is funded) pays everything owed in full, owed amounts first. Split wallets and launchers that cannot receive yet are handled the same way.

5. Consider moving the program's upgrade authority, and the config authority (`update_config` can hand it to another key), to a multisig. Keep in mind that cancelling a wrong epoch needs the config authority within the claim delay.
6. Have the program independently audited before promoting Quantum launches.

`/api/status` now reports `quantum.available: true` and the launch studio enables Quantum launches.

### Program operations (authority)

These instructions take the config authority's signature: the upgrade authority that ran `init-config.mjs`, or whichever key `update_config` has made authority since. `scripts/program-ops.mjs` runs them. Like `init-config.mjs`, it is a dry run without `--yes` (it checks the change against the chain and simulates the transaction) and refuses a mainnet-beta RPC unless you also pass `--mainnet`. With `--authority-pubkey <key>` in place of `--authority <keypair.json>` it prints the instruction (program id, accounts, data) for a multisig proposal and never sends.

```bash
# Print the config, or list a coin's epochs and which can still be cancelled (read-only):
node scripts/program-ops.mjs --rpc "$QUANTPAD_RPC_URL" --mainnet
node scripts/program-ops.mjs --rpc "$QUANTPAD_RPC_URL" --mainnet --epochs <mint>
# Cancel an epoch. The other actions are --pause, --unpause and update_config fields
# such as --keeper <public key> or --claim-delay <seconds>.
node scripts/program-ops.mjs --rpc "$QUANTPAD_RPC_URL" --mainnet \
  --authority path/to/authority.json --cancel-epoch <mint> <index>
# Read the summary, then run the same command with --yes to sign and send.
```

From code, the builders in `shared/quantum.mjs` named below do the same.

- **Claim delay.** Every Entanglement epoch opens for claims at `claim_start`, which is `claim_delay` seconds after it was posted. Until then the coin page shows "Claims open in …" and the keeper offers no claims. Pick a delay longer than the time you need to notice a wrong epoch and cancel it. A longer delay also holds back every holder's payout by that much. The program accepts at most one epoch per coin every 20 hours (the keeper posts once a day).
- **`cancel_epoch`** (`buildCancelEpochInstruction({ connection, authority, mint, index, programId })`) works only before the epoch's `claim_start`. It returns the epoch's SOL to the coin's holder reserve, closes the epoch account, sends its rent to the configured keeper and emits `EpochCancelled`. Use it for an epoch your keeper did not post, or one with a wrong snapshot or total. The keeper flags the first kind for you (see [Keeper alerts](#keeper-alerts)); `program-ops.mjs --epochs <mint>` lists a coin's epochs with their `claim_start`, and `GET /api/quantum/<mint>` lists the ones your keeper recorded. An index the keeper has no record of, or whose root differs from its record, was not posted by your keeper.
- **`set_paused`** (`buildSetPausedInstruction({ connection, authority, paused, programId })`) pauses or resumes the program. A pause stops everything that calls into pump.fun: new Quantum registrations, Quantum burns and Fusion. Pulses, claims, epoch closes, epoch cancels and token releases keep working, so nobody's funds are frozen (see `docs/QUANTUM_HOOKS_SPEC.md`). `/api/status` reports `quantum.available: false` with reason `paused`. `update_config` no longer changes the pause flag.
- **`update_config`** (`buildUpdateConfigInstruction({ ..., expectedVersion })`) changes the treasury, keeper, protocol share, burn cap, intervals, grace period, claim delay or authority. Every config change, including a pause, increments the config's `version`, and an update built against an older version fails with `ConfigChanged`. So an update prepared before a pause cannot undo it: re-read the config and rebuild the update after any other change. When `expectedVersion` is left out, the builder reads the current version when it builds the instruction.

## 4. Keeper

The keeper is a hot wallet. Its secret sits in the server's environment, and on Vercel in the same function that answers every anonymous request and loads the whole SDK dependency tree. Treat the key as exposed: give it only the SOL it needs soon and know how to replace it.

1. Create a fresh keypair for the keeper. Never reuse the authority, the treasury or a personal wallet. Set `QUANTPAD_KEEPER_SECRET` to it, and pass its public key to `init-config.mjs --keeper`. On Vercel, add the secret to the **Production** environment only, never Preview or Development, because preview deployments run any branch's code.
2. Set `CRON_SECRET`. On Vercel Pro, add a cron for `/api/keeper/tick` every 5 minutes. On Hobby, point any external scheduler (e.g. GitHub Actions) at `GET /api/keeper/tick` with `Authorization: Bearer $CRON_SECRET`. The app also runs a throttled keeper pass during normal traffic.
3. Fund it as described below, top it up regularly, and watch its balance. A keeper that runs dry stops pulses, burns, Fusion and epochs until it is refilled.

Optionally, keep the key out of the public function altogether: leave `QUANTPAD_KEEPER_SECRET` unset on Vercel and run the keeper as a private `npm start` process (bound to `127.0.0.1`, not reachable from the internet) with the same Redis database and `QUANTPAD_STORAGE_PREFIX`. The public deployment still serves epochs and claims from the shared storage.

### Keeper alerts

Each keeper run logs what needs you, and `GET /api/keeper/tick` also returns it as `keeper.alerts`:

- `foreign-epoch`: `epoch <mint>#<index> was not posted by this keeper; cancel it with cancel_epoch before <time>`. An on-chain epoch that the keeper has no record of, or whose root differs from its record, while it can still be cancelled. Cancel it with `program-ops.mjs --cancel-epoch` before that time, then rotate the keeper key (below): someone else holds it.
- `low-balance`: the keeper wallet holds less than 0.01 SOL per Quantum coin it serves (about a mid-sized epoch's rent plus a day of fees each). Top it up.

The keeper works through its coins a few per run, in rotation, so these appear only while the cron (or traffic) keeps it running. Forward the function's logs to something that notifies you (for example a Vercel log drain with an alert on `was not posted by this keeper`), and check them more often than the claim delay.

### Keeper SOL

**Fees.** Each pulse, burn, Fusion deposit, epoch post and epoch close is one transaction: 5 000 lamports per signature plus a priority fee.

**One-time rent per coin, never refunded.** The first action of each kind creates accounts at the keeper's expense:

| First …                   | Rent (lamports)                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| burn on the bonding curve | 3,918,480: the well's token account (2,074,080) and pump.fun's volume accumulator for the well (1,844,400) |
| burn on PumpSwap          | 1,844,400: PumpSwap's volume accumulator for the well                                                      |
| Fusion deposit            | 2,074,080: the well's LP token account                                                                     |

That is about 0.008 SOL over the life of each Quantum coin that burns before and after graduation and uses Fusion.

**Epoch rent held for the claim window.** Each Entanglement epoch is an account that costs about 0.002 SOL for a coin with a few holders and up to about 0.016 SOL at 16,384 holders (one bit per holder). Its rent comes back to the keeper that posted it only when the epoch is closed, after the 30-day claim window (a cancelled epoch refunds at once). With one epoch per coin a day, each coin with active Entanglement holds about 30 epochs at a time: roughly 0.06 SOL for a small coin and up to 0.5 SOL for one with 16,384 holders. Nothing is refunded during the first 30 days, so the need grows over the first month and then levels off.

**Sizing.** For example, 10 Quantum coins, 5 of them with Entanglement epochs of about 1,000 holders (about 0.003 SOL each): 10 × 0.008 + 5 × 30 × 0.003 ≈ 0.53 SOL over the first month, plus fees. Add 0.01 SOL for each new Quantum coin and 0.003 to 0.016 SOL a day for each coin that starts Entanglement. Top the wallet up every few days with what the next week needs rather than depositing the whole month at once: the wallet balance is what a leaked key loses at once, while rent already spent sits in the epoch accounts.

Post-graduation pulses no longer cost the keeper the 0.00204 SOL (2,039,280 lamports) rent of the well's WSOL account: PumpSwap's fee collection creates that account at the keeper's expense, and `pulse` refunds the rent to its `rent_payer` (the keeper) when it closes the account.

### What a leaked keeper key can do

The keeper key cannot change the config, pause the program, cancel epochs, or withdraw a well's SOL or locked tokens. Someone holding it can:

- spend the keeper wallet's SOL, and collect the rent of epochs the key posted as they close;
- post an Entanglement epoch for any Quantum coin whose merkle root pays themselves, up to that coin's whole holder reserve, at most once per coin every 20 hours. Nobody can claim it before its `claim_start`, so cancel it with `cancel_epoch` within the claim delay and the SOL goes back to the reserve. That only helps if someone acts: the keeper flags such epochs (see [Keeper alerts](#keeper-alerts)), so check for epochs your keeper did not post more often than the claim delay, and pick a claim delay you can keep up with;
- run burns and Fusion deposits without waiting for the grace period and without the limits that apply to everyone else, including wrapping them in their own trades (a sandwich), up to `max_burn_lamports` of a well's SOL per coin every `min_action_interval`. A modest `max_burn_lamports` limits this.

For comparison, anyone else may run a burn or Fusion only after `keeper_grace` without a keeper run (for Fusion, counted from the later of the last Fusion and the coin's graduation), at most `max_burn_lamports / 10` per action. Such a transaction must call the program at the top level and may contain only compute-budget, System, token, associated-token and Quantum Hooks instructions, plus pump.fun's or PumpSwap's volume-accumulator setup. See the trust model in `docs/QUANTUM_HOOKS_SPEC.md`.

### Rotating the keeper key

Rotate at once if the key may have leaked, and otherwise from time to time:

1. Create a new keypair and fund it.
2. Call `update_config` with `keeper` set to the new public key, signed by the authority (`program-ops.mjs --keeper <new public key>`). From then on the program refuses the old key for keeper-only actions.
3. Replace `QUANTPAD_KEEPER_SECRET` with the new secret (Production only) and redeploy. Until then the running keeper's transactions fail, which costs nothing but time.
4. Cancel any epoch the old key posted that your keeper did not post, before its `claim_start`: the new keeper's `foreign-epoch` alerts name them (it shares the old keeper's records), and `program-ops.mjs --epochs <mint>` lists a coin's epochs.
5. If the old key did not leak, move its SOL to the new keeper. It keeps receiving the rent of the epochs it posted as they close over the next 30 days, so sweep it again after that. If it leaked, count that SOL as lost.

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
(one subscriber's range). Every IPv6 /48 also shares 8 times each per-visitor limit (the daily upload
and pin budgets included), so a host with a routed /56 or /48 (a home connection, a tunnel broker)
cannot multiply its budget by rotating through its /64s. Self-hosted servers behind a proxy need
`QUANTPAD_TRUST_PROXY` (see below). Over a limit, the API answers 429.

With Redis, each instance counts in memory and adds its count to Redis once it holds a tenth of a
limit (one command), so ordinary visitors cost no Redis commands for rate limiting, and a visitor
spread over several instances can exceed a limit by up to a tenth per instance. When Redis fails,
limits go on with each instance's own count instead of refusing requests, so `/api/rpc` keeps
working; reads of stored data answer 503 `STORAGE_UNAVAILABLE`, and `/api/status` reports
`storage.healthy: false` with a `reason` (`quota-requests`, `quota-bandwidth`, `auth`, `timeout`,
...). The function logs the same reason as `[storage] Redis command failed: <reason>`.

| Route                                                                                                     | Limit per visitor                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/rpc`                                                                                           | 900 calls per minute, 1 to 25 per request. `getMultipleAccounts` counts each account (at most 100), and every full MiB of response counts as one more call. Responses over 16 MiB are refused.                                                                                                                                                                                                                                      |
| `GET /api/market`, `/api/coins`, `/api/stats`, `/api/coins/:mint` (with `/trades` and `/candles`)         | 300 per minute together. A request that has to read stored data, rather than a copy the server read for someone in the last few seconds, also counts against 60 per minute. Successful answers carry `Cache-Control: public, max-age=0, s-maxage=5, stale-while-revalidate=10`, so a CDN answers repeats for a few seconds (and those do not count).                                                                                |
| All other `POST` routes (`/api/media`, `/api/metadata`, `/api/launches`, `/api/coins/track`, `/api/sync`) | 30 per minute together                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/launches`                                                                                      | also 10 per minute                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/coins/track`                                                                                   | also 10 per minute. Tracking a coin the server does not know yet costs about 45 RPC calls, so with `QUANTPAD_RPC_GLOBAL_PER_MIN` set such a request also counts 45 calls against that shared budget, and past it gets 429.                                                                                                                                                                                                          |
| `POST /api/sync`                                                                                          | also 12 per minute. Each mint syncs at most once per 10 s; a request inside that window gets the stored record and one follow-up sync is queued. A full pass runs at most once per 10 s for everyone. Only coins already tracked are synced. With `QUANTPAD_RPC_GLOBAL_PER_MIN` set, each coin sync that runs counts 45 calls against it; past it the stored record is answered and a later sync or the background pass catches up. |
| `GET /api/quantum/:mint`                                                                                  | 60 per minute                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/quantum/:mint/claims`                                                                           | 30 per minute                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/media`, `POST /api/metadata`                                                                   | `QUANTPAD_MEDIA_CLIENT_MB` per day (default 16 MB). Each upload is charged at least 128 KB. Over it: 429 with `code: MEDIA_QUOTA`.                                                                                                                                                                                                                                                                                                  |
| `POST /api/metadata` with `PINATA_JWT` set                                                                | `QUANTPAD_PIN_CLIENT_DAILY` new IPFS pins per day (default 24, two per launch). Over it: 429 with `code: MEDIA_QUOTA`. The whole deployment may also create only `QUANTPAD_PIN_DAILY` new pins per day (default 400). Past that, everyone gets 429 with `code: PIN_QUOTA` until the next day (UTC).                                                                                                                                 |

Vercel's CDN caches the public `GET` answers above for 5 seconds and the files under `/media/` and
`/m/` (named by their content hash) for a year, from the `Cache-Control` headers the API sends;
`vercel.json` needs nothing for this. Errors are never cached.

Settings:

- `QUANTPAD_MEDIA_LIMIT_MB` (default 256): total storage for uploaded artwork and metadata, shared by
  everyone. On Redis it counts the stored size, about 4/3 of the file size (base64). Uploaded artwork
  and the metadata documents this server issues stay pending for 24 hours. They are kept for good only
  once a launch with that metadata URI registers (`POST /api/launches`), or once a coin created with
  that URI is first read (for example a launch whose tab closed before it registered). Abandoned
  uploads and documents expire and free their space.
- `QUANTPAD_MEDIA_CLIENT_MB` (default 16): each visitor's daily upload budget, as in the table.
- `PINATA_JWT`: when set, nothing is pinned at upload time. `/api/metadata` pins the artwork it
  references and the metadata document (two files on your Pinata plan per launch), and a file that
  was pinned before is reused instead of pinned again. Abandoned uploads never reach Pinata.
- `QUANTPAD_PIN_CLIENT_DAILY` (default 24): new pins each visitor may create per day, as in the table.
- `QUANTPAD_PIN_DAILY` (default 400): new pins the whole deployment may create per day, so abuse from
  many addresses pauses pinning for the day instead of using up your Pinata plan. Set it below what
  your plan allows per day.
- `QUANTPAD_RPC_GLOBAL_PER_MIN` (unset by default): an RPC budget shared by all visitors, in calls per
  minute. `POST /api/rpc` counts against it like the per-visitor limit. Tracking a coin the server
  does not know yet (`POST /api/coins/track`) and each coin sync a visitor starts (`POST /api/sync`)
  count 45 calls, an estimate of what the indexer reads for them. Set it below your provider plan's
  rate, leaving room for the indexer's background passes and the keeper (which it does not cover), so
  many visitors (or many addresses) cannot use up the plan. Past it, `/api/rpc` and new tracks get
  429 and syncs wait, until the next minute. On Vercel you can also add Firewall rate-limit rules for
  `/api/rpc` and `/api/coins/track`.
- `QUANTPAD_RPC_BATCH` (default 10): `getTransaction` calls per indexer batch request. The indexer
  drops to single requests by itself when a provider refuses batches.
- `QUANTPAD_INDEX_BATCH` (default 40): transactions read per address per indexing pass.
- `QUANTPAD_SYNC_MS`: time budget of one indexing pass, default 15 000 ms on Vercel and 40 000 ms
  elsewhere. The pass's lease lasts this long plus 45 s. On Vercel the request, the index pass and the
  keeper share the function's 60 s: the background pass after a response gets what the request left
  (it is skipped under 10 s), so keep this well under 60 s.
- `QUANTPAD_BACKGROUND_SYNC_MS` (default 60 000 on Vercel, `0` turns it off): with Redis, the
  request-driven index passes run at most once per this many ms across all instances. A pass costs
  about 15 Redis commands per coin it syncs, and Upstash plans are billed or capped by commands
  (the free plan stops answering after 500K a month). The keeper cron indexes on its own schedule,
  and a trade made in the app syncs its coin at once.
- `QUANTPAD_MAX_LAUNCHES` (default 2 000): the most native Quant Pad launches kept in the coin list.
  Hidden mints (`QUANTPAD_HIDDEN_MINTS`) do not count. At the cap, up to 10 stale launches are evicted
  to make room: launches that are not Quantum, were created on-chain more than 7 days ago, and in the
  last 7 days had no trade or less than 1 SOL of volume. Only when none can go does `/api/launches`
  answer 429 (`launch_cap`). Each metadata URI this server issues registers one coin, the first launch
  made with it, so one upload cannot fill the list. Quantum coins are never evicted (the keeper finds
  the coins it serves in this list); each costs its launcher an on-chain registration plus the
  pump.fun create, so filling the cap with them costs tens of SOL. Raise the cap if that ever happens.
- `QUANTPAD_LAUNCHES_PER_WALLET` (default 10, `0` turns it off): native launches one launcher wallet
  may register per UTC day. Over it, `/api/launches` answers 429 (`launch_cap`) and the launcher can
  register the coin the next day. Wallets are free, so this only slows a script that lists junk from
  one wallet; the staleness eviction above is what keeps the cap from filling for good.

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
- Set `QUANTPAD_PUBLIC_URL` to the site's public address as a full `http(s)` URL, or set
  `PINATA_JWT`. Without either, `POST /api/media` and `POST /api/metadata` answer 503 with
  `code: PUBLIC_URL_UNSET`, so nobody can launch from the site. The server no longer builds metadata
  URIs from the request's `Host` header, which any client can choose, so a server that relied on it
  needs the variable now. Only a server reached on `localhost`, `127.0.0.1` or `[::1]` (development)
  issues links under that local address without it. `npm run preview` behaves the same way.
- Behind a proxy, set `QUANTPAD_TRUST_PROXY` to the number of proxies in front of the server (`1` for a
  single Caddy or nginx). Rate limits then key on each visitor's address, taken from the right-hand end
  of `X-Forwarded-For`. Without it, every request comes from the proxy's address and all visitors share
  one rate-limit bucket. Leave it unset when clients connect directly: the header is then ignored,
  because anyone can send it. The proxy must append the client address. Caddy does by default; with
  nginx use `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
- Every response carries the security headers in `server/security-headers.json` (CSP,
  `X-Frame-Options`, `Cross-Origin-Opener-Policy: same-origin` and others). When the visitor came over
  https, the server adds `Strict-Transport-Security: max-age=63072000`: on a TLS socket, or behind
  `QUANTPAD_TRUST_PROXY` when `X-Forwarded-Proto` is `https`. The proxy must set that header (Caddy
  does; with nginx use `proxy_set_header X-Forwarded-Proto $scheme;`) and must pass the response
  header through. To add `includeSubDomains` or `preload`, which only you can decide for your domain,
  set the whole header at the proxy instead: Caddy's `header` directive replaces it, and with nginx
  use `proxy_hide_header Strict-Transport-Security;` together with your own `add_header ... always;`.
- Hashed files under `/assets/` are served with a one-year immutable `Cache-Control`. Everything else
  revalidates by ETag. Text responses, and API JSON of 1 KB or more, are brotli or gzip compressed
  (with `Vary: Accept-Encoding`).
- `npm run preview` serves a build the same way (API and security headers) for a local check.

The development server (`npm run dev`) listens on `127.0.0.1:5173` only. It serves files from the
repository root, which holds the program's deploy keypair and local data, so never expose it: pass
`--host` only on a network you trust (for example to test from a phone), and use `npm start` behind a
TLS proxy for anything public.

## Smoke test before announcing

1. Do a standard launch with a 0.01 SOL dev buy. It should appear in the market within seconds and on pump.fun.
2. Buy and sell from a second wallet. Confirm the trades, chart and platform fee transfer.
3. Do a Quantum launch with all four modules and a lock. Trade until at least 0.001 SOL of creator fees is waiting (the button stays off below that, since the program would refuse the pulse), then press **Pulse fees now**. Confirm the reserves and creator payout on Solscan.
4. Wait for the keeper to run a burn and an Entanglement epoch. The coin page shows when claims open (after the claim delay, 6 hours by default); then claim from a holder wallet.
5. Release vested tokens from the launcher wallet after the cliff (use a short cliff for the test coin).
