import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decodeEventLog, erc20Abi, parseAbiItem, formatUnits } from 'viem'
import { priceFromSqrt, decodeTrade } from './market-math.mjs'
const swapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)',
)
export function createIndexer({ client, config, abi, dataDir, store }) {
  const file = resolve(dataDir, `index-${config.chainId}-${config.factory.toLowerCase()}.json`)
  const storeKey = `index:${config.chainId}:${config.factory.toLowerCase()}`
  let lease = null
  let state = {
      cursor: Number(config.startBlock) - 1,
      blockHash: null,
      tokens: {},
      trades: {},
      updatedAt: null,
      error: null,
    },
    running = false,
    loaded = false
  async function load(refresh = false) {
    if ((loaded && !refresh) || (running && refresh)) return
    loaded = true
    try {
      const s = store ? await store.get(storeKey) : JSON.parse(await readFile(file, 'utf8'))
      if (refresh && running) return
      if (s?.factory === config.factory && s.chainId === config.chainId) state = s
    } catch (e) {
      if (store) {
        loaded = false
        throw e
      }
    }
  }
  async function save(snapshot = state) {
    if (store)
      return store.saveIndex(
        storeKey,
        { ...snapshot, factory: config.factory, chainId: config.chainId },
        lease,
      )
    await mkdir(dataDir, { recursive: true })
    const temp = file + '.tmp'
    await writeFile(
      temp,
      JSON.stringify({ ...snapshot, factory: config.factory, chainId: config.chainId }),
    )
    await rename(temp, file)
  }
  async function sync() {
    if (running) return
    running = true
    try {
      if (store) {
        lease = randomUUID()
        if (!(await store.set(`${storeKey}:lock`, lease, { nx: true, ttl: 55000 }))) return
        // Reload while holding the lease, so an older instance cannot overwrite newer progress.
        loaded = false
      }
      await load()
      if ((await client.getChainId()) !== config.chainId)
        throw Error('Indexer RPC is on the wrong chain')
      const tip = Number(await client.getBlockNumber()) - 2
      if (state.blockHash) {
        const checkpoint = await client.getBlock({ blockNumber: BigInt(state.cursor) })
        if (checkpoint.hash !== state.blockHash) {
          state = {
            cursor: Number(config.startBlock) - 1,
            blockHash: null,
            tokens: {},
            trades: {},
            updatedAt: null,
            error: 'Chain reorganized; rebuilding index.',
          }
        }
      }
      // Bounded batches keep the API responsive. Subsequent polls continue backfill.
      for (let batch = 0; batch < 4 && state.cursor < tip; batch++) {
        const batchState = { ...state, tokens: { ...state.tokens }, trades: { ...state.trades } }
        const fromBlock = BigInt(state.cursor + 1),
          toBlock = BigInt(Math.min(state.cursor + 2000, tip))
        const logs = await client.getLogs({ address: config.factory, fromBlock, toBlock })
        for (const log of logs) {
          let event
          try {
            event = decodeEventLog({ abi: abi.HookbrewFactory, ...log })
          } catch {
            continue
          }
          if (event.eventName !== 'TokenLaunched') continue
          const a = event.args,
            address = a.token.toLowerCase(),
            block = await client.getBlock({ blockNumber: log.blockNumber })
          const [name, symbol, totalSupply] = await Promise.all(
            ['name', 'symbol', 'totalSupply'].map((functionName) =>
              client.readContract({
                address: a.token,
                abi: erc20Abi,
                functionName,
                blockNumber: log.blockNumber,
              }),
            ),
          )
          batchState.tokens[address] = {
            address: a.token,
            name,
            symbol,
            totalSupply: formatUnits(totalSupply, 18),
            decimals: 18,
            creator: a.creator,
            poolId: a.poolId,
            fee: a.fee,
            hook: config.factory,
            quote: config.quote,
            createdAt: Number(block.timestamp),
            launchBlock: Number(log.blockNumber),
            launchTx: log.transactionHash,
            metadataURI: a.metadataURI,
            initialBuy: formatUnits(a.initialBuy, 6),
            founderTokens: formatUnits(a.tokensBought, 18),
            initialPrice: priceFromSqrt(a.sqrtPriceX96, a.token, config.quote),
            chainId: config.chainId,
          }
        }
        const tokens = Object.values(batchState.tokens)
        if (tokens.length) {
          const identities = new Map(tokens.map((t) => [t.poolId.toLowerCase(), t])),
            timestamps = new Map(),
            traders = new Map()
          for (const token of tokens)
            if (Number(token.initialBuy) > 0)
              traders.set(`${token.launchTx}:${token.address.toLowerCase()}`, token.creator)
          const ownTrades = await client.getLogs({
            address: config.router,
            event: abi.HookbrewRouter.find((x) => x.type === 'event' && x.name === 'Trade'),
            fromBlock,
            toBlock,
          })
          for (const l of ownTrades)
            traders.set(`${l.transactionHash}:${l.args.token.toLowerCase()}`, l.args.trader)
          for (let i = 0; i < tokens.length; i += 100) {
            const swaps = await client.getLogs({
              address: config.poolManager,
              event: swapEvent,
              args: { id: tokens.slice(i, i + 100).map((t) => t.poolId) },
              fromBlock,
              toBlock,
              strict: true,
            })
            for (const l of swaps) {
              const token = identities.get(l.args.id.toLowerCase())
              if (!token) continue
              if (!timestamps.has(String(l.blockNumber)))
                timestamps.set(
                  String(l.blockNumber),
                  Number((await client.getBlock({ blockNumber: l.blockNumber })).timestamp),
                )
              const trade = decodeTrade(
                l,
                token,
                config.quote,
                timestamps.get(String(l.blockNumber)),
                traders.get(`${l.transactionHash}:${token.address.toLowerCase()}`),
              )
              batchState.trades[trade.id] = { ...trade, token: token.address }
            }
          }
        }
        batchState.cursor = Number(toBlock)
        batchState.blockHash = (await client.getBlock({ blockNumber: toBlock })).hash
        batchState.updatedAt = new Date().toISOString()
        batchState.error = null
        await save(batchState)
        state = batchState
      }
    } catch (e) {
      state.error = e.shortMessage || e.message
    } finally {
      if (store && lease) await store.release(`${storeKey}:lock`, lease).catch(() => {})
      lease = null
      running = false
    }
  }
  function trades(address) {
    return Object.values(state.trades)
      .filter((t) => t.token.toLowerCase() === address.toLowerCase())
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
  }
  function token(address) {
    const t = state.tokens[address.toLowerCase()]
    if (!t) return null
    const rows = trades(address),
      recent = rows.filter((x) => x.timestamp >= Date.now() / 1000 - 86400),
      price = rows[0]?.price || t.initialPrice,
      base =
        rows.find((x) => x.timestamp < Date.now() / 1000 - 86400)?.price ||
        (t.createdAt >= Date.now() / 1000 - 86400 ? t.initialPrice : null)
    return {
      ...t,
      price,
      marketCap: price ? price * Number(t.totalSupply) : null,
      volume24h: recent.reduce((s, x) => s + Number(x.quoteAmount), 0),
      change24h: base ? (price / base - 1) * 100 : null,
      tradeCount: rows.length,
    }
  }
  return {
    sync,
    load,
    status: () => ({
      cursor: state.cursor,
      updatedAt: state.updatedAt,
      error: state.error,
      syncing: running,
      fromBlock: Number(config.startBlock),
    }),
    tokens: () => Object.keys(state.tokens).map(token),
    token,
    trades,
  }
}
