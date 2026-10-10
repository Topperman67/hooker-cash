import { TickMarkType } from 'lightweight-charts'

// lightweight-charts treats UNIX timestamps as UTC and labels them in UTC. Candle times stay UTC
// (shifting them per time zone would break ordering across a DST change); these formatters label
// the axis and crosshair in the viewer's local time instead, matching the trades table's ages.

const toDate = (time) => {
  if (typeof time === 'number') return new Date(time * 1000)
  if (typeof time === 'string') return new Date(`${time}T00:00:00`)
  return new Date(time.year, time.month - 1, time.day)
}

const TIME = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
const TICK = {
  [TickMarkType.Year]: { year: 'numeric' },
  [TickMarkType.Month]: { month: 'short' },
  [TickMarkType.DayOfMonth]: { day: 'numeric', month: 'short' },
  [TickMarkType.Time]: TIME,
  [TickMarkType.TimeWithSeconds]: { ...TIME, second: '2-digit' },
}

// `timeZone` is only for tests; the chart always uses the viewer's own zone.
const formats = new Map()
const format = (locale, options, timeZone) => {
  const key = `${locale || ''}|${timeZone || ''}|${JSON.stringify(options)}`
  if (!formats.has(key))
    formats.set(key, new Intl.DateTimeFormat(locale || undefined, { ...options, timeZone }))
  return formats.get(key)
}

export function tickMarkLabel(time, type, locale, timeZone) {
  return format(locale, TICK[type] ?? TIME, timeZone).format(toDate(time))
}

export function crosshairLabel(time, { seconds = false, locale, timeZone } = {}) {
  const date = toDate(time)
  const day = format(locale, { day: 'numeric', month: 'short', year: 'numeric' }, timeZone)
  const clock = format(locale, seconds ? TICK[TickMarkType.TimeWithSeconds] : TIME, timeZone)
  return `${day.format(date)} ${clock.format(date)}`
}
