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
import { crosshairLabel, tickMarkLabel } from './chartTime.js'
import { capTokens, chartPoints } from './chartScale.js'
import { DataCredit } from './TradesTable.jsx'

const INTERVALS = [
  [15, '15s'],
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [3600, '1h'],
  [86400, '1d'],
]

// `supply` is the coin record's raw mint supply (lower after burns) and `decimals` its mint
// decimals, so market-cap mode matches the server's market cap. `candlesPath` reads the candles
// from another route of the same shape (the $QUANTP page's /api/quantp/candles); a response
// with `source: 'geckoterminal'` credits GeckoTerminal under the chart.
export default function MarketChart({ mint, symbol, supply, decimals, candlesPath }) {
  const [interval, setInterval] = useState(60)
  const [mode, setMode] = useState('candles')
  const [unit, setUnit] = useState('price')
  const path = candlesPath || `/api/coins/${mint}/candles`
  const resource = useResource(`${path}?interval=${interval}`, 8000)
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
        textColor: '#c4cad4', // --on-graphite-2
        fontFamily: 'Martian Mono Variable, monospace',
        attributionLogo: true,
      },
      // Candle times are UTC; label them in the viewer's time zone.
      localization: { timeFormatter: (time) => crosshairLabel(time, { seconds: interval < 60 }) },
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
        tickMarkFormatter: tickMarkLabel,
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

  const k = unit === 'mcap' ? capTokens({ supply, decimals }) : 1
  useEffect(() => {
    if (!series.current || !resource.data) return
    const items = resource.data.items
    series.current.setData(chartPoints(items, { mode, k }))
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
  }, [resource.data, mode, unit, k])

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
            {/* A status line, not a section heading: the page outline goes h1 → h2 panels. */}
            <p className="chart-empty-title">
              {resource.loading ? 'Reading trades…' : 'No trades indexed yet'}
            </p>
            <p className="muted">
              {resource.error ||
                'The chart builds from confirmed Meteora trades as they are indexed.'}
            </p>
          </div>
        )}
      </div>
      {resource.data?.source === 'geckoterminal' && <DataCredit />}
    </section>
  )
}
