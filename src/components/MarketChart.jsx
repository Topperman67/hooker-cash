import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
} from 'lightweight-charts'
import { useResource } from '../lib/api.js'
import { Segmented } from './UI.jsx'

const INTERVALS = [
  [15, '15s'],
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [3600, '1h'],
  [86400, '1d'],
]

export default function MarketChart({ mint, symbol }) {
  const [interval, setInterval] = useState(60)
  const [mode, setMode] = useState('candles')
  const [unit, setUnit] = useState('price')
  const resource = useResource(`/api/coins/${mint}/candles?interval=${interval}`, 8000)
  const container = useRef(null)
  const chart = useRef(null)
  const series = useRef(null)
  const volume = useRef(null)
  const fitted = useRef(false)

  useEffect(() => {
    if (!container.current) return
    const instance = createChart(container.current, {
      height: 380,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a3abb8',
        fontFamily: 'Martian Mono Variable, monospace',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      rightPriceScale: { borderColor: '#3a414d', scaleMargins: { top: 0.12, bottom: 0.25 } },
      timeScale: {
        timeVisible: true,
        secondsVisible: interval < 60,
        borderColor: '#3a414d',
        maxBarSpacing: 22,
      },
      crosshair: { vertLine: { color: '#8fa4ff88' }, horzLine: { color: '#8fa4ff88' } },
    })
    chart.current = instance
    const format =
      unit === 'mcap'
        ? { type: 'price', precision: 2, minMove: 0.01 }
        : { type: 'price', precision: 12, minMove: 0.000000000001 }
    series.current =
      mode === 'candles'
        ? instance.addSeries(CandlestickSeries, {
            upColor: '#18d47a',
            downColor: '#ff4fae',
            wickUpColor: '#18d47a',
            wickDownColor: '#ff4fae',
            borderVisible: false,
            priceFormat: format,
          })
        : instance.addSeries(LineSeries, { color: '#8fa4ff', lineWidth: 2, priceFormat: format })
    volume.current = instance.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    fitted.current = false
    return () => {
      instance.remove()
      chart.current = null
    }
  }, [mint, interval, mode, unit])

  useEffect(() => {
    if (!series.current || !resource.data) return
    const k = unit === 'mcap' ? 1e9 : 1
    const items = resource.data.items
    series.current.setData(
      mode === 'candles'
        ? items.map(({ time, open, high, low, close }) => ({
            time,
            open: open * k,
            high: high * k,
            low: low * k,
            close: close * k,
          }))
        : items.map(({ time, close }) => ({ time, value: close * k })),
    )
    volume.current.setData(
      items.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? '#18d47a33' : '#ff4fae33',
      })),
    )
    if (items.length && !fitted.current) {
      chart.current.timeScale().fitContent()
      fitted.current = true
    }
  }, [resource.data, mode, unit])

  const empty = !resource.data?.items?.length
  return (
    <section className="instrument chart-panel" aria-label={`${symbol} chart`}>
      <div className="chart-toolbar">
        <strong>
          {symbol} / SOL {unit === 'mcap' ? 'market cap' : 'price'}
        </strong>
        <div className="chart-controls">
          <Segmented label="Interval" value={interval} onChange={setInterval} options={INTERVALS} />
          <Segmented
            label="Unit"
            value={unit}
            onChange={setUnit}
            options={[
              ['price', 'Price'],
              ['mcap', 'MCap'],
            ]}
          />
          <Segmented
            label="Style"
            value={mode}
            onChange={setMode}
            options={[
              ['candles', 'Candles'],
              ['line', 'Line'],
            ]}
          />
        </div>
      </div>
      <div className="chart-stage">
        <div ref={container} className="chart-canvas" />
        {empty && (
          <div className="chart-empty">
            <h3>{resource.loading ? 'Reading trades…' : 'No trades indexed yet'}</h3>
            <p className="muted">
              {resource.error ||
                'The chart builds from confirmed pump.fun trades as they are indexed.'}
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
