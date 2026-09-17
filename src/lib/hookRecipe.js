import {
  encodeAbiParameters,
  encodeDeployData,
  getCreate2Address,
  keccak256,
  toHex,
  zeroHash,
} from 'viem'

export const emptyRecipe = {
  window: 0,
  interval: 0,
  startCapBps: 0,
  endCapBps: 0,
  oracle: false,
  burnBps: 0,
  rewardBps: 0,
  buybackBps: 0,
  liquidityBps: 0,
}
export const recipeFields = [
  ['window', 'uint32'],
  ['interval', 'uint16'],
  ['startCapBps', 'uint16'],
  ['endCapBps', 'uint16'],
  ['oracle', 'bool'],
  ['burnBps', 'uint16'],
  ['rewardBps', 'uint16'],
  ['buybackBps', 'uint16'],
  ['liquidityBps', 'uint16'],
].map(([name, type]) => ({ name, type }))
export function normalizeRecipe(input = {}) {
  const r = Object.fromEntries(
    recipeFields.map(({ name, type }) => [
      name,
      type === 'bool' ? input[name] === true : Number(input[name] ?? 0),
    ]),
  )
  for (const { name, type } of recipeFields)
    if (type !== 'bool' && (!Number.isSafeInteger(r[name]) || r[name] < 0))
      throw Error('Module settings must be nonnegative whole numbers.')
  if (r.window > 3600 || r.interval > 60)
    throw Error('Opening window: up to 3,600 seconds. Buy spacing: up to 60 seconds.')
  if (r.startCapBps > r.endCapBps || r.endCapBps > 5000 || !r.startCapBps !== !r.endCapBps)
    throw Error('Buy caps must increase from 0.01% to at most 50%.')
  if (r.window === 0 ? r.interval || r.startCapBps : !r.interval && !r.startCapBps)
    throw Error('Opening guards need a duration and at least one active rule.')
  if (r.burnBps + r.rewardBps + r.buybackBps + r.liquidityBps > 10000)
    throw Error('Value modules can use at most 100% of your creator share.')
  if (!r.oracle && (r.buybackBps || r.liquidityBps))
    throw Error('Buyback and liquidity reinvestment require Price history.')
  return r
}
export const recipeHash = (r) =>
  keccak256(
    encodeAbiParameters([{ type: 'tuple', components: recipeFields }], [normalizeRecipe(r)]),
  )
export const recipeGuard = (r) => ({
  window: r.window,
  startCapBps: r.startCapBps,
  endCapBps: r.endCapBps,
  interval: r.interval,
})
export const recipeModules = (r) =>
  [
    r.interval && 'Buy spacing',
    r.startCapBps && 'Rising buy cap',
    r.oracle && 'Price history',
    r.burnBps && 'Fee burn',
    r.rewardBps && 'Holder rewards',
    r.buybackBps && 'Buyback & burn',
    r.liquidityBps && 'Liquidity reinvestment',
  ].filter(Boolean)
export function hookBuildData(packageArtifact, factoryArtifact, infrastructure, treasury, recipe) {
  const args = [
    infrastructure.poolManager,
    infrastructure.quote,
    treasury,
    10n ** 18n,
    normalizeRecipe(recipe),
  ]
  const data = encodeDeployData({ ...packageArtifact, args })
  const factoryCodeHash = keccak256(encodeDeployData({ ...factoryArtifact, args }))
  return { data, buildHash: keccak256(data), factoryCodeHash }
}
export function hookAddresses(infrastructure, build, salt) {
  const packageAddress = getCreate2Address({
    from: infrastructure.create2,
    salt,
    bytecodeHash: build.buildHash,
  })
  return {
    packageAddress,
    factory: getCreate2Address({
      from: packageAddress,
      salt: zeroHash,
      bytecodeHash: build.factoryCodeHash,
    }),
  }
}
export async function mineHook(
  infrastructure,
  build,
  onProgress = () => {},
  cancelled = () => false,
) {
  // Canonical search allows everyone to reuse the same recipe and deployed contracts.
  for (let nonce = 0n; nonce < 2000000n; nonce++) {
    if (cancelled()) throw Error('Hook preparation cancelled.')
    const salt = toHex(nonce, { size: 32 }),
      addresses = hookAddresses(infrastructure, build, salt)
    if ((BigInt(addresses.factory) & 0x3fffn) === 0x20c0n)
      return { ...addresses, salt, data: salt + build.data.slice(2) }
    if (nonce % 300n === 0n) {
      onProgress(Number(nonce))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  throw Error('Could not derive a valid hook address. Retry preparation.')
}
