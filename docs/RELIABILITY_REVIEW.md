# Hookbrew reliability review — 2026-09-17

Status: **local review complete**. This is an engineering review and regression campaign, not an independent contract audit or a guarantee of economic safety.

## Scope and evidence

| Area                                                                 | Verification                                                                                                     | Result                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Routes, responsive navigation, real market data and wallet discovery | Desktop/mobile browser suite                                                                                     | 41 browser tests passed                                                                                |
| Five-stage launch, metadata/artwork, approvals and recovery          | Real local V4 lifecycle; separate API instances; failed/replaced receipts                                        | Passed in the final browser/API suites                                                                 |
| Custom recipes, fees, guards, rewards, reserves and locked liquidity | Contract suite, including 48 reward transfer/distribution/claim rounds                                           | 17 passed                                                                                              |
| Allocation math and draft recovery                                   | Integer budget invariants and desktop/mobile sliders                                                             | Pass                                                                                                   |
| Trading review stability                                             | Wait through a token-detail poll while a real local trade remains under review                                   | Passed for base and custom venues                                                                      |
| Storage and cold starts                                              | Real Upstash Redis plus multi-instance unit tests                                                                | All 40 unit/API tests passed, zero skipped                                                             |
| Network/page failures                                                | API timeout/abort/invalid-response tests and failed lazy-chunk browser test                                      | Pass                                                                                                   |
| Production browser policy                                            | Built server, real security headers, wallet chooser and mobile builder                                           | Passed with no CSP violations or page errors                                                           |
| Compiler/artifact integrity                                          | Force-compile all 85 Solidity sources and compare all eight exported artifacts and ABIs                          | Byte-for-byte Git comparison passed                                                                    |
| Dependencies                                                         | Root and isolated contract-toolchain npm audits                                                                  | Root: zero; contract tooling: 13 low, zero moderate/high/critical                                      |
| Automated verification                                               | Main/PR workflow with real Redis service, contracts, artifact comparison, units, browser tests and format checks | Added; release results are in [main workflow runs](https://github.com/Topperman67/hooker-cash/actions) |
| Production                                                           | Exact revision, routes/API/index, headers and logs                                                               | Baseline healthy at f965574; post-push verification is recorded in the release/commit checks           |

Final local checks: 17 contract tests, 40 unit/API tests (including real Redis, zero skipped), 41 browser tests, formatting, production build, and artifact comparison passed. The intermediate browser run interrupted by development hot reload was discarded; the final run completed against stable source.

## Resolved findings

1. **Trade reviews were reset by ordinary polling.** Token detail recreated an identical deployment object every ten seconds. The terminal now preserves its identity until the venue changes. The regression waits for the next detail response before confirming a trade.
2. **API requests could remain pending indefinitely.** Fetch and response-body reads now have a 30-second deadline, follow explicit cancellation, clean up listeners/timers, and show readable connection/invalid-response errors.
3. **Cold starts could starve later custom venues.** A process-local scheduling offset repeatedly selected the first three hooks. A shared atomic counter rotates across venues; a test advances eight hooks through three fresh API instances.
4. **Index batches could mix chain data across a reorganization.** Batch anchors and event block hashes are checked before checkpoint commit. A failed reload cannot overwrite durable progress with an empty index. Errors preserve the last complete checkpoint and expose a sanitized diagnostic. Burned supply is refreshed only for affected tokens, reducing unnecessary RPC work.
5. **Redis transport errors could leak upstream details; replica reads lacked causal synchronization.** Errors now return a generic 503, and the REST adapter carries Upstash's sync token. Real-store tests cover competing activation writes, counters, expiry, media quota, fencing and cleanup. The initial millisecond-expiry test was adjusted to poll a bounded five-second deadline rather than assume a remote replica expires within ten milliseconds.
6. **Write limits reset on cold starts and used proxy socket addresses.** Production uses expiring atomic Redis counters and Vercel's trusted client-IP header. Local hosting ignores spoofable forwarded headers. Foreign/invalid origins are rejected before body processing.
7. **Failed lazy imports could leave a blank app.** An accessible error boundary offers an explicit reload while retaining drafts and pending receipt records; reload does not send a transaction.
8. **Production browser protections were absent.** CSP restricts executable scripts to this origin, RPC connections to the two configured Arc endpoints, and disables objects/framing. Both hosting paths also set frame, MIME, referrer and device-permission headers. Inline styles remain allowed because the glass/chart UI needs them.
9. **Development toolchain had high/moderate advisories.** Compatible transitive overrides update Undici, adm-zip, serialize-javascript, tmp, cookie and UUID without changing solc 0.8.26, Solidity source or deployment artifacts.
10. **Verification was manual and documentation was stale.** A SHA-pinned GitHub workflow now runs on main/PR changes. Supply copy distinguishes fixed initial supply from optional burns; storage documentation describes Redis production persistence.
11. **Fresh Linux builds exposed Git line-ending normalization.** The original modular factory compiler input contained mixed line endings; Git's automatic conversion changed its source hash and the metadata in two exported artifacts. Solidity sources now retain their exact original bytes through checkout. Contract behavior, existing exported bytecode and deterministic addresses remain unchanged, and CI still requires a byte-for-byte artifact match.

## Contract review

Reviewed launch parameter validation, immutable recipe/treasury binding, permission flags, guarded buys with sells open, exact-input routes, slippage/deadlines, vesting beneficiaries, claim eligibility, fee/reserve separation, oracle warm-up and price bands, and seed liquidity with no withdrawal path. Tests exercise both token/quote orderings, rejected invalid recipe reasons, unauthorized callbacks, supply changes, reward accounting, price manipulation rejection and token reserve isolation. Existing contract logic and bytecode were not modified; Git now preserves the original compiler input bytes across operating systems.

Compiler: `0.8.26+commit.8a97fa7a`, optimizer 200, viaIR, Cancun. Upstream known bugs were assessed as follows:

- SOL-2026-6: no named custom-error `require` calls found in the 85-source compiler AST.
- SOL-2026-4 / SOL-2026-2: static referenced-function call analysis found no mutual internal recursion cycles; source review found no recursive Hookbrew path. This check is not a proof about all compiler optimizations or assembly.
- SOL-2026-5: applies to the non-IR pipeline; this build uses viaIR.
- SOL-2025-1: storage-array slot-overflow issue. Hookbrew uses ordinary compiler-managed storage with bounded recipients/observations and no custom near-overflow storage layout. No applicable reachable case was identified in this review.

An independently reviewed future compiler/toolchain migration should be a separately versioned build. Silently changing the current artifacts would break exact-bytecode verification and deterministic recipe identities.

## Operational limits and follow-ups

- No mainnet wallet transaction was signed by this review. Contract/browser transactions use isolated local test accounts and a real local Uniswap V4 PoolManager. Production checks are read-only except disposable Redis test keys under a unique test namespace, which were removed.
- The old BT image URL still returns 404. Its original bytes were lost before persistent storage was connected and cannot be reconstructed from the chain. New artwork/metadata persistence, listing hydration and missing-image fallback are covered by tests.
- The contract development tree retains the low-severity `elliptic` advisory, reported through 13 dependent packages. These packages are not installed in the production website runtime. Removing it requires a Hardhat/toolchain migration, not an unsafe forced dependency upgrade.
- This review does not certify economic safety, oracle resistance under all markets, or absence of contract vulnerabilities. Independent contract review remains outstanding, as documented in the builder guide.
- The current index uses bounded polling and full per-venue snapshots. It is suitable for the present small deployment; sustained load, many venues and large trade histories need capacity testing, a dedicated index worker and partitioned history storage. The initial JS bundle also remains about 227 kB compressed, with chart/setup chunks loaded separately.
- Back up the production Redis database and keep eviction disabled. Existing deployed contracts and on-chain metadata URLs are immutable. Redis/provider outages and chain reorganizations can delay availability even with recovery paths.
- GitHub verification reports regressions on main; the existing Vercel Git integration still deploys independently. CI is not represented as a deployment gate.
- External LP management, leverage and transaction-capable agents remain the explicitly documented product backlog, not completed features.

## Sources

- [Solidity compiler known bugs](https://github.com/argotorg/solidity/blob/develop/docs/bugs_by_version.json)
- [Upstash read-your-writes consistency](https://upstash.com/docs/redis/howto/readyourwrites)
- [Vercel trusted request headers](https://vercel.com/docs/headers/request-headers)
- [Undici security advisories](https://github.com/nodejs/undici/security/advisories)
- [Remaining elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84)
- [GitHub Node.js CI guidance](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
