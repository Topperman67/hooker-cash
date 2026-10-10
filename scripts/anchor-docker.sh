#!/usr/bin/env bash
# Anchor 0.31.1 toolchain in Docker for programs/quantum-hooks (no host Rust/Solana needed).
#   scripts/anchor-docker.sh build        release build + IDL (-> shared/idl/quantum_hooks.json)
#   scripts/anchor-docker.sh build-test   test build with the `short-expiry` feature (target/deploy-test)
#   scripts/anchor-docker.sh unit         Rust unit tests
#   scripts/anchor-docker.sh keys         check the program keypair and print the program id
#   scripts/anchor-docker.sh validator <program id> <authority pubkey>   test validator on :8899
#   scripts/anchor-docker.sh shell | <any command>
# `build` and `keys` need the backed-up target/deploy/quantum_hooks-keypair.json matching
# declare_id!; they stop instead of generating one. QUANTPAD_NEW_PROGRAM_ID=1 (passed through)
# opts in to generating a new program id.
# Cargo's target dir, registry and git cache live in named volumes (fast, survive retries);
# target/deploy, target/deploy-test, target/idl and target/types are bind-mounted back to the host.
set -euo pipefail

IMAGE="${ANCHOR_IMAGE:-solanafoundation/anchor:v0.31.1}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WS="$REPO/programs/quantum-hooks"
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

mkdir -p "$WS/target/deploy" "$WS/target/deploy-test" "$WS/target/idl" "$WS/target/types"
cmd="${1:-build}"
[ $# -gt 0 ] && shift

tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-it)
ports=()
[ "$cmd" = "validator" ] && ports=(-p 127.0.0.1:8899:8899 -p 127.0.0.1:8900:8900)

T=/work/programs/quantum-hooks/target
# Git Bash would otherwise rewrite the container paths below.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
exec docker run --rm "${tty[@]}" "${ports[@]}" \
  -e CARGO_NET_RETRY=10 -e CARGO_HTTP_TIMEOUT=120 -e CARGO_TERM_COLOR=always \
  -e QUANTPAD_NEW_PROGRAM_ID \
  --mount "type=bind,source=$(host_path "$REPO"),target=/work" \
  --mount "type=volume,source=quantum-hooks-target,target=$T" \
  --mount "type=bind,source=$(host_path "$WS/target/deploy"),target=$T/deploy" \
  --mount "type=bind,source=$(host_path "$WS/target/deploy-test"),target=$T/deploy-test" \
  --mount "type=bind,source=$(host_path "$WS/target/idl"),target=$T/idl" \
  --mount "type=bind,source=$(host_path "$WS/target/types"),target=$T/types" \
  --mount "type=volume,source=quantum-hooks-cargo-registry,target=/root/.cargo/registry" \
  --mount "type=volume,source=quantum-hooks-cargo-git,target=/root/.cargo/git" \
  --mount "type=volume,source=quantum-hooks-solana-cache,target=/root/.cache/solana" \
  -w /work/programs/quantum-hooks \
  "$IMAGE" bash -c 'tr -d "\r" < scripts/in-container.sh > /tmp/ic.sh && exec bash /tmp/ic.sh "$@"' _ "$cmd" "$@"
