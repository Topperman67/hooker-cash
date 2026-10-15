// Test doubles for Meteora coins, shared by the indexer tests: DBC and DAMM v2 transactions in the
// JSON encoding the indexer reads (each event an Anchor event-CPI inner instruction under the
// instruction that emitted it, as mainnet has them), DBC pool / config and DAMM v2 pool accounts,
// an in-memory chain (mainnet getSignaturesForAddress semantics) and store, and a Quantum client
// double. Not a test file itself (node --test runs tests/unit/*.test.mjs).
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import BN from 'bn.js'
import { launchTiers, network } from '../../shared/network.mjs'
import {
  DAMM_EVENT_AUTHORITY,
  DAMM_POOL_AUTHORITY,
  DBC_EVENT_AUTHORITY,
  DBC_POOL_AUTHORITY,
  METAPLEX_PROGRAM_ID,
  dammCoder,
  dbcCoder,
  dbcPoolPda,
  dbcVaultPda,
  metadataPda,
  migratedPoolFor,
} from '../../shared/meteora.mjs'
import dbcIdl from '../../shared/idl/meteora_dbc.json' with { type: 'json' }
import dammIdl from '../../shared/idl/meteora_damm_v2.json' with { type: 'json' }

export const DBC = network.dbcProgram
export const DAMM = network.dammV2Program
export const WSOL = network.wsolMint
export const NOW = Math.floor(Date.now() / 1000)
// Quant Pad's 1% launch config: the indexer finds a pool under it by its address.
export const CONFIG = launchTiers[0].config
// Mainnet accounts (tests/fixtures/meteora-accounts.json) as getAccountInfo returns them: Quant
// Pad's launch configs, a launch's DBC pool, mint and Metaplex metadata, and a migrated coin's pools.
export const MAINNET = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(new URL('../fixtures/meteora-accounts.json', import.meta.url), 'utf8')),
  ).map(([address, a]) => [
    address,
    {
      owner: new PublicKey(a.owner),
      lamports: a.lamports,
      data: Buffer.from(a.data, 'base64'),
      executable: false,
    },
  ]),
)
// SOL in the curve when it fills (the config's migration_quote_threshold).
export const THRESHOLD = 85_000_000_000n
export const address = () => Keypair.generate().publicKey.toBase58()
export const signature = () => bs58.encode(randomBytes(64))
const key = (v) => (v instanceof PublicKey ? v : new PublicKey(v))
const b58 = (v) => key(v).toBase58()
const u64 = (v) => new BN(BigInt(v).toString())

// ---- prices -----------------------------------------------------------------------------------
// The Q64.64 sqrt price a Meteora pool holds at `price` SOL per whole token (inverse of
// priceFromSqrtPrice).
export const sqrtPriceFor = (price, decimals = network.tokenDecimals) =>
  BigInt(Math.round(Math.sqrt(price / 10 ** (decimals - 9)) * 2 ** 64))
// Raw tokens `lamports` buys at `price`.
const tokensFor = (lamports, price, decimals = network.tokenDecimals) =>
  BigInt(Math.round((Number(lamports) / 1e9 / price) * 10 ** decimals))

// ---- addresses --------------------------------------------------------------------------------
export const dbcPoolFor = (mint, config = CONFIG) => dbcPoolPda(config, key(mint)).toBase58()
// The DAMM v2 pool a coin under a config with `migrationFeeOption` migrates into (6, customizable,
// on Quant Pad's configs).
export const dammPoolFor = (mint, migrationFeeOption = 6) =>
  migratedPoolFor({ migrationFeeOption }, key(mint)).toBase58()

// ---- events and instructions ------------------------------------------------------------------
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
const camel = (name) => name[0].toLowerCase() + name.slice(1)
const IDLS = { [DBC]: [dbcIdl, dbcCoder], [DAMM]: [dammIdl, dammCoder] }
// An event's bytes as `emit_cpi!` sends them (without the event-CPI tag).
export function eventBytes(program, name, data) {
  const [idl, coder] = IDLS[program]
  const disc = Buffer.from(idl.events.find((e) => e.name === name).discriminator)
  return Buffer.concat([disc, coder.types.encode(camel(name), data)])
}
const eventIx = (program, name, data) => ({
  program,
  accounts: [program === DBC ? DBC_EVENT_AUTHORITY : DAMM_EVENT_AUTHORITY],
  data: Buffer.concat([EVENT_IX_TAG, eventBytes(program, name, data)]),
})

/**
 * A DBC launch through initialize_virtual_pool_with_spl_token: the outer instruction (its
 * arguments carry the name, symbol and uri) and its EvtInitializePool.
 */
export function createIx(
  mint,
  {
    creator,
    payer = creator,
    name = 'Test Coin',
    symbol = 'TEST',
    uri = '',
    config = CONFIG,
    quoteMint = WSOL,
    activationPoint = NOW,
    decimals = network.tokenDecimals,
  },
) {
  const pool = dbcPoolFor(mint, config)
  return {
    program: DBC,
    signers: [b58(payer), b58(mint)],
    balances: [
      {
        account: b58(dbcVaultPda(pool, mint)),
        mint: b58(mint),
        owner: DBC_POOL_AUTHORITY.toBase58(),
        decimals,
        amount: network.totalSupply,
      },
      {
        account: b58(dbcVaultPda(pool, quoteMint)),
        mint: b58(quoteMint),
        owner: DBC_POOL_AUTHORITY.toBase58(),
        decimals: 9,
      },
    ],
    accounts: [
      config,
      DBC_POOL_AUTHORITY,
      creator,
      mint,
      quoteMint,
      pool,
      dbcVaultPda(pool, mint),
      dbcVaultPda(pool, quoteMint),
      metadataPda(mint),
      METAPLEX_PROGRAM_ID,
      payer,
      network.tokenProgram,
      network.tokenProgram,
      '11111111111111111111111111111111',
      DBC_EVENT_AUTHORITY,
      DBC,
    ].map(b58),
    data: dbcCoder.instruction.encode('initializeVirtualPoolWithSplToken', {
      params: { name, symbol, uri },
    }),
    inner: [
      eventIx(DBC, 'EvtInitializePool', {
        pool: key(pool),
        config: key(config),
        creator: key(creator),
        baseMint: key(mint),
        poolType: 0,
        activationPoint: u64(activationPoint),
      }),
    ],
  }
}

/** DBC transfer_pool_creator (a Quantum launch hands its pool to the coin's well). */
export function transferCreatorIx(mint, { creator, newCreator, config = CONFIG }) {
  const pool = dbcPoolFor(mint, config)
  return {
    program: DBC,
    signers: [b58(creator)],
    accounts: [pool, config, creator, newCreator, DBC_EVENT_AUTHORITY, DBC].map(b58),
    data: dbcCoder.instruction.encode('transferPoolCreator', {}),
    inner: [
      eventIx(DBC, 'EvtUpdatePoolCreator', {
        pool: key(pool),
        creator: key(creator),
        newCreator: key(newCreator),
      }),
    ],
  }
}

/**
 * A DBC swap2 by `payer` that leaves the curve at `price` SOL per whole token: a buy of
 * `lamports` (SOL in) or a sell for `lamports` (SOL out). `complete` adds the EvtCurveComplete of
 * the swap that fills the curve.
 */
export function swapIx(
  mint,
  {
    price,
    side = 'buy',
    lamports = 1_000_000_000,
    tokens = tokensFor(lamports, price),
    fee = 0,
    timestamp = NOW,
    payer = address(),
    config = CONFIG,
    quoteReserve = lamports,
    threshold = THRESHOLD,
    complete = false,
  },
) {
  const pool = dbcPoolFor(mint, config)
  const buy = side === 'buy'
  const [input, output] = buy ? [lamports, tokens] : [tokens, lamports]
  return {
    program: DBC,
    signers: [b58(payer)],
    accounts: [
      DBC_POOL_AUTHORITY,
      config,
      pool,
      address(),
      address(),
      dbcVaultPda(pool, mint),
      dbcVaultPda(pool, WSOL),
      mint,
      WSOL,
      payer,
      network.tokenProgram,
      network.tokenProgram,
      DBC,
      DBC_EVENT_AUTHORITY,
      DBC,
    ].map(b58),
    data: dbcCoder.instruction.encode('swap2', {
      params: { amount0: u64(input), amount1: u64(0), swapMode: 0 },
    }),
    inner: [
      eventIx(DBC, 'EvtSwap2', {
        pool: key(pool),
        config: key(config),
        tradeDirection: buy ? 1 : 0,
        hasReferral: false,
        swapParameters: { amount0: u64(input), amount1: u64(0), swapMode: 0 },
        swapResult: {
          includedFeeInputAmount: u64(input),
          excludedFeeInputAmount: u64(input),
          amountLeft: u64(0),
          outputAmount: u64(output),
          nextSqrtPrice: u64(sqrtPriceFor(price)),
          tradingFee: u64(fee),
          protocolFee: u64(0),
          referralFee: u64(0),
        },
        quoteReserveAmount: u64(quoteReserve),
        migrationThreshold: u64(threshold),
        currentTimestamp: u64(timestamp),
      }),
      ...(complete
        ? [
            eventIx(DBC, 'EvtCurveComplete', {
              pool: key(pool),
              config: key(config),
              baseReserve: u64(0),
              quoteReserve: u64(quoteReserve),
            }),
          ]
        : []),
    ],
  }
}

/** A DAMM v2 swap2 by `payer` on the coin's migrated pool, leaving it at `price`. */
export function dammSwapIx(
  mint,
  {
    price,
    side = 'buy',
    lamports = 1_000_000_000,
    tokens = tokensFor(lamports, price),
    fee = 0,
    timestamp = NOW,
    payer = address(),
    pool = dammPoolFor(mint),
  },
) {
  const buy = side === 'buy'
  const [input, output] = buy ? [lamports, tokens] : [tokens, lamports]
  return {
    program: DAMM,
    signers: [b58(payer)],
    accounts: [
      DAMM_POOL_AUTHORITY,
      pool,
      address(),
      address(),
      address(),
      address(),
      mint,
      WSOL,
      payer,
      network.tokenProgram,
      network.tokenProgram,
      DAMM,
      DAMM_EVENT_AUTHORITY,
      DAMM,
    ].map(b58),
    data: dammCoder.instruction.encode('swap2', {
      params: { amount0: u64(input), amount1: u64(0), swapMode: 0 },
    }),
    inner: [
      eventIx(DAMM, 'EvtSwap2', {
        pool: key(pool),
        tradeDirection: buy ? 1 : 0,
        collectFeeMode: 0,
        hasReferral: false,
        params: { amount0: u64(input), amount1: u64(0), swapMode: 0 },
        swapResult: {
          includedFeeInputAmount: u64(input),
          excludedFeeInputAmount: u64(input),
          amountLeft: u64(0),
          outputAmount: u64(output),
          nextSqrtPrice: u64(sqrtPriceFor(price)),
          claimingFee: u64(fee),
          protocolFee: u64(0),
          compoundingFee: u64(0),
          referralFee: u64(0),
        },
        includedTransferFeeAmountIn: u64(input),
        includedTransferFeeAmountOut: u64(output),
        excludedTransferFeeAmountOut: u64(output),
        currentTimestamp: u64(timestamp),
        reserveAAmount: u64(0),
        reserveBAmount: u64(0),
      }),
    ],
  }
}

/**
 * A confirmed transaction in getTransaction's JSON encoding from instruction groups (see createIx):
 * account keys (the groups' signers first), outer instructions with their inner ones, the log lines
 * of each invocation and the token balances the groups left.
 */
export function buildTx(groups = [], { slot = 1, blockTime = NOW, err = null } = {}) {
  // Signers come first, the fee payer (the first group's first signer) leading, as on mainnet.
  const signers = [...new Set(groups.flatMap((g) => g.signers || []))]
  const keys = signers.length ? [...signers] : [address()]
  const index = (k) => {
    let i = keys.indexOf(k)
    if (i < 0) i = keys.push(k) - 1
    return i
  }
  const encode = (ix, stackHeight) => ({
    programIdIndex: index(ix.program),
    accounts: ix.accounts.map(index),
    data: bs58.encode(ix.data),
    stackHeight,
  })
  const logs = []
  const instructions = []
  const innerInstructions = []
  groups.forEach((group, i) => {
    instructions.push(encode(group, 1))
    logs.push(`Program ${group.program} invoke [1]`)
    const inner = (group.inner || []).map((ix) => {
      const depth = ix.stackHeight ?? 2
      logs.push(`Program ${ix.program} invoke [${depth}]`, `Program ${ix.program} success`)
      return encode(ix, depth)
    })
    logs.push(`Program ${group.program} success`)
    if (inner.length) innerInstructions.push({ index: i, instructions: inner })
  })
  // Token balances the groups left (a create's pool vaults), as the RPC reports them.
  const postTokenBalances = groups.flatMap((g) =>
    (g.balances || []).map(({ account, mint, owner, decimals, amount = '0' }) => ({
      accountIndex: index(account),
      mint,
      owner,
      programId: network.tokenProgram,
      uiTokenAmount: { amount: String(amount), decimals },
    })),
  )
  return {
    slot,
    blockTime,
    meta: {
      err,
      innerInstructions,
      logMessages: logs,
      loadedAddresses: { writable: [], readonly: [] },
      preTokenBalances: [],
      postTokenBalances,
    },
    transaction: {
      message: {
        accountKeys: keys,
        header: {
          numRequiredSignatures: Math.max(1, signers.length),
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions,
      },
      signatures: [],
    },
  }
}

// ---- accounts ---------------------------------------------------------------------------------
// An account of `name` with every field zero, to set the fields a test needs before encoding it.
const blank = (coder, idl, name) => {
  const disc = idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase()).discriminator
  const data = Buffer.alloc(coder.accounts.size(name))
  Buffer.from(disc).copy(data)
  return coder.accounts.decode(name, data)
}
// Anchor's own accounts.encode writes into a 1000-byte buffer, short of a PoolConfig or a DAMM v2
// Pool: encode into the account's real size instead.
const encode = (coder, name, value) => {
  const data = Buffer.alloc(coder.accounts.size(name))
  coder.accounts.accountDiscriminator(name).copy(data)
  coder.accounts.accountLayouts.get(name).layout.encode(value, data, 8)
  return data
}
const owned = (owner, data) => ({ data, owner: key(owner), lamports: 1_000_000, executable: false })

/** A DBC launch config: SOL-quoted, 6 decimals, filling at `threshold`. */
export async function dbcConfigAccount({
  quoteMint = WSOL,
  threshold = THRESHOLD,
  migrationFeeOption = 6,
  tokenDecimal = network.tokenDecimals,
} = {}) {
  const config = blank(dbcCoder, dbcIdl, 'poolConfig')
  Object.assign(config, {
    quoteMint: key(quoteMint),
    migrationQuoteThreshold: u64(threshold),
    migrationFeeOption,
    tokenDecimal,
    activationType: 1,
  })
  return owned(DBC, encode(dbcCoder, 'poolConfig', config))
}

/**
 * A coin's DBC pool at `price`, holding `quoteReserve` lamports. `complete`: the curve filled and
 * awaits migration; `migrated`: Meteora moved it into its DAMM v2 pool.
 */
export async function dbcPoolAccount(
  mint,
  {
    creator,
    config = CONFIG,
    price = 3e-8,
    quoteReserve = 1_000_000_000n,
    complete = false,
    migrated = false,
  },
) {
  const pool = blank(dbcCoder, dbcIdl, 'virtualPool')
  const pda = dbcPoolFor(mint, config)
  Object.assign(pool.poolState, {
    config: key(config),
    creator: key(creator),
    baseMint: key(mint),
    baseVault: dbcVaultPda(pda, mint),
    quoteVault: dbcVaultPda(pda, WSOL),
    quoteReserve: u64(complete || migrated ? THRESHOLD : quoteReserve),
    sqrtPrice: u64(sqrtPriceFor(price)),
    migrationProgress: migrated ? 3 : complete ? 1 : 0,
    isMigrated: migrated ? 1 : 0,
  })
  return owned(DBC, encode(dbcCoder, 'virtualPool', pool))
}

/** A coin's DAMM v2 pool (token A the coin, B WSOL) at `price`. */
export async function dammPoolAccount(mint, { price = 1e-7, liquidity = 1_000_000n, status = 0 }) {
  const pool = blank(dammCoder, dammIdl, 'pool')
  Object.assign(pool, {
    tokenAMint: key(mint),
    tokenBMint: key(WSOL),
    tokenAVault: Keypair.generate().publicKey,
    tokenBVault: Keypair.generate().publicKey,
    sqrtPrice: u64(sqrtPriceFor(price)),
    liquidity: u64(liquidity),
    poolStatus: status,
  })
  return owned(DAMM, encode(dammCoder, 'pool', pool))
}

/** A DAMM v2 position in `pool` whose NFT is `nftMint`. */
export async function dammPositionAccount(pool, nftMint, { liquidity = 0n } = {}) {
  const position = blank(dammCoder, dammIdl, 'position')
  Object.assign(position, {
    pool: key(pool),
    nftMint: key(nftMint),
    permanentLockedLiquidity: u64(liquidity),
  })
  return owned(DAMM, encode(dammCoder, 'position', position))
}

/** An SPL Token mint with `supply` raw units. */
export function mintAccount(supply = network.totalSupply, decimals = network.tokenDecimals) {
  const data = Buffer.alloc(82)
  data.writeBigUInt64LE(BigInt(supply), 36)
  data[44] = decimals
  data[45] = 1
  return owned(network.tokenProgram, data)
}

/**
 * The accounts of a live coin under `config`: its DBC pool (and DAMM v2 pool once `migrated`), as
 * { address: info } for chain.accounts.
 */
export async function coinAccounts(mint, options = {}) {
  const out = {
    [dbcPoolFor(mint, options.config)]: await dbcPoolAccount(mint, options),
  }
  if (options.migrated)
    out[dammPoolFor(mint)] = await dammPoolAccount(mint, { price: options.poolPrice })
  if (options.supply) out[mint] = mintAccount(options.supply)
  return out
}

// ---- in-memory store and chain ----------------------------------------------------------------
export function memoryStore({ latency = 0 } = {}) {
  const data = new Map()
  const sets = []
  const pause = () =>
    latency ? new Promise((r) => setTimeout(r, latency / 2 + Math.random() * latency)) : null
  const live = (k) => {
    const e = data.get(k)
    if (e?.expires && e.expires < Date.now()) data.delete(k)
    return data.get(k)
  }
  return {
    data,
    sets,
    async get(k) {
      await pause()
      const e = live(k)
      return e ? structuredClone(e.value) : null
    },
    async set(k, v, options = {}) {
      sets.push([k, options])
      await pause()
      if (options.nx && live(k)) return false
      data.set(k, {
        value: structuredClone(v),
        expires: options.ttl ? Date.now() + options.ttl : 0,
      })
      return true
    },
    async delete(k) {
      await pause()
      data.delete(k)
    },
    async release(k, owner) {
      await pause()
      if (live(k)?.value === owner) data.delete(k)
    },
  }
}

// Waits for fire-and-forget syncs (registerLaunch, track) to let go of their coin leases.
export async function idle(store) {
  for (let i = 0; i < 400; i++) {
    if (![...store.data.keys()].some((k) => k.startsWith('lease:') || k.startsWith('lock:'))) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw Error('background sync did not finish')
}

// The raw JSON-RPC getTransaction calls go through fetch: the chain made last answers them.
let current = null
const originalFetch = globalThis.fetch
export function installFetch(test) {
  globalThis.fetch = (url, init) =>
    current ? current.fetch(url, init) : Promise.reject(Error('offline'))
  test.after(() => {
    globalThis.fetch = originalFetch
  })
}

const POOL_DISCRIMINATOR = Buffer.from(
  dbcIdl.accounts.find((a) => a.name === 'VirtualPool').discriminator,
)

/**
 * An in-memory mainnet: `add(addresses, { ixs })` lands a transaction (instruction groups, see
 * buildTx, or a recorded `tx`) that touched `addresses`; `accounts` holds account infos by
 * address (Quant Pad's launch configs are there from the start). `policy(body)` may answer a
 * getTransaction request itself.
 */
export async function fakeChain(endpoint = 'http://chain.invalid') {
  const history = new Map() // address -> signatures, newest first
  const txs = new Map()
  const accounts = new Map()
  for (const tier of launchTiers) accounts.set(tier.config, MAINNET[tier.config])
  const fetched = []
  let slot = 5000
  const chain = {
    txs,
    accounts,
    fetched,
    listed: [],
    requests: [],
    reads: [], // the keys of every getMultipleAccountsInfo call
    policy: null,
    // `tx` lands a recorded mainnet transaction instead (its own slot and block time).
    add(addresses, { ixs = [], tx, blockTime = NOW, sameSlot = false, sig = signature() } = {}) {
      if (!sameSlot) slot++
      txs.set(sig, tx ? structuredClone(tx) : buildTx(ixs, { slot, blockTime }))
      if (tx) [slot, blockTime] = [Math.max(slot, tx.slot), tx.blockTime]
      for (const a of addresses) {
        if (!history.has(a)) history.set(a, [])
        history.get(a).unshift({ signature: sig, slot, blockTime, err: null })
      }
      return sig
    },
    async setAccounts(entries) {
      for (const [k, info] of Object.entries(await entries)) accounts.set(k, info)
    },
    connection: {
      rpcEndpoint: endpoint,
      async getSignaturesForAddress(k, { until, before, limit = 1000 } = {}) {
        chain.listed.push({ address: k.toBase58(), until, before, limit })
        const all = history.get(k.toBase58()) || []
        let i = 0
        if (before) {
          i = all.findIndex((s) => s.signature === before) + 1
          if (!i) return []
        }
        const out = []
        for (; i < all.length && out.length < Math.min(limit, 1000); i++) {
          if (all[i].signature === until) break
          out.push({ ...all[i] })
        }
        return out
      },
      async getMultipleAccountsInfo(keys) {
        chain.reads.push(keys.map((k) => k.toBase58()))
        return keys.map((k) => accounts.get(k.toBase58()) || null)
      },
      async getAccountInfo(k) {
        return accounts.get(k.toBase58()) || null
      },
      // DBC pools by base mint (findDbcPool's fallback for coins under other configs).
      async getProgramAccounts(program, { filters = [] } = {}) {
        const mint = filters.find((f) => f.memcmp?.offset === 136)?.memcmp.bytes
        return [...accounts.entries()]
          .filter(
            ([, info]) =>
              info.owner?.toBase58?.() === program.toBase58() &&
              Buffer.from(info.data).subarray(0, 8).equals(POOL_DISCRIMINATOR) &&
              (!mint || bs58.encode(Buffer.from(info.data).subarray(136, 168)) === mint),
          )
          .map(([pubkey, account]) => ({ pubkey: new PublicKey(pubkey), account }))
      },
    },
    async fetch(url, init) {
      const body = JSON.parse(init.body)
      chain.requests.push(body)
      const override = chain.policy?.(body)
      if (override) return override
      const calls = Array.isArray(body) ? body : [body]
      for (const c of calls) fetched.push(c.params[0])
      const answer = (c) => ({ jsonrpc: '2.0', id: c.id, result: txs.get(c.params[0]) || null })
      return Response.json(Array.isArray(body) ? calls.map(answer) : answer(body))
    },
  }
  current = chain
  return chain
}

// A Quantum client double: `register(mint, launcher)` serves a Quantum account at quantumPda(mint)
// naming its launcher; `well(mint)` is the coin's well.
export function fakeQuantum(chain) {
  const seed = new PublicKey('FgAfzGavpUSkhRo1Z1CWuGRrcz1AgZVFrkPeji8DuvWK')
  const pda = (tag, mint) =>
    PublicKey.findProgramAddressSync([Buffer.from(tag), mint.toBuffer()], seed)[0]
  return {
    wellPda: (mint) => pda('well', mint),
    quantumPda: (mint) => pda('quantum', mint),
    decodeQuantum: (data) => JSON.parse(Buffer.from(data).toString()),
    register(mint, launcher) {
      chain.accounts.set(pda('quantum', new PublicKey(mint)).toBase58(), {
        data: Buffer.from(JSON.stringify({ launcher, createdAt: NOW - 30 })),
      })
    },
    well: (mint) => pda('well', new PublicKey(mint)).toBase58(),
  }
}
