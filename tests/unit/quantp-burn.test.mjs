// The dev-only $QUANTP burner's transaction (src/lib/burn.js): which token accounts it burns from
// and the Token-2022 BurnChecked it builds, and the post it writes after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, decodeBurnCheckedInstruction } from '@solana/spl-token'
import {
  burnInstructions,
  burnPlan,
  burnTweet,
  pendingFor,
  suggestedBurn,
} from '../../src/lib/burn.js'
import { QUANTP } from '../../shared/network.mjs'

const OWNER = QUANTP.payoutWallet
// two token accounts of the wallet (any valid addresses)
const ATA = new PublicKey(Buffer.alloc(32, 7)).toBase58()
const OTHER = new PublicKey(Buffer.alloc(32, 9)).toBase58()

test('the plan burns from the largest account first, using as few as it takes', () => {
  const accounts = [
    { address: OTHER, amount: '250000000' },
    { address: ATA, amount: 1_432_024_251_739n },
  ]
  assert.deepEqual(burnPlan(accounts, 1_000_000_000_000n), [
    { account: ATA, amount: 1_000_000_000_000n },
  ])
  // all of it: both accounts, the largest first
  assert.deepEqual(burnPlan(accounts, 1_432_274_251_739n), [
    { account: ATA, amount: 1_432_024_251_739n },
    { account: OTHER, amount: 250_000_000n },
  ])
  assert.throws(() => burnPlan(accounts, 0n), /above zero/)
  assert.throws(() => burnPlan(accounts, null), /above zero/)
  assert.throws(() => burnPlan(accounts, 1_432_274_251_740n), /holds less \$QUANTP/)
  assert.throws(() => burnPlan([], 1n), /holds less/)
})

test('the amount starts at what waits to be burned, never at a whole balance nothing waits for', () => {
  const held = 3_500_001_616_770n
  assert.equal(suggestedBurn(null, 1_492_751_997n), null, 'balance not read yet')
  assert.equal(suggestedBurn(held, 1_492_751_997n), 1_492_751_997n)
  // nothing bought back and not burned: nothing, not the wallet's 3.5M
  assert.equal(suggestedBurn(held, 0n), 0n)
  // more waiting than it holds: what it holds
  assert.equal(suggestedBurn(1_000n, 5_000n), 1_000n)
  assert.equal(suggestedBurn(0n, 5_000n), 0n)
})

test('what waits to be burned is the wallet’s own once the ledger keeps it per wallet', () => {
  const pooled = { lamports: '265899', amount: '1492751997' }
  // a ledger that pools the team's wallets
  assert.deepEqual(pendingFor({ unburned: pooled }, QUANTP.creator), pooled)
  // one that keeps them apart: the creator has none waiting, the payout wallet has it all
  const totals = { unburned: pooled, unburnedByWallet: { [QUANTP.payoutWallet]: pooled } }
  assert.deepEqual(pendingFor(totals, QUANTP.payoutWallet), pooled)
  assert.deepEqual(pendingFor(totals, QUANTP.creator), { lamports: '0', amount: '0' })
  assert.equal(pendingFor(null, QUANTP.creator), null)
})

test('each burn is a Token-2022 BurnChecked of $QUANTP at 6 decimals, signed by the wallet', () => {
  const [ix, second] = burnInstructions(OWNER, [
    { account: ATA, amount: 1_432_024_251_739n },
    { account: OTHER, amount: 250_000_000n },
  ])
  assert.ok(ix.programId.equals(TOKEN_2022_PROGRAM_ID))
  const decoded = decodeBurnCheckedInstruction(ix, TOKEN_2022_PROGRAM_ID)
  assert.equal(decoded.keys.account.pubkey.toBase58(), ATA)
  assert.equal(decoded.keys.mint.pubkey.toBase58(), QUANTP.mint)
  assert.equal(decoded.keys.owner.pubkey.toBase58(), OWNER)
  assert.equal(decoded.keys.owner.isSigner, true)
  assert.equal(decoded.keys.account.isWritable, true)
  assert.equal(decoded.keys.mint.isWritable, true) // the supply goes down
  assert.equal(decoded.data.amount, 1_432_024_251_739n)
  assert.equal(decoded.data.decimals, 6)
  assert.equal(
    decodeBurnCheckedInstruction(second, TOKEN_2022_PROGRAM_ID).data.amount,
    250_000_000n,
  )
  assert.throws(() => burnInstructions('not a key', [{ account: ATA, amount: 1n }]))
})

test('the post names the burn, the SOL it was bought back with, and the transaction', () => {
  const signature = '4NbPdJNf'.padEnd(88, '1')
  const tweet = burnTweet({ amount: 1_432_024_251_739n, lamports: 320_013_872n, signature })
  assert.match(tweet, /^\$QUANTP buyback & burn 🔥/)
  assert.match(tweet, /1,432,024 \$QUANTP burned, bought back with 0\.32 SOL of the creator fees\./)
  assert.match(tweet, new RegExp(`Tx: https://solscan.io/tx/${signature}`))
  assert.match(tweet, /quantpad\.company\/quantp$/)
  // without the SOL known, just the burn
  assert.match(
    burnTweet({ amount: 5_000_000n, lamports: null, signature }),
    /^5 \$QUANTP burned\.$/m,
  )
})

test('the post never says a burn cost 0 SOL or burned 0 $QUANTP', () => {
  const signature = '4NbPdJNf'.padEnd(88, '1')
  // the 0.000266 SOL buyback of 1,492.75 $QUANTP the engine made on 2026-10-16 (it used to read
  // "bought back with 0 SOL")
  const small = burnTweet({ amount: 1_492_751_997n, lamports: '265899', signature })
  assert.match(
    small,
    /^1,492 \$QUANTP burned, bought back with 0\.0003 SOL of the creator fees\.$/m,
  )
  // under half the last of 4 decimals, significant digits
  assert.match(
    burnTweet({ amount: 1_000_000n, lamports: 26_589n, signature }),
    /bought back with 0\.0000266 SOL/,
  )
  // less than one token keeps its decimals
  assert.match(
    burnTweet({ amount: 500_000n, lamports: null, signature }),
    /^0\.5 \$QUANTP burned\.$/m,
  )
  assert.match(
    burnTweet({ amount: 1n, lamports: null, signature }),
    /^0\.000001 \$QUANTP burned\.$/m,
  )
  // nothing spent is not "0 SOL": the clause goes
  assert.match(burnTweet({ amount: 5_000_000n, lamports: 0n, signature }), /^5 \$QUANTP burned\.$/m)
  for (const lamports of [1n, 49n, 265_899n, 4_999n])
    assert.doesNotMatch(burnTweet({ amount: 1n, lamports, signature }), /\b0 SOL|\b0 \$QUANTP/)
})
