# quantum_hooks (Anchor 0.31.1)

On-chain half of Quant Pad's Quantum Hooks: every Quant Pad coin is a pump.fun coin whose
`creator` is the coin's **well** (a system-owned PDA of this program). Creator fees collected
into the well are routed by immutable per-coin rules: creator share + Superposition splits,
Quantum Burn, Entanglement (merkle epochs), Fusion (locked PumpSwap liquidity) and Time
Dilation (dev-buy vesting). The full spec is [`docs/QUANTUM_HOOKS_SPEC.md`](../../docs/QUANTUM_HOOKS_SPEC.md).

```
programs/quantum-hooks/
  Anchor.toml, Cargo.toml          workspace (program: programs/quantum_hooks)
  programs/quantum_hooks/src/      lib.rs, state.rs, constants.rs, errors.rs, events.rs, utils.rs,
                                   instructions/{config,register,dilation,pulse,burn,entanglement,fusion}.rs
  scripts/in-container.sh          what the Docker wrappers run inside the anchor image
  tests/                           merkle + client unit tests, e2e.test.ts, run-local.mjs
  tests/fixtures/fetch-fixtures.mjs  dumps mainnet pump.fun programs/accounts (read-only RPC)
shared/quantum.mjs                 client (browser + Node), shared/merkle.mjs, shared/idl/quantum_hooks.json
scripts/anchor-docker.ps1 / .sh    Docker wrappers (no Rust/Solana on the host)
```

## Toolchain (Docker only)

Everything runs in `solanafoundation/anchor:v0.31.1`. The wrappers bind-mount the repo at
`/work`, keep Cargo's target dir, registry and git cache plus the Solana platform-tools cache in
named volumes (`quantum-hooks-target`, `quantum-hooks-cargo-registry`, `quantum-hooks-cargo-git`,
`quantum-hooks-solana-cache`; Windows bind mounts are slow) and bind-mount only
`target/{deploy,deploy-test,idl,types}` back to the host. `CARGO_NET_RETRY=10` and
`CARGO_HTTP_TIMEOUT=120` are set for flaky networks.

```powershell
scripts\anchor-docker.ps1 build        # release .so + IDL; copies IDL to shared\idl\quantum_hooks.json
scripts\anchor-docker.ps1 build-test   # same program id, `short-expiry` feature -> target\deploy-test
scripts\anchor-docker.ps1 unit         # Rust unit tests (allow-list, merkle vectors, vesting, bps math)
scripts\anchor-docker.ps1 lock         # re-resolve Cargo.lock for platform-tools' cargo 1.79 (see below)
scripts\anchor-docker.ps1 keys         # checks the program keypair against declare_id!, prints the id
scripts\anchor-docker.ps1 shell        # interactive shell in the toolchain
```

(`scripts/anchor-docker.sh` takes the same commands on Linux/macOS/Git Bash.)

The image's platform-tools v1.43 build with cargo/rustc 1.79, which cannot parse edition-2024
crates. `Cargo.lock` is therefore resolved MSRV-aware (`rust-version = "1.79"`,
`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`), `anchor-lang`/`anchor-spl` are pinned to
`=0.31.1` and `blake3` to 1.5.5. Commit `Cargo.lock`; re-run `lock` only when changing dependencies.

### Program keypair — back it up

The program id (`FgAf…uWK`) is fixed by `declare_id!`, `Anchor.toml` and the `address` in
`shared/idl/quantum_hooks.json`. Its keypair, `programs/quantum-hooks/target/deploy/quantum_hooks-keypair.json`,
is gitignored. **Back this file up** (password manager / offline storage). Losing it means the
program id cannot be deployed to again; leaking it before the first deploy lets someone else take
the id.

In a fresh clone, restore the backup to that path before `build`, `keys` or a deploy. Those
commands stop with an error when the keypair is missing or does not match `declare_id!` and the
IDL; they never generate a new id on their own. `build-test` and `tests/run-local.mjs` do not need
the keypair: the test validator loads the test build at the IDL's address. To start over with a
brand-new program id on purpose (rewrites `declare_id!`, `Anchor.toml` and, on the next `build`,
the IDL), run with `QUANTPAD_NEW_PROGRAM_ID=1` (PowerShell: `$env:QUANTPAD_NEW_PROGRAM_ID = '1'`).

## Tests

```powershell
node programs\quantum-hooks\tests\run-local.mjs            # fixtures (if missing), build-test (if missing), validator, all tests
node programs\quantum-hooks\tests\run-local.mjs --build    # force a fresh test build first
node programs\quantum-hooks\tests\run-local.mjs --keep     # leave the validator running afterwards
node --test programs\quantum-hooks\tests\merkle.test.ts    # offline unit tests (Node >= 23.6 strips TS types)
```

`run-local.mjs`:

1. runs `tests/fixtures/fetch-fixtures.mjs` when fixtures are missing: dumps pump.fun
   (`6EF8…`), PumpSwap (`pAMM…`), pump fees (`pfee…`), mayhem (`MAyh…`), Token-2022 and Metaplex
   from mainnet plus `Global`, fee configs, volume accumulators, PumpSwap `GlobalConfig`, quote
   control, mayhem params, every fee / buyback recipient listed in `Global` / `GlobalConfig` and
   their WSOL ATAs. Read-only `getAccountInfo` calls against `FIXTURE_RPC`
   (default `https://api.mainnet-beta.solana.com`), with back-off. The `.so` dumps (~24 MB) and
   account JSONs are gitignored; `tests/fixtures/manifest.txt` records the slot they came from.
2. builds `target/deploy-test/quantum_hooks.so` with `--features short-expiry` (Entanglement
   epochs expire after 20 s instead of 30 days, so `close_epoch` is testable without a clock warp;
   never deploy this build),
3. starts `solana-test-validator` in Docker (`--account-dir` fixtures, `--bpf-program` dumps,
   `--upgradeable-program` for quantum_hooks with a throwaway test upgrade authority in
   `tests/fixtures/.keys/`) on `127.0.0.1:8899`,
4. runs `node --test` on the host against it, sequentially, then removes the container.

No transaction is ever sent anywhere but the local validator, and no real keys are used.

Last full run (2026-10-10, Agave 2.1.0 test validator, mainnet dumps from slot 455127538):
**35/35 passing** — 6 client checks, 11 merkle checks and 18 e2e tests: config init/update
guards; 3-transaction launch (register → create_v2 with creator = well + dev buy → lock) and
register rejections (including sysvar, builtin and program split wallets); creator fees accruing
from other wallets; curve pulse (protocol cut, Superposition, deferral, exact rounding, split
order, NothingToPulse); curve Quantum Burn (reserve and per-action caps, Overspent, sell
discriminator, non-pump target, KeeperOnly, TooSoon, grace); Entanglement (post, proofs,
bad/double claims, expiry, close); Time Dilation (cliff, partial, full); buy-out + `migrate_v2` to
PumpSwap; PumpSwap pulse with WSOL unwrap, the WSOL ATA rent refunded to the payer and exactly the
pending fees split; NothingToPulse when only the ATA rent would have crossed the 0.001 SOL floor;
pool Quantum Burn (non-canonical pool rejected); Fusion (keeper gating, LP kept by the well); plain
launch; a legacy SPL Token coin (pump.fun `create`) through curve pulse and burn, graduation, pool
pulse and burn, and Fusion; pause. Rust unit tests (`unit`): 9/9. Measured sizes without a lookup
table: curve burn 977 B, pool burn 942 B, fusion 1045 B, pool pulse 883 B (the keeper adds ~50 B of
compute-budget instructions). `create_v2` + dev buy needs a lookup table (the tests build one).

## Deploy (outline)

1. Restore the program keypair (see above), run `scripts\anchor-docker.ps1 build` and commit
   `shared/idl/quantum_hooks.json`. The client and the program must ship together: `pulse` takes
   a `rent_payer` signer and Fusion an `lp_token_program`, so an old client fails against the new
   program and the other way round.
2. Deploy `target/deploy/quantum_hooks.so` with the program keypair from a funded deployer
   (`solana program deploy --program-id target/deploy/quantum_hooks-keypair.json …` inside
   `scripts\anchor-docker.ps1 shell`, with the deployer key mounted deliberately).
3. Immediately initialise the config **signed by the upgrade authority**; the program refuses any
   other signer, so the deploy cannot be front-run:

   ```bash
   node scripts/init-config.mjs --rpc <url> --authority <upgrade-authority.json> --treasury <pubkey> \
     --keeper <pubkey of QUANTPAD_KEEPER_SECRET> [--protocol-bps 0-1000] [--max-burn-sol 1] \
     [--min-action-interval 3600] [--keeper-grace 86400] [--mainnet] [--yes]
   ```

   Without `--yes` it prints a dry run (cluster, upgrade authority check, values) and sends
   nothing. Mainnet-beta RPCs are refused unless `--mainnet` is passed too.
4. Get an independent audit before the program holds meaningful value.

## Client (`shared/quantum.mjs`)

ESM, browser + Node. Imports the pump SDK as `#pump-sdk` (root `package.json` `imports`), the
PumpSwap SDK, Anchor, web3.js v1, spl-token, bn.js and `buffer`; the IDL is imported as JSON
(`with { type: 'json' }`). The browser needs `globalThis.Buffer` (pump.fun's SDK uses `Buffer`
without importing it) and `global = globalThis`.

Launches are three transactions sent in order: `stages.register` (launcher + mint keypair sign),
`stages.launch` (pump.fun `create_v2` with `creator = well` + optional `buy_v2`; launcher + mint),
`stages.lock` (optional; launcher). `instructions` concatenates them.
