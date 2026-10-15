// Refreshes the mainnet fixtures the unit tests decode: a Quant Pad launch (a DBC create with its
// dev buy), a DBC curve swap and a DAMM v2 pool swap, each saved as { signature, tx } in the JSON
// encoding the indexer reads, and the accounts they trade on (meteora-accounts.json: Quant Pad's
// launch configs, the pools and their configs, the launched mint and its Metaplex metadata, as
// { address: { owner, lamports, data } } with base64 data). Reads are one request at a time with
// backoff, since the public RPC throttles getTransaction hard; each fixture is written as soon as
// it is found. Fixtures already on disk are kept unless --all is passed.
// Usage: node tests/fixtures/fetch-meteora.mjs [--all] [rpc-url] [pages]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { createFrom, extractEvents, metaplexMetadataPda, DBC, DAMM } from '../../server/solana.mjs'
import { dbcCoder, decodeDbcConfig, decodeDbcPool, migratedPoolFor } from '../../shared/meteora.mjs'
import { launchTiers } from '../../shared/network.mjs'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const all = process.argv.includes('--all')
const RPC = args[0] || 'https://api.mainnet-beta.solana.com'
const PAGES = Number(args[1]) || 10
const WSOL = 'So11111111111111111111111111111111111111112'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, params) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).catch(() => null)
    const body = response && (await response.json().catch(() => null))
    if (body && !body.error) return body.result
    if (attempt >= 10) throw Error(`${method}: ${body?.error?.message || response?.status}`)
    await sleep(Math.min(60_000, 3000 * 2 ** attempt))
  }
}
const getTx = (signature) =>
  call('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
  ])
const signatures = async (address, before) =>
  (await call('getSignaturesForAddress', [address, { limit: 25, before }])).filter((s) => !s.err)

const ixName = (ix) => {
  try {
    return ix && dbcCoder.instruction.decode(Buffer.from(bs58.decode(ix.data)))?.name
  } catch {
    return null
  }
}
const wanted = {
  // A launch through initialize_virtual_pool_with_spl_token with its dev buy in the same
  // transaction, as Quant Pad's own launches are.
  'dbc-create': (events) =>
    events.some(
      (e) =>
        e.program === DBC &&
        e.name === 'EvtInitializePool' &&
        ixName(e.emitter) === 'initializeVirtualPoolWithSplToken',
    ) && events.some((e) => e.program === DBC && e.name === 'EvtSwap2'),
  'dbc-swap': (events) =>
    events.filter((e) => e.program === DBC && e.name === 'EvtSwap2').length === 1 &&
    !events.some((e) => e.name === 'EvtInitializePool') &&
    !events.some((e) => e.program === DAMM),
  // A swap on a SOL-quoted DAMM v2 pool (as a migrated DBC coin's is).
  'damm-swap': (events, tx) =>
    events.filter((e) => e.program === DAMM && e.name === 'EvtSwap2').length === 1 &&
    !events.some((e) => e.program === DBC) &&
    tx.meta.postTokenBalances.some((b) => b.mint === WSOL),
}
const file = (name) => new URL(`./${name}.json`, import.meta.url)
const found = {}
if (!all)
  for (const name of Object.keys(wanted))
    if (existsSync(file(name))) found[name] = JSON.parse(readFileSync(file(name), 'utf8'))
const save = (name, value) => {
  found[name] = value
  writeFileSync(file(name), JSON.stringify(value, null, 1) + '\n')
  console.log(name, value.signature)
}

// Reads the newest transactions of `address` until every fixture in `names` is found.
async function scan(address, names) {
  let before
  for (let page = 0; page < PAGES && names.some((n) => !found[n]); page++) {
    const sigs = await signatures(address, before)
    if (!sigs.length) return
    before = sigs.at(-1).signature
    for (const { signature } of sigs) {
      if (names.every((n) => found[n])) return
      const tx = await getTx(signature)
      if (!tx || tx.meta?.err) continue
      const events = extractEvents(tx)
      for (const name of names)
        if (!found[name] && wanted[name](events, tx)) save(name, { signature, tx })
      await sleep(1000)
    }
  }
}

// Quant Pad's own launches first (its configs see little else), then the programs.
for (const { config } of launchTiers) await scan(config, ['dbc-create'])
await scan(DBC, ['dbc-create', 'dbc-swap'])
await scan(DAMM, ['damm-swap'])

// The accounts the fixtures trade on, as they are now: Quant Pad's configs, the pools swapped on,
// their DBC configs, and the DAMM v2 pool of a DBC coin that has migrated.
const accounts = {}
async function read(addresses) {
  addresses = addresses.filter((a) => !accounts[a])
  if (!addresses.length) return
  const { value } = await call('getMultipleAccounts', [
    addresses,
    { encoding: 'base64', commitment: 'confirmed' },
  ])
  addresses.forEach((address, i) => {
    if (value[i])
      accounts[address] = {
        owner: value[i].owner,
        lamports: value[i].lamports,
        data: value[i].data[0],
      }
  })
}
const pools = new Set()
for (const name of ['dbc-create', 'dbc-swap', 'damm-swap'])
  for (const e of found[name] ? extractEvents(found[name].tx) : [])
    if (e.name === 'EvtSwap2') pools.add(e.event.pool.toBase58())
await read([...launchTiers.map((t) => t.config), ...pools])
const dbcPools = Object.values(accounts)
  .map((a) => decodeDbcPool(Buffer.from(a.data, 'base64')))
  .filter(Boolean)
await read(dbcPools.map((p) => p.config))
await read(
  dbcPools
    .filter((p) => p.isMigrated)
    .map((p) => {
      const config = decodeDbcConfig(Buffer.from(accounts[p.config].data, 'base64'))
      return migratedPoolFor(config, new PublicKey(p.baseMint)).toBase58()
    }),
)
// The launched coin's mint and its Metaplex metadata (Quant Pad coins are SPL Token mints).
const launched = found['dbc-create'] && createFrom(found['dbc-create'].tx)
if (launched) await read([launched.mint, metaplexMetadataPda(launched.mint).toBase58()])
writeFileSync(file('meteora-accounts'), JSON.stringify(accounts, null, 1) + '\n')
console.log('meteora-accounts', Object.keys(accounts).length)

const missing = Object.keys(wanted).filter((k) => !found[k])
if (missing.length) {
  console.error('not found:', missing.join(', '))
  process.exitCode = 1
}
