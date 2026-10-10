// Address lookup table contents for Quant Pad transactions. A pump.fun create_v2 + dev buy
// references ~35 accounts (~1.6 KB), over Solana's 1 232-byte limit; with the static accounts in
// a lookup table each costs one byte instead of 32. Static = identical across launches, found by
// building two launches with unrelated keys and intersecting, plus every fee recipient pump.fun
// may pick at random.
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount } from '#pump-sdk'

async function sampleLaunchKeys(global, feeConfig) {
  const user = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: new BN(100_000_000),
    quoteMint: PublicKey.default,
  })
  const ixs = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint,
    name: 'Sample',
    symbol: 'SMPL',
    uri: 'https://example.invalid/meta.json',
    creator: user,
    user,
    amount,
    quoteAmount: new BN(100_000_000),
    mayhemMode: false,
  })
  return new Set(
    ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]),
  )
}

export async function staticLaunchAccounts(connection, { extra = [] } = {}) {
  const sdk = new OnlinePumpSdk(connection)
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()])
  const [a, b] = await Promise.all([
    sampleLaunchKeys(global, feeConfig),
    sampleLaunchKeys(global, feeConfig),
  ])
  const keys = new Set([...a].filter((k) => b.has(k)))
  for (const list of [
    global.feeRecipients,
    global.reservedFeeRecipients,
    global.buybackFeeRecipients,
  ])
    for (const k of list || []) if (!k.equals(PublicKey.default)) keys.add(k.toBase58())
  for (const k of [global.feeRecipient, global.reservedFeeRecipient])
    if (k && !k.equals(PublicKey.default)) keys.add(k.toBase58())
  keys.add('ComputeBudget111111111111111111111111111111')
  keys.add('SysvarRent111111111111111111111111111111111')
  for (const k of extra) keys.add(k.toString())
  return [...keys].map((k) => new PublicKey(k))
}
