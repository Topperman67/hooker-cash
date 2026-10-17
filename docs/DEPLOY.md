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

A Quantum launch's main transaction (the DBC create, the creator hand-off to the well, `sync` and
the dev buy) references 22 accounts, or 23 with the platform fee, at 32 bytes each. It comes to
about 1 120 to 1 250 bytes depending on the coin's name, ticker and metadata URI: close to Solana's
limit of 1 232 bytes, and over it with a long name or URI. The lookup table holds the accounts every
launch shares (Meteora's DBC accounts, Quant Pad's DBC launch configs, the token programs and
sysvars, and Quantum Hooks' config), so most of them cost one byte instead of 32, which takes about
150 bytes off every launch:

```bash
node scripts/create-lookup-table.mjs --keypair path/to/operator.json --rpc "$QUANTPAD_RPC_URL" \
  --config <DBC config>,<DBC config>,...
```

`--config` takes the launch configs, comma-separated: the `config` of each tier in `launchTiers` (`shared/network.mjs`). Without it the script uses `QUANTPAD_DBC_CONFIG`. Set the printed `QUANTPAD_LOOKUP_TABLE` and redeploy. Rerun with `--table <address>` to add a new launch config or other new static accounts; it adds only the addresses the table lacks. `QUANTPAD_LOOKUP_TABLE` is required for any launch with a dev buy, standard or Quantum: the DBC create and the dev buy always go in one transaction, which the table keeps under the limit, and the launch page refuses a dev buy when no table is configured. Launches without a dev buy still work without it.

## 3. Quantum Hooks program (**wallet**)

1. Build and test: `npm run program:test`. The tests run against Meteora's DBC and DAMM v2 programs dumped from mainnet onto a local validator. They do not need the program keypair.
2. Restore the program keypair. `programs/quantum-hooks/target/deploy/quantum_hooks-keypair.json` is gitignored and determines the program address baked into `declare_id!`, `Anchor.toml` and `shared/idl/quantum_hooks.json`. Keep a backup offline. Before `npm run program:build` or a deploy, restore the backed-up file to that path: `build` and `keys` stop with an error when it is missing or does not match `declare_id!`, and never generate a new id on their own. `QUANTPAD_NEW_PROGRAM_ID=1` deliberately creates a new program id (it rewrites `declare_id!`, `Anchor.toml` and the IDL). Never set it for the production program.
3. Build with `npm run program:build`, then deploy with the Anchor image and your deployer keypair (rent for the program data is roughly 3–5 SOL):
   `anchor deploy --provider.cluster mainnet --provider.wallet <deployer.json>` (see `programs/quantum-hooks/README.md`).

   **Deploy the program and the web app together.** The program, `shared/idl/quantum_hooks.json` and `shared/quantum.mjs` must match: the client builds each instruction's accounts and arguments from that IDL (the Meteora version added `harvest` and `sync`, and changed `pulse`, `quantum_burn` and `fusion`), so an older web app or keeper fails against the upgraded program, and the other way round. When you upgrade a deployed program, redeploy the web app (which also runs the keeper) from the same commit straight after the program upgrade lands.

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

- **Claim delay.** Every Entanglement epoch opens for claims at `claim_start`, which is `claim_delay` seconds after it was posted. Until then the coin page shows "Claims open in …" and the keeper offers no claims. Pick a delay longer than the time you need to notice a wrong epoch and cancel it. A longer delay also holds back every holder's payout by that much. The program accepts at most one epoch per coin every 20 hours. The keeper posts about once a day, splitting the holder reserve by each wallet's average balance since the previous epoch (see [Holder sampling](#holder-sampling)).
- **`cancel_epoch`** (`buildCancelEpochInstruction({ connection, authority, mint, index, programId })`) works only before the epoch's `claim_start`. It returns the epoch's SOL to the coin's holder reserve, closes the epoch account, sends its rent to the configured keeper and emits `EpochCancelled`. Use it for an epoch your keeper did not post, or one with wrong weights or a wrong total. The keeper flags the first kind for you (see [Keeper alerts](#keeper-alerts)); `program-ops.mjs --epochs <mint>` lists a coin's epochs with their `claim_start`, and `GET /api/quantum/<mint>` lists the ones your keeper recorded. An index the keeper has no record of, or whose root differs from its record, was not posted by your keeper.
- **`set_paused`** (`buildSetPausedInstruction({ connection, authority, paused, programId })`) pauses or resumes the program. A pause stops new Quantum registrations and everything that spends a well's SOL on Meteora: Quantum burns and Fusion. Harvests, pulses, claims, epoch closes, epoch cancels and token releases keep working, so nobody's funds are frozen (see `docs/QUANTUM_HOOKS_SPEC.md`). `/api/status` reports `quantum.available: false` with reason `paused`. `update_config` no longer changes the pause flag.
- **`update_config`** (`buildUpdateConfigInstruction({ ..., expectedVersion })`) changes the treasury, keeper, protocol share, burn cap, intervals, grace period, claim delay or authority. Every config change, including a pause, increments the config's `version`, and an update built against an older version fails with `ConfigChanged`. So an update prepared before a pause cannot undo it: re-read the config and rebuild the update after any other change. When `expectedVersion` is left out, the builder reads the current version when it builds the instruction.

## 4. Keeper

The keeper is a hot wallet. Its secret sits in the server's environment, and on Vercel in the same function that answers every anonymous request and loads the whole SDK dependency tree. Treat the key as exposed: give it only the SOL it needs soon and know how to replace it.

1. Create a fresh keypair for the keeper. Never reuse the authority, the treasury or a personal wallet. Set `QUANTPAD_KEEPER_SECRET` to it, and pass its public key to `init-config.mjs --keeper`. On Vercel, add the secret to the **Production** environment only, never Preview or Development, because preview deployments run any branch's code.
2. Set `CRON_SECRET` to a random string of at least 16 characters, in Vercel's **Production** environment and as the `CRON_SECRET` repository secret on GitHub (Settings → Secrets and variables → Actions). Two schedulers call `GET /api/keeper/tick` with `Authorization: Bearer <CRON_SECRET>`:
   - **Vercel Cron**, from `crons` in `vercel.json`: one daily cron for each hour of the day. Vercel sends the header itself, and calls the production deployment only. Hobby runs each cron at most once a day (an hourly expression such as `0 * * * *` fails the deploy) and starts it anywhere within its hour; Pro starts it within its minute. On Pro you can replace the 24 entries with one `*/5 * * * *` for the keeper's 5-minute pace. Vercel does not retry a failed call, and its log of a call shows only the HTTP status, which is 200 even when a step failed. The project's **Cron Jobs** settings list the crons and link to their logs.
   - **GitHub Actions** (`.github/workflows/keeper-cron.yml`), scheduled every 5 minutes, as the backup and for the keeper's pace. GitHub starts scheduled runs late or drops them: on this repository it has started this one only every 2 to 5 hours. It also turns a schedule off after 60 days without repository activity, so it is not enough alone. The repository is public, so a run prints only a summary of the response: the tick's HTTP status, each step's outcome and the payout engine's transactions. A step that failed is a warning on the run's summary page. The run fails, and GitHub emails whoever last changed the schedule in that file, when the payout engine could not send a transaction or the keeper raises a `foreign-epoch` alert. It never retries a call: a call that timed out may still have sent payouts, and the next run is the retry.

   Any other scheduler works too, with the same header, every 5 to 15 minutes. Point it at a URL that answers without a redirect (a bare domain often redirects to `www`): a redirect drops the header. Extra calls are harmless: the payout engine claims each hour on-chain before it pays anything, so with the store down too the chain decides whether an hour has run (see [$QUANTP payout engine](#quantp-payout-engine)), and the keeper's on-chain actions have their own minimum intervals. A call that does not come from Vercel Cron runs the payout engine only from minute 15 of the hour, so it covers an hour whose Vercel cron did not run instead of racing it. The app also runs a throttled keeper pass during normal traffic.

3. Fund it as described below, top it up regularly, and watch its balance. A keeper that runs dry stops pulses, burns, Fusion and epochs until it is refilled.

Optionally, keep the key out of the public function altogether: leave `QUANTPAD_KEEPER_SECRET` unset on Vercel and run the keeper as a private `npm start` process (bound to `127.0.0.1`, not reachable from the internet) with the same Redis database and `QUANTPAD_STORAGE_PREFIX`. The public deployment still serves epochs and claims from the shared storage.

### Keeper alerts

Each keeper run logs what needs you, and `GET /api/keeper/tick` also returns it as `keeper.alerts`:

- `foreign-epoch`: `epoch <mint>#<index> was not posted by this keeper; cancel it with cancel_epoch before <time>`. An on-chain epoch that the keeper has no record of, or whose root differs from its record, while it can still be cancelled. Cancel it with `program-ops.mjs --cancel-epoch` before that time, then rotate the keeper key (below): someone else holds it.
- `low-balance`: the keeper wallet holds less than 0.01 SOL per Quantum coin it serves (about a mid-sized epoch's rent plus a day of fees each). Top it up.
- `holdtime-stalled`: `holdtime <mint>: no holder sample since <time>; Entanglement cannot post without them` (or `no holder sample yet`). An Entanglement coin with a reserve to pay has had no holder sample for 3 hours, or has never had one because its scans keep timing out, so its next epoch cannot be built (see [Holder sampling](#holder-sampling)). The log lines before it name the failing scan; check your RPC provider's `getProgramAccounts` limits.

The keeper works through its coins a few per run, in rotation, so these appear only while the cron (or traffic) keeps it running. Log drains, which could forward these lines to an alert (for example on `was not posted by this keeper`), need a paid Vercel plan, and Hobby keeps function logs only briefly. On Hobby, a `foreign-epoch` alert reaches you in two ways: the GitHub workflow fails its run (and GitHub emails you) when its tick returns one, and `QUANTP_ALERT_WEBHOOK`, when set, posts it to a channel from any tick, Vercel Cron's included (see [Monitoring and alerts](#monitoring-and-alerts)). GitHub runs the workflow only every few hours, so set the webhook, pick a claim delay longer than that gap, and look at the channel more often than the claim delay. `low-balance` and `holdtime-stalled` appear only in the function logs and as warnings on the workflow's runs.

### Holder sampling

Entanglement pays by holding time, so the keeper samples each Entanglement coin's holder balances with one `getProgramAccounts` call about every 10 minutes, about 144 calls a day per active coin. A coin whose balances stop changing is sampled less often, down to every 50 minutes (about 29 calls a day). `getProgramAccounts` is one of the heavier RPC calls and some providers limit it or bill it at a higher rate, so check your plan before many coins use Entanglement. `QUANTPAD_RPC_GLOBAL_PER_MIN` does not count these calls. Sampling also uses Redis commands and bandwidth (see the storage sizing note under [Limits and tuning](#7-limits-and-tuning)).

Each keeper run samples at most 16 coins, oldest first, within a quarter of its time budget. With the 5-minute cron that is about 4 600 samples a day, so the 10-minute pace holds for about 30 active Entanglement coins. With more, each coin is sampled less often (about hourly at 200 coins): its anti-gaming resolution drops to that interval, and its 12 hours of samples take longer to gather.

Each scan is given up after 8 seconds, or sooner when the run's quarter is spent, and a rate-limited one fails at once instead of being retried. A coin whose scan takes the full 8 seconds is left out of that quick pass: the keeper samples it on the coin's own turn in the run, allowing up to 30 seconds, at most every 50 minutes, until its scans are fast again. If none succeeds for 3 hours the keeper raises `holdtime-stalled` (see [Keeper alerts](#keeper-alerts)).

Samples are taken only while the keeper runs, so keep the 5-minute cron going: a gap between samples is credited for at most an hour. An epoch needs 12 hours of samples, so each new coin's first epoch waits for them, and so does every coin's next epoch right after you first deploy a sampling keeper. If epochs land that the holding window did not pay for (for example while an older keeper version ran on the same storage), the window starts over from the next sample, so that time is not paid twice.

### Keeper SOL

**Fees.** Each pulse, burn, Fusion deposit, epoch post and epoch close is one transaction: 5 000 lamports per signature plus a priority fee.

**One-time rent per coin, never refunded.** The first harvest, burn or Fusion deposit of a coin, whichever comes first, creates the well's token account for the coin at the keeper's expense: 2,039,280 lamports, about 0.002 SOL over the life of each Quantum coin. The well's WSOL account costs the keeper nothing: `harvest` creates it to receive the fees and refunds its rent to the caller when it closes it in the same instruction, and burns and Fusion wrap the well's own SOL in it, so the well pays and recovers that rent. Fusion adds to the position the well already owns, so it creates no LP account.

**Epoch rent held for the claim window.** Each Entanglement epoch is an account that costs about 0.002 SOL for a coin with a few holders and up to about 0.016 SOL at 16,384 holders (one bit per holder). Its rent comes back to the keeper that posted it only when the epoch is closed, after the 30-day claim window (a cancelled epoch refunds at once). With one epoch per coin a day, each coin with active Entanglement holds about 30 epochs at a time: roughly 0.06 SOL for a small coin and up to 0.5 SOL for one with 16,384 holders. Nothing is refunded during the first 30 days, so the need grows over the first month and then levels off.

**Sizing.** For example, 10 Quantum coins, 5 of them with Entanglement epochs of about 1,000 holders (about 0.003 SOL each): 10 × 0.002 + 5 × 30 × 0.003 ≈ 0.47 SOL over the first month, plus fees. Add 0.002 SOL for each new Quantum coin and 0.003 to 0.016 SOL a day for each coin that starts Entanglement. Top the wallet up every few days with what the next week needs rather than depositing the whole month at once: the wallet balance is what a leaked key loses at once, while rent already spent sits in the epoch accounts.

### What a leaked keeper key can do

The keeper key cannot change the config, pause the program, cancel epochs, or withdraw a well's SOL or locked tokens. Someone holding it can:

- spend the keeper wallet's SOL, and collect the rent of epochs the key posted as they close;
- post an Entanglement epoch for any Quantum coin whose merkle root pays themselves, up to that coin's whole holder reserve, at most once per coin every 20 hours. Nobody can claim it before its `claim_start`, so cancel it with `cancel_epoch` within the claim delay and the SOL goes back to the reserve. That only helps if someone acts: the keeper flags such epochs (see [Keeper alerts](#keeper-alerts)), so check for epochs your keeper did not post more often than the claim delay, and pick a claim delay you can keep up with;
- run burns and Fusion deposits without waiting for the grace period and without the limits that apply to everyone else, including wrapping them in their own trades (a sandwich), up to `max_burn_lamports` of a well's SOL per coin every `min_action_interval`. A modest `max_burn_lamports` limits this.

For comparison, anyone else may run a burn or Fusion only after `keeper_grace` without a keeper run (for Fusion, counted from the later of the last Fusion and the coin's migration to DAMM v2), at most `max_burn_lamports / 10` per action. Such a transaction must call the program at the top level and may contain only compute-budget, System, SPL Token, Token-2022, associated-token and Quantum Hooks instructions: no Meteora instruction at all, so nothing in it can trade. See the trust model in `docs/QUANTUM_HOOKS_SPEC.md`.

### Rotating the keeper key

Rotate at once if the key may have leaked, and otherwise from time to time:

1. Create a new keypair and fund it.
2. Call `update_config` with `keeper` set to the new public key, signed by the authority (`program-ops.mjs --keeper <new public key>`). From then on the program refuses the old key for keeper-only actions.
3. Replace `QUANTPAD_KEEPER_SECRET` with the new secret (Production only) and redeploy. Until then the running keeper's transactions fail, which costs nothing but time.
4. Cancel any epoch the old key posted that your keeper did not post, before its `claim_start`: the new keeper's `foreign-epoch` alerts name them (it shares the old keeper's records), and `program-ops.mjs --epochs <mint>` lists a coin's epochs.
5. If the old key did not leak, move its SOL to the new keeper. It keeps receiving the rent of the epochs it posted as they close over the next 30 days, so sweep it again after that. If it leaked, count that SOL as lost.

### $QUANTP payout engine

`server/quantp-engine.mjs` pays $QUANTP holders and buys back and burns $QUANTP automatically, from the keeper tick, once in each clock hour (UTC). It pays out whatever SOL the team puts in its wallet; nothing on-chain makes the team fund it. Its rules live in `QUANTP.engine` in `shared/network.mjs`:

- Each run releases a 24th of the market cap tier's daily rate of what the engine wallet holds at that moment: 20% a day below $100k, 50% up to $1M, 100% above (`tiers`). Each run takes its slice of what the last one left, so a balance nobody tops up pays out about 18%, 40% or 64% of itself over a day, not the whole rate. The SOL trickles out, faster as the market cap grows. It keeps `reserveLamports` (0.02 SOL) for fees and releases at most `maxRunLamports` (1 SOL) in one run.
- 60% of a release (`QUANTP.holdersShareBps`) goes to the wallets holding at least `minHoldBps` (0.15%) of the current supply at that moment, in proportion to their balances, in SOL transfers of up to 18 per transaction. Only wallets are paid: an owner on the ed25519 curve whose account is missing or a plain system account (no data, not a program). Pool vaults (owned by program addresses), Solana's reserved addresses (the System Program, sysvars and builtin programs), the team's wallets and the incinerator are never paid. A share under `minTransferLamports` (0.00002 SOL), or too small for an empty wallet's rent, is skipped that run: its SOL stays in the engine wallet for later runs, and the holder is not owed it.
- The other 40% buys $QUANTP in its DAMM v2 pool and burns it in the same transaction (`slippageBps` 3%), together with any $QUANTP the wallet already holds. **The first run therefore burns everything the wallet holds**, such as the payout wallet's earlier buybacks. A buyback under `minBuybackLamports` (0.002 SOL) is skipped that run, and its SOL stays in the wallet.
- Every transaction is public on-chain and ends with a memo that starts `qp-engine:v1 h=<hour>` (the hour, counted in hours since 1 January 1970 UTC). The site's Payouts & burns panel lists them, and `GET /api/quantp/engine` shows the engine's state: whether it is live, its tier, how many wallets are eligible, and what the next run would release.

To turn it on:

1. Pick the wallet. `QUANTP.engine.wallet` pins its public address in the code: the engine refuses any other key. It is the payout wallet now. Keep nothing in it that the engine should not pay out or burn.
2. Set `QUANTP_ENGINE_SECRET` to that wallet's secret key (base58, or a JSON byte array as Solana CLI keypair files hold it) in Vercel's **Production** environment only, never Preview or Development. Like the keeper's, the key sits in the public function: treat it as exposed, and keep only what the engine should pay out in the wallet. Never commit it or paste it anywhere else, including chat. Set `QUANTP_ALERT_WEBHOOK` too (see [Monitoring and alerts](#monitoring-and-alerts)).
3. Make sure the keeper tick runs (`CRON_SECRET` and the schedulers in step 2 of [Keeper](#4-keeper)), and redeploy. The engine runs at the first tick in each clock hour (UTC) that finds the hour unclaimed, and skips the rest of that hour, so the hourly Vercel crons run it every hour on any plan, even though Hobby starts each one anywhere within its hour. On Hobby two runs can therefore be a minute or almost two hours apart, and a day has at most 24. A tick that does not come from Vercel Cron (GitHub's backup, another scheduler, a call by hand) runs the engine only from minute 15 of the hour (before that the engine reports `backup-window`), so it covers an hour whose Vercel cron did not come or failed before sending anything. An hour that no tick covers is skipped: nothing is paid for it, and its SOL stays in the wallet for later runs. Extra calls are harmless: each hour is claimed on-chain before any payout (below).
4. Fund the wallet with the SOL to pay out, for example the creator fees you claim. The engine splits whatever it holds.
5. Check `GET /api/quantp/engine`: `live: true`, the eligible count and the next release. After the next run, check that its transactions landed (see [Monitoring and alerts](#monitoring-and-alerts)).

`reason` in `/api/quantp/engine` says why it is not live: `unpinned` (no wallet in the code), `no-key`, `bad-key` (the secret could not be read), `key-mismatch` (the key is not the pinned wallet's) or `paused`.

#### One run per hour

The engine never runs twice in one hour, whether or not the store answers:

1. It first checks the store's record of the last run (`quantp:engine:last`) and its own instance's memory. Either one in this hour ends the tick (`not-due`) at no cost.
2. Otherwise it reads the engine wallet's 25 newest transactions from the chain, without any cache. One in this hour that the engine wallet paid the fee for means the hour has run, unless its memo names an earlier hour (a run that started just before the hour turned). A stranger's dust, which the wallet does not sign, never counts. When that read fails, it does not run (`unverified`) and the next tick tries again; when the hour has more transactions than it reads, the claim below decides.
3. The store's lock (`quantp:engine:lock`) keeps two instances from planning at once, and the engine reads the record again after taking it.
4. Before its first payout, the run claims the hour on-chain: one transaction creates an empty marker account at an address only the engine key can derive from the hour, with the memo `qp-engine:v1 h=<hour> claim`. Only one transaction can create that account, so another run in the same hour, on any instance, fails to create it and stops (`locked`) before paying anything. A claim that fails for any other reason skips the hour (`stopped: claim failed`) rather than risk a repeat. The claim costs a transaction fee and holds the account's rent (about 0.0009 SOL) until a later run reclaims it into the wallet.

A claimed hour is never run again, even if its run failed part way: what it did not send stays in the wallet for later hours. Within a run, a payout batch refused because of one recipient is resent once without it (`skipped`), any other failed batch is recorded (`failed`) while the rest still go out, and the buyback is tried whatever happened to the payouts, within the run's 25-second budget (`stopped: time limit before buyback` when it runs out). The site's ledger plays no part in this decision.

#### Monitoring and alerts

Vercel Cron starts most runs, and nothing reads its responses, so watch the engine from outside:

- `GET /api/quantp/engine/health` answers 200 `{ ok: true, lastPaidAt, lastBurnAt }` while the engine is paying, and 503 `{ ok: false, reason }` otherwise: `not-live` (paused, or no usable key), `late` (it has holders to pay, but its newest payout on-chain is more than 2 h 15 min old), `buyback-failing` (it has a buyback to make, but its newest burn is more than 3 h old) or `unknown` (its state could not be read, or the history that would tell is still loading). It reads on-chain history, not the store, and answers are cached for a minute. Point a free uptime monitor (UptimeRobot, Better Stack and the like) at it and have it email or text you on any status but 200.
- `QUANTP_ALERT_WEBHOOK` (Production, optional): an incoming-webhook URL, for example a Discord channel's webhook. Every tick that ends with an engine error, a run that stopped early, or a `foreign-epoch` keeper alert posts one line to it. Each reason is posted at most once an hour from each server instance, so an outage does not post every tick. Anyone with the URL can post to the channel: keep it out of the repository.
- The GitHub workflow fails its run (GitHub then emails whoever last changed the schedule in `.github/workflows/keeper-cron.yml`) when the engine could not send a transaction or the keeper raised a `foreign-epoch` alert. It sees only its own ticks, every few hours.
- Logs: the function logs a `[tick]` line with every step's error whenever a tick has a failed step or the engine stopped early, and `[quantp-engine]` lines with full send errors, which the public responses leave out. Hobby keeps function logs only briefly, and log drains need a paid plan.

To see what a run did, use `GET /api/quantp/ledger` (or the site's Payouts & burns panel), a GitHub run's "Payout engine" notice, or the health check above. Calling `GET /api/keeper/tick` by hand is not a status check: from minute 15 on, it runs the engine if this hour has not run yet, and it runs the index pass and the keeper too.

#### When something goes wrong

1. **Stop it.** Set `QUANTP_ENGINE_PAUSED=1` in Vercel's Production environment and redeploy (an environment change reaches only new deployments). `/api/quantp/engine` then reports `reason: paused`, and the health check answers 503 `not-live`. Removing `QUANTP_ENGINE_SECRET`, or moving the SOL out of the wallet, also stops it. If the key may have leaked, move the wallet's SOL and tokens to a new wallet at once, pin the new address in `QUANTP.engine.wallet`, and set its key.
2. **Find what happened.** The **Runs** tab of the site's Payouts & burns panel shows each hour with its payouts, buyback and burn. An hour marked `repeated` has two or more payout bursts, which the hour claim should make impossible: compare their memos (`h=<hour>`) and fee payers on Solscan, and keep the engine paused until you know why. The run's reason is in the alert channel, the GitHub notice or the health check, and the full error in the function's `[quantp-engine]` log lines.
3. **Start it again.** Remove `QUANTP_ENGINE_PAUSED` (or set it to anything but `1`) and redeploy. The engine runs at the next tick in an unclaimed hour. Hours missed while it was stopped are not made up: their SOL stays in the wallet and goes out in later runs.

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
pages. They remain on-chain and on Meteora.

A coin the server did not see launched through Quant Pad (a test launch by script, say) is
external: it opens at `/coin/<mint>`, but the home page, the market's default list, the tape and
`/api/stats` leave it out, and only the market's Tracked filter lists it. Add such mints to
`QUANTPAD_LISTED_MINTS` (comma-separated) to show them there too. The background pass tracks a
listed mint nobody has opened yet (about 45 RPC calls, once), and listed coins never drop out at
the 400-coin cap on external coins. Their pages still say they launched outside Quant Pad. A mint
in both lists stays hidden. Redeploy after changing either list.

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
  DBC pool's creation, so filling the cap with them costs tens of SOL. Raise the cap if that ever happens.
- `QUANTPAD_LAUNCHES_PER_WALLET` (default 10, `0` turns it off): native launches one launcher wallet
  may register per UTC day. Over it, `/api/launches` answers 429 (`launch_cap`) and the launcher can
  register the coin the next day. Wallets are free, so this only slows a script that lists junk from
  one wallet; the staleness eviction above is what keeps the cap from filling for good.

Storage sizing: each open Entanglement epoch keeps its leaves with their merkle proofs so claims are
cheap to serve, about 11 MB for a full epoch of 16 384 holders (less for smaller coins). Epochs stay
in storage for the 30-day claim window plus 2 days. Size the Redis plan for the number of busy Quantum
coins you expect: for example, 20 coins with full epochs need roughly 220 MB.

Each Entanglement coin also keeps its holder records for [holder sampling](#holder-sampling), about
150 bytes per holder (every bucket of 256 holders is kept twice, so an interrupted sample can be
redone): about 2.4 MB at 16 384 holders and 4.8 MB at 32 768, the most the keeper follows. A sample
that finds no balance changed costs 2 commands. Otherwise it reads and rewrites each bucket where a
balance moved: a busy coin with 16 384 holders and 50 to 300 changes a sample uses about 70 to 130
commands and moves 0.6 to 1.2 MB each way, about 10 000 to 19 000 commands and 180 to 350 MB a day;
at 32 768 holders, up to about 260 commands and 2.4 MB each way a sample. Each epoch post also reads
every bucket once. A bucket holds at most 4 096 records (about 430 KB), however many wallets land
in it. Check the plan's command, bandwidth and request-size limits against the busy Entanglement
coins you expect.

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

1. Do a standard launch with a 0.01 SOL dev buy. It should appear in the market within seconds, and its DBC pool on Meteora.
2. Buy and sell from a second wallet. Confirm the trades, chart and platform fee transfer.
3. Do a Quantum launch with all four modules and a lock. Trade until at least 0.001 SOL of creator fees is waiting (the button stays off below that, since the program would refuse the pulse), then press **Pulse fees now**. Confirm the reserves and creator payout on Solscan.
4. Wait for the keeper to run a burn and an Entanglement epoch. The coin page shows when claims open (after the claim delay, 6 hours by default); then claim from a holder wallet.
5. Release vested tokens from the launcher wallet after the cliff (use a short cliff for the test coin).
