// Refreshes the mainnet transaction fixtures the unit tests decode: a DBC launch (create), a DBC
// curve swap and a DAMM v2 pool swap, each saved as { signature, tx } in the JSON encoding the
// indexer reads. Usage: node tests/fixtures/fetch-meteora.mjs [rpc-url]
import { writeFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { extractEvents, fetchTransactions, DBC, DAMM } from '../../server/solana.mjs'

const connection = new Connection(process.argv[2] || 'https://api.mainnet-beta.solana.com', 'confirmed')
const WSOL = 'So11111111111111111111111111111111111111112'
const wanted = {
  'dbc-create': (events) =>
    events.some((e) => e.program === DBC && e.name === 'EvtInitializePool') &&
    events.some((e) => e.program === DBC && e.name === 'EvtSwap2'),
  'dbc-swap': (events) =>
    events.filter((e) => e.program === DBC && e.name === 'EvtSwap2').length === 1 &&
    !events.some((e) => e.name === 'EvtInitializePool'),
  'damm-swap': (events) => events.filter((e) => e.program === DAMM && e.name === 'EvtSwap2').length === 1,
}
const found = {}
for (const program of [DBC, DAMM]) {
  let before
  for (let page = 0; page < 30 && Object.keys(wanted).some((k) => !found[k]); page++) {
    const sigs = (await connection.getSignaturesForAddress(new PublicKey(program), { before, limit: 100 }))
      .filter((s) => !s.err)
    if (!sigs.length) break
    before = sigs.at(-1).signature
    const txs = await fetchTransactions(connection, sigs.map((s) => s.signature))
    for (const { signature, tx } of txs) {
      if (!tx) continue
      const events = extractEvents(tx)
      // DAMM swaps of a pool that DBC migrated: SOL is token B.
      for (const [name, match] of Object.entries(wanted))
        if (!found[name] && match(events)) {
          if (name === 'damm-swap' && !tx.meta.postTokenBalances.some((b) => b.mint === WSOL)) continue
          found[name] = { signature, tx }
          console.log(name, signature)
        }
    }
  }
}
for (const [name, value] of Object.entries(found))
  writeFileSync(new URL(`./${name}.json`, import.meta.url), JSON.stringify(value, null, 1) + '\n')
const missing = Object.keys(wanted).filter((k) => !found[k])
if (missing.length) {
  console.error('not found:', missing.join(', '))
  process.exitCode = 1
}
