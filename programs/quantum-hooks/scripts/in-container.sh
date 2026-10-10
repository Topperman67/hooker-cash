#!/usr/bin/env bash
# Runs inside solanafoundation/anchor:v0.31.1 (started by scripts/anchor-docker.sh / .ps1).
# The repo is bind-mounted at /work; target/ lives in a named volume except target/deploy,
# target/deploy-test, target/idl and target/types, which are bind-mounted back to the host.
set -euo pipefail
cd /work/programs/quantum-hooks

cmd="${1:-build}"
shift || true

ensure_keypair() {
  mkdir -p target/deploy
  if [ ! -f target/deploy/quantum_hooks-keypair.json ]; then
    echo "Generating the program keypair (BACK IT UP: target/deploy/quantum_hooks-keypair.json)"
    solana-keygen new --no-bip39-passphrase --silent --force -o target/deploy/quantum_hooks-keypair.json
  fi
  anchor keys sync
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
    # Test build: same program id, `short-expiry` feature (20 s epochs) for the local e2e tests.
    ensure_keypair
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
