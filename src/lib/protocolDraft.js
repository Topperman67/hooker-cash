import { getAddress, isAddress, parseUnits, zeroAddress } from 'viem'
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
export const defaultDraft = {
  name: '',
  symbol: '',
  description: '',
  image: '',
  website: '',
  twitter: '',
  telegram: '',
  fee: '20000',
  targetMcap: '4000',
  initialBuy: '',
  slippage: '1',
  guarded: true,
  window: '300',
  startCap: '1',
  endCap: '10',
  interval: '0',
  splits: [],
}
export function amount(value, decimals = 6) {
  if (!/^\d+(\.\d+)?$/.test(String(value)) || (String(value).split('.')[1]?.length || 0) > decimals)
    throw Error(`Enter a positive amount with at most ${decimals} decimals.`)
  const result = parseUnits(String(value), decimals)
  if (result <= 0n || result > 2n ** 127n - 1n)
    throw Error('Amount is outside the supported range.')
  return result
}
export function slippageBps(value) {
  const n = Number(value)
  if (!/^\d+(\.\d{1,2})?$/.test(String(value)) || n < 0.1 || n > 10)
    throw Error('Slippage must be 0.1% to 10%, with at most two decimals.')
  return parseUnits(String(value), 2)
}
export const minimum = (output, slippage) => (output * (10000n - slippageBps(slippage))) / 10000n
// Arc's ERC20 USDC shares the native balance, expressed at a different precision.
export function nativeBudget(gas, gasPrice, value = 0n, quoteSpend = 0n) {
  return value + quoteSpend * 10n ** 12n + (gas * gasPrice * 120n) / 100n
}
export function validateDraft(d, stage = 4) {
  const bytes = (s) => new TextEncoder().encode(s.trim()).length
  if (!bytes(d.name) || bytes(d.name) > 32) throw Error('Token name must use 1–32 UTF-8 bytes.')
  if (!bytes(d.symbol) || bytes(d.symbol) > 12 || /\s/.test(d.symbol.trim()))
    throw Error('Symbol must use 1–12 UTF-8 bytes without spaces.')
  if (d.description.length > 280) throw Error('Description must be 280 characters or fewer.')
  for (const key of ['website', 'twitter', 'telegram', 'image'])
    if (d[key]) {
      let url
      try {
        url = new URL(d[key])
      } catch {
        throw Error(`Enter a complete ${key} URL.`)
      }
      if (!['https:', 'http:'].includes(url.protocol)) throw Error(`${key} must use https or http.`)
    }
  if (stage < 1) return
  if (![10000, 20000, 30000, 40000, 50000].includes(Number(d.fee)))
    throw Error('Choose a fee from 1% to 5%.')
  if (Number(d.targetMcap) < 2000 || Number(d.targetMcap) > 10000)
    throw Error('Opening market cap must be 2,000–10,000 USDC.')
  amount(d.targetMcap)
  if (d.initialBuy && Number(d.initialBuy) !== 0) amount(d.initialBuy)
  slippageBps(d.slippage)
  if (stage < 2) return
  if (
    d.guarded &&
    (!Number.isInteger(Number(d.window)) ||
      Number(d.window) < 1 ||
      Number(d.window) > 3600 ||
      Number(d.startCap) <= 0 ||
      Number(d.endCap) < Number(d.startCap) ||
      Number(d.endCap) > 50 ||
      !Number.isInteger(Number(d.interval)) ||
      Number(d.interval) < 0 ||
      Number(d.interval) > 60 ||
      !/^\d+(\.\d{1,2})?$/.test(String(d.startCap)) ||
      !/^\d+(\.\d{1,2})?$/.test(String(d.endCap)))
  )
    throw Error('Guard: 1–3,600 seconds, caps 0.01–50%, spacing 0–60 seconds.')
  if (stage < 3) return
  if (d.splits.length > 10) throw Error('Use at most ten recipients.')
  const addresses = new Set()
  let total = 0
  for (const s of d.splits) {
    if (!isAddress(s.wallet) || same(s.wallet, zeroAddress))
      throw Error('Every recipient needs a valid, nonzero wallet address.')
    if (addresses.has(s.wallet.toLowerCase())) throw Error('Recipient addresses must be unique.')
    addresses.add(s.wallet.toLowerCase())
    const bps = Math.round(Number(s.percent) * 100)
    if (!(bps > 0) || bps > 10000 || !/^\d+(\.\d{1,2})?$/.test(String(s.percent)))
      throw Error('Recipient shares must be positive, with at most two decimal places.')
    total += bps
    if (
      ![s.cliffDays, s.durationDays].every((v) => Number.isInteger(Number(v)) && Number(v) >= 0) ||
      Number(s.cliffDays) + Number(s.durationDays) > 3650
    )
      throw Error('Vesting uses whole days, with a maximum combined period of 3,650 days.')
    if ((Number(s.cliffDays) || Number(s.durationDays)) && !Number(d.initialBuy))
      throw Error('Add a founder buy before configuring vesting.')
  }
  if (d.splits.length && total !== 10000) throw Error('Recipient shares must total exactly 100%.')
}
export function launchParams(d, uri, salt, minTokensOut = 0n) {
  validateDraft(d)
  return {
    name: d.name.trim(),
    symbol: d.symbol.trim(),
    metadataURI: uri,
    salt,
    fee: Number(d.fee),
    targetMcap: amount(d.targetMcap),
    initialBuy: Number(d.initialBuy) ? amount(d.initialBuy) : 0n,
    minTokensOut,
    guard: d.guarded
      ? {
          window: Number(d.window),
          startCapBps: Math.round(Number(d.startCap) * 100),
          endCapBps: Math.round(Number(d.endCap) * 100),
          interval: Number(d.interval),
        }
      : { window: 0, startCapBps: 0, endCapBps: 0, interval: 0 },
    splits: d.splits.map((s) => ({
      wallet: getAddress(s.wallet),
      bps: Math.round(Number(s.percent) * 100),
      cliff: Number(s.cliffDays) * 86400,
      duration: Number(s.durationDays) * 86400,
    })),
  }
}
