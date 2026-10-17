import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { THEME_KEY, applyTheme, currentTheme, readTheme, saveTheme } from '../../src/lib/theme.js'

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

// A document just big enough for applyTheme and public/theme-init.js.
function fakeDocument() {
  const meta = { content: '#e9ecf0', setAttribute: (k, v) => (meta[k] = v) }
  const root = {
    dataset: {},
    style: {},
    setAttribute: (k, v) => {
      if (k === 'data-theme') root.dataset.theme = v
    },
  }
  return {
    meta,
    documentElement: root,
    querySelector: (s) => (s === 'meta[name="theme-color"]' ? meta : null),
  }
}

// Minimal CSS reader (as in frontendUi-fixes.test.mjs): rules as { media, selectors, decls }.
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
function decl(rules, selector, prop) {
  let value
  for (const r of rules)
    if (r.selectors.includes(selector) && prop in r.decls) value = r.decls[prop]
  return value
}

const dark = readCss('theme-dark.css')
const base = readCss('base.css')
const ROOT = ":root[data-theme='dark']"
const SCOPE = `:where(${ROOT})`
function darkToken(name) {
  return decl(dark, ROOT, name)
}

// ---------- the stored choice ----------

test('the site opens in light unless dark was chosen before', () => {
  assert.equal(readTheme(null), 'light')
  assert.equal(readTheme(undefined), 'light')
  assert.equal(readTheme(memoryStorage()), 'light')
  for (const junk of ['', 'DARK', 'Dark', ' dark', 'night', '1', 'true', '{"theme":"dark"}'])
    assert.equal(readTheme(memoryStorage({ [THEME_KEY]: junk })), 'light', junk)
  assert.equal(readTheme(brokenStorage), 'light')
  assert.equal(readTheme(memoryStorage({ [THEME_KEY]: 'light' })), 'light')
  assert.equal(readTheme(memoryStorage({ [THEME_KEY]: 'dark' })), 'dark')
})

test('saving the choice survives storage that throws or is missing', () => {
  assert.doesNotThrow(() => saveTheme(brokenStorage, 'dark'))
  assert.doesNotThrow(() => saveTheme(null, 'dark'))
  const storage = memoryStorage()
  saveTheme(storage, 'dark')
  assert.equal(storage.data[THEME_KEY], 'dark')
  assert.equal(readTheme(storage), 'dark')
  saveTheme(storage, 'light')
  assert.equal(readTheme(storage), 'light')
})

test('applying a theme sets data-theme, the colour scheme and the browser chrome colour', () => {
  const doc = fakeDocument()
  applyTheme('dark', doc)
  assert.equal(doc.documentElement.dataset.theme, 'dark')
  assert.equal(doc.documentElement.style.colorScheme, 'dark')
  assert.equal(currentTheme(doc), 'dark')
  // the chrome colour is the night studio's page colour
  assert.equal(doc.meta.content.toLowerCase(), darkToken('--pearl'))
  applyTheme('light', doc)
  assert.equal(currentTheme(doc), 'light')
  assert.equal(doc.meta.content.toLowerCase(), '#e9ecf0')
  assert.equal(currentTheme(null), 'light')
})

// ---------- before first paint ----------

const initScript = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8')
function runInit(localStorage, prefersDark = true) {
  const doc = fakeDocument()
  // The OS asking for dark must not matter: light is the default.
  const matchMedia = (q) => ({ matches: prefersDark && q.includes('dark'), media: q })
  vm.runInNewContext(initScript, { document: doc, localStorage, matchMedia, window: {} })
  return doc
}

test('the pre-paint script opens in light even when the OS prefers dark', () => {
  for (const storage of [memoryStorage(), memoryStorage({ [THEME_KEY]: 'night' }), brokenStorage]) {
    const doc = runInit(storage)
    assert.equal(doc.documentElement.dataset.theme, 'light')
    assert.equal(doc.documentElement.style.colorScheme, 'light')
    assert.equal(doc.meta.content, '#e9ecf0')
  }
  const dark = runInit(memoryStorage({ [THEME_KEY]: 'dark' }), false)
  assert.equal(dark.documentElement.dataset.theme, 'dark')
  assert.equal(dark.documentElement.style.colorScheme, 'dark')
  assert.equal(dark.meta.content, '#07080c')
  // it reads the same key the app writes
  assert.ok(initScript.includes(`'${THEME_KEY}'`))
})

test('the pre-paint script is an external file that runs before the app', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const init = html.indexOf('<script src="/theme-init.js"></script>')
  assert.ok(init > 0, 'index.html loads /theme-init.js')
  // a classic blocking script in <head>, after the theme-color meta it updates
  assert.ok(init < html.indexOf('</head>'))
  assert.ok(html.indexOf('name="theme-color"') < init)
  assert.ok(init < html.indexOf('type="module"'))
  // the CSP allows no inline script
  assert.doesNotMatch(html, /<script>(?!<\/script>)/)
  assert.match(html, /<meta name="theme-color" content="#e9ecf0" \/>/)
})

// ---------- the night studio stylesheet ----------

test('every night rule is scoped to the dark theme, so light renders exactly as before', () => {
  for (const rule of dark)
    for (const s of rule.selectors)
      assert.ok(s === ROOT || s.startsWith(`${SCOPE} `), `unscoped selector: ${s}`)
  // the page itself goes dark: html paints --pearl
  assert.equal(decl(base, 'html', 'background'), 'var(--pearl)')
  assert.equal(darkToken('color-scheme'), 'dark')
})

// ---------- contrast in the night studio ----------

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
const saturate = ([r, g, b], s) =>
  [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ].map(([x, y, z]) => Math.min(255, Math.max(0, x * r + y * g + z * b)))
// a token's night value, or its light one where the night studio keeps it
const token = (name) => hex(darkToken(name) ?? decl(base, ':root', name))
const ratio = (name, bg) => contrast(token(name), bg)

// Brightest pixel of the bare night studio (content hidden, film grain on), found by rendering
// /terms at 360-1920px wide across the pools' whole drift cycle with the pools at the opacities
// below: yellow over green near the bottom of the page.
const NIGHT_POOLS_BRIGHTEST = [84, 68, 21]
const NIGHT_POOL_OPACITY = 0.44
const NIGHT_BLUE_OPACITY = 0.62
// The brightest pixel of the four lit lines (the yellow one at the top-right corner), with the
// line alphas below. The lines fade out before the reading column, but headings can still cross
// them.
const NIGHT_LINES_BRIGHTEST = [113, 90, 30]
const NIGHT_LINE_ALPHAS = [0.5, 0.36, 0.42, 0.66]

test('night text keeps WCAG AA 4.5:1 on the page under the brightest pool', () => {
  // the measurement above holds only while the pools are no brighter than this
  assert.ok(Number(decl(dark, `${SCOPE} .studio-pool`, 'opacity')) <= NIGHT_POOL_OPACITY)
  assert.ok(Number(decl(dark, `${SCOPE} .studio-blue`, 'opacity')) <= NIGHT_BLUE_OPACITY)
  for (const name of ['--steel', '--steel-2', '--ink-2', '--ink', '--buy', '--sell'])
    assert.ok(
      ratio(name, NIGHT_POOLS_BRIGHTEST) >= 4.5,
      `${name} on the night studio: ${ratio(name, NIGHT_POOLS_BRIGHTEST).toFixed(2)}`,
    )
})

test('night text keeps 4.5:1 on smoked glass panels over the brightest pool', () => {
  // The lightest point of the fill: the white bloom over the lighter body stop, over the studio
  // after the panel's backdrop saturation.
  const fill = darkToken('--glass-fill')
  const [bloom, ...body] = rgbas(fill)
  const sat = Number(darkToken('--glass-blur').match(/saturate\(([\d.]+)\)/)[1])
  const behind = saturate(NIGHT_POOLS_BRIGHTEST, sat)
  const glassBg = body
    .map((stop) => over(bloom, over(stop, behind)))
    .sort((a, b) => luminance(b) - luminance(a))[0]
  for (const name of ['--steel', '--steel-2', '--ink-2', '--buy', '--sell', '--blue-tint'])
    assert.ok(ratio(name, glassBg) >= 4.5, `${name} on night glass: ${ratio(name, glassBg)}`)
  // the focus ring stands out from both the page and the glass (WCAG 1.4.11)
  assert.ok(ratio('--focus', token('--pearl')) >= 3)
  assert.ok(ratio('--focus', glassBg) >= 3)
})

test('instrument text keeps 4.5:1 on night smoke over the brightest pool', () => {
  const [sheen, ...stops] = rgbas(darkToken('--smoke-fill'))
  const smokeBg = stops
    .map((stop) => over(sheen, over(stop, NIGHT_POOLS_BRIGHTEST)))
    .sort((a, b) => luminance(b) - luminance(a))[0]
  for (const name of ['--on-graphite', '--on-graphite-2', '--buy-bright', '--sell-bright'])
    assert.ok(ratio(name, smokeBg) >= 4.5, `${name} on night smoke: ${ratio(name, smokeBg)}`)
})

test('body text stays readable where it crosses the lit studio lines', () => {
  const lines = rgbas(decl(dark, `${SCOPE} .studio-lines`, 'background'))
  assert.equal(lines.length, NIGHT_LINE_ALPHAS.length)
  lines.forEach(([, , , a], k) => assert.ok(a <= NIGHT_LINE_ALPHAS[k], `line ${k} alpha ${a}`))
  for (const name of ['--ink', '--ink-2'])
    assert.ok(
      ratio(name, NIGHT_LINES_BRIGHTEST) >= 4.5,
      `${name} over a lit line: ${ratio(name, NIGHT_LINES_BRIGHTEST).toFixed(2)}`,
    )
  assert.ok(ratio('--steel', NIGHT_LINES_BRIGHTEST) >= 3)
})

test('the night model can tell: light muted text fails on the night studio', () => {
  assert.ok(contrast(hex(decl(base, ':root', '--steel')), NIGHT_POOLS_BRIGHTEST) < 4.5)
  // and a muted grey a step darker than --steel-2 would fail on the pools
  assert.ok(contrast(hex('#8c95a3'), NIGHT_POOLS_BRIGHTEST) < 4.5)
})

// ---------- $QUANTP surfaces (showcase.css) ----------

// The token's surfaces sit on smoked glass (instruments, the tape, the footer, the menu row) or on
// the header bar. Their text uses the instrument tokens, white or one link tint, and each keeps
// 4.5:1 on the lightest smoke it can sit on: day smoke over a white studio, night smoke over the
// brightest pool.
test('$QUANTP surfaces use instrument text colours that keep 4.5:1 on smoke, day and night', () => {
  const showcase = readCss('showcase.css')
  const glass = readCss('glass.css')
  const LINK_TINT = '#a9b9ff'
  const onSmoke = [
    'var(--on-graphite)',
    'var(--on-graphite-2)',
    'var(--buy-bright)',
    'var(--sell-bright)',
    '#fff',
    LINK_TINT,
  ]
  for (const rule of showcase)
    if ('color' in rule.decls) {
      assert.ok(
        onSmoke.includes(rule.decls.color),
        `${rule.selectors.join(', ')}: ${rule.decls.color}`,
      )
    }

  const lightest = (fill, behind) => {
    const [sheen, ...stops] = rgbas(fill)
    return stops
      .map((stop) => over(sheen, over(stop, behind)))
      .sort((a, b) => luminance(b) - luminance(a))[0]
  }
  const daySmoke = lightest(decl(glass, ':root', '--smoke-fill'), [255, 255, 255])
  const nightSmoke = lightest(darkToken('--smoke-fill'), NIGHT_POOLS_BRIGHTEST)
  const dayToken = (name) => hex(decl(base, ':root', name))
  for (const name of ['--on-graphite', '--on-graphite-2', '--buy-bright', '--sell-bright']) {
    assert.ok(contrast(dayToken(name), daySmoke) >= 4.5, `${name} on day smoke`)
    assert.ok(ratio(name, nightSmoke) >= 4.5, `${name} on night smoke`)
  }
  for (const bg of [daySmoke, nightSmoke])
    assert.ok(contrast(hex(LINK_TINT), bg) >= 4.5, `${LINK_TINT} on smoke`)
})
