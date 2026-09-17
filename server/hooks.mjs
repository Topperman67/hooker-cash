import { readFile, writeFile, mkdir, readdir, link, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getAddress, keccak256 } from 'viem'
import { normalizeRecipe, recipeHash, hookBuildData, hookAddresses } from '../src/lib/hookRecipe.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const proxyCode =
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3'
export function createHookRegistry({ client, infrastructure, treasury, store, dataDir, abi }) {
  const directory = resolve(dataDir, 'hooks')
  async function list() {
    if (store) return Object.values((await store.get('hooks')) || {})
    try {
      return await Promise.all(
        (await readdir(directory))
          .filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n))
          .map(async (n) => JSON.parse(await readFile(resolve(directory, n), 'utf8'))),
      )
    } catch (e) {
      if (e.code === 'ENOENT') return []
      throw e
    }
  }
  async function save(record) {
    if (store) {
      const owner = randomUUID()
      if (!(await store.set('hooks:lock', owner, { nx: true, ttl: 15000 })))
        throw Error('Another hook is being registered. Retry confirmation shortly.')
      try {
        const all = (await store.get('hooks')) || {}
        if (!all[record.recipeHash])
          await store.saveIndex('hooks', { ...all, [record.recipeHash]: record }, owner)
        return all[record.recipeHash] || record
      } finally {
        await store.release('hooks:lock', owner)
      }
    }
    await mkdir(directory, { recursive: true })
    const temporary = resolve(directory, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(record))
    try {
      await link(temporary, resolve(directory, `${record.recipeHash}.json`))
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      return JSON.parse(await readFile(resolve(directory, `${record.recipeHash}.json`), 'utf8'))
    } finally {
      await unlink(temporary)
    }
    return record
  }
  async function register({ recipe: input, transactionHash }) {
    const recipe = normalizeRecipe(input),
      hash = recipeHash(recipe)
    if (!/^0x[\da-f]{64}$/i.test(transactionHash || ''))
      throw Error('A confirmed hook-build transaction is required.')
    const [packageArtifact, factoryArtifact, tx, receipt, chain, proxy] = await Promise.all([
      ...['HookbrewHookPackage', 'HookbrewModularFactory'].map(async (name) =>
        JSON.parse(await readFile(resolve(root, `public/protocol/${name}.json`), 'utf8')),
      ),
      client.getTransaction({ hash: transactionHash }),
      client.getTransactionReceipt({ hash: transactionHash }),
      client.getChainId(),
      client.getCode({ address: infrastructure.create2 }),
    ])
    if (chain !== infrastructure.chainId || proxy !== proxyCode)
      throw Error('Hook build infrastructure mismatch.')
    const build = hookBuildData(
      packageArtifact,
      factoryArtifact,
      infrastructure,
      getAddress(treasury),
      recipe,
    )
    if (
      receipt.status !== 'success' ||
      !same(tx.to, infrastructure.create2) ||
      tx.value !== 0n ||
      tx.input.slice(66) !== build.data.slice(2)
    )
      throw Error('Transaction does not build the reviewed Hookbrew recipe and treasury.')
    if ((await client.getBlockNumber()) < receipt.blockNumber + 1n)
      throw Error('Wait for two hook-build confirmations.')
    const block = await client.getBlock({ blockNumber: receipt.blockNumber })
    if (block.hash !== receipt.blockHash) throw Error('Hook build receipt is no longer canonical.')
    const { packageAddress, factory } = hookAddresses(infrastructure, build, tx.input.slice(0, 66))
    if ((BigInt(factory) & 0x3fffn) !== 0x20c0n) throw Error('Invalid hook permission flags.')
    const [builtFactory, router, builtRecipe, vesting, fc] = await Promise.all([
      ...['factory', 'router', 'recipeHash'].map((functionName) =>
        client.readContract({
          address: packageAddress,
          abi: abi.HookbrewHookPackage,
          functionName,
        }),
      ),
      client.readContract({ address: factory, abi: abi.HookbrewFactory, functionName: 'vesting' }),
      client.getCode({ address: factory }),
    ])
    if (!same(builtFactory, factory) || builtRecipe !== hash || !fc || fc === '0x')
      throw Error('Hook build verification failed.')
    const rc = await client.getCode({ address: router })
    if (!rc || rc === '0x') throw Error('Hook router is unavailable.')
    return save({
      ...infrastructure,
      abiVersion: 'hookbrew-modular-v1',
      factory,
      router,
      vesting,
      treasury: getAddress(treasury),
      packageAddress,
      recipe,
      recipeHash: hash,
      factoryCodeHash: keccak256(fc),
      routerCodeHash: keccak256(rc),
      startBlock: Number(receipt.blockNumber),
      factoryTx: transactionHash,
      routerTx: transactionHash,
      builtBy: tx.from,
      activatedAt: new Date().toISOString(),
    })
  }
  return { list, register }
}
