# Launch transaction integration

The application now contains a real Arc V10 launch transaction builder, wallet-send path, and receipt verifier. **The production deployment is still unset and launching remains disabled.** Current factory/module implementation sources and the user's deployment/treasury decision are outstanding.

## Deployment contract

`src/config/launchDeployment.js` exports `null`. After the intended deployment and full source review are established, it must export a reviewed configuration with:

| Field                                    | Meaning                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `chainId`, `abiVersion`                  | `5042` and `hooker-arc-v10`; this adapter does not claim support for other interfaces |
| `factory`, `policy`, `treasury`, `quote` | Explicit addresses; quote must be the Arc USDC interface                              |
| `factoryCodeHash`, `policyCodeHash`      | Keccak-256 hashes of reviewed deployed runtime code                                   |
| `sourceReference`                        | Matching source commit/build evidence reference; a string alone is not an audit       |
| `startBlock`                             | Deployment block as an integer string                                                 |
| `totalSupply`                            | Permitted whole-token supply as an exact integer string; 18 token decimals            |
| `poolFee`                                | Reviewed V4 pool fee in hundredths of a basis point; `10000` means 1%                 |
| `presets`                                | Explicit `{id, name, address, codeHash}` entries for reviewed hooks                   |

The reference manifest in `docs/evidence/` is **not imported into the application**. No URL parameter, wallet announcement, or local-storage flag can select a deployment. Tests replace this configuration only inside isolated browser routes.

Code hash checks detect differences from the pinned runtimes. They do not validate all mutable state, proxy implementations, module behavior, custody, or administrative powers. Resolve those in the deployment/source review before activation.

## Implemented flow

1. Read the real chain ID, block, factory policy, factory/policy treasuries, launch fee, quote admission, and pinned runtime hashes. Show the factory and fee recipient explicitly.
2. Validate the token name, symbol, and description by UTF-8 **byte** length. Select only a configured hook. Supply and pool fee come from the reviewed deployment configuration.
3. Encode a real `launch` call with fresh cryptographic salt. This initial UI supports **no initial purchase**, no creator allocation, and no split/vesting options. It requests no ERC-20 approval. The original contract's separate initial-purchase path has been simulated, but is not yet integrated into this UI.
4. Simulate using the connected account, check native balance, estimate gas, and show the reviewed fee and gas estimate. A simulation result is not a deployed token.
5. On the user's confirmation click, re-read configuration/fees and re-simulate the exact calldata. Re-check the provider's exposed account and chain before one `eth_sendTransaction` request. Account changes, edited form data, navigation before signing, and failed preflight prevent a send. Wallet requests are never retried automatically.
6. Save the returned transaction hash and reviewed intent in session storage. On reload, expose a **read-only receipt verification** action; do not resubmit. Storage failures show a warning to preserve the explorer link. No private keys are stored.
7. Wait for two confirmations; track replacement hashes. Require success status, matching sender/factory/calldata/value, exactly one matching factory launch event, the expected token address, deployed token code, matching name/symbol/decimals/supply, and hook registration at the receipt block before showing success. Unrelated logs, a reverted transaction, and an unverified submission never become a confirmed launch.
8. A verified revert permits an explicit new attempt. A timed-out or otherwise unverified transaction stays tracked so it can be checked again.

Session storage is treated as untrusted intent: restored data is never used to send a transaction automatically, and success requires matching live transaction, receipt, and contract state. Two confirmations and these checks are not a guarantee against a deeper chain reorganization.

## Verification and limits

- `npm run test:unit` checks UTF-8 limits, deployment/fee/code drift, account/network changes, one-shot signing, and strict receipt validation.
- `npm run test:e2e` exercises the connected form with test-only wallet/RPC fixtures, rejection, unrelated logs, reverts, reload recovery, duplicate clicks, and mobile layout.
- `node scripts/verify-launch-adapter.mjs` runs the production preparation path against actual original Arc contracts, including live code/recipient checks, simulation and gas estimation. Only diagnostic funding is overridden; no wallet provider is supplied. See `docs/evidence/launch-adapter-check.json`.
- `node scripts/check-reference-launch-events.mjs` reads bounded original-factory history. It found genuine matching launch records, including the original platform token. It is not a market index.
- `node scripts/verify-reference-receipts.mjs` ran the production receipt/state verifier against two existing third-party launches at blocks **21124427** and **21124453**. The original signed calldata supplied historical intent; the event supplied its token address, so this checks real receipt decoding/state but does not independently test a prior prediction. See `docs/evidence/reference-receipt-check.json`.

The Arc public RPC does not expose `debug_traceCall`. This is recorded as unavailable, not treated as a passed trace check.

No user wallet has signed a Hookbrew launch. Full current-source matching, deployment selection, initial-purchase UX, subsequent swap routing, approvals/slippage, index synchronization, liquidity views, and fee/vesting claims remain outstanding. The goal is not complete. Activation is blocked on the deployment decision and missing implementation sources; those same prerequisites remain unresolved after repeated verification passes.
