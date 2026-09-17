import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
} from 'lightweight-charts'
import { useResource } from '../lib/api'
import Glass from './Glass'
export default function MarketChart({ address, symbol }) {
  const [interval, setInterval] = useState(300),
    [mode, setMode] = useState('candles')
  const resource = useResource(`/api/tokens/${address}/candles?interval=${interval}`, 10000)
  const container = useRef(null),
    chart = useRef(null),
    series = useRef(null),
    volume = useRef(null),
    fitted = useRef(false)
  useEffect(() => {
    if (!container.current) return
    const instance = createChart(container.current, {
      height: 390,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a49bb5',
        fontFamily: 'DM Sans Variable, sans-serif',
        attributionLogo: true,
      },
      grid: { vertLines: { color: '#ffffff06' }, horzLines: { color: '#ffffff09' } },
      rightPriceScale: { borderColor: '#ffffff10', scaleMargins: { top: 0.12, bottom: 0.25 } },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#ffffff10',
        maxBarSpacing: 22,
      },
      crosshair: { vertLine: { color: '#b4a1ff66' }, horzLine: { color: '#b4a1ff66' } },
    })
    chart.current = instance
    const format = { type: 'price', precision: 10, minMove: 0.0000000001 }
    series.current =
      mode === 'candles'
        ? instance.addSeries(CandlestickSeries, {
            upColor: '#a5e7d2',
            downColor: '#f29db4',
            wickUpColor: '#a5e7d2',
            wickDownColor: '#f29db4',
            borderVisible: false,
            priceFormat: format,
          })
        : instance.addSeries(LineSeries, { color: '#a5e7d2', lineWidth: 2, priceFormat: format })
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
  }, [address, interval, mode])
  useEffect(() => {
    if (!series.current || !resource.data) return
    const items = resource.data.items
    series.current.setData(
      mode === 'candles'
        ? items.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))
        : items.map(({ time, close }) => ({ time, value: close })),
    )
    volume.current.setData(
      items.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? '#a5e7d22a' : '#f29db42a',
      })),
    )
    if (items.length && !fitted.current) {
      chart.current.timeScale().fitContent()
      fitted.current = true
    }
  }, [resource.data, mode, address, interval])
  return (
    <Glass className="chart-panel" radius={24}>
      <div className="chart-toolbar">
        <strong>{symbol} / USDC</strong>
        <div className="chart-controls">
          {[
            [60, '1m'],
            [300, '5m'],
            [900, '15m'],
            [3600, '1h'],
            [14400, '4h'],
            [86400, '1d'],
          ].map(([n, label]) => (
            <button key={n} aria-pressed={n === interval} onClick={() => setInterval(n)}>
              {label}
            </button>
          ))}
        </div>
        <button
          className="chart-mode"
          onClick={() => setMode((m) => (m === 'candles' ? 'line' : 'candles'))}
        >
          {mode === 'candles' ? 'Line' : 'Candles'}
        </button>
      </div>
      <div className="chart-stage">
        <div
          ref={container}
          className="market-chart"
          aria-label={`${symbol} price chart in USDC`}
        />
        {!resource.data?.items?.length && (
          <div className="chart-empty">
            <span className="chart-empty-icon">⌁</span>
            <h3>
              {resource.loading ? 'Reading pool history…' : 'The first trade starts the chart.'}
            </h3>
            <p>
              {resource.error ||
                'Confirmed swaps appear here automatically. No synthetic price history.'}
            </p>
          </div>
        )}
      </div>
      {resource.data?.items?.length > 0 && resource.error && (
        <p className="form-error">Chart refresh failed: {resource.error}</p>
      )}
      <div className="chart-caption">
        <span>PoolManager events · 2-block indexing delay</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView ↗
        </a>
      </div>
    </Glass>
  )
}
