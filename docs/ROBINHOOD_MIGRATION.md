# Robinhood Chain v2 operating instructions

This is a fresh deployment on Robinhood mainnet **4663**, using native **ETH (18 decimals)**. The quote currency is Uniswap V4's zero address. The launch fee is `100000000000000` wei. Market-cap inputs span `500000000000000000`–`5000000000000000000` wei, with `1000000000000000000` wei as the default. JSON records retain monetary settings as integer strings; transaction arithmetic uses bigint.

## Infrastructure

| Setting          | Value                                        |
| ---------------- | -------------------------------------------- |
| RPC              | `https://rpc.mainnet.chain.robinhood.com`    |
| Explorer         | `https://robinhoodchain.blockscout.com`      |
| PoolManager      | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| Quoter           | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| StateView        | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| Treasury         | `0x2e01dD8dF4A4fb06Ea62a944a658E9ae01DB2ac4` |

Sources: [Robinhood connection documentation](https://docs.robinhood.com/chain/connecting/) and [Uniswap v4 deployment addresses](https://developers.uniswap.org/docs/protocols/v4/deployments). Read-only RPC checks and the local fork test validate chain ID and infrastructure code before execution.

## Prepare the application

1. Install dependencies and regenerate artifacts with `npm run contracts:build`. Keep the pinned Solidity 0.8.26 compiler, Cancun target, viaIR, and optimizer 200. Never reuse Arc salts or deployment records.
2. Run the local, unit, browser, Redis, and fork checks documented in the README. The fork writes only to an in-process local chain. It does not use a live wallet or broadcast upstream.
3. Set the stable HTTPS `HOOKBREW_PUBLIC_URL=https://hookbrew.tech`. Set the server `HOOKBREW_RPC_URL` to a dedicated Robinhood mainnet archive endpoint for production indexing. Robinhood documents the default public RPC as rate-limited and unsuitable for production, and requires archive access for historical state. The public endpoint supports preparation and read-only checks; keeping it as the production override leaves an operational readiness gap. Provider credentials remain server-side; browser configuration continues to use the official public RPC.
4. Configure production Redis. The version suffix is mandatory, even when a custom prefix is supplied. Leave the old Arc namespace intact for historical evidence. The filesystem equivalent is `<HOOKBREW_DATA_DIR>/4663-v2`.
5. Deploy the application. Check `/api/status` for chain 4663, native ETH, 18 quote decimals, the exact launch fee, a healthy durable store, and no imported Arc deployment. Before wallet setup, `deployment: null` is expected.

## Wallet deployment and activation

1. Open `/setup` with a funded Robinhood wallet. Prepare the factory, review its treasury and gas estimate, then sign. The current bytecode and constructor arguments determine the CREATE2 address and required hook flags `0x2080`.
2. Prepare and sign the router deployment. The factory creates its vesting vault. Save public transaction receipts using **Export record**; failed or interrupted confirmation can resume without redeploying.
3. Connect the configured treasury wallet. Sign the deployment-specific activation message; activation itself is gas-free. The server verifies chain ID, exact constructor data, zero deployment transaction value, current bytecode, treasury, two L2 confirmations, and canonical receipt block hashes.
4. Export the activated deployment record from `/setup`. It includes addresses, transaction hashes, creation/runtime hashes, CREATE2 salt, compiler settings, and the indexing start block.
5. For each custom recipe, use Stage 2's one-transaction build flow. It deploys a package, modular factory, router, token deployer, and vesting vault with factory flags `0x20c0`. The registry records the recipe and current build evidence. Custom recipes cannot select an Arc or v1 deployment.

Contracts cannot be deployed or activated by publishing frontend files. Wallet signatures are required. Do not declare the venue live until the following verification and signed smoke test complete.

## Publish source verification

Set `BLOCKSCOUT_API_KEY` in your local shell and run `npm run contracts:verify -- https://hookbrew.tech` after activation. The command reads the active venue and custom recipes, validates on-chain runtime hashes, submits factory/router/vault/package/token-deployer and indexed token sources to Robinhood Blockscout, and exports `artifacts/robinhood/verified-deployments.json`. It uses the pinned compiler and exact constructor arguments, requires no private key, and makes no on-chain transactions. Verification failures must be resolved before recording completion. Keep the exported record and compiler build-info with deployment backups.

The [current Blockscout Hardhat instructions](https://docs.blockscout.com/devs/verification/hardhat-verification-plugin) require an API key for public chains. Robinhood’s legacy instance API returned a browser challenge in preflight; the Pro endpoint requires authentication. The command uses `https://api.blockscout.com/4663/api`. Alternatively, `npm run contracts:build` exports standard JSON compiler inputs into `artifacts/robinhood/source-verification` for submission through Blockscout’s verification UI. Keep API keys in your shell or secret manager.

The generated `public/protocol/RobinhoodRelease.json` contains a valid deterministic factory candidate and current compiler/network settings. The setup flow chooses a fresh valid salt; only confirmed activation receipts establish the deployed addresses.

## Signed smoke test

Using funded wallets on chain 4663:

1. Launch a token at a chosen 0.5–5 ETH opening target. The wallet must show exactly 0.0001 ETH plus any founder purchase as transaction value. Founder buys must never request an ETH approval. Use a small founder purchase if testing vesting.
2. Check the confirmed token appears in markets, its identity metadata resolves from the stable origin, and factory/token/transaction explorer links reach Robinhood Blockscout.
3. Buy a small amount with native ETH. Confirm there is no approval transaction and the indexed trade, candle, and volume use ETH.
4. Sell tokens. Confirm an exact token approval followed by a zero-value swap; verify the ETH proceeds and indexed results.
5. Harvest fees, then claim eligible creator and treasury allocations. For a reward recipe, also claim holder ETH rewards. Exercise a short vesting release when using a vested founder allocation.
6. Save launch/buy/sell/harvest/claim hashes with the deployment export and check canonical receipts after two L2 confirmations. Record actual outcomes, never predicted success.

Two L2 confirmations are an interaction threshold, not Ethereum finality. The indexer rewinds/rebuilds on reorganizations; submitted actions recover by receipt verification rather than sending again. Keep backups of deployment records and immutable metadata; index checkpoints can be rebuilt from the recorded start block.

## Accounting and historical evidence

Native PoolManager debt settlement calls `sync(address(0))` before payable `settle`. Token settlement remains ERC20-based. Factory ETH receipts are restricted to PoolManager; launches and payable swap/reward methods enforce exact value. Claims clear balances before guarded transfers, and reverted transfers restore entitlements atomically. Creator, treasury, holder, buyback, and liquidity reserves remain separate.

The original Arc integration research and unused adapter are retained under `contracts/review`; older audits and reference scripts are historical. They are not imported into application code. Arc browser state and server records are neither migrated nor relabeled as ETH.
