import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement, Suspense } from 'react'
import { prerenderToNodeStream } from 'react-dom/static'
import {
  claimReload,
  failedModuleUrl,
  installChunkReload,
  isChunkLoadError,
  lazyPage,
  retryFailedPages,
  retryUrl,
} from '../../src/components/recovery.js'
import { trapTarget } from '../../src/components/focus.js'
import { gateExempt, readAccepted, saveAccepted, RISK_KEY } from '../../src/components/gate.js'
import { crosshairLabel, tickMarkLabel } from '../../src/components/chartTime.js'
import { capTokens, chartPoints } from '../../src/components/chartScale.js'
import { lowerBound } from '../../src/components/figures.js'
import { capSupply, marketCap } from '../../server/market-math.mjs'

const memoryStorage = (initial = {}) => {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => (data[k] = String(v)),
  }
}
const brokenStorage = {
  getItem() {
    throw new Error('SecurityError')
  },
  setItem() {
    throw new Error('QuotaExceededError')
  },
}

// ---------- production-08: error boundary recovery ----------

test('chunk load failures are recognised in every browser wording', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://quantpad.fun/assets/LaunchPage-BngejgQT.js',
    'error loading dynamically imported module: https://quantpad.fun/assets/CoinPage-1.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/CoinPage-1.css',
    'Loading chunk 42 failed.',
  ])
    assert.equal(isChunkLoadError(new Error(message)), true, message)
  assert.equal(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' })), true)
  assert.equal(
    isChunkLoadError(new TypeError("Cannot read properties of null (reading 'x')")),
    false,
  )
  assert.equal(isChunkLoadError(null), false)
})

async function prerender(element) {
  const errors = []
  const { prelude } = await prerenderToNodeStream(element, {
    onError: (e) => {
      errors.push(e)
    },
  })
  let html = ''
  for await (const chunk of prelude) html += chunk
  return { html, errors }
}

const launchModule = { default: () => createElement('h1', null, 'Launch studio') }
const URL_ = 'https://quantpad.fun/assets/LaunchPage-BngejgQT.js'

test('a lazy page whose chunk failed imports it again, under a fresh URL, after a retry', async () => {
  let loads = 0
  const reimports = []
  let fail = true
  const Page = lazyPage(
    async () => {
      loads += 1
      throw new TypeError(`Failed to fetch dynamically imported module: ${URL_}`)
    },
    async (url) => {
      reimports.push(url)
      if (fail) throw new TypeError(`Failed to fetch dynamically imported module: ${URL_}`)
      return launchModule
    },
  )
  const tree = () => createElement(Suspense, { fallback: 'loading' }, createElement(Page))

  const first = await prerender(tree())
  assert.equal(loads, 1)
  assert.ok(first.errors.some(isChunkLoadError))
  assert.doesNotMatch(first.html, /Launch studio/)

  // Re-rendering on its own must not re-import (React retries the failing render; resetting
  // there would loop), the failure stays cached until the boundary asks for a retry.
  await prerender(tree())
  assert.equal(loads + reimports.length, 1)

  // Browsers cache a failed module URL, so the retry asks for the same chunk under a new query.
  retryFailedPages()
  await prerender(tree())
  assert.deepEqual(reimports, [`${URL_}?retry=1`])

  fail = false
  retryFailedPages()
  const retried = await prerender(tree())
  assert.deepEqual(reimports, [`${URL_}?retry=1`, `${URL_}?retry=2`])
  assert.match(retried.html, /Launch studio/)
  assert.deepEqual(retried.errors, [])

  // A page that loaded fine is not imported again by a later retry.
  retryFailedPages()
  await prerender(tree())
  assert.equal(loads, 1)
  assert.equal(reimports.length, 2)
})

test('without a URL in the error (Safari) the retry calls the original import again', async () => {
  let loads = 0
  const Page = lazyPage(async () => {
    loads += 1
    if (loads === 1) throw new TypeError('Importing a module script failed.')
    return launchModule
  })
  const tree = () => createElement(Suspense, { fallback: 'loading' }, createElement(Page))
  await prerender(tree())
  retryFailedPages()
  const { html } = await prerender(tree())
  assert.equal(loads, 2)
  assert.match(html, /Launch studio/)
})

test('failed module URLs are read from browser messages', () => {
  assert.equal(
    failedModuleUrl(new Error(`Failed to fetch dynamically imported module: ${URL_}`)),
    URL_,
  )
  assert.equal(
    failedModuleUrl(new Error(`error loading dynamically imported module: ${URL_}.`)),
    URL_,
  )
  assert.equal(failedModuleUrl(new Error('Importing a module script failed.')), null)
  assert.equal(retryUrl('https://x.test/a.js', 3), 'https://x.test/a.js?retry=3')
  assert.equal(retryUrl('https://x.test/a.js?v=1', 3), 'https://x.test/a.js?v=1&retry=3')
})

test('a chunk that resolves without a page is reported as a load failure', async () => {
  const Page = lazyPage(async () => undefined)
  const { errors } = await prerender(
    createElement(Suspense, { fallback: 'loading' }, createElement(Page)),
  )
  assert.ok(errors.some(isChunkLoadError))
})

test('automatic reload after a chunk error happens at most once per 30 seconds', () => {
  const storage = memoryStorage()
  assert.equal(claimReload(storage, 1_000_000), true)
  assert.equal(claimReload(storage, 1_010_000), false)
  assert.equal(claimReload(storage, 1_029_999), false)
  assert.equal(claimReload(storage, 1_031_000), true)
  assert.equal(claimReload(brokenStorage, 1_000_000), false)
})

test('vite:preloadError reloads the tab once, then lets the error reach the boundary', () => {
  const win = new EventTarget()
  let reloads = 0
  win.sessionStorage = memoryStorage()
  win.location = { reload: () => (reloads += 1) }
  const uninstall = installChunkReload(win)
  const fire = () => {
    const event = new Event('vite:preloadError', { cancelable: true })
    win.dispatchEvent(event)
    return event.defaultPrevented
  }
  assert.equal(fire(), true)
  assert.equal(reloads, 1)
  assert.equal(fire(), false)
  assert.equal(reloads, 1)
  uninstall()
})

// ---------- production-05: modal focus trap ----------

test('Tab and Shift+Tab wrap around inside the dialog', () => {
  const [close, wallet, link] = [{ id: 'close' }, { id: 'wallet' }, { id: 'link' }]
  const items = [close, wallet, link]
  const dialog = { id: 'dialog' }
  assert.equal(trapTarget(items, link, false), close)
  assert.equal(trapTarget(items, close, true), link)
  assert.equal(trapTarget(items, wallet, false), null)
  assert.equal(trapTarget(items, wallet, true), null)
  // Focus outside the dialog (body after a control was removed) comes back to an end.
  assert.equal(trapTarget(items, { id: 'body' }, false), close)
  assert.equal(trapTarget(items, { id: 'body' }, true), link)
  // Nothing focusable: keep focus on the dialog itself.
  assert.equal(trapTarget([], { id: 'body' }, false, dialog), dialog)
})

// ---------- production-13: risk gate ----------

test('terms and docs are readable before accepting the risk notice', () => {
  for (const path of ['/terms', '/terms/', '/docs', '/Terms']) assert.equal(gateExempt(path), true)
  for (const path of ['/', '/launch', '/market', '/coin/abc', '/terms-and-more', '/docsx'])
    assert.equal(gateExempt(path), false, path)
})

test('risk acceptance survives storage that throws', () => {
  const storage = memoryStorage()
  assert.equal(readAccepted(storage), false)
  saveAccepted(storage)
  assert.equal(storage.data[RISK_KEY], '1')
  assert.equal(readAccepted(storage), true)
  assert.equal(readAccepted(brokenStorage), false)
  assert.doesNotThrow(() => saveAccepted(brokenStorage))
  assert.equal(readAccepted(null), false)
})

// ---------- production-10: chart time axis ----------

test('chart labels candle times in the viewer time zone, not UTC', () => {
  const t = 1791612345 // 06:05:45 UTC, 02:05:45 in New York (EDT)
  assert.equal(tickMarkLabel(t, 3, 'en-US', 'America/New_York'), '02:05')
  assert.equal(tickMarkLabel(t, 4, 'en-US', 'America/New_York'), '02:05:45')
  assert.equal(tickMarkLabel(t, 3, 'en-US', 'Asia/Kolkata'), '11:35')
  assert.equal(tickMarkLabel(t, 3, 'en-US', 'UTC'), '06:05')
  const lateUtc = t + 20 * 3600 // 02:05 UTC on Oct 11 is still Oct 10 in New York
  assert.equal(tickMarkLabel(lateUtc, 2, 'en-US', 'UTC'), 'Oct 11')
  assert.equal(tickMarkLabel(lateUtc, 2, 'en-US', 'America/New_York'), 'Oct 10')
  assert.equal(tickMarkLabel(t, 0, 'en-US', 'UTC'), '2026')
  assert.equal(
    crosshairLabel(t, { locale: 'en-US', timeZone: 'America/New_York' }),
    'Oct 10, 2026 02:05',
  )
  assert.equal(
    crosshairLabel(t, { seconds: true, locale: 'en-GB', timeZone: 'Asia/Kolkata' }),
    '10 Oct 2026 11:35:45',
  )
  // Without an explicit zone the formatters use the runtime's local zone.
  const local = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(t * 1000))
  assert.equal(tickMarkLabel(t, 3, 'en-US'), local)
})

// ---------- cross-group: chart market cap uses the coin's real supply ----------

test("market-cap mode counts the coin's real supply, the same way the server does", () => {
  const price = 4.2e-8 // SOL per whole token, as candles carry it
  for (const record of [
    { supply: '2000000000000000', mayhem: true }, // mayhem: 2B minted
    { supply: '900000000000000' }, // 100M burned
    { supply: 1e15 }, // a number works too
    { supply: null }, // not read yet: pump.fun's 1B
    { supply: null, mayhem: true }, // not read yet, mayhem: 2B
    { supply: '0' }, // never a zero market cap
    {},
  ]) {
    const chart = price * capTokens(record)
    const server = marketCap(price, capSupply(record))
    assert.ok(Math.abs(chart - server) < 1e-9, `${JSON.stringify(record)}: ${chart} vs ${server}`)
  }
  assert.equal(capTokens({ supply: '2000000000000000' }), 2e9)
  assert.equal(capTokens({ supply: '900000000000000' }), 9e8)
  assert.equal(capTokens(), 1e9)
  assert.equal(capTokens({ mayhem: true }), 2e9)
})

test('chart points scale every price by k and leave times alone', () => {
  const items = [
    { time: 60, open: 1e-8, high: 3e-8, low: 5e-9, close: 2e-8, volume: 4 },
    { time: 120, open: 2e-8, high: 2e-8, low: 1e-8, close: 1.5e-8, volume: 1 },
  ]
  const k = capTokens({ supply: '2000000000000000' })
  const candles = chartPoints(items, { mode: 'candles', k })
  assert.deepEqual(
    candles.map((c) => c.time),
    [60, 120],
  )
  assert.ok(Math.abs(candles[0].open - 20) < 1e-9 && Math.abs(candles[0].high - 60) < 1e-9)
  assert.ok(Math.abs(candles[0].low - 10) < 1e-9 && Math.abs(candles[0].close - 40) < 1e-9)
  const line = chartPoints(items, { mode: 'line', k })
  assert.deepEqual(Object.keys(line[1]), ['time', 'value'])
  assert.ok(Math.abs(line[1].value - 30) < 1e-9)
  assert.deepEqual(chartPoints(items, { mode: 'line' })[0], { time: 60, value: 2e-8 })

  // MarketChart takes the supply from the coin record instead of assuming 1B tokens.
  const source = readFileSync(
    new URL('../../src/components/MarketChart.jsx', import.meta.url),
    'utf8',
  )
  assert.match(source, /function MarketChart\(\{[^}]*\bsupply\b[^}]*\}\)/)
  assert.match(source, /capTokens\(\{ supply, mayhem \}\)/)
  assert.doesNotMatch(source, /1e9/)
})

test('24h figures read while history is still being indexed show as lower bounds', () => {
  assert.equal(lowerBound(12.5, '12.5 SOL', false), '12.5 SOL')
  assert.equal(lowerBound(0, '0 SOL', false), '0 SOL')
  assert.equal(lowerBound(12.5, '12.5 SOL', true), '≥ 12.5 SOL')
  assert.equal(lowerBound(311, '311', true), '≥ 311')
  // Nothing indexed yet in a partial window is unknown, not zero.
  assert.equal(lowerBound(0, '0 SOL', true), '—')
  assert.equal(lowerBound(undefined, '0', true), '—')
})

// ---------- stylesheet checks ----------

// Minimal CSS reader: rules as { media, selectors, decls } in source order.
function readCss(file) {
  const css = readFileSync(new URL(`../../src/styles/${file}`, import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
  const rules = []
  let i = 0
  const block = (media) => {
    while (i < css.length) {
      const open = css.indexOf('{', i)
      const close = css.indexOf('}', i)
      if (close !== -1 && (open === -1 || close < open)) {
        i = close + 1
        return
      }
      if (open === -1) return
      const head = css.slice(i, open).trim().replace(/\s+/g, ' ')
      i = open + 1
      if (head.startsWith('@')) {
        block(head)
        continue
      }
      const end = css.indexOf('}', i)
      const decls = {}
      for (const d of css.slice(i, end).split(';')) {
        const k = d.indexOf(':')
        if (k > 0)
          decls[d.slice(0, k).trim()] = d
            .slice(k + 1)
            .trim()
            .replace(/\s+/g, ' ')
      }
      i = end + 1
      rules.push({ media, selectors: head.split(',').map((s) => s.trim()), decls })
    }
  }
  block(null)
  return rules
}
// The value that wins for `selector` (last matching rule), optionally inside one media query.
function decl(rules, selector, prop, media = null) {
  let value
  for (const r of rules)
    if (r.media === media && r.selectors.includes(selector) && prop in r.decls)
      value = r.decls[prop]
  return value
}

const base = readCss('base.css')
const glass = readCss('glass.css')
const pages = readCss('pages.css')
const shell = readCss('shell.css')
const components = readCss('components.css')

test('mobile coin page: panels shrink to the column and the trades table scrolls inside', () => {
  assert.equal(decl(pages, '.coin-main', 'grid-template-columns'), 'minmax(0, 1fr)')
  assert.equal(decl(pages, '.coin-side', 'grid-template-columns'), 'minmax(0, 1fr)')
  // same implicit-track trap on the launch studio at 320px
  assert.equal(decl(pages, '.launch-form', 'grid-template-columns'), 'minmax(0, 1fr)')
  assert.equal(decl(pages, '.launch-aside', 'grid-template-columns'), 'minmax(0, 1fr)')
  assert.equal(decl(components, '.table-wrap', 'overflow-x'), 'auto')
})

test('segmented labels and nav links never wrap mid-word', () => {
  assert.equal(decl(components, '.segmented button', 'white-space'), 'nowrap')
  assert.equal(decl(components, '.segmented button', 'flex'), 'none')
  assert.equal(decl(components, '.segmented button', 'overflow-wrap'), 'normal')
  assert.equal(decl(components, '.segmented', 'overflow-x'), 'auto')
  assert.equal(decl(pages, '.docs-nav a', 'white-space', '@media (max-width: 960px)'), 'nowrap')
  assert.equal(decl(shell, '.nav a', 'white-space'), 'nowrap')
})

test('the header collapses into the menu before the search box gets squeezed', () => {
  const collapse = '@media (max-width: 1140px)'
  assert.equal(decl(shell, '.nav', 'display', collapse), 'none')
  assert.equal(decl(shell, '.topbar-search', 'display', collapse), 'none')
  assert.equal(decl(shell, '.topbar .menu-toggle', 'display', collapse), 'inline-flex')
  assert.equal(decl(shell, '.topbar-search', 'min-width'), '180px')
})

test('the fee flow stacks with downward arrows once it stops fitting on one row', () => {
  const narrow = '@media (max-width: 960px)'
  assert.equal(decl(pages, '.flow', 'flex-direction', narrow), 'column')
  assert.equal(decl(pages, '.flow-node', 'flex', narrow), 'none')
  assert.equal(decl(pages, '.flow-arrow::after', 'border-left-color', narrow), 'transparent')
  assert.equal(decl(pages, '.flow-arrow::after', 'border-top-color', narrow), 'var(--steel)')
})

// ---------- production-04: text contrast over glass and studio light ----------

const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16))
const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const over = ([r, g, b, a], bg) => [r, g, b].map((c, k) => c * a + bg[k] * (1 - a))
const rgbas = (text) =>
  [...text.matchAll(/rgba\(([^)]+)\)/g)].map((m) => m[1].split(',').map(Number))
// CSS saturate() as the Filter Effects spec defines it (sRGB, clamped).
const saturate = ([r, g, b], s) =>
  [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ].map(([x, y, z]) => Math.min(255, Math.max(0, x * r + y * g + z * b)))

// Darkest pixel of the bare studio (no content) with the light pools at opacity 0.55, found by
// rendering /market at 360-1920px wide across the pools' whole drift cycle: the blue pool.
const STUDIO_DARKEST = [159, 171, 245]
const WHITE = [255, 255, 255]
const token = (name) => hex(decl(base, ':root', name))
const ratio = (name, bg) => contrast(token(name), bg).toFixed(2)

test('muted text keeps WCAG AA 4.5:1 over the worst studio light, on glass and off it', () => {
  // The measured backdrop above is only valid while the pools are no brighter than this.
  assert.ok(Number(decl(glass, '.studio-pool', 'opacity')) <= 0.55)

  // Text straight on the page (page heads, prose, docs nav, header links).
  for (const name of ['--steel', '--ink-2', '--ink'])
    assert.ok(ratio(name, STUDIO_DARKEST) >= 4.5, `${name} on the studio`)

  // Glass panels: the weakest white of the fill over the saturated studio light.
  const fill = decl(glass, ':root', '--glass-fill')
  const weakest = Math.min(...rgbas(fill.slice(fill.indexOf('linear-gradient'))).map((c) => c[3]))
  const sat = Number(decl(glass, ':root', '--glass-blur').match(/saturate\(([\d.]+)\)/)[1])
  const glassBg = over([...WHITE, weakest], saturate(STUDIO_DARKEST, sat))
  for (const name of ['--steel', '--steel-2', '--buy', '--sell', '--blue-deep'])
    assert.ok(ratio(name, glassBg) >= 4.5, `${name} on glass: ${ratio(name, glassBg)}`)

  // Smoked instruments: their lightest corner (sheen over the lighter stop) over studio white.
  const [sheen, ...stops] = rgbas(decl(glass, ':root', '--smoke-fill'))
  const smokeBg = stops
    .map((stop) => over(sheen, over(stop, WHITE)))
    .sort((a, b) => luminance(b) - luminance(a))[0]
  for (const name of ['--on-graphite', '--on-graphite-2', '--buy-bright', '--sell-bright'])
    assert.ok(ratio(name, smokeBg) >= 4.5, `${name} on smoke: ${ratio(name, smokeBg)}`)

  // White numerals on the cobalt step index, at its lightest stop.
  const cobalt = decl(base, ':root', '--cobalt-anodised').match(/#[0-9a-f]{6}/i)[0]
  assert.ok(contrast(WHITE, hex(cobalt)) >= 4.5)
})

test('the previous palette fails the same model, so the check can tell', () => {
  const studioAt09 = [131, 148, 248] // darkest page backdrop measured with the pools at 0.9
  assert.ok(contrast(hex('#5f6876'), studioAt09) < 4.5) // old --steel
  const oldGlass = over([...WHITE, 0.16], saturate(studioAt09, 1.9))
  assert.ok(contrast(hex('#7d8693'), oldGlass) < 4.5) // old --steel-2
})

// ---------- production-12: keyboard focus on range sliders in every engine ----------

test('range sliders show a solid focus ring on the thumb in Chromium, Safari and Firefox', () => {
  // The track itself has no outline, so the thumb must carry the ring.
  assert.equal(decl(components, '.range', 'outline'), 'none')
  const ring = '0 0 0 2px #fff, 0 0 0 4px var(--focus)'
  assert.equal(decl(components, '.range:focus-visible::-webkit-slider-thumb', 'box-shadow'), ring)
  assert.equal(decl(components, '.range:focus-visible::-moz-range-thumb', 'box-shadow'), ring)
  // A selector list that mixes engine prefixes is invalid in both engines and dropped whole.
  for (const rule of components) {
    const text = rule.selectors.join(',')
    assert.ok(!(/::-webkit-/.test(text) && /::-moz-/.test(text)), `mixed prefixes: ${text}`)
  }
  // WCAG 1.4.11: the ring is at least 3:1 against the white gap that separates it from any backdrop.
  assert.ok(contrast(token('--focus'), WHITE) >= 3)
})
