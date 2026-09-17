# Hookbrew v1 implementation

This build replaces the default two-field launch placeholder with a five-stage studio and adds an independent contract venue, a persistent event API, and a chart/trading terminal. It implements the core launch → market → buy/sell flow requested after the reference-site audit. The older audit documents are a point-in-time baseline; their missing-backend/source observations no longer describe this build.

## Deployment identity

- Protocol: independent Hookbrew v1; not the original V10 factory.
- Chain: Arc, 5042. Quotes: ERC20 USDC (6 decimals). Native gas/launch fee: USDC (18 decimals).
- Treasury: `0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4`.
- Launch fee: 1 native USDC. Seed LP fees: 70% creator recipients, 30% treasury.
- Factory is the V4 beforeInitialize/beforeSwap hook, address flags `0x2080` under mask `0x3fff`.
- Compiler: pinned local solc 0.8.26, optimizer 200, viaIR, Cancun. Contract-size enforcement remains enabled.
- No mainnet deployment or user-wallet transaction has been broadcast by development tools.

Factory and router are immutable. Deployment setup mines a valid CREATE2 salt, estimates costs, and requests the user's wallet signature. Activation requires a fresh, host-bound, expiring treasury signature covering both transaction hashes. The backend compares their calldata to the compiled artifact and configured treasury. Runtime hashes are checked again before app transactions.

## Economics and contract behavior

Arc USDC's native (18 decimals) and ERC20 (6 decimals) interfaces share one balance. The transaction adapter sums quote input, native launch value and a gas reserve in native units before sending. Buy MAX reserves gas instead of spending the full ERC20 view. See the [Arc stablecoin model](https://docs.arc.io/arc/concepts/stablecoin-native-model). Local tests use a standard ERC20 quote fixture, with separate unit coverage for this Arc-specific combined budget.

All launches mint exactly one billion tokens. There are no later mint, freeze, ownership upgrade, or transfer-tax functions. The factory seeds a token-only V4 position, with no liquidity removal entry point. Integer rounding can leave token dust at the factory. Opening market cap is a price target rounded to a V4 tick; it is not deposited USDC liquidity.

The founder purchase is atomic with launch and capped at 10% of supply. Recipient shares apply to both founder allocation and creator fees. Vesting starts after the configured cliff, then releases linearly over the configured duration. Zero duration unlocks the full amount at the cliff. Release is permissionless but always pays the beneficiary.

Creator fees remain claimable only when the recipient holds their founder allocation (liquid balance plus unreleased vesting). Protocol fees use separate accounting so the treasury cannot be blocked by creator hold eligibility. Fees accrue in each pool currency. Harvest is permissionless; claims always pay their named recipient.

Buy guards use the seed position's virtual quote reserves, avoiding a zero-active-liquidity edge case at an upper initial tick and preventing unrelated LP additions from changing the cap. They expire automatically, exempt the founder purchase and all sells, and optionally enforce global spacing. They do not guarantee bot resistance.

## Data

The server indexes factory launches and PoolManager swaps two blocks behind the head. It attributes own-router trades, labels other routes as external, sorts by block/log order, and builds candles only from actual observations. Its saved checkpoint includes a block hash; a mismatch triggers a rebuild. API data includes cursor/error state. A fresh deployment naturally has no listings or candles.

Token artwork and metadata use hashed files under persistent `media/`. Only PNG/JPEG/WebP uploads are accepted. Arbitrary metadata URLs are never fetched by the server. Creator links are rendered only with HTTP(S) schemes. On-chain metadata needs a stable public HTTPS origin; launches from an unconfigured localhost origin are blocked before sending.

The file store/index is for a single server instance. It needs disk backups, an appropriate RPC log/history limit, and sufficient disk capacity. A future production-scale iteration can move the same API to a database and object store without changing contracts.

## Verification and remaining boundaries

Tests cover real V4 launch and trading paths, both address orderings, protected buy timing, vesting, slippage/expiry, recipient mistakes, creator hold eligibility, protocol fee isolation, server activation, indexing/restarts/reorgs, and the browser's core lifecycle. Production deployment signatures, public hosting, and independent contract security review remain outstanding external steps.

The reference product's modular hook builder, reflection/burn/buyback designs, external LP management, leveraged positions and agent transaction service are not claimed as implemented. The catalogue is explicitly a reference catalogue.
