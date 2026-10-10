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
        textColor: '#a7a1d6',
        fontFamily: 'Manrope Variable, sans-serif',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: 'rgba(167,161,214,0.05)' },
        horzLines: { color: 'rgba(167,161,214,0.07)' },
      },
      rightPriceScale: { borderColor: '#2a2550', scaleMargins: { top: 0.12, bottom: 0.25 } },
      timeScale: {
        timeVisible: true,
        secondsVisible: interval < 60,
        borderColor: '#2a2550',
        maxBarSpacing: 22,
      },
      crosshair: { vertLine: { color: '#b69cff66' }, horzLine: { color: '#b69cff66' } },
    })
    chart.current = instance
    const format =
      unit === 'mcap'
        ? { type: 'price', precision: 2, minMove: 0.01 }
        : { type: 'price', precision: 12, minMove: 0.000000000001 }
    series.current =
      mode === 'candles'
        ? instance.addSeries(CandlestickSeries, {
            upColor: '#3ef0a0',
            downColor: '#ff5c8a',
            wickUpColor: '#3ef0a0',
            wickDownColor: '#ff5c8a',
            borderVisible: false,
            priceFormat: format,
          })
        : instance.addSeries(LineSeries, { color: '#b69cff', lineWidth: 2, priceFormat: format })
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
        color: c.close >= c.open ? '#3ef0a033' : '#ff5c8a33',
      })),
    )
    if (items.length && !fitted.current) {
      chart.current.timeScale().fitContent()
      fitted.current = true
    }
  }, [resource.data, mode, unit])

  const empty = !resource.data?.items?.length
  return (
    <section className="panel chart-panel" aria-label={`${symbol} chart`}>
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
