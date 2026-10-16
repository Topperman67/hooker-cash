// The dev-only $QUANTP burner's transaction (src/lib/burn.js): which token accounts it burns from
// and the Token-2022 BurnChecked it builds, and the post it writes after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, decodeBurnCheckedInstruction } from '@solana/spl-token'
import { burnInstructions, burnPlan, burnTweet } from '../../src/lib/burn.js'
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
