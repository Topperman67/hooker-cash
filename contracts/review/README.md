# Recovered Hooker V10 source and read-only diagnostics

This directory contains review material for the **original Hooker deployment**, not a selected Hookbrew deployment. The application does not import it or enable transactions from it.

## Source provenance

`LaunchpadHookCore.standard.json` is the unchanged Solidity standard-JSON input published at [hooker.cash/LaunchpadHookCore.standard.json](https://hooker.cash/LaunchpadHookCore.standard.json), retrieved on 2026-09-17 UTC. SHA-256:

```text
8edd68bfc9e1750fa84c67fdb5907dac085b3cea28d0491eead2457d2a122117
```

Its 81 source units include the V10 hook core, base contracts, token implementation, interfaces, and Uniswap dependencies. Original authorship, comments, and SPDX headers are preserved. The files declare MIT, GPL-3.0-or-later, AGPL-3.0-only, and BUSL-1.1 licenses; this directory does not relicense that material. The core is GPL-3.0-or-later, while its base is MIT. There is no corresponding current repository commit supplied with the download.

The factory, builder, policy, module implementations, current fee engine, vesting implementation, distributor, and seed executor are **not included**. Interfaces are not their implementations.

## Reproduce from the project root

```sh
npm ci
npm ci --ignore-scripts --prefix contracts/review
node scripts/verify-hook-core-source.mjs
node scripts/simulate-reference-launch.mjs
node scripts/simulate-launch-initial-buy.mjs
```

The compiler is pinned to `solc 0.8.26+commit.8a97fa7a`, optimizer 200 runs, via IR, Cancun, and metadata hash `none`. The source-verification script uses the downloaded settings, changing only output selection. Its runtime comparison masks only compiler-identified immutable positions, then separately verifies **every immutable value and occurrence**, preset manifests, dependency getters, and the executor's factory/policy pointers. A disagreement fails the command; network errors do not count as successful verification.

Reports are written to `docs/evidence/`. The runtime-template comparison and dependency checks do not establish the correctness of unreviewed modules, all storage, upgrade powers, or economic behavior.

## Simulation probe

`LaunchReadOnlyProbe.sol` is an original MIT-licensed diagnostic harness. **Do not deploy or fund it.** Its deliberately unrestricted call is only used as temporary runtime code at an otherwise empty address inside an RPC `eth_call` state override.

The probe temporarily receives 100 native USDC, approves the real factory to spend 1 ERC-20 USDC, calls the real launch method with its current native launch fee, and observes the resulting token, balances, hook registration, and vesting destination. Only the diagnostic account's code/balance are overridden; protocol contracts and storage use actual Arc state at the recorded block. The entire call is discarded. The scripts have no wallet client or transaction-broadcast operation.

The creator-allocation argument is a **purchase cap** in the observed current launch path, not a free token grant. A zero cap rejects a nonzero initial purchase. A vesting schedule belongs to a split recipient and locks the purchased tokens; supplying a nonzero cap alone does not create vesting.

These checks establish the reported call outcomes only. They do not test vesting maturity, later market swaps, fee claims, every module configuration, or a wallet-signed Hookbrew launch. See [the integration review](../../docs/CONTRACT_REVIEW.md).
