// Burning $QUANTP the team bought back (src/pages/BurnPage.jsx, dev-only): which of the wallet's
// token accounts to burn from, and the Token-2022 BurnChecked instructions that do it, signed by
// the wallet itself. A burn, not a transfer to the incinerator: it lowers the mint's supply, which
// the site's Burned figure and Burns list (server/quantp.mjs) both read.
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, createBurnCheckedInstruction } from '@solana/spl-token'
import { QUANTP, explorer } from '../../shared/network.mjs'

/**
 * Which of `accounts` ({ address, amount } with raw amounts) to burn `amount` raw units from: the
 * largest first, as few as it takes. Throws a message to show when the amount is not positive or
 * the accounts hold less.
 */
export function burnPlan(accounts, amount) {
  let left = BigInt(amount ?? 0)
  if (left <= 0n) throw Error('Enter an amount above zero.')
  const held = accounts.map((a) => ({ address: a.address, amount: BigInt(a.amount) }))
  const total = held.reduce((s, a) => s + a.amount, 0n)
  if (left > total) throw Error(`This wallet holds less $${QUANTP.symbol} than that.`)
  const plan = []
  for (const a of held.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))) {
    if (left === 0n) break
    const take = a.amount < left ? a.amount : left
    if (take > 0n) plan.push({ account: a.address, amount: take })
    left -= take
  }
  return plan
}

/** One BurnChecked per planned account, with `owner` (the connected wallet) as the authority. */
export function burnInstructions(owner, plan, token = QUANTP) {
  const ownerKey = new PublicKey(owner)
  const mint = new PublicKey(token.mint)
  return plan.map(({ account, amount }) =>
    createBurnCheckedInstruction(
      new PublicKey(account),
      mint,
      ownerKey,
      BigInt(amount),
      token.decimals,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  )
}

/**
 * The post announcing a burn: what was burned, the SOL the burned tokens were bought back with
 * when known (lamports), and the transaction.
 */
export function burnTweet({ amount, lamports, signature, token = QUANTP }) {
  const whole = (Number(BigInt(amount)) / 10 ** token.decimals).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })
  const sol = lamports == null ? null : (Number(lamports) / 1e9).toFixed(4).replace(/\.?0+$/, '')
  return [
    `$${token.symbol} buyback & burn 🔥`,
    ``,
    sol
      ? `${whole} $${token.symbol} burned, bought back with ${sol} SOL of the creator fees.`
      : `${whole} $${token.symbol} burned.`,
    ``,
    `Tx: ${explorer.tx(signature)}`,
    ``,
    `quantpad.company/quantp`,
  ].join('\n')
}
