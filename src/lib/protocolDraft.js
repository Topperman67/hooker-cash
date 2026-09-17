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
  fee: '10000',
  targetMcap: '',
  initialBuy: '',
  slippage: '1',
  guarded: false,
  window: '300',
  startCap: '1',
  endCap: '10',
  interval: '0',
  vesting: { cliff: '0', cliffUnit: 'days', duration: '0', durationUnit: 'days' },
  splits: [],
}
export const openingMarketCap = (draft) => String(draft.targetMcap).trim() || '5000'
const schedule = (cliff, cliffUnit, duration, durationUnit) => ({
  cliff: String(cliff),
  cliffUnit,
  duration: String(duration),
  durationUnit,
})
export const vestingPresets = [
  {
    name: 'No lock',
    description: 'Your allocation is available at launch.',
    value: schedule(0, 'days', 0, 'days'),
  },
  {
    name: '1h cliff',
    description: 'Locked for one hour, then fully available.',
    value: schedule(1, 'hours', 0, 'hours'),
  },
  {
    name: 'Linear 24h',
    description: 'Unlocks continuously over one day.',
    value: schedule(0, 'hours', 24, 'hours'),
  },
  {
    name: '1h cliff + 24h linear',
    description: 'One-hour wait, then a 24-hour unlock.',
    value: schedule(1, 'hours', 24, 'hours'),
  },
  {
    name: 'Linear 30d',
    description: 'Unlocks continuously over 30 days.',
    value: schedule(0, 'days', 30, 'days'),
  },
  {
    name: 'Quarter',
    description: 'Seven-day wait, then a 90-day unlock.',
    value: schedule(7, 'days', 90, 'days'),
  },
  {
    name: 'Year',
    description: '30-day wait, then a 365-day unlock.',
    value: schedule(30, 'days', 365, 'days'),
  },
]
export function vestingSeconds(value = defaultDraft.vesting) {
  const seconds = (key) => {
    const scale = { hours: 3600, days: 86400 }[value[`${key}Unit`]]
    if (!scale || !/^\d+$/.test(String(value[key])))
      throw Error('Vesting uses whole hours or days.')
    return Number(value[key]) * scale
  }
  const cliff = seconds('cliff'),
    duration = seconds('duration')
  if (!Number.isSafeInteger(cliff + duration) || cliff + duration > 3650 * 86400)
    throw Error('Vesting cannot exceed a combined period of 3,650 days.')
  return { cliff, duration }
}
export function recipientVesting(draft, recipient) {
  if (recipient?.vesting) return recipient.vesting
  // Existing saved drafts used an independent schedule in whole days for every wallet.
  if (recipient && ('cliffDays' in recipient || 'durationDays' in recipient))
    return schedule(recipient.cliffDays ?? 0, 'days', recipient.durationDays ?? 0, 'days')
  return draft.vesting || defaultDraft.vesting
}
export function vestingLabel(value) {
  const { cliff, duration } = vestingSeconds(value)
  const time = (seconds) => (seconds % 86400 === 0 ? `${seconds / 86400}d` : `${seconds / 3600}h`)
  return !cliff && !duration
    ? 'No lock'
    : [cliff ? `${time(cliff)} cliff` : '', duration ? `${time(duration)} linear` : '']
        .filter(Boolean)
        .join(' + ')
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
  if (![10000, 20000, 30000, 40000, 50000].includes(Number(d.fee)))
    throw Error('Choose a fee from 1% to 5%.')
  const mcap = amount(openingMarketCap(d))
  if (mcap < 2000_000000n || mcap > 10000_000000n)
    throw Error('Opening market cap must be 2,000–10,000 USDC.')
  if (stage < 1) return
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
  if (stage < 2) return
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
  if (stage < 3) return
  if (d.initialBuy && Number(d.initialBuy) !== 0) amount(d.initialBuy)
  slippageBps(d.slippage)
  const checkVesting = (value) => {
    const { cliff, duration } = vestingSeconds(value)
    if ((cliff || duration) && !Number(d.initialBuy))
      throw Error('Add a founder buy before configuring vesting.')
  }
  checkVesting(recipientVesting(d))
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
    checkVesting(recipientVesting(d, s))
  }
  if (d.splits.length && total !== 10000) throw Error('Recipient shares must total exactly 100%.')
}
export function launchParams(d, uri, salt, minTokensOut = 0n, creator) {
  validateDraft(d)
  let splits = d.splits
  const vesting = vestingSeconds(recipientVesting(d))
  if (!splits.length && (vesting.cliff || vesting.duration)) {
    if (!isAddress(creator || '') || same(creator, zeroAddress))
      throw Error('Connect your wallet to assign the founder vesting schedule.')
    splits = [{ wallet: creator, percent: '100' }]
  }
  return {
    name: d.name.trim(),
    symbol: d.symbol.trim(),
    metadataURI: uri,
    salt,
    fee: Number(d.fee),
    targetMcap: amount(openingMarketCap(d)),
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
    splits: splits.map((s) => ({
      wallet: getAddress(s.wallet),
      bps: Math.round(Number(s.percent) * 100),
      ...vestingSeconds(recipientVesting(d, s)),
    })),
  }
}
