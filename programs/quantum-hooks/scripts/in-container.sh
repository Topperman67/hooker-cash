#!/usr/bin/env bash
# Runs inside solanafoundation/anchor:v0.31.1 (started by scripts/anchor-docker.sh / .ps1).
# The repo is bind-mounted at /work; target/ lives in a named volume except target/deploy,
# target/deploy-test, target/idl and target/types, which are bind-mounted back to the host.
set -euo pipefail
cd /work/programs/quantum-hooks

cmd="${1:-build}"
shift || true

keypair=target/deploy/quantum_hooks-keypair.json
idl_file=/work/shared/idl/quantum_hooks.json

declared_id() {
  sed -n 's/^declare_id!("\([1-9A-HJ-NP-Za-km-z]*\)");.*/\1/p' programs/quantum_hooks/src/lib.rs | head -n 1
}

idl_address() {
  if [ -f "$idl_file" ]; then
    { grep -o '"address": *"[^"]*"' "$idl_file" || true; } | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

# The program id in declare_id! and shared/idl/quantum_hooks.json is the deployed program, and its
# keypair is not in git. Never replace it silently: a missing or different keypair stops the build
# unless QUANTPAD_NEW_PROGRAM_ID=1 asks for a new program id on purpose.
ensure_keypair() {
  mkdir -p target/deploy
  local declared idl key
  declared="$(declared_id)"
  idl="$(idl_address)"
  if [ "${QUANTPAD_NEW_PROGRAM_ID:-}" = "1" ]; then
    if [ ! -f "$keypair" ]; then
      echo "QUANTPAD_NEW_PROGRAM_ID=1: generating a NEW program keypair. BACK IT UP: programs/quantum-hooks/$keypair"
      solana-keygen new --no-bip39-passphrase --silent -o "$keypair"
    fi
    anchor keys sync
    return
  fi
  if [ ! -f "$keypair" ]; then
    cat >&2 <<EOF
error: programs/quantum-hooks/$keypair is missing.

Quant Pad's program id $declared (declare_id! in lib.rs and the "address" in
shared/idl/quantum_hooks.json) belongs to that keypair, which is gitignored. Restore your backup
of quantum_hooks-keypair.json to programs/quantum-hooks/$keypair and run this again
(see "Program keypair" in programs/quantum-hooks/README.md).

- The local tests do not need it: build-test and tests/run-local.mjs use the program id from
  shared/idl/quantum_hooks.json.
- To start over with a brand-new program id instead (rewrites declare_id!, Anchor.toml and
  shared/idl/quantum_hooks.json; the deployed program stays where it is), rerun with
  QUANTPAD_NEW_PROGRAM_ID=1.
EOF
    exit 1
  fi
  key="$(solana-keygen pubkey "$keypair")"
  if [ "$key" != "$declared" ] || { [ -n "$idl" ] && [ "$key" != "$idl" ]; }; then
    cat >&2 <<EOF
error: programs/quantum-hooks/$keypair is $key,
but declare_id! is $declared and shared/idl/quantum_hooks.json says ${idl:-<no address>}.
Restore the keypair that matches $declared, or rerun with QUANTPAD_NEW_PROGRAM_ID=1 to switch the
program id to $key on purpose.
EOF
    exit 1
  fi
}

export_idl() {
  mkdir -p /work/shared/idl
  cp target/idl/quantum_hooks.json /work/shared/idl/quantum_hooks.json
  echo "IDL -> shared/idl/quantum_hooks.json"
}

case "$cmd" in
  lock)
    # Re-resolve Cargo.lock with the image's cargo 1.86, preferring crate versions whose
    # rust-version fits platform-tools' cargo/rustc 1.79 (no edition2024 crates).
    rm -f Cargo.lock
    CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile
    # blake3 >= 1.8.3 pulls digest 0.11 / edition-2024 crates; 1.5.5 is what Solana 2.1 used.
    cargo update -p blake3 --precise 1.5.5
    ;;
  build)
    # Release build (30-day epochs) + IDL.
    ensure_keypair
    anchor build "$@"
    export_idl
    ls -l target/deploy
    ;;
  build-test)
    # Test build: same program id, `short-expiry` feature (20 s epochs, one per 15 s) for the local
    # e2e tests.
    # Needs no program keypair (the test validator loads the .so at the id from shared/idl).
    mkdir -p target/deploy-test
    cargo build-sbf --manifest-path programs/quantum_hooks/Cargo.toml --features short-expiry \
      --sbf-out-dir target/deploy-test "$@"
    rm -f target/deploy-test/quantum_hooks-keypair.json
    ls -l target/deploy-test
    ;;
  unit)
    cargo test --manifest-path programs/quantum_hooks/Cargo.toml --lib "$@"
    ;;
  keys)
    # Checks the keypair against declare_id! and the IDL (never creates one unless
    # QUANTPAD_NEW_PROGRAM_ID=1), then prints the program id.
    ensure_keypair
    anchor keys list
    ;;
  versions)
    anchor --version; solana --version; cargo --version; rustc --version
    cargo build-sbf --version || true
    ;;
  validator)
    # solana-test-validator with the dumped mainnet programs/accounts and quantum_hooks.
    # Args: <quantum program id> <upgrade authority pubkey> [extra validator args...]
    program_id="$1"; authority="$2"; shift 2
    fixtures=tests/fixtures
    args=(--reset --quiet --ledger /tmp/qh-ledger --bind-address 0.0.0.0 --rpc-port 8899
      --account-dir "$fixtures/accounts")
    for so in "$fixtures"/programs/*.so; do
      id="$(basename "$so" .so)"
      args+=(--bpf-program "$id" "$so")
    done
    if [ -f target/deploy-test/quantum_hooks.so ]; then
      args+=(--upgradeable-program "$program_id" target/deploy-test/quantum_hooks.so "$authority")
    else
      echo "target/deploy-test/quantum_hooks.so missing: starting without quantum_hooks"
    fi
    echo "solana-test-validator ${args[*]} $*"
    exec solana-test-validator "${args[@]}" "$@"
    ;;
  shell)
    exec bash
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
