// A read-only check of the $QUANTP payout engine on mainnet: builds the run it would send now,
// exactly as its tick does (server/quantp-engine.mjs draft(): the hour's claim, the payout batches
// with their memos and the buyback with its memo), paid by the engine wallet's public key, and
// simulates each transaction (signatures not checked, blockhash replaced). Nothing is signed or
// sent, and the engine's key is never needed: the claim is seeded with a throwaway key, so its
// account is one nobody has made. One more simulation creates a claim account and takes its rent
// back in the same transaction, which checks the reclaim a later hour makes.
//
//   node scripts/simulate-engine-run.mjs [rpc url]
//
// It reads the supply and market cap from the site (/api/quantp), and exits 1 when a transaction
// would fail.
import { Connection, Keypair } from '@solana/web3.js'
import {
  claimInstructions,
  createQuantpEngine,
  engineTransaction,
} from '../server/quantp-engine.mjs'
import { QUANTP } from '../shared/network.mjs'

const rpc = process.argv[2] || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const site = process.env.QUANTPAD_SITE || 'https://www.quantpad.company'
const connection = new Connection(rpc, 'confirmed')

// The feed the engine plans with: the site's own figures.
const feed = {
  async snapshot() {
    const res = await fetch(`${site}/api/quantp`)
    if (!res.ok) throw Error(`${site}/api/quantp answered ${res.status}`)
    const q = await res.json()
    return { supply: q.supply, marketCapUsd: q.marketCapUsd }
  },
}
// draft() reads nothing from the store; this one is never written to.
const store = { get: async () => null, set: async () => false, release: async () => {} }
const engine = createQuantpEngine({ connection, store, feed, log: { ...console, warn() {} } })

const throwaway = Keypair.generate()
const { hour, state, transactions, stopped } = await engine.draft({
  secretKey: throwaway.secretKey,
})
const p = state.plan
const sol = (lamports) => (Number(lamports) / 1e9).toFixed(6)
console.log(`engine wallet ${QUANTP.engine.wallet}, hour ${hour}, rpc ${rpc}`)
console.log(
  `balance ${sol(state.balance)} SOL, market cap $${Math.round(state.marketCapUsd ?? 0)}, ` +
    `release ${sol(p.release)} SOL: ${sol(p.paying)} to ${p.payouts.length} of ` +
    `${state.holders.length} eligible holders (${state.notPayable.length} not payable, ` +
    `${p.skipped.length} skipped), buyback ${sol(p.buyback)} SOL` +
    (p.buybackSkipped ? ` (${p.buybackSkipped})` : '') +
    `, rent exemption ${state.rentExemptLamports} lamports`,
)
if (stopped) console.log(`the run would stop: ${stopped}`)

// The reclaim check: the claim's account created and emptied back into the wallet at once.
const claim = transactions.find((t) => t.label === 'claim')?.claim
const checks = [...transactions]
if (claim) {
  const reclaim = {
    seed: claim.seed,
    address: claim.account,
    lamports: state.rentExemptLamports,
  }
  const instructions = claimInstructions({
    wallet: QUANTP.engine.wallet,
    period: hour,
    seed: claim.seed,
    account: claim.account,
    lamports: state.rentExemptLamports,
    reclaims: [reclaim],
  })
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const base = transactions[0]
  checks.push({
    label: 'claim + reclaim (check)',
    units: base.units,
    price: base.price,
    instructions,
    transaction: engineTransaction({
      payer: QUANTP.engine.wallet,
      instructions,
      units: base.units,
      price: base.price,
      blockhash,
    }),
  })
}

let failed = 0
for (const t of checks) {
  const sim = await connection.simulateTransaction(t.transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  })
  const { err, unitsConsumed, logs } = sim.value
  if (err) failed++
  console.log(
    `${t.label.padEnd(26)} err ${JSON.stringify(err)}  units ${unitsConsumed} of ${t.units}  ` +
      `bytes ${t.transaction.serialize().length}  price ${t.price ?? '-'} µlamports`,
  )
  // the memo as the chain records it, and what it cost
  const memo = (logs ?? []).filter(
    (l) => l.startsWith('Program log: Memo') || /^Program MemoSq4g\w+ consumed/.test(l),
  )
  for (const line of memo) console.log(`${' '.repeat(26)} ${line}`)
  if (err) console.log((logs ?? []).slice(-12).join('\n'))
}
process.exit(failed ? 1 : 0)
