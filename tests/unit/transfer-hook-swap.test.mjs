// Trading Token-2022 coins with a transfer hook ($QUANTP's kind): resolving the hook's extra
// accounts from the chain, the swap2_with_transfer_hook build for a DBC TransferHookPool, the
// Token-2022 DAMM v2 build a graduated hook coin trades with (DBC revokes the hook at migration),
// which Token-2022 extensions block a trade, the pool fee and price impact a quote reports, and the
// errors a hook trade can fail with.
//
// tests/fixtures/transfer-hook-accounts.json holds mainnet accounts read on 2026-10-16:
// - Midas's other coin D39Uo… on its curve, under the hook program $QUANTP had (4xh25C…): one
//   extra account, the whitelist PDA.
// - 8V2jTn… on its curve, whose hook (4Tabcoy…) takes four extras, the Instructions sysvar among
//   them. A sell built this way simulated on mainnet with the output equal to the quote.
// - $QUANTP after graduation: its migrated TransferHookPool, config, the revoked-hook mint and
//   its DAMM v2 pool EkUL2W….
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

// src/lib/solana.js builds its Connection from window.location at import time.
globalThis.window ??= { location: { origin: 'http://127.0.0.1:9' } }

const meteora = await import('../../shared/meteora.mjs')
const { QUANTP } = await import('../../shared/network.mjs')
const solana = await import('../../src/lib/solana.js')
const trade = await import('../../src/lib/trade.js')
const txerrors = await import('../../src/lib/txerrors.js')
const amounts = await import('../../src/lib/amounts.js')

const ACCOUNTS = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(new URL('../fixtures/transfer-hook-accounts.json', import.meta.url), 'utf8'),
    ),
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
const MIDAS = {
  mint: 'D39UoLNuu9hzszUhk9gD6XyeLC2FGgteMNb2AAiT927G',
  dbcPool: 'EN9ctHbraq52QV3iMatYGXop4YivTYfw5boc2fYtQ15A',
  hook: '4xh25C2V65F5buKwKzYpSKHdhz7xTfNTJofCgB1WTDrE',
  metas: 'HPVCiQkeBASKdC1PK8hvZ3AiDtgp2Xq6bnnCCQSjLmCM',
  whitelist: '8rppa2uvGXFtyiBfqetkrvErcJ6hWh74CeZpTy5nvQYW',
}
const COSIGN = {
  mint: '8V2jTnUbfTDkzznAD2BwhCRR1jJrin3Exj5zPoU2AmJA',
  dbcPool: '6tdNjDNFzDdEuKyyvtKtke4Zuarp3MyZwCiERwTsq5Xg',
  hook: '4Tabcoy1niosiNAGHMruLBFscgJWXZsVF3pfij3FqMB5',
  metas: 'GbkBLpGFSfGP8qHygj9Ranh7Bxn6u5wxHSZtuHXkeBxG',
  extra: 'J6mMdv8DKXuXx1MRBbwtFhPSSS9AovXYUwjWbxMJiHfn',
}
const QP = {
  mint: QUANTP.mint,
  dbcPool: QUANTP.pool,
  damm: 'EkUL2WDEKdJK3hxTxcfhqK7GbwwpPoTEzi4quEVCM5rw',
}
const WSOL = NATIVE_MINT.toBase58()
const b58 = (k) => k.toBase58()
const key = () => Keypair.generate().publicKey

// A connection over `accounts` that counts its reads.
function fakeConnection(accounts = ACCOUNTS) {
  const reads = []
  return {
    reads,
    getAccountInfo: async (k) => (reads.push(['one', b58(k)]), accounts[b58(k)] ?? null),
    getMultipleAccountsInfo: async (keys) => (
      reads.push(['many', keys.map(b58)]),
      keys.map((k) => accounts[b58(k)] ?? null)
    ),
  }
}

// Serves `accounts` to src/lib/trade.js (through solana.js's connection) for the length of `fn`.
async function withChain(accounts, fn) {
  const fake = fakeConnection(accounts)
  const names = ['getAccountInfo', 'getMultipleAccountsInfo', 'getSlot', 'getBalance']
  const saved = Object.fromEntries(names.map((n) => [n, solana.connection[n]]))
  Object.assign(solana.connection, {
    getAccountInfo: fake.getAccountInfo,
    getMultipleAccountsInfo: fake.getMultipleAccountsInfo,
    getSlot: async () => 400_000_000,
    getBalance: async () => 1_000_000_000,
  })
  try {
    return await fn(fake)
  } finally {
    Object.assign(solana.connection, saved)
  }
}

// A Token-2022 mint account with `extensions` ([type, data] pairs, spl-token ExtensionType numbers).
function token2022Mint(extensions) {
  const base = Buffer.alloc(165)
  base.writeBigUInt64LE(10n ** 15n, 36) // supply
  base[44] = 6 // decimals
  base[45] = 1 // initialised
  const tlv = extensions.map(([type, data]) => {
    const head = Buffer.alloc(4)
    head.writeUInt16LE(type, 0)
    head.writeUInt16LE(data.length, 2)
    return Buffer.concat([head, data])
  })
  return {
    owner: TOKEN_2022_PROGRAM_ID,
    lamports: 1,
    data: Buffer.concat([base, Buffer.from([1]), ...tlv]), // AccountType.Mint
    executable: false,
  }
}
const hookExtension = (program) => [
  14, // TransferHook: authority, program
  Buffer.concat([key().toBuffer(), new PublicKey(program).toBuffer()]),
]
const metadataPointer = [18, Buffer.alloc(64)]
const metasAddress = (mint, program) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('extra-account-metas'), new PublicKey(mint).toBuffer()],
    new PublicKey(program),
  )[0]

const isDbc = (ix) => ix.programId.equals(meteora.DBC_PROGRAM_ID)
const isDamm = (ix) => ix.programId.equals(meteora.DAMM_V2_PROGRAM_ID)
const ataCreates = (ixs) => ixs.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID))

// ---- resolving the hook's accounts ------------------------------------------------------------

test('transferHookAccounts reads the extras from the hook’s metas account, then the program and the metas account', async () => {
  const user = key()
  const vault = new PublicKey(meteora.decodeDbcPool(ACCOUNTS[MIDAS.dbcPool].data).baseVault)
  const account = getAssociatedTokenAddressSync(
    new PublicKey(MIDAS.mint),
    user,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const connection = fakeConnection()
  const buy = await meteora.transferHookAccounts(connection, MIDAS.mint, {
    source: vault,
    destination: account,
    owner: meteora.DBC_POOL_AUTHORITY,
  })
  assert.deepEqual(
    buy.map((a) => [b58(a.pubkey), a.isSigner, a.isWritable]),
    [
      [MIDAS.whitelist, false, false], // PDA ['whitelist', mint] of the hook program
      [MIDAS.hook, false, false],
      [MIDAS.metas, false, false],
    ],
  )
  // The mint, then the metas account: nothing else is read.
  assert.deepEqual(
    connection.reads.map(([, k]) => k),
    [MIDAS.mint, MIDAS.metas],
  )
  // A mint the caller already read is not read again.
  const sell = await meteora.transferHookAccounts(connection, MIDAS.mint, {
    source: account,
    destination: vault,
    owner: user,
    mintInfo: ACCOUNTS[MIDAS.mint],
  })
  assert.deepEqual(
    sell.map((a) => b58(a.pubkey)),
    buy.map((a) => b58(a.pubkey)),
  )
  assert.equal(connection.reads.length, 3)
  // A hook with four extras (one of them the Instructions sysvar) resolves in its own order.
  const cosign = await meteora.transferHookAccounts(fakeConnection(), COSIGN.mint, {
    source: key(),
    destination: key(),
    owner: key(),
  })
  assert.deepEqual(
    cosign.map((a) => b58(a.pubkey)),
    [COSIGN.extra, b58(SYSVAR_INSTRUCTIONS_PUBKEY), COSIGN.hook, COSIGN.metas],
  )
})

test('a mint with no hook, a revoked hook or no metas account needs no extras (or just the program)', async () => {
  // $QUANTP after graduation: DBC revoked its hook, which leaves the extension with no program.
  const revoked = ACCOUNTS[QP.mint]
  assert.ok(revoked.owner.equals(TOKEN_2022_PROGRAM_ID))
  assert.equal(meteora.transferHookProgram(QP.mint, revoked), null)
  const owner = key()
  const args = { source: key(), destination: key(), owner }
  assert.deepEqual(await meteora.transferHookAccounts(fakeConnection(), QP.mint, args), [])
  // An SPL Token mint.
  const spl = { owner: TOKEN_PROGRAM_ID, lamports: 1, data: Buffer.alloc(82), executable: false }
  const splMint = key()
  assert.equal(meteora.transferHookProgram(splMint, spl), null)
  assert.deepEqual(
    await meteora.transferHookAccounts(fakeConnection({ [b58(splMint)]: spl }), splMint, args),
    [],
  )
  // A hook whose metas account does not exist: Token-2022 still needs its program.
  const program = key()
  const mint = key()
  const bare = { [b58(mint)]: token2022Mint([hookExtension(program)]) }
  assert.ok(meteora.transferHookProgram(mint, bare[b58(mint)]).equals(program))
  const accounts = await meteora.transferHookAccounts(fakeConnection(bare), mint, args)
  assert.deepEqual(
    accounts.map((a) => b58(a.pubkey)),
    [b58(program), b58(metasAddress(mint, program))],
  )
  await assert.rejects(meteora.transferHookAccounts(fakeConnection({}), key(), args), /not exist/)
})

// ---- the builders -----------------------------------------------------------------------------

test('dbcSwapInstructions builds swap2_with_transfer_hook with Token-2022 accounts and the hook’s extras', async () => {
  const user = key()
  const pool = meteora.decodeDbcPool(ACCOUNTS[MIDAS.dbcPool].data)
  const hook = [MIDAS.whitelist, MIDAS.hook, MIDAS.metas].map((k) => ({
    pubkey: new PublicKey(k),
    isSigner: false,
    isWritable: false,
  }))
  const coin = getAssociatedTokenAddressSync(
    new PublicKey(MIDAS.mint),
    user,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  for (const firstSwap of [false, true]) {
    const ixs = await meteora.dbcSwapInstructions({
      config: pool.config,
      mint: MIDAS.mint,
      user,
      side: 'buy',
      amountIn: 10_000_000n,
      minOut: 5n,
      mode: meteora.SWAP_MODE.PARTIAL_FILL,
      firstSwap,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      transferHookAccounts: hook,
    })
    const swap = ixs.find(isDbc)
    const { name, data } = meteora.dbcCoder.instruction.decode(swap.data)
    assert.equal(name, 'swap2WithTransferHook')
    assert.equal(swap.data.subarray(0, 8).toString('hex'), 'b75d992818e6c297')
    assert.equal(data.params.amount0.toString(), '10000000')
    assert.equal(data.params.amount1.toString(), '5')
    assert.equal(data.params.swapMode, meteora.SWAP_MODE.PARTIAL_FILL)
    assert.deepEqual(data.transferHookAccountsInfo.slices, [
      { accountsType: { transferHookBase: {} }, length: 3 },
    ])
    // IDL order: the pool is the derived one, the coin account is the Token-2022 ATA, the base mint
    // is writable (DBC revokes the hook through it), token_base_program is Token-2022.
    const keys = swap.keys
    assert.equal(b58(keys[2].pubkey), MIDAS.dbcPool)
    assert.ok(keys[4].pubkey.equals(coin))
    assert.equal(b58(keys[5].pubkey), pool.baseVault)
    assert.equal(b58(keys[7].pubkey), MIDAS.mint)
    assert.equal(keys[7].isWritable, true)
    assert.ok(keys[10].pubkey.equals(TOKEN_2022_PROGRAM_ID))
    assert.ok(keys[11].pubkey.equals(TOKEN_PROGRAM_ID))
    // Remaining accounts: the optional sysvar, then the hook's, in order and read-only.
    const remaining = keys.slice(15)
    assert.deepEqual(
      remaining.map((k) => b58(k.pubkey)),
      [...(firstSwap ? [b58(SYSVAR_INSTRUCTIONS_PUBKEY)] : []), ...hook.map((h) => b58(h.pubkey))],
    )
    assert.ok(remaining.every((k) => !k.isWritable && !k.isSigner))
    // The coin's account is created for Token-2022; WSOL stays SPL Token.
    const [wsolCreate, coinCreate] = ataCreates(ixs)
    assert.ok(wsolCreate.keys[5].pubkey.equals(TOKEN_PROGRAM_ID))
    assert.ok(coinCreate.keys[1].pubkey.equals(coin))
    assert.ok(coinCreate.keys[5].pubkey.equals(TOKEN_2022_PROGRAM_ID))
  }
})

test('dbcSwapInstructions and dammSwapInstructions keep their SPL Token build by default', async () => {
  const user = key()
  const mint = key()
  const config = meteora.decodeDbcPool(ACCOUNTS[MIDAS.dbcPool].data).config
  const spl = getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID)
  const dev = await meteora.dbcSwapInstructions({
    config,
    mint,
    user,
    side: 'buy',
    amountIn: 1_000_000n,
    minOut: 1n,
    mode: meteora.SWAP_MODE.EXACT_OUT,
    firstSwap: true,
  })
  const swap = dev.find(isDbc)
  assert.equal(meteora.dbcCoder.instruction.decode(swap.data).name, 'swap2')
  assert.ok(swap.keys[4].pubkey.equals(spl))
  assert.ok(swap.keys[10].pubkey.equals(TOKEN_PROGRAM_ID))
  assert.deepEqual(
    swap.keys.slice(15).map((k) => b58(k.pubkey)),
    [b58(SYSVAR_INSTRUCTIONS_PUBKEY)],
  )
  assert.ok(ataCreates(dev)[1].keys[5].pubkey.equals(TOKEN_PROGRAM_ID))
  // DAMM v2: tokenAProgram and the coin's account follow `tokenAProgram`.
  const damm = meteora.decodeDammPool(ACCOUNTS[QP.damm].data)
  for (const [program, expected] of [
    [undefined, TOKEN_PROGRAM_ID],
    [TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
  ]) {
    const ixs = await meteora.dammSwapInstructions({
      damm,
      dammPool: QP.damm,
      mint: QP.mint,
      user,
      side: 'sell',
      amountIn: 1_000_000n,
      minOut: 1n,
      ...(program ? { tokenAProgram: program } : {}),
    })
    const swap = ixs.find(isDamm)
    const coin = getAssociatedTokenAddressSync(new PublicKey(QP.mint), user, true, expected)
    assert.ok(swap.keys[2].pubkey.equals(coin), 'input is the coin account')
    assert.ok(swap.keys[9].pubkey.equals(expected), 'token_a_program')
    assert.ok(swap.keys[10].pubkey.equals(TOKEN_PROGRAM_ID), 'token_b_program')
    assert.ok(ataCreates(ixs)[1].keys[5].pubkey.equals(expected))
  }
})

// ---- the ticket's market reads and builds ------------------------------------------------------

test('a curve hook coin reads in batched calls, quotes exactly and builds the hook swap for each side', async () => {
  await withChain(ACCOUNTS, async (chain) => {
    const user = key()
    const state = await trade.marketState(COSIGN.mint, b58(user), COSIGN.dbcPool)
    // First read: the mint and pool, then the config and the hook's metas account.
    assert.deepEqual(
      chain.reads.map(([kind]) => kind),
      ['many', 'many'],
    )
    assert.equal(state.venue, 'curve')
    assert.ok(state.tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
    assert.equal(b58(state.hookProgram), COSIGN.hook)
    assert.ok(state.extensions.includes('TransferHook'))
    assert.equal(trade.tradeBlocker(state), null)
    for (const side of ['buy', 'sell'])
      assert.deepEqual(
        state.hookAccounts[side].map((a) => b58(a.pubkey)),
        [COSIGN.extra, b58(SYSVAR_INSTRUCTIONS_PUBKEY), COSIGN.hook, COSIGN.metas],
      )
    // A refresh is one call, for every account at once.
    chain.reads.length = 0
    await trade.marketState(COSIGN.mint, b58(user), COSIGN.dbcPool)
    assert.deepEqual(
      chain.reads.map(([kind]) => kind),
      ['many'],
    )
    assert.equal(chain.reads[0][1].length, 4)

    // The quote is the SDK's, with the curve's fee and the price impact.
    const tokens = 1_000_000_000_000n
    const sold = trade.quoteSell(state, tokens, 2)
    const exact = meteora.dbcQuote({
      pool: state.pool,
      config: state.config,
      side: 'sell',
      amountIn: tokens,
      slippageBps: 200,
      currentPoint: state.point,
    })
    assert.equal(sold.lamports, exact.out)
    assert.equal(sold.minLamports, exact.minOut)
    assert.equal(sold.fee, exact.fee)
    assert.equal(sold.feeToken, 'sol')
    assert.ok(sold.impact > 0 && sold.impact < 0.05)
    assert.equal(Math.round(trade.poolFeeBps(state)), 100)

    const platform = { feeBps: 0, treasury: null }
    const sell = await trade.sellInstructions({
      mint: COSIGN.mint,
      user: b58(user),
      tokens,
      slippagePct: 2,
      platform,
      dbcPool: COSIGN.dbcPool,
    })
    const swap = sell.instructions.find(isDbc)
    const decoded = meteora.dbcCoder.instruction.decode(swap.data)
    assert.equal(decoded.name, 'swap2WithTransferHook')
    assert.equal(decoded.data.params.swapMode, meteora.SWAP_MODE.EXACT_IN)
    assert.equal(decoded.data.params.amount1.toString(), exact.minOut.toString())
    assert.equal(decoded.data.transferHookAccountsInfo.slices[0].length, 4)
    assert.deepEqual(
      swap.keys.slice(15).map((k) => b58(k.pubkey)),
      state.hookAccounts.sell.map((a) => b58(a.pubkey)),
    )
    const buy = await trade.buyInstructions({
      mint: COSIGN.mint,
      user: b58(user),
      lamports: 10_000_000n,
      slippagePct: 2,
      platform,
      dbcPool: COSIGN.dbcPool,
    })
    const buySwap = buy.instructions.find(isDbc)
    const params = meteora.dbcCoder.instruction.decode(buySwap.data).data.params
    assert.equal(params.swapMode, meteora.SWAP_MODE.PARTIAL_FILL)
    assert.equal(params.amount0.toString(), '10000000')
    const quoted = trade.quoteBuy(state, 10_000_000n, 2)
    assert.equal(buy.expected, quoted.tokens)
    assert.equal(
      BigInt(params.amount1.toString()),
      amounts.minimumOut(quoted.tokens, 2),
      'min out is the quote less the slippage picked',
    )
    // The buy spends exactly what was entered: the wrap and the swap's budget.
    const wrapped = buy.instructions
      .filter((ix) => ix.programId.equals(SystemProgram.programId))
      .reduce((sum, ix) => sum + ix.data.readBigUInt64LE(4), 0n)
    assert.equal(wrapped, 10_000_000n)
  })
})

test('$QUANTP after graduation trades as plain Token-2022 in its DAMM v2 pool at 5%', async () => {
  await withChain(ACCOUNTS, async (chain) => {
    const user = key()
    const state = await trade.marketState(QP.mint, b58(user), QP.dbcPool)
    // The mint and pool, then the config, then the DAMM v2 pool its address needs.
    assert.deepEqual(
      chain.reads.map(([kind]) => kind),
      ['many', 'many', 'many'],
    )
    assert.equal(state.venue, 'pool')
    assert.equal(b58(state.dammPool), QP.damm)
    assert.equal(state.pool.transferHook, true)
    assert.equal(state.hookProgram, null)
    assert.ok(state.extensions.includes('TransferHook'))
    assert.ok(state.tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
    assert.equal(trade.tradeBlocker(state), null)
    assert.equal(trade.poolFeeBps(state, 'buy'), 500)
    assert.equal(trade.poolFeeBps(state, 'sell'), 500)
    assert.equal(trade.currentTaxBps(state), null)

    const bought = trade.quoteBuy(state, 10_000_000n, 2)
    const exact = meteora.dammQuote({
      damm: state.damm,
      side: 'buy',
      amountIn: 10_000_000n,
      slippageBps: 200,
      currentPoint: state.point,
    })
    assert.equal(bought.tokens, exact.out)
    // This pool takes its fee in SOL (collect mode OnlyB): 5% of the SOL in.
    assert.equal(bought.feeToken, 'sol')
    assert.equal(bought.fee, 500_000n)
    const built = await trade.buyInstructions({
      mint: QP.mint,
      user: b58(user),
      lamports: 10_000_000n,
      slippagePct: 2,
      platform: { feeBps: 0, treasury: null },
      dbcPool: QP.dbcPool,
    })
    assert.equal(built.venue, 'pool')
    const swap = built.instructions.find(isDamm)
    assert.equal(meteora.dammCoder.instruction.decode(swap.data).name, 'swap2')
    const coin = getAssociatedTokenAddressSync(
      new PublicKey(QP.mint),
      user,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
    assert.ok(swap.keys[3].pubkey.equals(coin), 'the coin arrives in its Token-2022 account')
    assert.ok(swap.keys[9].pubkey.equals(TOKEN_2022_PROGRAM_ID))
    assert.equal(swap.keys.length, 14, 'no hook accounts after graduation')
    assert.ok(ataCreates(built.instructions)[1].keys[5].pubkey.equals(TOKEN_2022_PROGRAM_ID))
  })
})

test('the ticket finds a coin’s pool from its config, and refuses only extensions it cannot honour', async () => {
  const config = meteora.decodeDbcPool(ACCOUNTS[MIDAS.dbcPool].data).config
  assert.equal(trade.dbcPoolFor(config, MIDAS.mint), MIDAS.dbcPool)
  const blocker = async (mintInfo) =>
    withChain({ ...ACCOUNTS, [MIDAS.mint]: mintInfo }, async () =>
      trade.tradeBlocker(await trade.marketState(MIDAS.mint, null, MIDAS.dbcPool)),
    )
  // Plain Token-2022 (metadata and a hook): tradable. Before, every Token-2022 coin was refused.
  assert.equal(await blocker(token2022Mint([metadataPointer, hookExtension(MIDAS.hook)])), null)
  for (const [type, length, message] of [
    [1, 108, /transfer fee/],
    [9, 0, /cannot be transferred/],
    [12, 32, /permanent delegate/],
    [26, 33, /paused/],
    [4, 65, /confidential/],
  ])
    assert.match(
      await blocker(token2022Mint([[type, Buffer.alloc(length)], hookExtension(MIDAS.hook)])),
      message,
    )
  // A hook whose extras cannot be resolved (its metas account does not decode): no trade until
  // they can be, and the market read itself still works.
  const broken = key()
  const unreadable = await withChain(
    {
      ...ACCOUNTS,
      [MIDAS.mint]: token2022Mint([hookExtension(broken)]),
      [b58(metasAddress(MIDAS.mint, broken))]: {
        owner: broken,
        lamports: 1,
        data: Buffer.alloc(5),
        executable: false,
      },
    },
    () => trade.marketState(MIDAS.mint, null, MIDAS.dbcPool),
  )
  assert.equal(unreadable.hookAccounts, undefined)
  assert.match(trade.tradeBlocker(unreadable), /transfer hook needs/)

  // States as marketState returns them.
  const curve = await withChain(ACCOUNTS, () => trade.marketState(MIDAS.mint, null, MIDAS.dbcPool))
  assert.equal(trade.tradeBlocker(curve), null)
  assert.match(trade.tradeBlocker({ ...curve, hookAccounts: undefined }), /transfer hook needs/)
  assert.match(
    trade.tradeBlocker({ ...curve, venue: 'pool', damm: { tokenBMint: WSOL } }),
    /Meteora pool cannot run it/,
  )
  assert.match(
    trade.tradeBlocker({ ...curve, config: { ...curve.config, quoteMint: b58(key()) } }),
    /other than SOL/,
  )
  assert.match(trade.tradeBlocker({ venue: 'migrating' }), /bonding curve is full/)
})

// ---- quote details ----------------------------------------------------------------------------

test('swapQuoteDetails says which token the pool fee is taken in and the price impact', () => {
  const sqrt = (price) => BigInt(Math.round(Math.sqrt(price) * 2 ** 64)) // raw lamports per raw token
  // A buy whose fee comes off the SOL in (DBC; DAMM v2 collecting SOL only).
  const solFee = meteora.swapQuoteDetails(
    {
      includedFeeInputAmount: '1000000',
      excludedFeeInputAmount: '980000',
      outputAmount: '9800',
      tradingFee: '16000',
      protocolFee: '4000',
    },
    'buy',
    sqrt(100),
  )
  assert.equal(solFee.fee, 20_000n)
  assert.equal(solFee.feeToken, 'sol')
  assert.ok(Math.abs(solFee.impact) < 1e-9, 'filled at the pool price')
  // A DAMM v2 pool collecting both tokens takes a buy's fee from the coins it pays out.
  const tokenFee = meteora.swapQuoteDetails(
    {
      includedFeeInputAmount: '1000000',
      excludedFeeInputAmount: '1000000',
      outputAmount: '9500',
      claimingFee: '400',
      protocolFee: '100',
    },
    'buy',
    sqrt(95),
  )
  assert.equal(tokenFee.fee, 500n)
  assert.equal(tokenFee.feeToken, 'token')
  // 1,000,000 lamports for 10,000 tokens before the fee: 100 per token against 95 spot.
  assert.ok(Math.abs(tokenFee.impact - (100 / 95 - 1)) < 1e-9)
  // A sell: its fee comes off the SOL out.
  const sell = meteora.swapQuoteDetails(
    {
      includedFeeInputAmount: '10000',
      excludedFeeInputAmount: '10000',
      outputAmount: '950000',
      tradingFee: '50000',
    },
    'sell',
    sqrt(100),
  )
  assert.equal(sell.feeToken, 'sol')
  assert.ok(Math.abs(sell.impact) < 1e-9)
  assert.equal(meteora.swapQuoteDetails({ outputAmount: '0' }, 'buy', 0n).impact, null)
})

// ---- errors -----------------------------------------------------------------------------------

test('transfer-hook failures read as the hook’s doing, and DBC’s hook errors are worded', () => {
  const { explainCustomError, explainSimulation, friendlyWalletError, MESSAGES, PROGRAMS } =
    txerrors
  for (const code of [6070, 6071, 6073, 6074, 6077])
    assert.equal(explainCustomError(PROGRAMS.dbc, code), MESSAGES.hookAccounts)
  assert.match(explainCustomError(PROGRAMS.dbc, 6076), /different kind of swap/)
  assert.match(explainCustomError(PROGRAMS.dbc, 6075), /wrong Meteora pool/)
  assert.match(explainCustomError(PROGRAMS.dbc, 6072), /no longer has a transfer hook/)
  // $QUANTP's hook program is known from the start; others once the ticket meets them.
  const failing = (program, code) => [
    `Program ${PROGRAMS.dbc} invoke [1]`,
    `Program ${PROGRAMS.token2022} invoke [2]`,
    `Program ${program} invoke [3]`,
    `Program log: AnchorError thrown in lib.rs:181. Error Code: NotThroughApps. Error Number: ${code}.`,
    `Program ${program} failed: custom program error: 0x${code.toString(16)}`,
    `Program ${PROGRAMS.token2022} failed: custom program error: 0x${code.toString(16)}`,
    `Program ${PROGRAMS.dbc} failed: custom program error: 0x${code.toString(16)}`,
  ]
  const err = { InstructionError: [6, { Custom: 6000 }] }
  assert.equal(
    explainSimulation({ err, logs: failing(QUANTP.hookProgram, 6000) }),
    MESSAGES.hookRefused,
  )
  const other = b58(key())
  assert.match(explainSimulation({ err, logs: failing(other, 6000) }), /in a Solana program|error/)
  txerrors.registerTransferHook(other)
  assert.equal(explainSimulation({ err, logs: failing(other, 6000) }), MESSAGES.hookRefused)
  // Midas's whitelist before the open time.
  const whitelist = [
    `Program ${QUANTP.hookProgram} invoke [3]`,
    "Program log: 7cAJ… isn't whitelisted before the open time",
    `Program ${QUANTP.hookProgram} failed: custom program error: 0x1770`,
  ]
  assert.equal(explainSimulation({ err, logs: whitelist }), MESSAGES.hookWhitelist)
  assert.equal(
    friendlyWalletError(Object.assign(Error('Transaction simulation failed'), { logs: whitelist })),
    MESSAGES.hookWhitelist,
  )
  // Unrelated failures keep their own wording.
  assert.equal(explainCustomError(PROGRAMS.dbc, 6002), MESSAGES.slippage)
})

// ---- the ticket -------------------------------------------------------------------------------

test('the ticket shows the pool’s own fee for coins outside Quant Pad’s tiers and needs no coin record', () => {
  const ticket = readFileSync(
    new URL('../../src/components/TradeTicket.jsx', import.meta.url),
    'utf8',
  )
  // Its contract: the few coin fields it reads.
  const header = ticket.slice(0, ticket.indexOf('import '))
  for (const field of ['mint', 'symbol', 'dbcPool', 'dbcConfig', 'decimals'])
    assert.match(header, new RegExp(`\\b${field}\\b`))
  assert.match(
    ticket,
    /const poolFee = !tier && trade && market \? trade\.poolFeeBps\(market, side\)/,
  )
  assert.match(ticket, /<dt>Pool fee<\/dt>/)
  assert.match(ticket, /<dt>Price impact<\/dt>/)
  assert.match(ticket, /trade\.dbcPoolFor\(coin\.dbcConfig, coin\.mint\)/)
  assert.match(ticket, /trade\.marketState\(coin\.mint, address, dbcPool\)/)
  // A trade never waits on the indexer: /api/sync after it may fail without a word.
  assert.match(ticket, /api\('\/api\/sync', \{ mint: coin\.mint \}\)\.catch\(\(\) => \{\}\)/)
  assert.doesNotMatch(ticket, /(api|useResource|fetch)\(\s*['`"]\/api\/coins/)
  assert.doesNotMatch(ticket, /7%/)
})
