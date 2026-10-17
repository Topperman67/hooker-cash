import { useLayoutEffect, useRef, useState } from 'react'
import { niceTicks, timeTicks } from './engineData.js'

const HEIGHT = 230
const PAD = { top: 14, right: 14, bottom: 28, left: 52 }

/** The element's content box in px ({ width, height }), kept current as it resizes. */
export function useSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const set = ({ width, height }) =>
      setSize({ width: Math.round(width), height: Math.round(height) })
    set(el.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => set(entry.contentRect))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return size
}

const dayFmt = { month: 'short', day: 'numeric' }
const hourFmt = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
const stamp = (t) => new Date(t * 1000).toLocaleString('en-US', { ...dayFmt, ...hourFmt })

/**
 * A running total over time as a step line on a graphite panel: it rises at each event and holds
 * until the next, out to now. `points` are oldest first ({ t, v, ... }); `tone` is 'green' or
 * 'pink'; `format` writes an axis value; `readout(point)` the tooltip's lines ({ value, lines }).
 * The pointer, or the arrow keys once focused, move a crosshair from event to event; the tables
 * below the chart list every value too.
 */
export default function EngineChart({ points, tone, format, readout, label, now }) {
  const box = useRef(null)
  const { width } = useSize(box)
  const [active, setActive] = useState(null)
  const id = `eng-fill-${tone}`

  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const first = points[0]
  const last = points.at(-1)
  const end = Math.max(now, last.t)
  const t0 = first.t - Math.max((end - first.t) * 0.04, 1800)
  const t1 = end
  const ticks = niceTicks(last.v)
  const top = ticks.at(-1)
  const x = (t) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * plotW
  const y = (v) => PAD.top + plotH - (v / top) * plotH

  let line = `M${x(t0)},${y(0)}`
  for (const p of points) line += ` H${x(p.t)} V${y(p.v)}`
  line += ` H${x(t1)}`
  const area = `${line} V${y(0)} H${x(t0)} Z`

  const point = active == null ? null : points[active]
  const nearest = (clientX) => {
    const rect = box.current.getBoundingClientRect()
    const t = t0 + ((clientX - rect.left - PAD.left) / (plotW || 1)) * (t1 - t0)
    let best = 0
    points.forEach((p, i) => {
      if (Math.abs(p.t - t) < Math.abs(points[best].t - t)) best = i
    })
    return best
  }
  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')
      return
    e.preventDefault()
    const at = active ?? points.length - 1
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? points.length - 1
          : Math.min(points.length - 1, Math.max(0, at + (e.key === 'ArrowLeft' ? -1 : 1)))
    setActive(next)
  }
  const tip = point && readout(point)
  const tipLeft = point ? Math.min(Math.max(x(point.t), 90), Math.max(90, width - 90)) : 0
  // above the line where it runs low, below it where it runs high
  const tipTop = point && y(point.v) < PAD.top + plotH / 2 ? PAD.top + plotH - 78 : PAD.top

  return (
    <div
      ref={box}
      className={`eng-chart eng-chart-${tone}`}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the arrow keys to step through each one.`}
      onPointerMove={(e) => setActive(nearest(e.clientX))}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((a) => a ?? points.length - 1)}
      onBlur={() => setActive(null)}
      onKeyDown={onKey}
    >
      {width > 0 && (
        <svg width={width} height={HEIGHT} aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="eng-fill-top" />
              <stop offset="100%" className="eng-fill-bottom" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line
                className="eng-gridline"
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(v)}
                y2={y(v)}
              />
              <text className="eng-axis" x={PAD.left - 10} y={y(v)} dy="0.32em" textAnchor="end">
                {format(v)}
              </text>
            </g>
          ))}
          {timeTicks(t0, t1, plotW)
            // a label centred on a tick near either end would run past the plot
            .filter((tick) => x(tick.t) - PAD.left >= 22 && PAD.left + plotW - x(tick.t) >= 22)
            .map((tick) => (
              <text
                key={tick.t}
                className="eng-axis"
                x={x(tick.t)}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {tick.label}
              </text>
            ))}
          <path d={area} fill={`url(#${id})`} />
          <path d={line} className="eng-line" />
          {point && (
            <line
              className="eng-cross"
              x1={x(point.t)}
              x2={x(point.t)}
              y1={PAD.top}
              y2={PAD.top + plotH}
            />
          )}
          <circle className="eng-dot" cx={x(last.t)} cy={y(last.v)} r="5" />
          {point && <circle className="eng-dot is-active" cx={x(point.t)} cy={y(point.v)} r="6" />}
        </svg>
      )}
      {tip && (
        <div className="eng-tip" style={{ left: tipLeft, top: tipTop }} role="status">
          <strong className="num">{tip.value}</strong>
          {tip.lines.map((text) => (
            <span key={text}>{text}</span>
          ))}
          <span className="eng-tip-when">{stamp(point.t)}</span>
        </div>
      )}
    </div>
  )
}
