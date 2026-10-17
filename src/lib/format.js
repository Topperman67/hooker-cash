// Display formatting. Raw on-chain amounts arrive as integer strings or bigints.
export const LAMPORTS = 1e9
export const TOKEN_DECIMALS = 6

export const toSol = (lamports) => (lamports == null ? null : Number(lamports) / LAMPORTS)
export const toTokens = (raw) => (raw == null ? null : Number(raw) / 10 ** TOKEN_DECIMALS)

// An amount `digits` decimals would round to zero (0.000266 at 3 digits) is shown to 3 significant
// digits instead, so a real amount never reads "0 SOL" or "-0 SOL".
export function sol(value, { digits = 4, unit = true } = {}) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value) || 0 // -0 is 0
  const text =
    n !== 0 && Math.abs(n) < 0.5 * 10 ** -digits
      ? n.toLocaleString('en-US', { maximumSignificantDigits: 3 })
      : n.toLocaleString('en-US', { maximumFractionDigits: digits })
  return unit ? `${text} SOL` : text
}

export function usd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const n = Number(value)
  if (Math.abs(n) >= 1000)
    return (
      '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n)
    )
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01)
    return '$' + n.toLocaleString('en-US', { maximumSignificantDigits: 3 })
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

export const compact = (value) =>
  value == null || !Number.isFinite(Number(value))
    ? '—'
    : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(
        Number(value),
      )

// Token prices are tiny. Below 0.001 a price is shown like trading UIs do, with the run of zeros
// after the decimal point written as a count: 0.0000000412 reads "0.0₇412". `text` is always the
// plain decimal (for copying, titles and screen readers); `zeros` and `digits` are set only for
// the zero-count form, which the Price component draws with the brand font's own digits (Unicode
// subscript digits are missing from the loaded font subsets and fall back to a comma-like mark).
export function priceParts(value) {
  if (value == null || !(value > 0) || !Number.isFinite(value)) return null
  if (value >= 0.001)
    return { text: value.toLocaleString('en-US', { maximumSignificantDigits: 4 }) }
  const [mantissa, exponent] = value.toExponential(3).split('e-')
  const zeros = Number(exponent) - 1
  const digits = mantissa.replace('.', '').replace(/0+$/, '')
  return { text: `0.${'0'.repeat(zeros)}${digits}`, zeros, digits }
}

/** A price as plain text (the full decimal), or '—'. */
export const price = (value) => priceParts(value)?.text ?? '—'

export function pct(value, { sign = true } = {}) {
  if (value == null || !Number.isFinite(value)) return '—'
  const text =
    Math.abs(value) >= 1000 ? compact(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 1)
  return `${sign && value > 0 ? '+' : ''}${text}%`
}

export const bps = (value) =>
  `${(Number(value) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

export const short = (value, head = 4, tail = 4) =>
  value ? `${value.slice(0, head)}…${value.slice(-tail)}` : '—'

export function ago(seconds) {
  if (!seconds) return '—'
  const diff = Math.max(0, Date.now() / 1000 - seconds)
  if (diff < 60) return `${Math.floor(diff)}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 3600) return `${Math.round(s / 60)} min`
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} days`
}

/** Time left until something opens, rounded up so it never reads as open early. */
export function countdown(seconds) {
  const s = Math.max(0, Math.ceil(seconds))
  if (s < 60) return 'less than a minute'
  const minutes = Math.ceil(s / 60)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60)
    return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  const hours = Math.ceil(s / 3600)
  return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`
}

export const safeLink = (value) => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

// Parse a decimal string into integer base units without floating point.
export function parseUnits(text, decimals) {
  const value = String(text ?? '').trim()
  if (!/^\d*(\.\d*)?$/.test(value) || value === '' || value === '.') return null
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) return null
  return (
    BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  )
}

export function formatUnits(raw, decimals, maxFraction = decimals) {
  const value = BigInt(raw ?? 0)
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let fraction = (abs % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFraction)
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}${fraction ? '.' + fraction : ''}`
}
